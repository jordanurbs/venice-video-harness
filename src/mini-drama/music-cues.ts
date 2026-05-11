// ---------------------------------------------------------------------------
// Per-act music cues with ffmpeg crossfades.
//
// Replaces the assembler's single-static-bed model with an ordered list of
// cues, each anchored to a shot id. Cues crossfade at their configured fade
// points so beats can change with the story: bed → ominous → bed → climactic.
//
// Per-shot musicHold (sustain / swell / drop / stinger) layers automation on
// top of the cue: volume ramps, sidechain ducks, transient stingers.
//
// This module is pure orchestration — it shells ffmpeg via execFile but does
// not know how to call Venice. Cue audio is either supplied via
// `cue.audioPath` or rendered separately and the path threaded in by the
// caller (see the music-cue reference scripts).
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { MusicCueSpec, ShotScript } from '../series/types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GAIN_DB = -22;
const DEFAULT_FADE_IN = 1.0;
const DEFAULT_FADE_OUT = 1.5;

/** A cue annotated with its resolved timeline window. */
export interface ResolvedMusicCue {
  spec: MusicCueSpec;
  /** Source audio file, after generation / passthrough. */
  audioPath: string;
  startSec: number;
  endSec: number;
}

export interface PlacementMap {
  /** Shot id (string, zero-padded for numeric shots like "003" / "003b"). */
  [shotId: string]: { startSec: number; endSec: number };
}

/** Normalize a shot id (number or string) to a string key. */
export function shotIdKey(id: number | string): string {
  if (typeof id === 'number') return String(id).padStart(3, '0');
  // Suffixed forms like "3b" -> "003b". Suffix letters preserved as-is.
  const match = id.match(/^(\d+)([a-zA-Z]*)$/);
  if (match) return String(match[1]).padStart(3, '0') + match[2];
  return id;
}

/**
 * Resolve a cue's timeline window from the placement map.
 * Returns null when the start or end shot can't be found — callers should
 * warn and skip the cue rather than emit a misaligned cue.
 */
export function resolveCueWindow(
  cue: MusicCueSpec,
  placementMap: PlacementMap,
): { startSec: number; endSec: number } | null {
  const startKey = shotIdKey(cue.startShot);
  const endKey = shotIdKey(cue.endShot);
  const start = placementMap[startKey];
  const end = placementMap[endKey];
  if (!start || !end) return null;
  return { startSec: start.startSec, endSec: end.endSec };
}

/**
 * Assemble a list of resolved cues into a single MP3 track with crossfades.
 *
 * For each cue:
 *   - trim/pad to the resolved window length,
 *   - apply gain and fade-in / fade-out,
 *   - acrossfade with the previous track at the trailing fade point.
 *
 * The output sample rate is fixed at 48000 Hz / stereo for compatibility
 * with the assembler's final aac encode.
 */
export async function renderMusicCuesTrack(opts: {
  cues: ResolvedMusicCue[];
  outputPath: string;
  totalDurationSec: number;
}): Promise<string> {
  if (opts.cues.length === 0) {
    throw new Error('renderMusicCuesTrack: at least one cue is required');
  }
  await mkdir(dirname(opts.outputPath), { recursive: true });

  // For a single cue, just gain + fade + write.
  if (opts.cues.length === 1) {
    const cue = opts.cues[0];
    const dur = cue.endSec - cue.startSec;
    const gain = cue.spec.gain ?? DEFAULT_GAIN_DB;
    const fadeIn = cue.spec.fadeIn ?? DEFAULT_FADE_IN;
    const fadeOut = cue.spec.fadeOut ?? DEFAULT_FADE_OUT;
    const filter = [
      `volume=${gain}dB`,
      `afade=t=in:st=0:d=${fadeIn}`,
      `afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`,
    ].join(',');
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', cue.audioPath,
      '-af', filter,
      '-t', String(dur),
      '-ar', '48000',
      '-ac', '2',
      opts.outputPath,
    ]);
    return opts.outputPath;
  }

  // Multi-cue path: build a concat-with-crossfade filter graph.
  const inputs: string[] = [];
  for (const cue of opts.cues) {
    inputs.push('-i', cue.audioPath);
  }

  // Build per-input filter chains, then chain acrossfade between them.
  const filterParts: string[] = [];
  for (let i = 0; i < opts.cues.length; i++) {
    const cue = opts.cues[i];
    const dur = cue.endSec - cue.startSec;
    const gain = cue.spec.gain ?? DEFAULT_GAIN_DB;
    const fadeIn = cue.spec.fadeIn ?? DEFAULT_FADE_IN;
    // Trim/pad to window length, apply gain. Inner fade-in only — the
    // crossfade handles outgoing edges. The very first cue gets a fade-in,
    // the very last cue gets a fade-out.
    const chain: string[] = [`atrim=0:${dur}`, `asetpts=N/SR/TB`, `volume=${gain}dB`];
    if (i === 0) chain.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (i === opts.cues.length - 1) {
      const fadeOut = cue.spec.fadeOut ?? DEFAULT_FADE_OUT;
      chain.push(`afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`);
    }
    filterParts.push(`[${i}:a]${chain.join(',')}[a${i}]`);
  }

  // Chain acrossfade: [a0][a1]acrossfade=d=X[ax1]; [ax1][a2]acrossfade=d=Y[ax2]; ...
  let prevLabel = '[a0]';
  for (let i = 1; i < opts.cues.length; i++) {
    // Crossfade duration is the min of the trailing fadeOut on the previous
    // cue and the leading fadeIn on the next cue — this is the overlap region
    // both cues already attenuate.
    const prev = opts.cues[i - 1].spec;
    const next = opts.cues[i].spec;
    const xfade = Math.min(
      prev.fadeOut ?? DEFAULT_FADE_OUT,
      next.fadeIn ?? DEFAULT_FADE_IN,
    );
    const outLabel = i === opts.cues.length - 1 ? '[aout]' : `[ax${i}]`;
    filterParts.push(`${prevLabel}[a${i}]acrossfade=d=${xfade.toFixed(3)}:c1=tri:c2=tri${outLabel}`);
    prevLabel = outLabel;
  }

  await execFileAsync('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-ar', '48000',
    '-ac', '2',
    opts.outputPath,
  ]);
  return opts.outputPath;
}

