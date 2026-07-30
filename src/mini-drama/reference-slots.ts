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
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { SeriesState, ShotScript } from '../series/types.js';
import { getMaxReferenceImages } from '../series/types.js';
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

const LOCATION_ANGLE_ORDER_DEFAULT = ['wide.png', 'medium.png', 'detail.png'];
const LOCATION_ANGLE_ORDER_CLOSER = ['medium.png', 'wide.png', 'detail.png'];

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
  const primary: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const dir = getCharacterDir(series, char.name);
    const path = ['front.png', 'three-quarter.png']
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
  const location: CandidateSlot[] = [];
  if (shot.location) {
    const loc = getLocation(series, shot.location);
    if (loc) {
      const dir = getLocationDir(series, loc.slug);
      const closer = shot.type === 'close-up' || shot.type === 'reaction' || shot.type === 'insert';
      const order = closer ? LOCATION_ANGLE_ORDER_CLOSER : LOCATION_ANGLE_ORDER_DEFAULT;
      const angleRole: Record<string, string> = {
        'wide.png': 'a wide angle of the location',
        'medium.png': 'a second angle of the same location',
        'detail.png': 'a third angle of the same location (detail)',
      };
      let angleCount = 0;
      for (const f of order) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        angleCount += 1;
        const anglePhrase = angleCount === 1
          ? `is the location environment reference (${loc.name}) — match its setting, architecture, and lighting; it is not a character`
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
