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
//   3. Location angles (wide, then medium, then detail) — environment;
//      a staged plate (stage-ref) leads them and replaces its source view
//   4. Second character angles (three-quarter.png)      — extra identity
//
// Overflow policy (user decision 2026-07-30): drop second character angles
// first, then extra location angles; storyboard plates are protected and
// dropped only if characters + plates alone exceed the budget.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { stagedPlate } from './staging.js';
import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import { getMaxReferenceImages } from 'venice-video-harness/core/series/types.js';
import {
  getCharacterDir,
  getLocationDir,
  getLocation,
  getStoryboardRefPath,
} from '../series/manager.js';

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
  const budget = getMaxReferenceImages(modelId);
  const dropped: string[] = [];

  const charNames = options.characterNames ?? shot.characters;
  const resolvedChars = charNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is SeriesState['characters'][number] => Boolean(c));

  // --- Tier 1: one primary angle per character ---
  // anchor.png outranks the generated sheets: it is a frame harvested from an
  // APPROVED render (harvest-anchor), so it shows the exact rendered identity
  // later units must match — the strongest anti-drift reference available.
  const primary: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const dir = getCharacterDir(series, char.name);
    const path = ['anchor.png', 'front.png', 'three-quarter.png']
      .map(f => join(dir, f))
      .find(p => existsSync(p));
    if (!path) continue;
    primary.push({
      kind: 'character-primary',
      path,
      label: char.name,
      roleClause: `is ${char.name} — use this reference for ${char.name}'s face, hair, and wardrobe`,
    });
  }

  // A staged plate (stage-ref) for the shot: see tier 3.
  const staged = stagedPlate(series, shot);

  // --- Tier 2: storyboard blocking plate (PROTECTED) ---
  // Not for a staged shot: the blocking plate was composed on the plate
  // before the edit, so it would bring back what the edit removed.
  const storyboard: CandidateSlot[] = [];
  if (shot.storyboardRef && staged) {
    dropped.push(`storyboard ref "${shot.storyboardRef}" (the shot's staging ref replaces it)`);
  } else if (shot.storyboardRef) {
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
  const location: CandidateSlot[] = [];
  // A staged plate (stage-ref) leads the location slots and the view it was
  // edited from is not sent: the original would bring back what the edit
  // removed (a boat the plate shows where the shot needs another one).
  const stagedLoc = shot.location ? getLocation(series, shot.location) : undefined;
  if (staged) {
    const where = stagedLoc
      ? `${stagedLoc.name}${staged.ref.replacesView ? `, the ${staged.ref.replacesView} view` : ''}, edited for this shot`
      : 'edited for this shot';
    location.push({
      kind: 'location',
      path: staged.path,
      label: stagedLoc?.slug ?? 'staging',
      roleClause: `is the view this shot is staged on, as it must look in this shot (${where}) — match its background, architecture, lighting and every vehicle and object in it exactly; where it differs from the location's description, this image is right; it is not a character`,
    });
  }
  if (shot.location) {
    const loc = getLocation(series, shot.location);
    if (loc) {
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
      const canonical = new Set([
        'north.png', 'south.png', 'east.png', 'west.png',
        'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
      ]);
      let customAngles: string[] = [];
      try {
        customAngles = readdirSync(dir)
          .filter(f =>
            /\.png$/i.test(f)
            && !canonical.has(f)
            && !f.includes('archive')
            && !f.includes('-pre-'))
          .sort();
      } catch {
        // No location dir — canonical loop below reports nothing either.
      }

      let angleCount = staged ? 1 : 0;
      const replaced = staged?.ref.replacesView ? `${staged.ref.replacesView}.png` : null;
      for (const f of [...order, ...customAngles]) {
        const p = join(dir, f);
        if (!existsSync(p) || f === replaced) continue;
        angleCount += 1;
        const customName = canonical.has(f) ? null : f.replace(/\.png$/i, '').replace(/-/g, ' ');
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
    }
  }

  // --- Tier 4: second character angles ---
  const charAngles: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const dir = getCharacterDir(series, char.name);
    const primaryPath = primary.find(s => s.label === char.name)?.path;
    const path = ['three-quarter.png', 'profile.png', 'full-body.png']
      .map(f => join(dir, f))
      .find(p => existsSync(p) && p !== primaryPath);
    if (!path) continue;
    charAngles.push({
      kind: 'character-angle',
      path,
      label: char.name,
      roleClause: `is a second angle of ${char.name} — same person as ${char.name}'s primary reference`,
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