/**
 * derive a per-shot volume curve for music automation.
 *
 * Combines `shot.musicHold` with the containing cue's `musicHold` and
 * returns an ffmpeg `volume=` expression suitable for layering over the
 * already-rendered cues track. Returns `null` when no automation is needed
 * (everything is sustain).
 *
 * The expression evaluates `t` (timeline seconds) and produces a multiplier
 * in [0, 4] — 1.0 is unity, sub-1 ducks, super-1 swells.
 *
 *   stinger: 0.4s pulse +6 dB at the start of the shot, return to 1.0
 *   swell:   linear ramp from 1.0 to 1.58 (+4 dB) across the shot
 *   drop:    constant 0.001 (≈ -60 dB) for the shot's duration
 *   sustain: no change
 */
export function buildMusicHoldExpr(
  shots: ShotScript[],
  placementMap: PlacementMap,
): string | null {
  const pieces: string[] = [];
  for (const shot of shots) {
    const hold = shot.musicHold;
    if (!hold || hold === 'sustain') continue;
    const placement = placementMap[shotIdKey(shot.shotNumber)];
    if (!placement) continue;
    const { startSec, endSec } = placement;
    if (hold === 'stinger') {
      pieces.push(`if(between(t,${startSec.toFixed(3)},${(startSec + 0.4).toFixed(3)}),2.0,`);
      pieces.push(')'); // close the if — placeholder; we wrap below.
    } else if (hold === 'swell') {
      // 1.0 -> 1.58 across the shot
      pieces.push(
        `if(between(t,${startSec.toFixed(3)},${endSec.toFixed(3)}),` +
        `1.0+(0.58*(t-${startSec.toFixed(3)})/${(endSec - startSec).toFixed(3)}),`,
      );
      pieces.push(')');
    } else if (hold === 'drop') {
      pieces.push(`if(between(t,${startSec.toFixed(3)},${endSec.toFixed(3)}),0.001,`);
      pieces.push(')');
    }
  }
  if (pieces.length === 0) return null;
  // Nest the if-expressions with `1` (sustain) as the innermost else.
  const opens = pieces.filter(p => p !== ')');
  const closes = pieces.filter(p => p === ')').length;
  return opens.join('') + '1' + ')'.repeat(closes);
}

/**
 * Apply a `volume=` expression to an existing music track and emit a new file.
 * Use this AFTER `renderMusicCuesTrack` to layer `musicHold` automation
 * without re-rendering the full filter graph.
 */
export async function applyMusicHoldAutomation(opts: {
  inputPath: string;
  outputPath: string;
  volumeExpr: string;
}): Promise<string> {
  if (!existsSync(opts.inputPath)) {
    throw new Error(`applyMusicHoldAutomation: input not found at ${opts.inputPath}`);
  }
  await mkdir(dirname(opts.outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', opts.inputPath,
    '-af', `volume=${opts.volumeExpr}:eval=frame`,
    '-ar', '48000',
    '-ac', '2',
    opts.outputPath,
  ]);
  return opts.outputPath;
}

/**
 * Convenience: convert a flat list of cue specs into resolved cues by
 * looking up each in the placement map. Cues whose start or end shot
 * cannot be resolved are skipped (with a console.warn) — they were
 * scripted but the placement map doesn't have the shot yet, e.g. because
 * the shot is out of range or was removed.
 */
export function resolveMusicCues(
  specs: MusicCueSpec[],
  placementMap: PlacementMap,
  audioPathFor: (spec: MusicCueSpec) => string | undefined,
): ResolvedMusicCue[] {
  const out: ResolvedMusicCue[] = [];
  for (const spec of specs) {
    const window = resolveCueWindow(spec, placementMap);
    if (!window) {
      console.warn(`  music-cue: skipping cue ${shotIdKey(spec.startShot)}->${shotIdKey(spec.endShot)} — shot ids not in placement map`);
      continue;
    }
    const audioPath = spec.audioPath ?? audioPathFor(spec);
    if (!audioPath || !existsSync(audioPath)) {
      console.warn(`  music-cue: skipping cue ${shotIdKey(spec.startShot)}->${shotIdKey(spec.endShot)} — audio file missing`);
      continue;
    }
    out.push({ spec, audioPath, startSec: window.startSec, endSec: window.endSec });
  }
  return out;
}
