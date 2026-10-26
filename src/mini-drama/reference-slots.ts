// ---------------------------------------------------------------------------
// Reference slot allocator (@Image1..@ImageN)
//
// Central bookkeeping for the flat reference_image_urls array on @Image-tag
// models (Seedance 2.0 R2V family, HappyHorse 1.1 R2V). The @ImageN index in
// the prompt MUST match the push order of reference_image_urls in the queue
// body, so both the prompt builder and the video generator consume the SAME
// ordered slot list built here.
//
// Slot order (within the per-model budget, default 9 on Seedance R2V):
//   1. One primary angle per character (front.png)      — identity
//   2. Storyboard blocking plate(s) for the shot's beat — PROTECTED
//   3. Location angles (wide, then medium, then detail) — environment
//   4. Second character angles (three-quarter.png)      — extra identity
//
// Overflow policy (user decision 2026-07-30): drop second character angles
// first, then extra location angles; storyboard plates are protected and
// dropped only if characters + plates alone exceed the budget.
//
// A shot-list montage unit plans its stack with `buildMontageSlotPlan`
// (bottom of this file): staged views in first-appearance order when its
// shots name their plateView, the order above otherwise.
// ---------------------------------------------------------------------------

import { basename, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import { getMaxReferenceImages, isObjectCastMember } from 'venice-video-harness/core/series/types.js';
import {
  getCharacterDir,
  getLocationDir,
  getLocation,
  getStoryboardRefPath,
} from '../series/manager.js';
import { viewTexts } from './plan-check.js';

export type ReferenceSlotKind =
  | 'character-primary'
  | 'character-angle'
  | 'storyboard'
  | 'location';

export interface ReferenceSlot {
  /** 1-based index — @Image<imageIndex> in the prompt. */
  imageIndex: number;
  kind: ReferenceSlotKind;
  /** Absolute path to the image on disk. */
  path: string;
  /** Character name (character slots), location slug, or storyboard slug. */
  label: string;
  /** Prompt role clause emitted verbatim (without the @ImageN prefix). */
  roleClause: string;
}

export interface ReferenceSlotPlan {
  slots: ReferenceSlot[];
  /** Character name -> primary slot imageIndex (for @ImageN name substitution). */
  characterSlotByName: Map<string, number>;
  /** Human-readable notes about what was dropped due to budget. */
  dropped: string[];
}

interface CandidateSlot {
  kind: ReferenceSlotKind;
  path: string;
  label: string;
  roleClause: string;
}

// North (the hero plate) first, then the derived same-wall plates
// (south/east/west), then the legacy names (only present on pre-2026-10-05
// projects). The derived plates are all multi-edits of the north plate, so
// they depict ONE coherent space — safe to send together as "same place,
// different wall".
const LOCATION_ANGLE_ORDER_DEFAULT = [
  'north.png', 'south.png', 'east.png', 'west.png',
  'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
];
/** The plate files the harness names itself; anything else in a location dir is a custom angle. */
const CANONICAL_PLATES = new Set(LOCATION_ANGLE_ORDER_DEFAULT);
// Closer shot types no longer prefer a "medium" distance angle (the ladder is
// gone); the same north-first order applies. Kept as a named constant so the
// call site reads clearly.
const LOCATION_ANGLE_ORDER_CLOSER = LOCATION_ANGLE_ORDER_DEFAULT;

/**
 * Location plate files in reference order for a shot. A shot that names its
 * `plateView` (the view it is staged on) puts that plate first, so panels and
 * video draw that background; every other shot keeps the north-first order.
 * Every caller that picks a location plate (slot plan, panel pass, panel
 * approval digest, legacy fold) reads this, so they cannot disagree.
 */
export function locationPlateOrder(shot?: Pick<ShotScript, 'plateView' | 'type'>): string[] {
  const base = shot && (shot.type === 'close-up' || shot.type === 'reaction' || shot.type === 'insert')
    ? LOCATION_ANGLE_ORDER_CLOSER
    : LOCATION_ANGLE_ORDER_DEFAULT;
  const lead = shot?.plateView ? `${shot.plateView}.png` : null;
  return lead && base.includes(lead) ? [lead, ...base.filter(file => file !== lead)] : [...base];
}

/**
 * Build the ordered reference slot plan for a shot on an @Image-tag model.
 *
 * The returned slots array is the exact push order of reference_image_urls;
 * @ImageN in the prompt = slots[N-1]. Characters always occupy the first
 * slots (one primary angle each) so drop decisions never renumber them.
 */
export function buildReferenceSlotPlan(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  options: { characterNames?: string[] } = {},
): ReferenceSlotPlan {
  return planReferenceSlots(series, shot, modelId, options.characterNames ?? shot.characters, shot.location ? [shot.location] : []);
}

/** An object cast member's name with an article: "the CABLE TRAM", and "THE PHONE" as it is. */
function objectName(name: string): string {
  return /^the\s/i.test(name) ? name : `the ${name}`;
}

/** The person clause for a cast member's primary reference, or the object clause for an object cast member. */
function primaryRoleClause(char: SeriesState['characters'][number]): string {
  return isObjectCastMember(char)
    ? `is ${objectName(char.name)} — an object, not a person; match its exact shape, materials, colours and marks`
    : `is ${char.name} — use this reference for ${char.name}'s face, hair, and wardrobe`;
}

function secondAngleRoleClause(char: SeriesState['characters'][number]): string {
  return isObjectCastMember(char)
    ? `is a second view of ${objectName(char.name)} — the same object as its primary reference`
    : `is a second angle of ${char.name} — same person as ${char.name}'s primary reference`;
}

/**
 * The slot plan behind `buildReferenceSlotPlan`, for one or more locations
 * (a montage unit that crosses places sends each place's plates in turn).
 */
function planReferenceSlots(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  charNames: string[],
  locationSlugs: string[],
): ReferenceSlotPlan {
  const budget = getMaxReferenceImages(modelId);
  const dropped: string[] = [];

  const resolvedChars = charNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is SeriesState['characters'][number] => Boolean(c));

  // --- Tier 1: one primary angle per character ---
  // anchor.png outranks the generated sheets: it is a frame harvested from an
  // APPROVED render (harvest-anchor), so it shows the exact rendered identity
  // later units must match — the strongest anti-drift reference available.
  const primary: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const path = primaryReferencePath(series, char.name);
    if (!path) continue;
    primary.push({
      kind: 'character-primary',
      path,
      label: char.name,
      roleClause: primaryRoleClause(char),
    });
  }

  // --- Tier 2: storyboard blocking plate (PROTECTED) ---
  const storyboard: CandidateSlot[] = [];
  if (shot.storyboardRef) {
    const sbPath = getStoryboardRefPath(series, shot.storyboardRef);
    if (sbPath && existsSync(sbPath)) {
      storyboard.push({
        kind: 'storyboard',
        path: sbPath,
        label: shot.storyboardRef,
        roleClause:
          'is the storyboard blocking reference — it shows where the characters are ' +
          'positioned in the location and in relation to each other; use it ONLY for ' +
          'composition, blocking, and spatial relationships. Take each character\'s ' +
          'appearance from their own reference image, and the environment from the ' +
          'location references. It is not a character and not a style reference.',
      });
    } else {
      dropped.push(`storyboard ref "${shot.storyboardRef}" (not found on disk)`);
    }
  }

  // --- Tier 3: location angles ---
  const location: CandidateSlot[] = locationSlugs.flatMap(slug => locationCandidates(series, shot, slug));

  // --- Tier 4: second character angles ---
  const charAngles: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const primaryPath = primary.find(s => s.label === char.name)?.path;
    const path = secondAnglePath(series, char.name, primaryPath);
    if (!path) continue;
    charAngles.push({
      kind: 'character-angle',
      path,
      label: char.name,
      roleClause: secondAngleRoleClause(char),
    });
  }

  // --- Budget allocation ---
  // Priority: primaries > storyboard (protected) > location angles (first
  // angle prioritized over char angles; extra angles below char angles is
  // NOT the chosen policy — user chose: drop char angles first, then extra
  // location angles, storyboard protected. So the fill order is:
  //   primaries, storyboard, location[0], charAngles, location[1..]
  // and the DROP order (reverse fill) is: location[1..] last-in-first-out,
  // then charAngles, then location[0], then storyboard.
  // To express "drop second character angles first, then extra location
  // angles" we fill in this order:
  //   primaries, storyboard, ALL location angles, charAngles
  // so charAngles overflow first, then trailing location angles.
  const fillOrder: CandidateSlot[] = [
    ...primary,
    ...storyboard,
    ...location,
    ...charAngles,
  ];

  const slots: ReferenceSlot[] = [];
  for (const candidate of fillOrder) {
    if (slots.length >= budget) {
      dropped.push(`${candidate.kind} "${candidate.label}" (over ${budget}-image budget for ${modelId})`);
      continue;
    }
    slots.push({
      imageIndex: slots.length + 1,
      ...candidate,
    });
  }

  const characterSlotByName = new Map<string, number>();
  for (const slot of slots) {
    if (slot.kind === 'character-primary') {
      characterSlotByName.set(slot.label.toUpperCase(), slot.imageIndex);
    }
  }

  return { slots, characterSlotByName, dropped };
}

