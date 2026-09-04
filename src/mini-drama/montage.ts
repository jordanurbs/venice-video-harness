// ---------------------------------------------------------------------------
// Montage-first generation (Seedance 2.5 branch, 2026-08-07)
//
// Seedance 2.5 renders up to 30 seconds in a single pass with up to 30 image
// references, which flips the harness default: instead of one generation per
// shot (or a 15s multi-shot bundle), a whole SCENE of consecutive beats
// renders as ONE "montage" generation prompted with a timestamped SEQUENCE
// beat list — the grammar demonstrated in the vault's "Make a full trailer
// with Seedance 2.5" prompt pack:
//
//   SHOT: "<scene intent>" — a 30-second fast-cut montage, cut it yourself
//   in the edit.
//   REFERENCES: @Image1 = THE DRIVER (wardrobe locked) ...
//   SEQUENCE:
//   [0:00-0:03] extreme wide, high and still — ...
//   [0:03-0:05] macro on the ignition — ...
//   STYLE: <one style token, pasted identical into every prompt>
//
// The four rules baked into every montage prompt (per the vault pack):
//   1. No music — diegetic sound only, described per beat; music is added
//      in the edit.
//   2. "Face stable throughout, no deformation." in every prompt.
//   3. @Image discipline — every reference is a named role; never cite an
//      image that is not attached.
//   4. Negative prompts stay short.
//
// After the render, `cutMontageIntoShots` slices the clip at the SAME beat
// timestamps that were written into the prompt (a single source of truth on
// GenerationUnit.montageBeats), producing per-shot clips that are:
//   - written next to the panels as canonical `shot-NNN.mp4` files, AND
//   - organized into the episode's media library at
//     `media-library/scene-NN/shot-NNN.mp4` (plus the uncut master),
// so a human or the Venice Video Creator can cut by hand when
// `videoDefaults.autoEdit` is off, while `assemble-episode` picks the same
// canonical files up automatically when auto-edit is on.
// ---------------------------------------------------------------------------

import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  EpisodeScript,
  GenerationPlan,
  GenerationUnit,
  GenerationUnitSegment,
  MontageBeat,
  SeriesState,
  ShotScript,
  VideoModelDefaults,
} from '../series/types.js';
import {
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
  resolveMontageModel,
} from '../series/types.js';
import { mustRenderAsExactLipSync, parseShotDuration } from './generation-planner.js';
import { shotKey } from './shot-paths.js';

// ---------------------------------------------------------------------------
// Scene grouping
// ---------------------------------------------------------------------------

/** A scene: consecutive shots sharing a location (or all untagged). */
export interface SceneGroup {
  sceneNumber: number;
  location?: string;
  shots: ShotScript[];
}

/**
 * Group an episode's shots into scenes. A scene is a maximal run of
 * consecutive shots with the same `location` tag. Untagged shots inherit the
 * running scene when they sit between same-location shots (a close-up the
 * script LLM forgot to tag), but an untagged shot after a location change
 * starts a new scene. This keeps the montage's single reference stack honest:
 * one blocking plate + one location's angles per generation (rule 21b).
 */
export function groupShotsIntoScenes(shots: ShotScript[]): SceneGroup[] {
  const scenes: SceneGroup[] = [];
  let current: SceneGroup | null = null;

  for (const shot of shots) {
    const loc = shot.location;
    const startsNewScene = !current
      || (loc !== undefined && current.location !== undefined && loc !== current.location)
      || (loc !== undefined && current.location === undefined);

    if (startsNewScene) {
      current = { sceneNumber: scenes.length + 1, location: loc, shots: [shot] };
      scenes.push(current);
      continue;
    }
    // Same location, or untagged shot continuing the current scene.
    if (current!.location === undefined && loc !== undefined) current!.location = loc;
    current!.shots.push(shot);
  }

  return scenes;
}

// ---------------------------------------------------------------------------
// Beat timing
// ---------------------------------------------------------------------------

/**
 * Lay a window of shots onto a montage timeline. Planned shot durations are
 * kept verbatim when they fit; when the window total exceeds the ceiling the
 * caller should have split it (see planMontageUnits) — this function only
 * rounds and enforces a 1s beat floor.
 */
export function layoutMontageBeats(shots: ShotScript[]): MontageBeat[] {
  const beats: MontageBeat[] = [];
  let cursor = 0;
  for (const shot of shots) {
    const dur = Math.max(1, parseShotDuration(shot.duration));
    beats.push({
      shotNumber: shot.shotNumber,
      startSec: cursor,
      endSec: cursor + dur,
    });
    cursor += dur;
  }
  return beats;
}

/** Format seconds as the vault pack's `M:SS` timestamp. */
export function formatBeatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Montage planning
// ---------------------------------------------------------------------------

