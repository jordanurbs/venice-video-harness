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
// GenerationUnit.montageBeats), each snapped to the scene cut detected near
// it, producing per-shot clips that are:
//   - written next to the panels as canonical `shot-NNN.mp4` files, AND
//   - organized into the episode's media library at
//     `media-library/scene-NN/shot-NNN.mp4` (plus the uncut master),
// so a human or the Venice Video Creator can cut by hand when
// `videoDefaults.autoEdit` is off, while `assemble-episode` picks the same
// canonical files up automatically when auto-edit is on.
//
// Since 2026-10-25 the default prompt is a shot list instead
// (`videoDefaults.montageGrammar: 'shots'`, see `buildMontagePrompt`):
//
//   One continuous scene in 4 connected shots, in story order, moving through <A>, then <B>. ...
//   References, in the order they first appear: @Image1 is ANNA — ...
//   Shot 1 | 0-5s | <A> (@Image3): <camera>. <action> Blocking: ... Sound: ...
//   Cut to Shot 2 | 5-9s | <A> (@Image4): ...
//   Every cut is an abrupt single-frame hard cut: the two images never blend.
//
// and a scene may cross places when its shots are joined by
// `continuity.from: 'continuous'`, so one action (onto a tram at the stop,
// then the ride inside it) stays one generation and the vehicle, the props
// and the facing carry across the cuts. In a 31-render continuity bakeoff
// (Seedance 2.5 R2V, 720p), one generation kept a recurring vehicle the same
// in 3 of 3 takes; separate per-shot generations swapped it in 4 of 4.
// `montageGrammar: 'sequence'` brings back the SEQUENCE grammar together
// with its grouping (one location per generation) and references.
// ---------------------------------------------------------------------------

import { mkdirSync, copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
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
} from 'venice-video-harness/core/series/types.js';
import {
  resolveMontageGrammar,
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
  resolveMontageModel,
} from 'venice-video-harness/core/series/types.js';
import { mustRenderAsExactLipSync, parseShotDuration } from './generation-planner.js';
import { shotKey } from './shot-paths.js';

// ---------------------------------------------------------------------------
// Scene grouping
// ---------------------------------------------------------------------------

/** A scene: consecutive shots one generation can carry. */
export interface SceneGroup {
  sceneNumber: number;
  /** The first location tag in the scene. */
  location?: string;
  /** Every location the scene passes through, in order (one, unless a continuous run crosses places). */
  locations: string[];
  shots: ShotScript[];
}

export interface SceneGroupingOptions {
  /**
   * Read each shot's `continuity` (default `true`, the shot-list grammar). Set
   * `false` for the SEQUENCE grammar: scenes then split on every change of
   * location and nothing else, the rule from before `continuity` existed.
   */
  continuity?: boolean;
}

/**
 * Group an episode's shots into scenes, the runs a single montage generation
 * may carry.
 *
 * - A shot whose `continuity.from` is `continuous` stays in the scene even
 *   when its location changes. That keeps one action across places (onto a
 *   tram at the stop, then the ride inside it) in one
 *   generation, so the vehicle, the props and the facing carry across the
 *   cuts. In a 31-render continuity bakeoff, one generation kept the vehicle
 *   the same in 3 of 3 takes; separate generations swapped it in 4 of 4.
 * - `new-scene` always starts a scene.
 * - Otherwise (`later`, or no continuity) a change of location starts a scene,
 *   as it always did, so scripts without `continuity` group as before.
 *
 * Untagged shots inherit the running scene when they sit between
 * same-location shots (a close-up the script LLM forgot to tag), but an
 * untagged shot after a location change starts a new scene.
 *
 * With `{ continuity: false }` (the SEQUENCE grammar) a scene is a maximal
 * run of shots with the same `location` tag: one blocking plate and one
 * location's angles per generation (rule 21b).
 */