/** A cast member's primary reference: a harvested anchor, else the front sheet, else the three-quarter. */
export function primaryReferencePath(series: SeriesState, name: string): string | undefined {
  const dir = getCharacterDir(series, name);
  return ['anchor.png', 'front.png', 'three-quarter.png'].map(f => join(dir, f)).find(p => existsSync(p));
}

function secondAnglePath(series: SeriesState, name: string, primaryPath: string | undefined): string | undefined {
  const dir = getCharacterDir(series, name);
  return ['three-quarter.png', 'profile.png', 'full-body.png'].map(f => join(dir, f)).find(p => existsSync(p) && p !== primaryPath);
}

/** Every plate of a location on disk, in reference order, with its role clause. */
function locationCandidates(series: SeriesState, shot: ShotScript, slug: string): CandidateSlot[] {
  const loc = getLocation(series, slug);
  if (!loc) return [];
  const dir = getLocationDir(series, loc.slug);
  const order = locationPlateOrder(shot);
  const angleRole: Record<string, string> = {
    'north.png': 'a wide establishing plate of the location, facing the north wall',
    'south.png': 'the south wall of the same location',
    'east.png': 'the east wall of the same location',
    'west.png': 'the west wall of the same location',
    'wide.png': 'a wide establishing angle of the location',
    'angle-2.png': 'another angle of the same location',
    'angle-3.png': 'another angle of the same location',
    'angle-4.png': 'another angle of the same location',
    'medium.png': 'a second angle of the same location',
    'detail.png': 'a third angle of the same location (detail)',
  };
  // Custom angles (operator-generated extra coverage beyond the canonical
  // set, e.g. reverse-angle.png) queue after the canonical plates, in
  // stable name order. Archives and sidecar-less strays are excluded by
  // pattern.
  let customAngles: string[] = [];
  try {
    customAngles = readdirSync(dir)
      .filter(f =>
        /\.png$/i.test(f)
        && !CANONICAL_PLATES.has(f)
        && !f.includes('archive')
        && !f.includes('-pre-'))
      .sort();
  } catch {
    // No location dir — canonical loop below reports nothing either.
  }

  const location: CandidateSlot[] = [];
  let angleCount = 0;
  for (const f of [...order, ...customAngles]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    angleCount += 1;
    const customName = CANONICAL_PLATES.has(f) ? null : f.replace(/\.png$/i, '').replace(/-/g, ' ');
    const stagedView = angleCount === 1 && shot.plateView && f === `${shot.plateView}.png`;
    const anglePhrase = stagedView
      ? `is the view this shot is staged on (${loc.name}, ${shot.plateView} view) — the camera looks along this frame: match its background, architecture, and lighting; it is not a character`
      : angleCount === 1
      ? `is the location environment reference (${loc.name}) — match its setting, architecture, and lighting; it is not a character`
      : customName
        ? `is another angle of the same location (${loc.name}: ${customName}) — same place, different angle; keep the environment consistent with it`
        : `is ${angleRole[f] ?? 'another angle of the same location'} (${loc.name}) — same place, different angle; keep the environment consistent with it`;
    location.push({
      kind: 'location',
      path: p,
      label: loc.slug,
      roleClause: anglePhrase,
    });
  }
  return location;
}

