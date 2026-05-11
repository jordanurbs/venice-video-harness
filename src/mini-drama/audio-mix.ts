// ---------------------------------------------------------------------------
// Shared audio-mix helpers.
//
// SFX trim + fade — trims every raw SFX clip to a max duration and applies
// a short fade-out, so fire crackle doesn't bleed across cuts and panic
// shouts don't overlap dialogue.
//
// Loudness normalization — final pass targeting -16 LUFS integrated /
// true-peak ≤ -1 dBTP. Applied as the last step of the final encode so all
// upstream gain decisions are consistent.
//
// The assembler module consumes these via its `audioMix` options. Standalone
// scripts can call the helpers directly.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AudioMixDefaults } from '../series/types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_SFX_MAX_DURATION_SEC = 2.0;
export const DEFAULT_SFX_FADE_OUT_SEC = 0.3;
export const DEFAULT_DIALOGUE_GAIN_DB = 0;
export const DEFAULT_MUSIC_GAIN_DB = -22;
export const DEFAULT_SFX_GAIN_DB = -16;
export const DEFAULT_LUFS_TARGET = -16;
export const DEFAULT_TRUE_PEAK_DB = -1;

/** Resolve a partial audio-mix config to a fully populated one. */
export function resolveAudioMix(defaults?: AudioMixDefaults): Required<AudioMixDefaults> {
  return {
    sfxMaxDurationSec: defaults?.sfxMaxDurationSec ?? DEFAULT_SFX_MAX_DURATION_SEC,
    sfxFadeOutSec: defaults?.sfxFadeOutSec ?? DEFAULT_SFX_FADE_OUT_SEC,
    dialogueGainDb: defaults?.dialogueGainDb ?? DEFAULT_DIALOGUE_GAIN_DB,
    musicGainDb: defaults?.musicGainDb ?? DEFAULT_MUSIC_GAIN_DB,
    sfxGainDb: defaults?.sfxGainDb ?? DEFAULT_SFX_GAIN_DB,
    lufsTarget: defaults?.lufsTarget ?? DEFAULT_LUFS_TARGET,
    truePeakDb: defaults?.truePeakDb ?? DEFAULT_TRUE_PEAK_DB,
  };
}

export interface SfxTrimOptions {
  /** Override the global max duration for this specific clip (e.g. ambient SFX). */
  maxDurationSec?: number;
  /** Override the fade-out duration for this clip. */
  fadeOutSec?: number;
}

/**
 * Trim a single SFX clip and apply a fade-out.
 *
 * Raw SFX clips from elevenlabs-sound-effects-v2 are 3-6 seconds long.
 * Without trimming, fire crackle bleeds across cuts and panic shouts overlap
 * dialogue. The fade-out is short (0.3s) — long enough to avoid a click,
 * short enough to keep the SFX feeling punchy.
 */
export async function trimAndFadeSfx(opts: {
  inputPath: string;
  outputPath: string;
  options?: SfxTrimOptions;
  globalDefaults?: AudioMixDefaults;
}): Promise<string> {
  const global = resolveAudioMix(opts.globalDefaults);
  const maxDur = opts.options?.maxDurationSec ?? global.sfxMaxDurationSec;
  const fadeOut = opts.options?.fadeOutSec ?? global.sfxFadeOutSec;

  await mkdir(dirname(opts.outputPath), { recursive: true });
  const fadeStart = Math.max(0, maxDur - fadeOut);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', opts.inputPath,
    '-af', `atrim=0:${maxDur},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`,
    '-ar', '48000',
    '-ac', '2',
    opts.outputPath,
  ]);
  return opts.outputPath;
}

/**
 * Apply trim+fade to every SFX clip in a directory.
 *
 * - The output directory mirrors the input layout.
 * - Per-clip overrides can be supplied via the `perFile` map keyed on the
 *   clip basename (e.g. `"fire-crackle.mp3"`) — useful for ambient SFX that
 *   need a longer max duration than the global default.
 * - Returns the list of output paths in input order.
 */
export async function trimAndFadeSfxBatch(opts: {
  inputPaths: string[];
  outputDir: string;
  perFile?: Record<string, SfxTrimOptions>;
  globalDefaults?: AudioMixDefaults;
}): Promise<string[]> {
  await mkdir(opts.outputDir, { recursive: true });
  const outPaths: string[] = [];
  for (const inputPath of opts.inputPaths) {
    if (!existsSync(inputPath)) {
      console.warn(`  SFX trim: skipping missing file ${inputPath}`);
      continue;
    }
    const filename = basename(inputPath);
    const outputPath = join(opts.outputDir, filename);
    await trimAndFadeSfx({
      inputPath,
      outputPath,
      options: opts.perFile?.[filename],
      globalDefaults: opts.globalDefaults,
    });
    outPaths.push(outputPath);
  }
  return outPaths;
}

/**
 * Final loudness normalization to a target integrated LUFS and true-peak
 * ceiling. Uses ffmpeg's `loudnorm` filter (EBU R128 implementation).
 *
 * Two-pass loudnorm is more accurate but the single-pass form is fine for
 * a final delivery encode — the input is already at a reasonable level
 * after upstream gain decisions, and `loudnorm` will only nudge the
 * envelope, not crush it.
 */
export async function loudnessNormalize(opts: {
  inputPath: string;
  outputPath: string;
  audioMix?: AudioMixDefaults;
  /**
   * When the input is a video file, set this to copy the video stream
   * instead of re-encoding it. Defaults to false (input treated as audio).
   */
  videoInput?: boolean;
}): Promise<string> {
  const mix = resolveAudioMix(opts.audioMix);
  await mkdir(dirname(opts.outputPath), { recursive: true });
  const loudFilter = `loudnorm=I=${mix.lufsTarget}:TP=${mix.truePeakDb}:LRA=11`;
  const args = ['-y', '-i', opts.inputPath];
  if (opts.videoInput) {
    args.push('-c:v', 'copy', '-af', loudFilter, '-c:a', 'aac');
  } else {
    args.push('-af', loudFilter, '-ar', '48000', '-ac', '2');
  }
  args.push(opts.outputPath);
  await execFileAsync('ffmpeg', args);
  return opts.outputPath;
}