export function groupShotsIntoScenes(shots: ShotScript[], options: SceneGroupingOptions = {}): SceneGroup[] {
  const readContinuity = options.continuity ?? true;
  const scenes: SceneGroup[] = [];
  let current: SceneGroup | null = null;

  for (const shot of shots) {
    const loc = shot.location;
    const from = readContinuity ? shot.continuity?.from : undefined;
    const open = current as SceneGroup | null;
    const lastLocation = open ? open.locations[open.locations.length - 1] : undefined;
    const startsNewScene = !open
      || from === 'new-scene'
      || (from !== 'continuous' && (
        (loc !== undefined && lastLocation !== undefined && loc !== lastLocation)
        || (loc !== undefined && open.location === undefined)
      ));

    if (startsNewScene) {
      current = { sceneNumber: scenes.length + 1, location: loc, locations: loc ? [loc] : [], shots: [shot] };
      scenes.push(current);
      continue;
    }
    // Same location, an untagged shot continuing the scene, or a continuous move to another place.
    if (current!.location === undefined && loc !== undefined) current!.location = loc;
    if (loc !== undefined && current!.locations[current!.locations.length - 1] !== loc) current!.locations.push(loc);
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
      ...(shot.shotIdSuffix ? { shotIdSuffix: shot.shotIdSuffix } : {}),
      startSec: cursor,
      endSec: cursor + dur,
    });
    cursor += dur;
  }
  return beats;
}

