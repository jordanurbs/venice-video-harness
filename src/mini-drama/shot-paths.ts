// ---------------------------------------------------------------------------
// Canonical shot-id path builders.
//
// Failure mode this prevents: assembly scripts keyed file lookups by unpadded
// shot ids (`"3"`, `"3b"`, `"3c"`, `"4"`) while dialogue files on disk are
// zero-padded (`dialogue-shot-003.mp3`, `dialogue-shot-003b.mp3`). Every
// `existsSync` returned false silently, the for-loop continued past every
// iteration, and the master shipped with the relevant narration missing.
//
// Fix: every harness path that depends on a shot id goes through this
// module. Numeric ids are zero-padded to 3 digits; suffix letters
// ("b", "c") are preserved as-is.
//
// Anti-pattern: ad-hoc template literals like
//   `dialogue-shot-${id}.mp3`
// are forbidden in new code — they bypass the padding contract.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ShotId = number | string;

/**
 * A timeline placement map keyed by shot id. The string keys are the
 * zero-padded form produced by `shotKey()` — numeric portion padded to 3
 * digits, suffix letters preserved as-is.
 */
export type PlacementMap = Record<string, { startSec: number; endSec: number }>;

/**
 * canonical shot-id key. Numeric portions are zero-padded to 3
 * digits; suffix letters ("b", "c", ...) are preserved as-is.
 *
 *   shotKey(3)       -> "003"
 *   shotKey("3b")    -> "003b"
 *   shotKey("002c")  -> "002c"
 *   shotKey("intro") -> "intro"  (unrecognized — passed through)
 */
export function shotKey(id: ShotId): string {
  if (typeof id === 'number') return String(id).padStart(3, '0');
  const match = id.match(/^(\d+)([a-zA-Z]*)$/);
  if (match) return String(match[1]).padStart(3, '0') + match[2];
  return id;
}

/** Dialogue file path: `dialogueDir/dialogue-shot-<key>.mp3`. */
export function dialogueFileForShot(dialogueDir: string, id: ShotId): string {
  return join(dialogueDir, `dialogue-shot-${shotKey(id)}.mp3`);
}

/** Panel file path: `panelDir/shot-<key>.png`. */
export function panelFileForShot(panelDir: string, id: ShotId): string {
  return join(panelDir, `shot-${shotKey(id)}.png`);
}

/** Video file path: `videoDir/shot-<key>.mp4`. */
export function videoFileForShot(videoDir: string, id: ShotId): string {
  return join(videoDir, `shot-${shotKey(id)}.mp4`);
}

/**
 * place a list of narration cues into the timeline by shot id,
 * not by master timestamp. Returns the resolved placement records and an
 * array of warnings — when any cue can't be placed (file missing, shot id
 * not in the placement map), the warning is collected so the assembler
 * can surface it loudly.
 *
 * Centralizing this here means future bugs in dialogue placement only
 * have one place to be fixed.
 */
export interface NarrationCue {
  /** Shot id (number or suffix string). */
  shotId: ShotId;
  /** Human-readable label (e.g. "NARRATOR" / character name). */
  label?: string;
  /**
   * Override the dialogue file. Defaults to the canonical
   * `dialogueFileForShot(dialogueDir, shotId)`.
   */
  audioPath?: string;
  /** Optional offset within the shot's window. Defaults to 0. */
  startOffsetSec?: number;
}

export interface PlacedNarrationCue {
  shotId: ShotId;
  label?: string;
  audioPath: string;
  startSec: number;
  endSec: number;
}

export function placeNarrationCues(opts: {
  cues: NarrationCue[];
  placementMap: PlacementMap;
  dialogueDir: string;
}): { placements: PlacedNarrationCue[]; warnings: string[] } {
  const placements: PlacedNarrationCue[] = [];
  const warnings: string[] = [];

  for (const cue of opts.cues) {
    const key = shotKey(cue.shotId);
    const window = opts.placementMap[key];
    if (!window) {
      warnings.push(`narration: shot id ${key} not in placement map — skipping`);
      continue;
    }
    const audioPath = cue.audioPath ?? dialogueFileForShot(opts.dialogueDir, cue.shotId);
    if (!existsSync(audioPath)) {
      warnings.push(`narration: missing dialogue file ${audioPath} — skipping`);
      continue;
    }
    const startSec = window.startSec + (cue.startOffsetSec ?? 0);
    placements.push({
      shotId: cue.shotId,
      label: cue.label,
      audioPath,
      startSec,
      endSec: window.endSec,
    });
  }

  return { placements, warnings };
}

/**
 * Sanity assertion. After placing narration cues, callers should verify
 * that placements within a contiguous region have distinct startSec values.
 * Collapsing placements (e.g. N narrator beats collapsing to 0 actual
 * placements) typically indicates a fall-through in the placement loop —
 * see the module-level docstring.
 *
 * Returns the array of *suspect* groupings (key = startSec rounded to 2dp,
 * value = colliding cue keys) so the caller can decide whether to warn,
 * error, or log.
 */
export function findCollidingNarrationStarts(
  placements: PlacedNarrationCue[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const p of placements) {
    const k = p.startSec.toFixed(2);
    const list = grouped.get(k) ?? [];
    list.push(shotKey(p.shotId));
    grouped.set(k, list);
  }
  const collisions = new Map<string, string[]>();
  for (const [k, v] of grouped) {
    if (v.length > 1) collisions.set(k, v);
  }
  return collisions;
}