// ---------------------------------------------------------------------------
// Montage slot plan (shot-list grammar, 2026-10-25)
//
// One generation can carry a continuous run across several places. When the
// run's shots name the view they are staged on (`plateView`), its references
// go in the order things first appear: each cast member's primary reference
// where they first enter, and each shot's STAGED view where that view is
// first used. Only staged views by default: in a 31-render continuity
// bakeoff, sending all four views of each of two places staged one place's
// action on the plate of the other. Each place image says which shots it
// serves and that it does not set where things are in the others.
//
// A unit where no shot names a plateView (every script written before the
// field existed) gets the load a montage always sent: every view of each of
// its places, custom angles and the cast's second angles.
// ---------------------------------------------------------------------------

const COMPASS_VIEWS = new Set(['north', 'east', 'south', 'west']);

export interface StagedPlate {
  slug: string;
  name: string;
  file: string;
  path: string;
  /** The compass view, when the file is one ("north"); undefined for legacy or custom plates. */
  view?: string;
}

/** The location plate a shot is staged on: its plateView, else the first plate on disk in reference order. */
export function stagedPlateFor(series: SeriesState, shot: ShotScript): StagedPlate | null {
  if (!shot.location) return null;
  const loc = getLocation(series, shot.location);
  if (!loc) return null;
  const dir = getLocationDir(series, loc.slug);
  for (const file of locationPlateOrder(shot)) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const view = file.replace(/\.png$/, '');
    return { slug: loc.slug, name: loc.name, file, path, ...(COMPASS_VIEWS.has(view) ? { view } : {}) };
  }
  return null;
}

