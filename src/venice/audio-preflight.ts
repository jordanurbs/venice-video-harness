// ---------------------------------------------------------------------------
// Audio pre-flight helpers for Wan 2.7 (and any future model that constrains
// `audio_url` input duration).
//
// Wan 2.7's `audio_url` rejects clips shorter than 3 seconds with HTTP 400:
//   "audio_url: Audio duration is too short. Minimum is 3 seconds."
//
// POST /video/quote does NOT validate audio duration, so the error only
// surfaces at queue time. This module:
//
//   - probes audio duration via `ffprobe`
//   - throws `WanAudioTooShortError` when below a model's `minAudioInputSec`
//   - pads short clips with TRAILING silence via `ffmpeg apad`
//
// Trailing (not leading) silence is the right call:
// leading silence wastes the most-interesting visual portion on a held pose
// before the mouth moves. Trailing silence lets the model finish speech and
// idle (blinks, micro-motion) naturally.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getVideoModel } from './models.js';

const execFileAsync = promisify(execFile);

export class WanAudioTooShortError extends Error {
  readonly model: string;
  readonly audioPath: string;
  readonly durationSec: number;
  readonly minSec: number;

  constructor(info: { model: string; audioPath: string; durationSec: number; minSec: number }) {
    super(
      `[WanAudioTooShort] ${info.model} requires audio_url >= ${info.minSec}s, ` +
        `got ${info.durationSec.toFixed(3)}s (${info.audioPath}). ` +
        `Pad with trailing silence via padAudioForModel().`,
    );
    this.name = 'WanAudioTooShortError';
    this.model = info.model;
    this.audioPath = info.audioPath;
    this.durationSec = info.durationSec;
    this.minSec = info.minSec;
  }
}

/**
 * Probe an audio file's duration in seconds via ffprobe.
 *
 * Throws if ffprobe is not on PATH or the file cannot be read.
 */
export async function probeAudioDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`Could not parse ffprobe duration for ${audioPath} (got "${stdout.trim()}")`);
  }
  return seconds;
}

/**
 * Pad an audio file with TRAILING silence to exactly `targetSec` seconds.
 *
 * Writes the padded variant to `outPath`, leaving the source file untouched.
 * The caller decides where to put it — convention is `audio/dialogue-padded/`
 * so the original short clip remains usable for non-Wan placements.
 *
 * Pads to exactly `targetSec` (no slack). Less padding = less held-pose
 * visual time after the speech ends.
 */
export async function padAudioWithTrailingSilence(opts: {
  inputPath: string;
  outputPath: string;
  targetSec: number;
}): Promise<{ outputPath: string; paddedFromSec: number; toSec: number }> {
  const fromSec = await probeAudioDurationSec(opts.inputPath);
  if (fromSec >= opts.targetSec) {
    return { outputPath: opts.inputPath, paddedFromSec: fromSec, toSec: fromSec };
  }
  await mkdir(dirname(opts.outputPath), { recursive: true });
  // `apad=pad_dur=<delta>` appends `<delta>` seconds of silence; `-t targetSec`
  // is a belt-and-braces cap in case ffmpeg's apad rounding overshoots.
  const padDur = (opts.targetSec - fromSec).toFixed(3);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', opts.inputPath,
    '-af', `apad=pad_dur=${padDur}`,
    '-t', String(opts.targetSec),
    opts.outputPath,
  ]);
  return { outputPath: opts.outputPath, paddedFromSec: fromSec, toSec: opts.targetSec };
}

export interface PadAudioForModelOptions {
  /** Model id from the registry. `minAudioInputSec` drives the target. */
  model: string;
  /** Path to the source audio file. */
  audioPath: string;
  /**
   * Directory where padded variants land. Defaults to `<input dir>/padded/`.
   * The original file is never modified.
   */
  paddedDir?: string;
  /**
   * Override the target seconds. Defaults to the model's `minAudioInputSec`.
   */
  targetSec?: number;
}

/**
 * Ensure an audio file meets a model's minimum-duration requirement.
 *
 * - If the model has no `minAudioInputSec` or the clip already qualifies,
 *   returns the original path unmodified.
 * - Otherwise, pads with trailing silence and returns the padded path.
 *
 * Throws `WanAudioTooShortError` only if the model declares a minimum AND
 * padding is explicitly disabled (`paddedDir: null` is reserved for that
 * future variant; today we always pad rather than throw, because callers
 * have already paid for the TTS and want the render).
 */
export async function padAudioForModel(
  opts: PadAudioForModelOptions,
): Promise<{ outputPath: string; padded: boolean; durationSec: number }> {
  const spec = getVideoModel(opts.model);
  const minSec = opts.targetSec ?? spec?.minAudioInputSec;
  if (!minSec) {
    const durationSec = await probeAudioDurationSec(opts.audioPath);
    return { outputPath: opts.audioPath, padded: false, durationSec };
  }
  const fromSec = await probeAudioDurationSec(opts.audioPath);
  if (fromSec >= minSec) {
    return { outputPath: opts.audioPath, padded: false, durationSec: fromSec };
  }
  const dir = opts.paddedDir ?? join(dirname(opts.audioPath), 'padded');
  const baseName = basename(opts.audioPath);
  const outPath = join(dir, baseName);
  const { toSec } = await padAudioWithTrailingSilence({
    inputPath: opts.audioPath,
    outputPath: outPath,
    targetSec: minSec,
  });
  return { outputPath: outPath, padded: true, durationSec: toSec };
}

/**
 * Assert an audio file is long enough for a given model.
 *
 * Use this when callers want to reject short audio explicitly rather than
 * silently padding it.
 */
export async function assertAudioMeetsModelMin(opts: {
  model: string;
  audioPath: string;
}): Promise<void> {
  const spec = getVideoModel(opts.model);
  const minSec = spec?.minAudioInputSec;
  if (!minSec) return;
  const durationSec = await probeAudioDurationSec(opts.audioPath);
  if (durationSec < minSec) {
    throw new WanAudioTooShortError({
      model: opts.model,
      audioPath: opts.audioPath,
      durationSec,
      minSec,
    });
  }
}