function padShot(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * A shot the montage lane must NOT swallow: title cards / inserts render as
 * their own singles (they need exact framing, not montage energy), and
 * exact-lip-sync dialogue shots keep their dedicated pipeline. Everything
 * else — establishing, action, dialogue-on-native, reaction, close-up —
 * rides the montage.
 */
function shotBlocksMontage(shot: ShotScript, videoDefaults?: VideoModelDefaults): boolean {
  if (shot.mustStaySingle) return true;
  if (shot.type === 'insert') return true;
  if (/title card/i.test(shot.description)) return true;
  // Exact-lip-sync dialogue keeps its dedicated single-clip pipeline —
  // bundling it into a montage would drop the lip-sync entirely.
  if (mustRenderAsExactLipSync(shot, videoDefaults)) return true;
  return false;
}

/**
 * Split a scene's shots into montage windows under the duration ceiling.
 * Greedy fill: keep appending beats while the window total stays <= max.
 * A single shot longer than the ceiling is clamped to it with a warning
 * (Seedance 2.5 tops out at 30s).
 */
function splitSceneIntoWindows(shots: ShotScript[], maxSec: number): ShotScript[][] {
  const windows: ShotScript[][] = [];
  let window: ShotScript[] = [];
  let total = 0;
  for (const shot of shots) {
    const dur = Math.max(1, parseShotDuration(shot.duration));
    if (window.length > 0 && total + dur > maxSec) {
      windows.push(window);
      window = [];
      total = 0;
    }
    window.push(shot);
    total += dur;
  }
  if (window.length > 0) windows.push(window);
  return windows;
}

/**
 * Build a montage-first generation plan: each scene's consecutive
 * montage-eligible beats become ONE `montage` unit (up to the model ceiling,
 * default 30s on Seedance 2.5), carrying the timestamped beat map that both
 * the prompt's SEQUENCE block and the post-render cutter consume. Shots that
 * block the montage (inserts, title cards, forced singles) fall through as
 * `single` units via the fallback builder supplied by the caller.
 */
export function planMontageUnits(
  script: EpisodeScript,
  series: Pick<SeriesState, 'videoDefaults'>,
  buildSingleFallback: (shot: ShotScript, prev?: ShotScript, next?: ShotScript) => GenerationUnit,
): GenerationPlan {
  const videoDefaults: VideoModelDefaults | undefined = series.videoDefaults;
  const maxSec = resolveMontageMaxDurationSec(videoDefaults);
  const minSec = resolveMontageMinDurationSec(videoDefaults);
  const model = resolveMontageModel(videoDefaults);
  const units: GenerationUnit[] = [];
  const scenes = groupShotsIntoScenes(script.shots);

  for (const scene of scenes) {
    // Partition the scene into montage runs and blocking singles, keeping
    // script order.
    let run: ShotScript[] = [];

    const flushRun = () => {
      if (run.length === 0) return;
      for (const window of splitSceneIntoWindows(run, maxSec)) {
        const beats = layoutMontageBeats(window);
        const totalSec = beats[beats.length - 1].endSec;
        if (window.length === 1 && totalSec < minSec) {
          // Too short for the montage ladder — plain single.
          const shot = window[0];
          units.push(buildSingleFallback(shot));
          continue;
        }
        const clampedSec = Math.min(totalSec, maxSec);
        if (clampedSec !== totalSec) {
          console.warn(`  ⚠ Montage window exceeds ${maxSec}s; clamping to the model ceiling.`);
        }
        const first = window[0];
        const last = window[window.length - 1];
        units.push({
          unitId: `montage-s${String(scene.sceneNumber).padStart(2, '0')}-${padShot(first.shotNumber)}-${padShot(last.shotNumber)}`,
          unitType: 'montage',
          shotNumbers: window.map(s => s.shotNumber),
          outputFile: `montage-s${String(scene.sceneNumber).padStart(2, '0')}-${padShot(first.shotNumber)}-${padShot(last.shotNumber)}.mp4`,
          model,
          duration: `${Math.max(minSec, Math.round(clampedSec))}s`,
          startFrameStrategy: 'panel',
          endFrameStrategy: 'natural',
          decisionReasons: [
            `scene ${scene.sceneNumber}${scene.location ? ` (${scene.location})` : ''}: ${window.length}-beat single-pass montage on ${model}`,
            'timestamped SEQUENCE prompt (vault Seedance 2.5 trailer grammar); cut per-beat after render',
          ],
          fallbackToSingles: false,
          montageBeats: beats,
          sceneNumber: scene.sceneNumber,
        });
      }
      run = [];
    };

    for (const shot of scene.shots) {
      if (shotBlocksMontage(shot, videoDefaults)) {
        flushRun();
        units.push(buildSingleFallback(shot));
        continue;
      }
      run.push(shot);
    }
    flushRun();
  }

  return {
    episode: script.episode,
    generatedAt: new Date().toISOString(),
    units,
  };
}

// ---------------------------------------------------------------------------
// Post-render cutting + media library
// ---------------------------------------------------------------------------

function ffprobeDuration(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : 0;
}

function ffmpegCut(sourcePath: string, startSec: number, durationSec: number, outputPath: string): void {
  // Re-encode (not stream copy) so every cut is frame-accurate at the beat
  // boundary — a montage's whole point is that cuts land exactly where the
  // SEQUENCE block said they would. Same codec settings as the multi-shot
  // splitter so downstream concat never hits a mismatch.
  const r = spawnSync('ffmpeg', [
    '-y',
    '-ss', String(startSec),
    '-i', sourcePath,
    '-t', String(durationSec),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    outputPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg cut failed for ${outputPath}: ${r.stderr?.slice(-400)}`);
  }
}

export interface MontageCutResult {
  /** Canonical per-shot clips (`<sceneDir>/shot-NNN.mp4`), for the assembler. */
  shotPaths: string[];
  /** Media-library copies (`media-library/scene-NN/shot-NNN.mp4`). */
  libraryPaths: string[];
  segments: GenerationUnitSegment[];
}

/**
 * Cut a rendered montage at its planned beat boundaries.
 *
 * The beat map is scaled to the ACTUAL rendered duration (Seedance can come
 * back a hair short or long of the requested window) so the last beat never
 * runs off the end and the proportions the prompt asked for are preserved.
 *
 * Every shot is written twice:
 *   1. `<sceneDir>/shot-NNN.mp4` — the canonical path every downstream step
 *      (assemble-episode, subtitles, QA) already reads.
 *   2. `<episodeDir>/media-library/scene-NN/shot-NNN.mp4` — the organized
 *      library for hand editing / the Venice Video Creator, alongside the
 *      uncut montage master and a `manifest.json` describing each cut.
 */
export function cutMontageIntoShots(options: {
  montagePath: string;
  unit: GenerationUnit;
  shotsByNumber: Map<number, ShotScript>;
  sceneDir: string;
  episodeDir: string;
  archiveExisting: (path: string) => void;
}): MontageCutResult {
  const { montagePath, unit, shotsByNumber, sceneDir, episodeDir, archiveExisting } = options;
  const beats = unit.montageBeats ?? [];
  if (beats.length === 0) {
    throw new Error(`Montage unit ${unit.unitId} has no beat map — cannot cut.`);
  }

  const renderedSec = ffprobeDuration(montagePath);
  const plannedSec = beats[beats.length - 1].endSec;
  const scale = plannedSec > 0 && renderedSec > 0 ? renderedSec / plannedSec : 1;
  if (Math.abs(scale - 1) > 0.05) {
    console.warn(`  ⚠ ${unit.unitId}: rendered ${renderedSec.toFixed(2)}s vs planned ${plannedSec}s — scaling beat map by ${scale.toFixed(3)}.`);
  }

  const sceneNumber = unit.sceneNumber ?? 1;
  const libraryDir = join(episodeDir, 'media-library', `scene-${String(sceneNumber).padStart(2, '0')}`);
  mkdirSync(libraryDir, { recursive: true });

  const shotPaths: string[] = [];
  const libraryPaths: string[] = [];
  const segments: GenerationUnitSegment[] = [];

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const isLast = i === beats.length - 1;
    const start = beat.startSec * scale;
    const end = isLast ? renderedSec : beat.endSec * scale;
    const dur = Math.max(0.1, end - start);
    const key = shotKey(beat.shotNumber);

    const canonicalPath = join(sceneDir, `shot-${key}.mp4`);
    archiveExisting(canonicalPath);
    ffmpegCut(montagePath, start, dur, canonicalPath);
    shotPaths.push(canonicalPath);

    const libraryPath = join(libraryDir, `shot-${key}.mp4`);
    copyFileSync(canonicalPath, libraryPath);
    libraryPaths.push(libraryPath);

    segments.push({
      shotNumber: beat.shotNumber,
      startOffsetSec: Number(start.toFixed(3)),
      durationSec: Number(dur.toFixed(3)),
      outputFile: `shot-${key}.mp4`,
    });
  }

  // The uncut master rides along in the library so an editor can pull
  // alternate frames around the planned cut points.
  const masterLibraryPath = join(libraryDir, unit.outputFile);
  copyFileSync(montagePath, masterLibraryPath);

  const manifest = {
    unitId: unit.unitId,
    scene: sceneNumber,
    model: unit.model,
    master: unit.outputFile,
    renderedDurationSec: Number(renderedSec.toFixed(3)),
    plannedDurationSec: plannedSec,
    beatScale: Number(scale.toFixed(4)),
    cuts: segments.map(seg => {
      const shot = shotsByNumber.get(seg.shotNumber);
      return {
        shot: shotKey(seg.shotNumber),
        file: seg.outputFile,
        startSec: seg.startOffsetSec,
        durationSec: seg.durationSec,
        type: shot?.type,
        description: shot?.description,
      };
    }),
  };
  writeFileSync(join(libraryDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { shotPaths, libraryPaths, segments };
}