export interface MontageSlotPlan extends ReferenceSlotPlan {
  /** Shot number -> the @Image index of the place image the shot is staged on. */
  placeByShot: Map<number, number>;
}

interface MontageCandidate extends CandidateSlot {
  key: string;
  /** Dropped last when the budget is short. */
  essential: boolean;
  /** Shot numbers a place image serves. */
  shots?: number[];
}

/** The leading clauses of a text, up to about `max` characters, cut at a clause boundary (or a word, with an ellipsis). */
function firstClauses(text: string, max: number): string {
  const clean = text.trim().replace(/\.$/, '');
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf(','));
  return cut > max * 0.4 ? head.slice(0, cut) : `${head.replace(/\s+\S*$/, '')}…`;
}

function listShots(positions: number[]): string {
  if (positions.length === 1) return `shot ${positions[0]}`;
  return `shots ${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`;
}

function placeRoleClause(series: SeriesState, shots: ShotScript[], candidate: MontageCandidate, positionOf: Map<number, number>): string {
  const loc = getLocation(series, candidate.label);
  const name = loc?.name ?? candidate.label;
  const view = basename(candidate.path).replace(/\.png$/, '');
  const compass = COMPASS_VIEWS.has(view) ? view as 'north' | 'east' | 'south' | 'west' : undefined;
  const served = (candidate.shots ?? []).map(n => positionOf.get(n)).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
  const firstShot = shots.find(shot => candidate.shots?.includes(shot.shotNumber));
  const viewText = compass && loc
    ? viewTexts({ slug: loc.slug, name: loc.name, description: loc.description, spatialAnchors: loc.spatialAnchors })[compass]
    : undefined;
  const what = firstShot?.stagedOn?.trim()
    || (viewText ? firstClauses(viewText, 140) : '')
    || firstClauses((loc?.description ?? '').split(/(?<=\.)\s/)[0], 140);
  const only = shots.length > 1 ? ' only' : '';
  return `is ${name}${compass ? ` (the ${compass} view)` : ''}, for ${listShots(served)}${only}${what ? `: ${what.replace(/\.$/, '')}` : ''}. `
    + 'It does not set where people, vehicles or props are in any other shot';
}