/** A beat's shot id: its number, with a suffixed insert's suffix ("13b"). */
function montageBeatShotId(beat: Pick<MontageBeat, 'shotNumber' | 'shotIdSuffix'>): number | string {
  return beat.shotIdSuffix ? `${beat.shotNumber}${beat.shotIdSuffix}` : beat.shotNumber;
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
 * rides the montage. With the shot-list grammar, an insert that continues
 * the action (`continuity.from: 'continuous'`: the hands, the umbrella in
 * them) rides in its run too, so the prop and the light carry across the
 * cut.
 */
function shotBlocksMontage(shot: ShotScript, videoDefaults: VideoModelDefaults | undefined, readContinuity: boolean): boolean {
  // A staging ref (stage-ref) belongs to its shot alone: only a single sends it.
  if (shot.mustStaySingle || shot.stagingRef) return true;
  if (shot.type === 'insert' && !(readContinuity && shot.continuity?.from === 'continuous')) return true;
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
 * the prompt and the post-render cutter consume. Shots that block the
 * montage (inserts, title cards, forced singles) fall through as `single`
 * units via the fallback builder supplied by the caller.
 *
 * The grammar sets the grouping: the shot list (default) reads `continuity`,
 * so a continuous run stays one unit across places; the SEQUENCE fallback
 * splits on every change of location, as it always did.
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
  const shotList = resolveMontageGrammar(videoDefaults) === 'shots';
  const units: GenerationUnit[] = [];
  const scenes = groupShotsIntoScenes(script.shots, { continuity: shotList });

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
        const places = window
          .map(s => s.location)
          .filter((loc, i, all): loc is string => Boolean(loc) && all[i - 1] !== loc);
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
            `scene ${scene.sceneNumber}${places.length ? ` (${places.join(' → ')})` : ''}: ${window.length}-beat single-pass montage on ${model}`,
            ...(new Set(places).size > 1
              ? ['one continuous run across places (continuity: continuous): one generation keeps the vehicle, props and facing across the cuts']
              : []),
            shotList
              ? 'shot-list prompt ("Shot N | a-bs | place"); cut at the detected cuts after render'
              : 'timestamped SEQUENCE prompt (vault Seedance 2.5 trailer grammar); cut per-beat after render',
          ],
          fallbackToSingles: false,
          montageBeats: beats,
          sceneNumber: scene.sceneNumber,
        });
      }
      run = [];
    };

    for (const shot of scene.shots) {
      if (shotBlocksMontage(shot, videoDefaults, shotList)) {
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

interface VideoProbe {
  fps: number;
  /** Frames in the first video stream. */
  frames: number;
  hasAudio: boolean;
}

function parseRate(rate: unknown): number {
  const [num, den] = String(rate ?? '').split('/').map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** A video's frame rate and frame count, and whether it has audio. Null when it has no video stream. */
function probeVideo(path: string): VideoProbe | null {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,avg_frame_rate,r_frame_rate,nb_frames,duration', '-of', 'json', path,
  ], { encoding: 'utf-8' });
  let streams: Array<Record<string, unknown>> = [];
  try {
    streams = (JSON.parse(r.stdout || '{}') as { streams?: Array<Record<string, unknown>> }).streams ?? [];
  } catch {
    return null;
  }
  const video = streams.find(s => s.codec_type === 'video');
  if (!video) return null;
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 24;
  const counted = Number(video.nb_frames);
  const durationSec = Number(video.duration) || ffprobeDuration(path);
  const frames = Number.isInteger(counted) && counted > 0 ? counted : Math.round(durationSec * fps);
  return { fps, frames, hasAudio: streams.some(s => s.codec_type === 'audio') };
}

interface ClipCut {
  fps: number;
  /** The clip's first frame and the frame after its last, in the master. */
  startFrame: number;
  endFrame: number;
  /** The last clip runs to the end of the master, audio included. */
  toEnd: boolean;
  hasAudio: boolean;
  /** Show a copy of the neighbouring frame in place of the first / last one (video only; the clip keeps its length). */
  holdFirst: boolean;
  holdLast: boolean;
}

function ffmpegCut(sourcePath: string, outputPath: string, cut: ClipCut): void {
  // Re-encode (not stream copy) so every cut is frame-accurate at the beat
  // boundary — a montage's whole point is that each clip holds exactly the
  // shot the prompt put there. Same codec settings as the multi-shot
  // splitter so downstream concat never hits a mismatch.
  //
  // Seek to half a frame before a frame about a second ahead of the cut, so
  // decoding starts on a known frame, then cut video by frame number and
  // audio at the same instants: neighbouring clips share their boundary, so
  // a cut loses no audio and no frame.
  const lead = Math.max(0, cut.startFrame - Math.round(cut.fps));
  const seekSec = lead > 0 ? (lead - 0.5) / cut.fps : 0;
  const first = cut.startFrame - lead;
  const frames = cut.endFrame - cut.startFrame;
  const holdFirst = cut.holdFirst && frames >= 3;
  const holdLast = cut.holdLast && frames >= 3;
  const video = [
    `trim=start_frame=${first + (holdFirst ? 1 : 0)}${cut.toEnd ? '' : `:end_frame=${first + frames - (holdLast ? 1 : 0)}`}`,
    'setpts=PTS-STARTPTS',
    ...(holdFirst || holdLast ? [`tpad=start=${holdFirst ? 1 : 0}:start_mode=clone:stop=${holdLast ? 1 : 0}:stop_mode=clone`] : []),
  ].join(',');
  const audioStart = (cut.startFrame / cut.fps - seekSec).toFixed(6);
  const audioEnd = (cut.endFrame / cut.fps - seekSec).toFixed(6);
  const audio = `atrim=start=${audioStart}${cut.toEnd ? '' : `:end=${audioEnd}`},asetpts=PTS-STARTPTS`;
  const r = spawnSync('ffmpeg', [
    '-y',
    ...(seekSec > 0 ? ['-ss', seekSec.toFixed(6)] : []),
    '-i', sourcePath,
    '-filter_complex', cut.hasAudio ? `[0:v]${video}[v];[0:a]${audio}[a]` : `[0:v]${video}[v]`,
    '-map', '[v]', ...(cut.hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    ...(cut.hasAudio ? ['-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k'] : []),
    outputPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg cut failed for ${outputPath}: ${r.stderr?.slice(-400)}`);
  }
  const size = existsSync(outputPath) ? statSync(outputPath).size : 0;
  if (size === 0 || (probeVideo(outputPath)?.frames ?? 0) < 1) {
    throw new Error(`Montage cut wrote no video: ${outputPath} (${size} bytes, frames ${cut.startFrame}-${cut.endFrame} of the master).`);
  }
}

/** Scene cuts in a video (seconds), from ffmpeg's scene score. Empty when ffmpeg finds none or fails. */
export function detectSceneCuts(videoPath: string, threshold = 0.3): number[] {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-i', videoPath, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-',
  ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return [...`${r.stderr ?? ''}`.matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(parseFloat(m[1]).toFixed(3)));
}

export interface SnappedBoundary {
  /** Where the plan put the cut (seconds, already scaled to the render). */
  planned: number;
  /** Where the clip is cut: the detected cut matched to this boundary, else the planned time. */
  at: number;
  snapped: boolean;
  /** detected - planned, when snapped. */
  offset?: number;
}

/**
 * Move each planned boundary to a detected scene cut within `toleranceSec`.
 * Seedance lands a planned cut up to about half a second off, mostly early,
 * so slicing at the planned time carries frames of the neighbouring shot.
 *
 * Cuts are matched in order: each cut is used once, and a boundary only
 * takes a cut at least `minGapSec` after the edge before it. Of the
 * assignments that allows, the one that snaps the most boundaries wins, then
 * the one with the smallest total offset. So a lone cut between two
 * boundaries goes to the nearer one, and a boundary never takes the next
 * boundary's cut when that would leave the next one without its own: planned
 * 2 s and 3 s with real cuts at 1.45 s and 2.45 s snap to 1.45 and 2.45,
 * where taking the nearest cut for each boundary in turn gave the first one
 * 2.45 and ended clip 1 with shot 2's footage. A boundary with no cut keeps
 * its planned time, pushed past the edge before it by `minGapSec` but never
 * past `endSec` (the end of the render).
 */
export function snapBoundaries(planned: number[], detected: number[], toleranceSec = 0.8, minGapSec = 0.3, endSec = Infinity): SnappedBoundary[] {
  const cuts = [...new Set(detected.filter(Number.isFinite))].sort((a, b) => a - b);
  interface Assignment { snapped: number; offset: number; picks: number[] }
  const memo = new Map<string, Assignment>();
  // The best assignment for boundaries i.. when the edge before them is at
  // `floor` and cuts[last] is the last cut used.
  const best = (i: number, last: number, floor: number): Assignment => {
    if (i === planned.length) return { snapped: 0, offset: 0, picks: [] };
    const key = `${i}|${last}|${floor}`;
    const known = memo.get(key);
    if (known) return known;
    const want = planned[i];
    const unmatched = best(i + 1, last, Math.min(Math.max(want, floor + minGapSec), endSec));
    let result: Assignment = { ...unmatched, picks: [-1, ...unmatched.picks] };
    for (let j = last + 1; j < cuts.length && cuts[j] <= want + toleranceSec; j++) {
      const at = cuts[j];
      if (at < want - toleranceSec || at <= floor + minGapSec) continue;
      const rest = best(i + 1, j, at);
      const snapped = rest.snapped + 1;
      const offset = rest.offset + Math.abs(at - want);
      if (snapped > result.snapped || (snapped === result.snapped && offset < result.offset - 1e-9)) {
        result = { snapped, offset, picks: [j, ...rest.picks] };
      }
    }
    memo.set(key, result);
    return result;
  };

  const { picks } = best(0, -1, 0);
  const out: SnappedBoundary[] = [];
  let floor = 0;
  planned.forEach((want, i) => {
    const j = picks[i];
    if (j >= 0) {
      out.push({ planned: want, at: cuts[j], snapped: true, offset: Number((cuts[j] - want).toFixed(3)) });
      floor = cuts[j];
    } else {
      const at = Math.min(Math.max(want, floor + minGapSec), endSec);
      out.push({ planned: want, at, snapped: false });
      floor = at;
    }
  });
  return out;
}

export interface MontageCutResult {
  /** Canonical per-shot clips (`<sceneDir>/shot-NNN.mp4`), for the assembler. */
  shotPaths: string[];
  /** Media-library copies (`media-library/scene-NN/shot-NNN.mp4`). */
  libraryPaths: string[];
  segments: GenerationUnitSegment[];
}

/**
 * Cut a rendered montage at its beat boundaries.
 *
 * The beat map is scaled to the ACTUAL rendered duration (Seedance can come
 * back a hair short or long of the requested window) so the last beat never
 * runs off the end and the proportions the prompt asked for are preserved.
 * Each scaled boundary then snaps to the scene cut detected near it
 * (`snapBoundaries`); ffmpeg reports a scene cut at the new shot's first
 * frame, so a snapped cut is exact and nothing is trimmed there. At a
 * planned cut no scene cut confirmed, the frame on each side shows a copy of
 * its neighbour instead (video only), in case the real cut is a frame off.
 * Cuts fall on frames, neighbouring clips share their boundary instant, and
 * no audio is cut away: the clips' audio adds up to the master's. Every
 * clip keeps at least one frame, and a clip with no video fails the run.
 * `manifest.json` records the detected cuts, the boundaries and any cut
 * nobody planned.
 *
 * Every shot is written twice, under its shot id with an insert's suffix
 * (`shot-013b.mp4` for 13b, which shares 13's number):
 *   1. `<sceneDir>/shot-NNN.mp4` — the canonical path every downstream step
 *      (assemble-episode, subtitles, QA) already reads.
 *   2. `<episodeDir>/media-library/scene-NN/shot-NNN.mp4` — the organized
 *      library for hand editing / the Venice Video Creator, alongside the
 *      uncut montage master and a `manifest.json` describing each cut.
 */
export function cutMontageIntoShots(options: {
  montagePath: string;
  unit: GenerationUnit;
  /** The unit's shots: the manifest describes each cut from its own shot, an insert included. */
  shots?: ShotScript[];
  shotsByNumber?: Map<number, ShotScript>;
  sceneDir: string;
  episodeDir: string;
  archiveExisting: (path: string) => void;
}): MontageCutResult {
  const { montagePath, unit, shots, shotsByNumber, sceneDir, episodeDir, archiveExisting } = options;
  const beats = unit.montageBeats ?? [];
  if (beats.length === 0) {
    throw new Error(`Montage unit ${unit.unitId} has no beat map — cannot cut.`);
  }
  const keys = beats.map(beat => shotKey(montageBeatShotId(beat)));
  const shared = keys.filter((key, i) => keys.indexOf(key) !== i);
  if (shared.length > 0) {
    throw new Error(`Montage unit ${unit.unitId}: two of its shots would write shot-${shared[0]}.mp4; a suffixed insert's beat needs its shotIdSuffix.`);
  }

  const renderedSec = ffprobeDuration(montagePath);
  const video = probeVideo(montagePath);
  if (!video || video.frames < beats.length) {
    throw new Error(`Montage unit ${unit.unitId}: ${montagePath} has ${video ? `${video.frames} frame(s), fewer than its ${beats.length} shots` : 'no video stream'}; cannot cut it.`);
  }
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

  // Cut at the real hard cuts: each planned boundary snaps to a detected
  // scene change; the cutter then works in frames.
  const SNAP_TOLERANCE_SEC = 0.8;
  const detected = beats.length > 1 ? detectSceneCuts(montagePath) : [];
  const boundaries = snapBoundaries(beats.slice(1).map(beat => beat.startSec * scale), detected, SNAP_TOLERANCE_SEC, 0.3, renderedSec);
  const missed = boundaries.filter(b => !b.snapped).length;
  if (missed > 0) {
    console.warn(`  ⚠ ${unit.unitId}: ${missed} of ${boundaries.length} planned cut(s) had no detected cut within ${SNAP_TOLERANCE_SEC} s; cut at the planned time. Check those joins.`);
  }
  const extraCuts = detected.filter(t => t > 0.3 && t < renderedSec - 0.3 && !boundaries.some(b => b.snapped && b.at === t));
  // Each boundary on a frame, every clip at least one frame long: a cut pushed
  // past the end of a short render comes back inside it.
  const edgeFrames = [0];
  boundaries.forEach((boundary, i) => {
    const frame = Math.min(Math.max(Math.round(boundary.at * video.fps), edgeFrames[i] + 1), video.frames - (beats.length - 1 - i));
    if (Math.abs(frame / video.fps - boundary.at) > 1 / video.fps) {
      console.warn(`  ⚠ ${unit.unitId}: cut ${i + 1} at ${boundary.at.toFixed(2)} s does not fit the ${renderedSec.toFixed(2)} s render (every clip keeps a frame); moved to ${(frame / video.fps).toFixed(2)} s.`);
    }
    boundary.at = Number((frame / video.fps).toFixed(3));
    edgeFrames.push(frame);
  });
  edgeFrames.push(video.frames);

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const key = keys[i];

    const canonicalPath = join(sceneDir, `shot-${key}.mp4`);
    archiveExisting(canonicalPath);
    ffmpegCut(montagePath, canonicalPath, {
      fps: video.fps,
      startFrame: edgeFrames[i],
      endFrame: edgeFrames[i + 1],
      toEnd: i === beats.length - 1,
      hasAudio: video.hasAudio,
      holdFirst: i > 0 && !boundaries[i - 1].snapped,
      holdLast: i < beats.length - 1 && !boundaries[i].snapped,
    });
    shotPaths.push(canonicalPath);

    const libraryPath = join(libraryDir, `shot-${key}.mp4`);
    copyFileSync(canonicalPath, libraryPath);
    libraryPaths.push(libraryPath);

    segments.push({
      shotNumber: beat.shotNumber,
      ...(beat.shotIdSuffix ? { shotIdSuffix: beat.shotIdSuffix } : {}),
      startOffsetSec: Number((edgeFrames[i] / video.fps).toFixed(3)),
      durationSec: Number(((edgeFrames[i + 1] - edgeFrames[i]) / video.fps).toFixed(3)),
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
    detectedCuts: detected,
    boundaries,
    extraCuts,
    cuts: segments.map((seg, i) => {
      const shot = shots?.find(s => s.shotNumber === seg.shotNumber && (s.shotIdSuffix ?? '') === (seg.shotIdSuffix ?? ''))
        ?? shotsByNumber?.get(seg.shotNumber);
      return {
        shot: keys[i],
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
