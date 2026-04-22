/**
 * EDL (Edit Decision List) authoring and validation.
 *
 * The EDL is a JSON document the LLM reads and mutates. This module
 * provides helpers that keep invariants tight: no negative durations,
 * every `sourceId` resolves, transition ms within ffmpeg's sensible
 * range, output settings present.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Edl, EdlClip, EdlTransition, Take } from './types.js';

export const DEFAULT_EDL_OUTPUT: Edl['output'] = {
  videoCodec: 'libx264',
  audioCodec: 'aac',
  crf: 18,
};

export const DEFAULT_AUDIO_FADE_MS = 30;
export const DEFAULT_TRANSITION_MS = 250;

export interface CreateEdlOptions {
  audioFadeMs?: number;
  output?: Partial<Edl['output']>;
}

export function createEmptyEdl(options: CreateEdlOptions = {}): Edl {
  return {
    clips: [],
    audioFadeMs: options.audioFadeMs ?? DEFAULT_AUDIO_FADE_MS,
    output: { ...DEFAULT_EDL_OUTPUT, ...(options.output ?? {}) },
  };
}

export interface EdlValidationError {
  clipIndex: number;
  message: string;
}

export function validateEdl(edl: Edl, takes: Take[]): EdlValidationError[] {
  const errors: EdlValidationError[] = [];
  const takeById = new Map(takes.map((t) => [t.id, t]));

  if (edl.clips.length === 0) {
    errors.push({ clipIndex: -1, message: 'EDL has no clips' });
    return errors;
  }

  if (edl.audioFadeMs < 0 || edl.audioFadeMs > 500) {
    errors.push({ clipIndex: -1, message: `audioFadeMs out of sensible range: ${edl.audioFadeMs}` });
  }

  edl.clips.forEach((clip, i) => {
    const take = takeById.get(clip.sourceId);
    if (!take) {
      errors.push({ clipIndex: i, message: `Unknown sourceId: ${clip.sourceId}` });
      return;
    }
    if (!(clip.endSec > clip.startSec)) {
      errors.push({
        clipIndex: i,
        message: `endSec (${clip.endSec}) must be greater than startSec (${clip.startSec})`,
      });
    }
    if (clip.startSec < 0) {
      errors.push({ clipIndex: i, message: `startSec cannot be negative: ${clip.startSec}` });
    }
    if (clip.endSec > take.durationSec + 0.05) {
      errors.push({
        clipIndex: i,
        message: `endSec (${clip.endSec}) exceeds source duration (${take.durationSec})`,
      });
    }
    if (clip.transitionIn && clip.transitionIn !== 'cut' && (clip.transitionMs ?? 0) <= 0) {
      errors.push({
        clipIndex: i,
        message: `transitionIn=${clip.transitionIn} requires positive transitionMs`,
      });
    }
    if ((clip.trimStartMs ?? 0) < 0 || (clip.trimEndMs ?? 0) < 0) {
      errors.push({ clipIndex: i, message: 'trimStartMs / trimEndMs cannot be negative' });
    }
  });

  return errors;
}

/** Effective clip duration in seconds after applying trimStart/trimEnd. */
export function effectiveDurationSec(clip: EdlClip): number {
  const base = clip.endSec - clip.startSec;
  const trim = ((clip.trimStartMs ?? 0) + (clip.trimEndMs ?? 0)) / 1000;
  return Math.max(0, base - trim);
}

/** Sum of clip durations minus crossfade overlaps. */
export function estimateOutputDurationSec(edl: Edl): number {
  let total = 0;
  edl.clips.forEach((clip, i) => {
    total += effectiveDurationSec(clip);
    if (i > 0 && clip.transitionIn && clip.transitionIn !== 'cut') {
      total -= (clip.transitionMs ?? DEFAULT_TRANSITION_MS) / 1000;
    }
  });
  return Math.max(0, total);
}

export interface AddClipInput {
  sourceId: string;
  startSec: number;
  endSec: number;
  trimStartMs?: number;
  trimEndMs?: number;
  transitionIn?: EdlTransition;
  transitionMs?: number;
  rationale?: string;
}

export function addClip(edl: Edl, input: AddClipInput): void {
  const clip: EdlClip = {
    sourceId: input.sourceId,
    startSec: input.startSec,
    endSec: input.endSec,
    trimStartMs: input.trimStartMs,
    trimEndMs: input.trimEndMs,
    transitionIn: input.transitionIn ?? 'cut',
    transitionMs:
      input.transitionIn && input.transitionIn !== 'cut'
        ? input.transitionMs ?? DEFAULT_TRANSITION_MS
        : undefined,
    rationale: input.rationale,
  };
  edl.clips.push(clip);
}

/**
 * Insert a crossfade at a cut boundary (between clip `i - 1` and `i`).
 * Used by the cut-qa agent's `insert-crossfade` fix.
 */
export function insertCrossfade(
  edl: Edl,
  clipIndex: number,
  transitionMs: number = 200,
): void {
  if (clipIndex <= 0 || clipIndex >= edl.clips.length) {
    throw new Error(`insertCrossfade: clipIndex ${clipIndex} out of range`);
  }
  const clip = edl.clips[clipIndex];
  clip.transitionIn = 'crossfade';
  clip.transitionMs = transitionMs;
}

export function readEdl(path: string): Edl {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`EDL at ${path} is not an object`);
  }
  if (!Array.isArray(parsed.clips)) {
    throw new Error(`EDL at ${path} is missing a 'clips' array`);
  }
  const edl: Edl = {
    clips: parsed.clips,
    audioFadeMs: parsed.audioFadeMs ?? DEFAULT_AUDIO_FADE_MS,
    colorGrade: parsed.colorGrade,
    output: { ...DEFAULT_EDL_OUTPUT, ...(parsed.output ?? {}) },
  };
  return edl;
}

export function writeEdl(edl: Edl, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(edl, null, 2), 'utf-8');
}