/**
 * The ordered reference slot plan for a shot-list montage unit.
 *
 * When at least one shot names its `plateView`: first-appearance order,
 * staged views only (`views: 'all'` adds the other canonical views of each
 * place and the cast's second angles; not custom angles). Overflow drops the
 * extra views and second angles first, then later views of a place already
 * shown, then the other place images and storyboard plates from the end;
 * the cast's primary references go last (rule 42). A shot whose image was
 * dropped points at the first image of its place still sent, and that
 * image's clause names the shot.
 *
 * When no shot names one: the load a montage always sent (see
 * `buildUnstagedMontageSlotPlan`), whatever `views` says.
 */
export function buildMontageSlotPlan(
  series: SeriesState,
  shots: ShotScript[],
  modelId: string,
  options: { views?: 'staged' | 'all' } = {},
): MontageSlotPlan {
  if (!shots.some(shot => shot.plateView)) return buildUnstagedMontageSlotPlan(series, shots, modelId);

  const budget = getMaxReferenceImages(modelId);
  const views = options.views ?? 'staged';
  const dropped: string[] = [];
  const candidates: MontageCandidate[] = [];
  const byKey = new Map<string, MontageCandidate>();
  const add = (candidate: MontageCandidate): MontageCandidate => {
    const existing = byKey.get(candidate.key);
    if (existing) {
      if (candidate.shots) existing.shots = [...new Set([...(existing.shots ?? []), ...candidate.shots])];
      existing.essential = existing.essential || candidate.essential;
      return existing;
    }
    byKey.set(candidate.key, candidate);
    candidates.push(candidate);
    return candidate;
  };

  const placeKeyByShot = new Map<number, string>();
  const castInOrder: SeriesState['characters'] = [];
  for (const shot of shots) {
    for (const name of shot.characters) {
      const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
      if (!char) continue;
      const path = primaryReferencePath(series, char.name);
      if (!path) continue;
      if (!castInOrder.includes(char)) castInOrder.push(char);
      add({
        key: `cast:${char.name.toUpperCase()}`, essential: true, kind: 'character-primary', path, label: char.name,
        roleClause: primaryRoleClause(char),
      });
    }
    if (shot.storyboardRef) {
      const sbPath = getStoryboardRefPath(series, shot.storyboardRef);
      if (sbPath && existsSync(sbPath)) {
        add({
          key: `storyboard:${shot.storyboardRef}`, essential: true, kind: 'storyboard', path: sbPath, label: shot.storyboardRef,
          roleClause: 'is a storyboard blocking reference — use it ONLY for composition, blocking and spatial relationships; take appearance from each character\'s own reference and the environment from the place images',
        });
      }
    }
    const staged = stagedPlateFor(series, shot);
    if (!staged) continue;
    const key = `place:${staged.slug}:${staged.file}`;
    add({ key, essential: true, kind: 'location', path: staged.path, label: staged.slug, roleClause: '', shots: [shot.shotNumber] });
    placeKeyByShot.set(shot.shotNumber, key);
    if (views === 'all') {
      const dir = getLocationDir(series, staged.slug);
      for (const file of locationPlateOrder(shot)) {
        if (file === staged.file) continue;
        const path = join(dir, file);
        if (!existsSync(path)) continue;
        add({
          key: `place:${staged.slug}:${file}`, essential: false, kind: 'location', path, label: staged.slug,
          roleClause: `is another view of ${staged.name} (${file.replace(/\.png$/, '')}) — geography only; keep the place consistent with it`,
        });
      }
    }
  }
  if (views === 'all') {
    for (const char of castInOrder) {
      const path = secondAnglePath(series, char.name, byKey.get(`cast:${char.name.toUpperCase()}`)?.path);
      if (!path) continue;
      add({
        key: `angle:${char.name.toUpperCase()}`, essential: false, kind: 'character-angle', path, label: char.name,
        roleClause: secondAngleRoleClause(char),
      });
    }
  }

  // Budget: extra views and second angles go first, then later views of a
  // place already shown, then the other place images and storyboard plates
  // from the end; the cast goes last, as in every lane (rule 42).
  const kept = [...candidates];
  const drop = (index: number, why: string) => {
    dropped.push(`${kept[index].kind} "${kept[index].label}" (${why})`);
    kept.splice(index, 1);
  };
  for (let i = kept.length - 1; i >= 0 && kept.length > budget; i--) {
    if (!kept[i].essential) drop(i, `over ${budget}-image budget for ${modelId}`);
  }
  for (let i = kept.length - 1; i >= 0 && kept.length > budget; i--) {
    const candidate = kept[i];
    if (candidate.kind !== 'location') continue;
    if (!kept.slice(0, i).some(other => other.kind === 'location' && other.label === candidate.label && other.shots)) continue;
    drop(i, `a later view of a place already shown; over the ${budget}-image budget`);
  }
  for (const kind of ['location', 'storyboard', 'character-primary'] as const) {
    for (let i = kept.length - 1; i >= 0 && kept.length > budget; i--) {
      if (kept[i].kind === kind) drop(i, `over ${budget}-image budget for ${modelId}`);
    }
  }

  // Each shot's place image: its staged view, or, when that was dropped, the
  // first image of the same place still sent, whose clause then names it too.
  const placeByShot = new Map<number, number>();
  const servedBy = new Map<MontageCandidate, number[]>();
  for (const shot of shots) {
    const key = placeKeyByShot.get(shot.shotNumber);
    const staged = key ? byKey.get(key) : undefined;
    if (!staged) continue;
    const image = kept.includes(staged) ? staged : kept.find(candidate => candidate.kind === 'location' && candidate.label === staged.label);
    if (!image) continue;
    servedBy.set(image, [...(servedBy.get(image) ?? []), shot.shotNumber]);
    placeByShot.set(shot.shotNumber, kept.indexOf(image) + 1);
  }

  const positionOf = new Map(shots.map((shot, index) => [shot.shotNumber, index + 1]));
  const slots: ReferenceSlot[] = kept.map((candidate, index) => {
    const served = servedBy.get(candidate);
    return {
      imageIndex: index + 1,
      kind: candidate.kind,
      path: candidate.path,
      label: candidate.label,
      roleClause: served ? placeRoleClause(series, shots, { ...candidate, shots: served }, positionOf) : candidate.roleClause,
    };
  });

  const characterSlotByName = new Map<string, number>();
  for (const slot of slots) if (slot.kind === 'character-primary') characterSlotByName.set(slot.label.toUpperCase(), slot.imageIndex);
  return { slots, characterSlotByName, dropped, placeByShot };
}

/**
 * The montage reference load from before staged views, for a unit where no
 * shot names its `plateView`: the first shot's storyboard plate, every plate
 * of the unit's place (custom angles too) and the cast's second angles, with
 * the same role clauses and overflow order as `buildReferenceSlotPlan`. A
 * unit at one place gets the plan the SEQUENCE grammar sends; a continuous
 * run across places gets each place's plates in the order the places appear.
 * Each shot's place image is that place's first plate.
 */
function buildUnstagedMontageSlotPlan(series: SeriesState, shots: ShotScript[], modelId: string): MontageSlotPlan {
  const characterNames = Array.from(new Set(shots.flatMap(shot => shot.characters)));
  const slugOf = (shot: ShotScript) => (shot.location ? getLocation(series, shot.location)?.slug : undefined);
  const places = Array.from(new Set(shots.map(slugOf).filter((slug): slug is string => Boolean(slug))));
  const planShot: ShotScript = { ...shots[0], characters: characterNames, location: places[0] };
  const plan = planReferenceSlots(series, planShot, modelId, characterNames, places);
  const placeByShot = new Map<number, number>();
  for (const shot of shots) {
    const slug = slugOf(shot);
    const slot = slug ? plan.slots.find(s => s.kind === 'location' && s.label === slug) : undefined;
    if (slot) placeByShot.set(shot.shotNumber, slot.imageIndex);
  }
  return { ...plan, placeByShot };
}
