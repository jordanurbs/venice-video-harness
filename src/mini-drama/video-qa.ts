// ---------------------------------------------------------------------------
// Post-render video QA (`qa-videos`)
//
// Born from the canopy-run failure (2026-08-10): storyboard QA passed, every
// montage unit rendered fine in isolation, and the assembled film still had
// three different protagonists — because each generation unit re-interprets
// the character references independently, and NOTHING compared the rendered
// units to each other. Panel QA cannot catch cross-unit drift by definition:
// it runs before any video exists.
//
// This module closes that hole with two layers:
//
//   1. PROGRAMMATIC (free, always on):
//      - head-glitch scan: per-frame mean-luma deltas over each unit's first
//        second; a spike-and-revert inside the first ~10 frames is the
//        Seedance transition-junk flash that survived the beat cut.
//      - boundary luma jump: mean-luma delta across every unit join in
//        assembly order (matches cut-qa's lighting-discontinuity check). A
//        join that changes location is a scene cut and is not compared.
//      - speech tail: a clip with an on-camera speaker whose cut does not fall
//        in silence (the line is cut off). A warning.
//
//   2. VISION (per-unit sampled frames, same intelligence layer as panel QA):
//      - identity: one mid-beat frame per character-bearing shot, sent WITH
//        the character reference sheets — verdict per unit.
//      - cross-unit: the per-unit hero frames sent TOGETHER in one call —
//        "is this the same person in every frame?" This is the check that
//        would have caught canopy-run's three Wrens.
//      - neighbour continuity: one call per cut, the end of one shot against
//        the start of the next (vehicle, props, people, facing, action,
//        light), on the generation plan or on any edit's cut list.
//
// The report lands next to qa-report.json as video-qa-report.json, and
// assemble-episode refuses (without --skip-video-qa) to stitch units that
// have a FLAG-CRITICAL verdict or a check that could not run.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VeniceClient } from '../venice/client.js';
import type { SeriesState, EpisodeScript } from 'venice-video-harness/core/series/types.js';
import { getCharacterDir } from '../series/manager.js';

export type VideoQaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';

export interface UnitFrameSample {
  unitId: string;
  shotNumber: number;
  /** Seconds into the UNIT master where the frame was grabbed (into the shot's clip, for a unit with no master). */
  atSec: number;
  framePath: string;
}

export interface HeadGlitchFinding {
  unitId: string;
  /** 0-based frame index where the spike occurred. */
  frameIndex: number;
  /** Mean-luma delta that triggered the finding. */
  lumaDelta: number;
}

export interface BoundaryFinding {
  fromUnit: string;
  toUnit: string;
  lumaDelta: number;
  severity: 'warn' | 'fail';
}

export interface UnitIdentityResult {
  unitId: string;
  verdict: VideoQaVerdict;
  issues: string[];
  /** True when the vision call itself failed — the unit is UNCHECKED, not passed. */
  errored?: boolean;
}

export interface CrossUnitResult {
  verdict: VideoQaVerdict;
  issues: string[];
  /** Unit ids the model judged to not match the majority identity. */
  driftingUnits: string[];
  errored?: boolean;
}

export interface VideoQaReport {
  episode: number;
  model: string;
  analyzedAt: string;
  headGlitches: HeadGlitchFinding[];
  boundaries: BoundaryFinding[];
  unitIdentity: UnitIdentityResult[];
  crossUnit: CrossUnitResult;
  /** Neighbour continuity: one result per checked cut (vehicle, people, props, facing, action, light). */
  continuity?: PairContinuityResult[];
  /** Clips whose on-camera line is still sounding at the cut (warnings). */
  speechTails?: SpeechTailFinding[];
  /**
   * Units not checked because a staged shot in them (stage-ref) has no clip
   * from its pick: checking the clip on disk would pass the defect the pick
   * removes. They count as unchecked, so the report does not pass (rule 46);
   * the cuts beside such a clip are unchecked too.
   */
  notChecked?: Array<{ unitId: string; shots: string[]; reason: string }>;
  summary: {
    units: number;
    criticals: number;
    errored: number;
    passed: boolean;
  };
}

// ---------------------------------------------------------------------------
// ffmpeg/ffprobe primitives
// ---------------------------------------------------------------------------

export function ffprobeDurationSec(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : 0;
}

export function extractFrame(videoPath: string, atSec: number, outPath: string, options: { flip?: boolean } = {}): boolean {
  // A seek past the last frame exits 0 and writes nothing: an older file at
  // the same path must not pass for the new frame.
  rmSync(outPath, { force: true });
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(atSec), '-i', videoPath,
    ...(options.flip ? ['-vf', 'hflip'] : []),
    '-frames:v', '1', outPath,
  ], { encoding: 'utf-8' });
  return r.status === 0 && existsSync(outPath);
}

/**
 * Duration of the first video stream, or of the container when the stream
 * carries none. A longer audio track puts the container's end past the last
 * decodable frame (extractLastFrame in video-generator.ts probes the same way).
 */
export function videoStreamDurationSec(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) && v > 0 ? v : ffprobeDurationSec(path);
}

/**
 * The frame at `atSec`, or the nearest earlier one that decodes: steps back in
 * widening offsets (as extractLastFrame does), never before `notBeforeSec`.
 * Returns the time read, or undefined when no frame came out.
 */
export function extractFrameAtOrBefore(
  videoPath: string,
  atSec: number,
  outPath: string,
  options: { notBeforeSec?: number; flip?: boolean } = {},
): number | undefined {
  const floor = Math.max(0, options.notBeforeSec ?? 0);
  for (const back of [0, 0.1, 0.3, 0.6, 1.0]) {
    const at = Math.max(floor, atSec - back);
    if (extractFrame(videoPath, at, outPath, { flip: options.flip })) return at;
    if (at === floor) break;
  }
  return undefined;
}

/** Whether a file has an audio stream. */
export function hasAudioStream(path: string): boolean {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

/**
 * Mean luma (YUV Y-plane average, 0-255) for each of the first `count`
 * frames of a video, via ffmpeg's signalstats filter. Returns [] on failure
 * rather than throwing — a QA scan must never kill the pipeline.
 */
export function headFrameLumas(videoPath: string, count = 24): number[] {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-i', videoPath,
    '-vf', `select='lt(n\\,${count})',signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { encoding: 'utf-8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lumas: number[] = [];
  for (const m of out.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    lumas.push(parseFloat(m[1]));
  }
  return lumas;
}

/**
 * Detect the Seedance head-flash: within the first `windowFrames` frames, a
 * frame whose luma jumps by more than `threshold` from its neighbour and
 * reverts within 3 frames. A hard scene change holds its new level; a glitch
 * flash does not.
 */
export function detectHeadGlitch(
  videoPath: string,
  unitId: string,
  options: { windowFrames?: number; threshold?: number } = {},
): HeadGlitchFinding | undefined {
  const windowFrames = options.windowFrames ?? 12;
  const threshold = options.threshold ?? 28;
  const lumas = headFrameLumas(videoPath, windowFrames + 4);
  for (let i = 1; i < Math.min(lumas.length, windowFrames); i++) {
    const jump = Math.abs(lumas[i] - lumas[i - 1]);
    if (jump < threshold) continue;
    // Does it revert toward the pre-jump level within 3 frames?
    const base = lumas[i - 1];
    for (let j = i + 1; j <= Math.min(i + 3, lumas.length - 1); j++) {
      if (Math.abs(lumas[j] - base) < threshold / 2) {
        return { unitId, frameIndex: i, lumaDelta: Number(jump.toFixed(1)) };
      }
    }
  }
  return undefined;
}

/** Mean luma of a single frame image (used for boundary comparison). */
export function frameLuma(videoPath: string, atSec: number): number | undefined {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ], { encoding: 'utf-8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = out.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Vision layer
// ---------------------------------------------------------------------------

/** Longest edge of an image sent to the vision model. Full 1080p PNGs (and 4K sheets) overflow the request: HTTP 413. */
export const VISION_MAX_EDGE = 1024;

/** An image as a data URI for the vision model: scaled to VISION_MAX_EDGE and JPEG-encoded, or the raw file if ffmpeg fails. */
export function visionDataUri(p: string): string {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', p,
    '-vf', `scale='min(${VISION_MAX_EDGE},iw)':'min(${VISION_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
    '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0 && r.stdout && r.stdout.length > 0) {
    return `data:image/jpeg;base64,${Buffer.from(r.stdout).toString('base64')}`;
  }
  return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
}

const toDataUri = visionDataUri;

/**
 * True when two consecutive units meet at a change of location. In montage mode every unit is one location, so a
 * join is a scene cut and a change of light there is expected, not a continuity fault.
 */
export function isLocationChange(
  prev: { shotNumbers: number[] },
  next: { shotNumbers: number[] },
  shots: Array<{ shotNumber: number; location?: string }>,
): boolean {
  const loc = new Map(shots.map(s => [s.shotNumber, s.location]));
  const a = loc.get(prev.shotNumbers[prev.shotNumbers.length - 1]);
  const b = loc.get(next.shotNumbers[0]);
  return Boolean(a && b && a !== b);
}

interface PlanUnitLike {
  unitId: string;
  outputFile: string;
  shotNumbers: number[];
  segments?: Array<{ shotNumber: number; shotIdSuffix?: string; startOffsetSec: number; durationSec: number; outputFile?: string }>;
}

/** Where a rendered unit's footage is on disk. */
export interface UnitFootage {
  /** The unit's master, when a file carries the unit's name. */
  master?: string;
  /** Otherwise the clips cut from it, one per segment, in order. */
  clips?: string[];
  /** The file the unit starts in and the one it ends in. */
  head: string;
  tail: string;
}

/**
 * A unit's footage: its master, or, when no master carries the unit's name
 * (generate-videos keeps a montage unit whose clips are all on disk; a change
 * in grouping renames units), the clips cut from it, so the unit is checked
 * from its clips. Null when neither is on disk: the unit was not rendered.
 */
export function unitFootage(unit: PlanUnitLike, sceneDir: string): UnitFootage | null {
  const master = join(sceneDir, unit.outputFile);
  if (existsSync(master)) return { master, head: master, tail: master };
  const clips = (unit.segments ?? []).map(seg => (seg.outputFile ? join(sceneDir, seg.outputFile) : ''));
  if (clips.length === 0 || !clips.every(clip => clip && existsSync(clip))) return null;
  return { clips, head: clips[0], tail: clips[clips.length - 1] };
}

/**
 * Sample one mid-beat frame per character-bearing shot of each unit, from
 * its master or, for a unit with no master, from each shot's clip.
 * Frames land in a temp dir; callers get the manifest.
 */
export function sampleUnitFrames(
  units: PlanUnitLike[],
  sceneDir: string,
  script: EpisodeScript,
  options: { framesDir?: string } = {},
): UnitFrameSample[] {
  const framesDir = options.framesDir ?? join(tmpdir(), `video-qa-${Date.now()}`);
  mkdirSync(framesDir, { recursive: true });
  const samples: UnitFrameSample[] = [];
  for (const unit of units) {
    const footage = unitFootage(unit, sceneDir);
    if (!footage) continue;
    const duration = footage.master ? ffprobeDurationSec(footage.master) : 0;
    const segments: NonNullable<PlanUnitLike['segments']> = unit.segments && unit.segments.length > 0
      ? unit.segments
      : [{ shotNumber: unit.shotNumbers[0], startOffsetSec: 0, durationSec: duration }];
    for (const [index, seg] of segments.entries()) {
      // A suffixed insert (13b) shares its base shot's number, and may share its unit.
      const suffix = seg.shotIdSuffix ?? '';
      const shot = script.shots.find(s => s.shotNumber === seg.shotNumber && (s.shotIdSuffix ?? '') === suffix)
        ?? script.shots.find(s => s.shotNumber === seg.shotNumber);
      if (!shot || shot.characters.length === 0) continue;
      const source = footage.master ?? footage.clips![index];
      const atSec = footage.master
        ? Math.min(seg.startOffsetSec + seg.durationSec / 2, Math.max(duration - 0.1, 0))
        : ffprobeDurationSec(source) / 2;
      const framePath = join(framesDir, `${unit.unitId}-shot-${String(seg.shotNumber).padStart(3, '0')}${suffix}.png`);
      if (extractFrame(source, atSec, framePath)) {
        samples.push({ unitId: unit.unitId, shotNumber: seg.shotNumber, atSec, framePath });
      }
    }
  }
  return samples;
}

const IDENTITY_SYSTEM_PROMPT = `You are a film-continuity QA analyst. You receive rendered VIDEO FRAMES from one generation unit of a film, followed by the official character reference sheet(s). Judge whether the character(s) in the frames match the reference: face/body design, hair or shell color and style, wardrobe, and signature accessories. Characters may be non-human (drones, machines, creatures) — the reference sheet defines what they look like; never flag a shot merely because no human is visible when the referenced character is not human. Rendered frames are mid-action, so allow motion blur, unusual angles, and partial occlusion — flag identity substance, not rendering softness. If the referenced character is not visible or too small/occluded to judge in every frame, use verdict FLAG-LOW with issue "character not clearly visible" — never FLAG-CRITICAL for absence alone (the frame may be a scripted insert or an empty beat).
Respond with JSON only: {"verdict": "PASS" | "FLAG-CRITICAL" | "FLAG-MODERATE" | "FLAG-LOW", "issues": string[], "notes": string}
FLAG-CRITICAL means a viewer would read a visible character as a different person/design (wrong hair color, different face, wrong shell/body design, missing signature wardrobe element).`;

const CROSS_UNIT_SYSTEM_PROMPT = `You are a film-continuity QA analyst. Every image you receive is a rendered frame from a DIFFERENT generation unit of one film, in film order, and each SHOULD show the same protagonist. Your single question: across the frames where the protagonist is clearly visible, does the protagonist read as the same person — same face, same hair color and style, same wardrobe and signature accessories?
Frames where the protagonist is absent, heavily occluded, facing away, or too small to judge go in unclearFrames and MUST NOT be counted as drift. Only put a frame in driftingFrames when the protagonist is clearly visible and reads as a different person.
Respond with JSON only: {"verdict": "PASS" | "FLAG-CRITICAL" | "FLAG-MODERATE" | "FLAG-LOW", "issues": string[], "driftingFrames": number[], "unclearFrames": number[], "notes": string}
driftingFrames and unclearFrames list 1-based frame indexes. FLAG-CRITICAL means at least one clearly-visible frame reads as a different person.`;

/**
 * Per-unit identity check: hero frame(s) of a unit vs the character sheets.
 */
export async function checkUnitIdentity(
  client: VeniceClient,
  model: string,
  series: SeriesState,
  unitId: string,
  frames: UnitFrameSample[],
  characterNames: string[],
): Promise<UnitIdentityResult> {
  const images = frames.slice(0, 3).map(f => toDataUri(f.framePath));
  const refNames: string[] = [];
  for (const name of characterNames.slice(0, 2)) {
    const front = join(getCharacterDir(series, name), 'front.png');
    if (existsSync(front)) {
      images.push(toDataUri(front));
      refNames.push(name);
    }
  }
  if (images.length === 0 || refNames.length === 0) {
    return { unitId, verdict: 'PASS', issues: [], errored: false };
  }
  try {
    const parsed = await client.chatJson<{ verdict: VideoQaVerdict; issues: string[]; notes: string }>({
      model,
      systemPrompt: IDENTITY_SYSTEM_PROMPT,
      userPrompt: `The first ${Math.min(frames.length, 3)} image(s) are rendered frames from unit ${unitId}. The remaining image(s) are the official reference sheet(s) for: ${refNames.join(', ')}. Do the rendered characters match their references?`,
      images,
      maxTokens: 2000,
      temperature: 0.2,
      label: `unit ${unitId} identity QA`,
    });
    return { unitId, verdict: parsed.verdict, issues: parsed.issues ?? [] };
  } catch (err) {
    return {
      unitId,
      verdict: 'FLAG-LOW',
      issues: [`identity QA failed: ${err instanceof Error ? err.message : String(err)}`],
      errored: true,
    };
  }
}

/**
 * The cross-unit check — the one that would have caught canopy-run's three
 * Wrens. One hero frame per unit, all in one vision call, in film order.
 */
export async function checkCrossUnitIdentity(
  client: VeniceClient,
  model: string,
  heroFrames: UnitFrameSample[],
  protagonistName: string,
): Promise<CrossUnitResult> {
  if (heroFrames.length < 2) {
    return { verdict: 'PASS', issues: [], driftingUnits: [] };
  }
  try {
    const parsed = await client.chatJson<{
      verdict: VideoQaVerdict; issues: string[]; driftingFrames?: number[]; unclearFrames?: number[]; notes: string;
    }>({
      model,
      systemPrompt: CROSS_UNIT_SYSTEM_PROMPT,
      userPrompt: `${heroFrames.length} frames, one per generation unit, in film order. The protagonist is ${protagonistName}. Across the frames where ${protagonistName} is clearly visible, is this the same person?`,
      images: heroFrames.map(f => toDataUri(f.framePath)),
      maxTokens: 2000,
      temperature: 0.2,
      label: 'cross-unit identity QA',
    });
    const drifting = (parsed.driftingFrames ?? [])
      .map(index => heroFrames[index - 1]?.unitId)
      .filter((id): id is string => Boolean(id));
    const issues = [...(parsed.issues ?? [])];
    const unclear = (parsed.unclearFrames ?? [])
      .map(index => heroFrames[index - 1]?.unitId)
      .filter((id): id is string => Boolean(id));
    if (unclear.length > 0) {
      issues.push(`protagonist not clearly visible in: ${unclear.join(', ')} (not counted as drift)`);
    }
    return { verdict: parsed.verdict, issues, driftingUnits: drifting };
  } catch (err) {
    return {
      verdict: 'FLAG-LOW',
      issues: [`cross-unit QA failed: ${err instanceof Error ? err.message : String(err)}`],
      driftingUnits: [],
      errored: true,
    };
  }
}

/** Persist the report next to qa-report.json. */
export async function saveVideoQaReport(episodeDir: string, report: VideoQaReport): Promise<string> {
  const reportPath = join(episodeDir, 'video-qa-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Neighbour continuity (2026-10-26): one vision call per cut between two
// clips meant to play as one sequence. The identity checks compare only
// people, so a vehicle that changes between two generations, a person who
// faces the other way after the cut, or an object a close-up shows and the
// next shot does not, all passed. The check runs on a generation plan's shot
// clips or on any cut list, including an EDL, since a film cut in an editor
// never passes through assemble-episode.
// ---------------------------------------------------------------------------

/**
 * How a judged cut joins the clip before it when it is not one continuous
 * action: `later` (the script says time passes) or `unknown` (the script does
 * not say). Both are judged with the time-cut rule: only a different vehicle,
 * person or prop counts, and never as critical.
 */
export type CutJoin = 'later' | 'unknown';

/** One clip of a cut list, in play order. */
export interface CutClip {
  id: string;
  file: string;
  /** Source in point (seconds). */
  inSec: number;
  /** Source out point (seconds); the clip's end when absent. */
  outSec?: number;
  shot?: number;
  shotIdSuffix?: string;
  /** Where the clip is set (the script's location for a known shot). */
  location?: string;
  /**
   * The cut into this clip is not judged: a new scene, or a join the script
   * cannot vouch for (see markJoins).
   */
  newScene?: boolean;
  /** The cut into this clip is judged, but not as one continuous action. */
  join?: CutJoin;
  /** Why the clip cannot be read (a bad time or reference in the cut list): the cuts beside it are unchecked. */
  problem?: string;
  /** The generation (unit, or source file) the clip was cut from, when known. */
  generation?: string;
  /** The cut mirrors the clip (a shot's `flip`, as assemble-episode applies it). */
  flip?: boolean;
  /** What the shot should show, for an edit with no script behind it. */
  text?: string;
  /** Reference images of the objects and vehicles in the shot (a vehicle that changes is the commonest break). */
  refs?: Array<{ name: string; file: string }>;
  /** Someone speaks on camera in this clip: its cut belongs in silence. */
  speech?: boolean;
}

/** The fields of a script shot the cut checks read. */
export interface CutShot {
  shotNumber: number;
  shotIdSuffix?: string;
  location?: string;
  continuity?: { from?: string };
  trimStart?: number;
  trimEnd?: number;
  flip?: boolean;
}

export interface PairContinuityResult {
  from: string;
  to: string;
  verdict: VideoQaVerdict;
  issues: string[];
  /** What broke: vehicle, people, props, facing, action, light. */
  kinds: string[];
  /** The two clips come from different generations (the riskier joins). */
  acrossGenerations: boolean;
  /** Not one continuous action (a time cut, or a join the script does not state): never critical. */
  join?: CutJoin;
  /** The check could not run, or the reply did not answer the checklist: the cut is UNCHECKED, not passed. */
  errored?: boolean;
}

/** The script shot a clip shows, by number and suffix. */
export function shotForClip<T extends { shotNumber: number; shotIdSuffix?: string }>(
  shots: T[],
  clip: Pick<CutClip, 'shot' | 'shotIdSuffix'>,
): T | undefined {
  if (clip.shot === undefined) return undefined;
  return shots.find(s => s.shotNumber === clip.shot && (s.shotIdSuffix ?? '') === (clip.shotIdSuffix ?? ''));
}

/**
 * How each cut joins the clip before it.
 * - Between two script shots, the shot's `continuity.from` counts only when
 *   the clip before is the script's previous shot: an edit that reorders the
 *   shots, or puts a cutaway between them, is not the join the script
 *   describes. `continuous` is judged in full, even across a change of
 *   location; `new-scene` is not judged; `later` is a time cut. With no
 *   `from` (scripts written before the field) or a join the script does not
 *   describe, only a cut known to stay in one place (both clips tagged with
 *   the same location) is judged, and never as critical (`unknown`); with a
 *   location missing on either side, or two different ones, it is not judged.
 * - A cut inside one shot (the same shot on both sides) is one action.
 * - A clip from outside the script follows the cut list: it is judged as
 *   continuous with the clip before unless it sets `newScene`, or the two are
 *   set in different locations.
 * A clip already marked `newScene` keeps it.
 */
export function markJoins<T extends CutClip>(clips: T[], shots: CutShot[] = []): T[] {
  const order = new Map(shots.map((shot, index) => [shot, index]));
  return clips.map((clip, i) => {
    if (i === 0 || clip.newScene) return clip;
    const prev = clips[i - 1];
    const a = shotForClip(shots, prev);
    const b = shotForClip(shots, clip);
    const before = a?.location ?? prev.location;
    const after = b?.location ?? clip.location;
    if (!a || !b) return before && after && before !== after ? { ...clip, newScene: true } : clip;
    if (a === b) return clip;
    const from = order.get(a) === order.get(b)! - 1 ? b.continuity?.from : undefined;
    if (from === 'continuous') return clip;
    if (from === 'new-scene') return { ...clip, newScene: true };
    if (from === 'later') return { ...clip, join: 'later' };
    return before && after && before === after ? { ...clip, join: 'unknown' } : { ...clip, newScene: true };
  });
}

/**
 * The plan's shot clips in script order, each tagged with its generation, cut
 * as assemble-episode cuts them (assembler.ts `normalizeClip`): from
 * `trimStart`, to `trimEnd` before the file's end, mirrored by `flip`. A shot
 * whose clip is not on disk stays in the list, so the cuts beside it come out
 * unchecked instead of its neighbours being paired.
 */
export function cutListFromPlan(
  plan: { units: Array<{ unitId: string; shotNumbers: number[] }> },
  sceneDir: string,
  shots: CutShot[],
): CutClip[] {
  const generationOf = new Map<number, string>();
  for (const unit of plan.units) for (const n of unit.shotNumbers) generationOf.set(n, unit.unitId);
  const clips: CutClip[] = [];
  for (const shot of shots) {
    const key = `${String(shot.shotNumber).padStart(3, '0')}${shot.shotIdSuffix ?? ''}`;
    const file = join(sceneDir, `shot-${key}.mp4`);
    const inSec = shot.trimStart && shot.trimStart > 0 ? shot.trimStart : 0;
    const outSec = shot.trimEnd && shot.trimEnd > 0 && existsSync(file) ? ffprobeDurationSec(file) - shot.trimEnd : undefined;
    clips.push({
      id: `shot ${shot.shotNumber}${shot.shotIdSuffix ?? ''}`,
      file,
      inSec,
      ...(outSec !== undefined && outSec > inSec ? { outSec } : {}),
      shot: shot.shotNumber,
      ...(shot.shotIdSuffix ? { shotIdSuffix: shot.shotIdSuffix } : {}),
      ...(shot.location ? { location: shot.location } : {}),
      ...(shot.flip ? { flip: true } : {}),
      generation: generationOf.get(shot.shotNumber),
    });
  }
  return markJoins(clips, shots);
}

/** A shot reference from a cut list: 8, "8" or "8b". */
function parseShotRef(value: unknown): Pick<CutClip, 'shot' | 'shotIdSuffix'> {
  if (value === undefined || value === null) return {};
  const match = /^(\d+)([a-z]*)$/i.exec(String(value).trim());
  if (!match) return {};
  return { shot: Number(match[1]), ...(match[2] ? { shotIdSuffix: match[2].toLowerCase() } : {}) };
}

/**
 * A cut list from JSON: `{ "clips": [{ "file", "in", "out", "shot", "location", "newScene", "generation", "flip",
 * "text", "refs", "speech" }] }`, or an EDL with `cuts: [{ master, srcIn, srcOut, shot, location }]`. Relative paths
 * resolve against the first of `baseDir` that has the file. A clip's generation defaults to its source file: two
 * clips cut from one file are one generation. A clip with no file throws; a bad time or reference in a clip (an out
 * point that is null, or not after the in point; a reference with no file) leaves that clip with a `problem`, and the
 * cuts beside it come out unchecked.
 */
export function cutListFromJson(json: unknown, baseDir: string | string[]): CutClip[] {
  const data = json as { clips?: Array<Record<string, unknown>>; cuts?: Array<Record<string, unknown>> };
  // An EDL may name its media from the project root, not from its own folder: the first base that has the file wins.
  const bases = Array.isArray(baseDir) ? baseDir : [baseDir];
  const resolvePath = (file: string) => {
    if (isAbsolute(file)) return file;
    return bases.map(base => join(base, file)).find(path => existsSync(path)) ?? join(bases[0], file);
  };
  const reader = () => {
    const problems: string[] = [];
    /** Absent (undefined) is the default; anything that is not a time is a problem, null included. */
    const time = (value: unknown, name: string, fallback?: number): number | undefined => {
      if (value === undefined) return fallback;
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      if (Number.isFinite(n) && n >= 0) return n;
      problems.push(`"${name}" is not a time in seconds (${JSON.stringify(value)})`);
      return fallback;
    };
    const span = (inSec: number | undefined, outSec: number | undefined, names: [string, string]) => {
      if (inSec !== undefined && outSec !== undefined && outSec <= inSec) problems.push(`"${names[1]}" (${outSec}) is not after "${names[0]}" (${inSec})`);
    };
    const refs = (value: unknown): Array<{ name: string; file: string }> | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) { problems.push('"refs" is not a list'); return undefined; }
      const out: Array<{ name: string; file: string }> = [];
      value.forEach((ref: unknown, i) => {
        const entry = ref && typeof ref === 'object' ? ref as { name?: unknown; file?: unknown } : undefined;
        if (typeof ref === 'string' && ref) out.push({ name: ref.split('/').pop()!.replace(/\.[a-z]+$/i, ''), file: resolvePath(ref) });
        else if (entry && typeof entry.file === 'string' && entry.file) out.push({ name: typeof entry.name === 'string' && entry.name ? entry.name : 'object', file: resolvePath(entry.file) });
        else problems.push(`reference ${i + 1} has no file (${JSON.stringify(ref)})`);
      });
      return out;
    };
    const problem = () => (problems.length ? { problem: problems.join('; ') } : {});
    return { time, span, refs, problem };
  };
  if (Array.isArray(data?.clips)) {
    return data.clips.map((clip, index) => {
      const where = `clip ${index + 1}`;
      if (typeof clip?.file !== 'string' || !clip.file) throw new Error(`Cut list ${where} has no "file".`);
      const file = resolvePath(clip.file);
      const { time, span, refs, problem } = reader();
      const inSec = time(clip.in, 'in', 0);
      const outSec = time(clip.out, 'out');
      span(inSec, outSec, ['in', 'out']);
      const refList = refs(clip.refs);
      return {
        id: String(clip.id ?? clip.label ?? where),
        file,
        inSec: inSec ?? 0,
        ...(outSec !== undefined ? { outSec } : {}),
        ...parseShotRef(clip.shot),
        ...(clip.location ? { location: String(clip.location) } : {}),
        ...(clip.newScene ? { newScene: true } : {}),
        generation: clip.generation ? String(clip.generation) : file,
        ...(clip.flip ? { flip: true } : {}),
        ...(clip.text ? { text: String(clip.text) } : {}),
        ...(clip.speech ? { speech: true } : {}),
        ...(refList ? { refs: refList } : {}),
        ...problem(),
      };
    });
  }
  if (Array.isArray(data?.cuts)) {
    return data.cuts.map((cut, index) => {
      const where = `cut ${index + 1}`;
      if (typeof cut?.master !== 'string' || !cut.master) throw new Error(`Cut list ${where} has no "master".`);
      const file = resolvePath(cut.master);
      const ref = parseShotRef(cut.shot);
      const { time, span, problem } = reader();
      const inSec = time(cut.srcIn, 'srcIn', 0);
      const outSec = time(cut.srcOut, 'srcOut');
      span(inSec, outSec, ['srcIn', 'srcOut']);
      return {
        id: ref.shot !== undefined ? `shot ${ref.shot}${ref.shotIdSuffix ?? ''}` : where,
        file,
        inSec: inSec ?? 0,
        ...(outSec !== undefined ? { outSec } : {}),
        ...ref,
        ...(cut.location ? { location: String(cut.location) } : {}),
        generation: file,
        ...problem(),
      };
    });
  }
  throw new Error('Not a cut list: expected "clips" (file, in, out) or an EDL with "cuts" (master, srcIn, srcOut).');
}

/** Whether a path is a file that can be read. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Why a clip cannot be read, if it cannot: a problem in the cut list, a file
 * that is not on disk, or a reference image that is not a file. The cuts
 * beside such a clip are unchecked, and no call is made for them.
 */
export function clipProblem(clip: CutClip): string | undefined {
  if (clip.problem) return clip.problem;
  if (!isFile(clip.file)) return `${clip.file} is not on disk`;
  const ref = (clip.refs ?? []).find(item => !isFile(item.file));
  return ref ? `the reference for ${ref.name} (${ref.file}) is not a file on disk` : undefined;
}

/** Which cuts of a cut list to check: every cut, or only those between two generations; never into a new scene. */
export function pairsToCheck(clips: CutClip[], scope: 'all' | 'joins'): Array<[CutClip, CutClip]> {
  const pairs: Array<[CutClip, CutClip]> = [];
  for (let i = 1; i < clips.length; i++) {
    const [a, b] = [clips[i - 1], clips[i]];
    if (b.newScene) continue;
    if (scope === 'joins' && a.generation && b.generation && a.generation === b.generation) continue;
    pairs.push([a, b]);
  }
  return pairs;
}

const PAIR_SYSTEM_PROMPT = `You are a film-continuity supervisor checking ONE cut between two shots meant to play one after the other as a continuous sequence. Images 1 and 2 are the end of shot A (its middle, then its last frame). Images 3 and 4 are the start of shot B (its first frame, then its middle). Any further images are references for objects and vehicles, named in the request.
Answer each question by looking hard at the frames. Describe before you judge.
- vehicle: describe the vehicle in A (kind, length, hull or body colour, cabin shape, windows, marks) and in B. Same vehicle, a different one, or n/a (in neither)? When a reference image of the vehicle is given, a vehicle in either shot that does not match the reference is "different", even if only one shot shows it.
- people: for each person who appears in BOTH shots, the same face and clothes? same, different, or n/a when no person appears in both. Different people in the two shots (one person in A, another in B) is not a fault.
- props: the object in use in A and in B. The same object, a different one, or n/a? An object that does not match its reference image is "different".
- facing: in A, which way does each person face (and each vehicle head) relative to the clearest landmark (a skyline, a shore, a doorway)? In B? The same, reversed, or n/a? A person seen from the front with the landmark behind them faces away from it.
- action: does B plausibly continue from where A ends (moored or under way, open or shut, standing or seated)? continues or breaks.
- light: the same time of day and light, or different?
The shot text, when given, says what each shot should show; a change the text asks for (she turns round, the boat pulls away) is not a fault, but a change it asks for that the frames do not show is.
Respond with JSON only, every key present: {"vehicle": {"answer": "same" | "different" | "n/a", "note": string}, "people": {"answer": "same" | "different" | "n/a", "note": string}, "props": {"answer": "same" | "different" | "n/a", "note": string}, "facing": {"answer": "same" | "reversed" | "n/a", "note": string}, "action": {"answer": "continues" | "breaks", "note": string}, "light": {"answer": "same" | "different", "note": string}}`;

const PAIR_KEYS = ['vehicle', 'people', 'props', 'facing', 'action', 'light'] as const;
type PairKey = typeof PAIR_KEYS[number];

/** The answers each question allows (the reply schema in PAIR_SYSTEM_PROMPT). */
const PAIR_ANSWERS: Record<PairKey, readonly string[]> = {
  vehicle: ['same', 'different', 'n/a'],
  people: ['same', 'different', 'n/a'],
  props: ['same', 'different', 'n/a'],
  facing: ['same', 'reversed', 'n/a'],
  action: ['continues', 'breaks'],
  light: ['same', 'different'],
};

/** The answer that marks a break. */
const PAIR_FAULT: Record<PairKey, string> = {
  vehicle: 'different', people: 'different', props: 'different', facing: 'reversed', action: 'breaks', light: 'different',
};

export interface PairVerdict {
  verdict: VideoQaVerdict;
  issues: string[];
  kinds: string[];
  /** The reply did not answer every question with an allowed value: the cut is unchecked, not passed. */
  errored?: boolean;
}

/**
 * The verdict follows from the answers. On a continuous cut a different
 * vehicle, person or prop, or a reversed facing, is critical, a broken action
 * moderate, a change of light low. On a cut that is not one continuous action
 * (`join`: a time cut, or a join the script does not state) only a different
 * vehicle, person or prop counts, and as moderate. A reply that does not
 * answer all six questions with an allowed value is unchecked, never a pass
 * (rule 46).
 */
export function verdictFromAnswers(reply: unknown, options: { join?: CutJoin } = {}): PairVerdict {
  const capped = Boolean(options.join);
  const answers = new Map<PairKey, { answer: string; note: string }>();
  const unanswered: PairKey[] = [];
  for (const key of PAIR_KEYS) {
    const entry = reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>)[key] : undefined;
    const fields = entry && typeof entry === 'object' ? entry as { answer?: unknown; note?: unknown } : {};
    const answer = typeof fields.answer === 'string' ? fields.answer.trim().toLowerCase() : '';
    if (!PAIR_ANSWERS[key].includes(answer)) { unanswered.push(key); continue; }
    answers.set(key, { answer, note: typeof fields.note === 'string' ? fields.note.trim() : '' });
  }
  if (unanswered.length) {
    return {
      verdict: 'FLAG-LOW',
      issues: [`the reply did not answer the checklist (${unanswered.join(', ')}: missing, or not one of the allowed answers)`],
      kinds: [],
      errored: true,
    };
  }
  const broken = PAIR_KEYS.filter(key => answers.get(key)!.answer === PAIR_FAULT[key]);
  const kinds = capped ? broken.filter(key => key === 'vehicle' || key === 'people' || key === 'props') : broken;
  const severity = (key: PairKey) => (capped || key === 'action' ? 'moderate' : key === 'light' ? 'low' : 'critical');
  const verdict: VideoQaVerdict = kinds.some(key => severity(key) === 'critical') ? 'FLAG-CRITICAL'
    : kinds.some(key => severity(key) === 'moderate') ? 'FLAG-MODERATE'
      : kinds.length ? 'FLAG-LOW' : 'PASS';
  const issues = kinds.map(key => (answers.get(key)!.note ? `${key}: ${answers.get(key)!.note}` : key));
  return { verdict, issues, kinds: [...kinds] };
}

/** The clip's out point: its `outSec`, or the end of the file (audio included). */
function clipOutSec(clip: CutClip): number {
  return clip.outSec ?? ffprobeDurationSec(clip.file);
}

/** The clip's last moment with picture: its out point, or the end of the video stream when that comes first. */
function pictureEndSec(clip: CutClip): number {
  const stream = videoStreamDurationSec(clip.file);
  const out = clip.outSec ?? stream;
  return stream > 0 ? Math.min(out, stream) : out;
}

/** What the judge is told about a cut that is not one continuous action. */
const JOIN_NOTES: Record<CutJoin, string> = {
  later: 'Time passes between shot A and shot B (a time cut): the action need not continue, and positions, facing and light may change. Answer every question all the same.',
  unknown: 'The script does not say whether shot B follows straight on from shot A: time may pass between them, so positions, facing and light may change. Answer every question all the same.',
};

/** One vision call on one cut: the end of A against the start of B. */
export async function checkPairContinuity(
  client: Pick<VeniceClient, 'chatJson'>,
  model: string,
  a: CutClip,
  b: CutClip,
  options: { framesDir: string; aText?: string; bText?: string },
): Promise<PairContinuityResult> {
  const acrossGenerations = !a.generation || !b.generation || a.generation !== b.generation;
  const base = { from: a.id, to: b.id, acrossGenerations, ...(b.join ? { join: b.join } : {}) };
  const unchecked = (issue: string): PairContinuityResult => ({ ...base, verdict: 'FLAG-LOW', issues: [issue], kinds: [], errored: true });
  for (const clip of [a, b]) {
    const problem = clipProblem(clip);
    if (problem) return unchecked(`${clip.id}: ${problem}`);
  }
  // Everything that reads a file is inside the try: an unreadable frame or
  // reference leaves this cut unchecked instead of ending the run.
  try {
    mkdirSync(options.framesDir, { recursive: true });
    const aEnd = pictureEndSec(a);
    const bEnd = pictureEndSec(b);
    const stamp = `${a.id}-${b.id}`.replace(/[^a-z0-9]+/gi, '-');
    // A seek lands on the first frame at or after its time: 50 ms before the end
    // is the last frame at 24-30 fps, and an earlier one is found by stepping back.
    const frames: Array<[CutClip, number, string]> = [
      [a, a.inSec + (aEnd - a.inSec) / 2, 'a-mid'],
      [a, aEnd - 0.05, 'a-last'],
      [b, Math.min(b.inSec + 0.08, b.inSec + (bEnd - b.inSec) / 2), 'b-first'],
      [b, b.inSec + (bEnd - b.inSec) / 2, 'b-mid'],
    ];
    const images: string[] = [];
    for (const [clip, at, name] of frames) {
      const out = join(options.framesDir, `${stamp}-${name}.png`);
      if (extractFrameAtOrBefore(clip.file, at, out, { notBeforeSec: clip.inSec, flip: clip.flip }) === undefined) {
        return unchecked(`could not read a frame from ${clip.file} at ${at.toFixed(2)} s`);
      }
      images.push(visionDataUri(out));
    }
    const refs = [...(a.refs ?? []), ...(b.refs ?? [])]
      .filter((ref, i, all) => all.findIndex(other => other.file === ref.file) === i)
      .slice(0, 3);
    for (const ref of refs) images.push(visionDataUri(ref.file));
    const mirrored = ([['A', a], ['B', b]] as const).filter(([, clip]) => clip.flip).map(([label]) => label);
    const text = [
      options.aText ? `Shot A (${a.id}) should show: ${options.aText}` : '',
      options.bText ? `Shot B (${b.id}) should show: ${options.bText}` : '',
      b.join ? JOIN_NOTES[b.join] : '',
      // The cut plays a flipped clip mirrored, and so do its frames here; the references are not.
      ...mirrored.map(label => `Shot ${label}'s frames are mirrored (the cut flips it left to right), so lettering and markings on it read reversed: that alone is not a difference from a reference.`),
      ...refs.map((ref, i) => `Image ${5 + i} is the reference for ${ref.name}: in either shot it must look like this.`),
    ].filter(Boolean).join('\n');
    const reply = await client.chatJson<unknown>({
      model,
      systemPrompt: PAIR_SYSTEM_PROMPT,
      userPrompt: `${text ? `${text}\n` : ''}Does the cut from ${a.id} to ${b.id} hold together${b.join ? '' : ' as one continuous sequence'}?`,
      images,
      // Reasoning vision models spend most of the budget thinking (rule 47).
      maxTokens: 8000,
      temperature: 0.2,
      label: `continuity ${a.id} → ${b.id}`,
    });
    return { ...base, ...verdictFromAnswers(reply, { join: b.join }) };
  } catch (err) {
    return unchecked(`continuity QA failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reference images of the object cast members among a shot's characters
 * (props and vehicles cast like people, with traits that start "inanimate
 * object"): the judge compares the boat with the boat's reference.
 */
export function objectRefsFor(series: SeriesState, names: string[]): Array<{ name: string; file: string }> {
  const refs: Array<{ name: string; file: string }> = [];
  for (const name of names) {
    const member = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    if (!member || !/^\s*inanimate object/i.test(member.baseTraits ?? '')) continue;
    const dir = getCharacterDir(series, member.name);
    const file = ['anchor.png', 'front.png', 'three-quarter.png'].map(f => join(dir, f)).find(path => existsSync(path));
    if (file) refs.push({ name: member.name, file });
  }
  return refs;
}

/** Someone speaks on camera: the shot has a line, and its speaker is in the shot and is not the narrator. */
export function speaksOnCamera(shot?: { characters?: string[]; dialogue?: { character?: string; line?: string } | null }): boolean {
  const who = shot?.dialogue?.line?.trim() ? (shot.dialogue.character ?? '').trim().toUpperCase() : '';
  if (!who || who === 'NARRATOR' || who === 'VO' || who === 'V.O.') return false;
  return (shot?.characters ?? []).some(name => name.toUpperCase() === who);
}

// ---------------------------------------------------------------------------
// A spoken line cut off by the picture cut (2026-10-26). An on-camera line
// that runs on past the cut loses its last word, and a transcript's word
// edges are not precise enough to place a cut (they can be a third of a
// second out); the audio's silences are. The cut of a clip with on-camera
// speech belongs in silence.
// ---------------------------------------------------------------------------

/** The shortest pause the check looks for (silencedetect's `d`). */
const SPEECH_PAUSE_SEC = 0.06;
/** At the very end of the sound a shorter pause is enough: the line has ended. */
const SPEECH_END_PAUSE_SEC = 0.02;

/** Duration of the first audio stream (the container's when the stream carries none); 0 with no audio stream. */
export function audioStreamDurationSec(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !out) return 0;
  const v = parseFloat(out);
  return Number.isFinite(v) && v > 0 ? v : ffprobeDurationSec(path);
}

/**
 * Silences (absolute seconds) in a file's audio between `startSec` and
 * `startSec + durSec`, as ffmpeg's silencedetect finds them: at least `minSec`
 * below `noiseDb` dBFS. Undefined when the audio cannot be read (ffmpeg
 * failed, there is no audio stream, or none of it lies in the window), which
 * is not the same as no silence.
 */
export function silencesIn(file: string, startSec: number, durSec: number, noiseDb = -35, minSec = SPEECH_PAUSE_SEC): Array<[number, number]> | undefined {
  const from = Math.max(0, startSec);
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-ss', String(from), '-t', String(Math.max(0.05, durSec)), '-i', file,
    '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-',
  ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return undefined;
  const log = `${r.stderr ?? ''}`;
  if (/Output file is empty|nothing was encoded/i.test(log)) return undefined;
  const starts = [...log.matchAll(/silence_start: (-?[0-9.]+)/g)].map(m => from + parseFloat(m[1]));
  const ends = [...log.matchAll(/silence_end: (-?[0-9.]+)/g)].map(m => from + parseFloat(m[1]));
  return starts.map((start, i) => [Number(start.toFixed(3)), Number((ends[i] ?? from + durSec).toFixed(3))]);
}

export interface SpeechTailFinding {
  clip: string;
  shot?: number;
  /** The clip's out point (seconds into its file). */
  outSec: number;
  /** How far the speech runs past the out point, when the source continues. */
  runsPastMs?: number;
  /** The audio at the cut could not be read: check it by ear. */
  unmeasured?: boolean;
  message: string;
}

/**
 * The next clip plays on from this clip's sound: the same source picked up
 * where this clip stops (an edit's contiguous cuts), or the next shot of the
 * same generation with nothing trimmed between them (a montage's beat cuts).
 * A line that carries over such a cut is not cut off.
 */
export function playsOn(clip: CutClip, next?: CutClip): boolean {
  if (!next || next.problem || !isFile(next.file)) return false;
  if (next.file === clip.file) return clip.outSec !== undefined && Math.abs(next.inSec - clip.outSec) <= 0.05;
  return Boolean(clip.generation) && clip.generation === next.generation && clip.outSec === undefined && next.inSec === 0;
}

/**
 * A line still sounding at the clip's out point. The test is whether the out
 * point falls inside a stretch silencedetect calls silent (below -35 dBFS for
 * at least 60 ms, or 20 ms at the very end of the sound), not how loud the cut
 * is, because a word's last sound can be as quiet as the background. The
 * threshold is fixed, not set from the clip's room tone, so loud ambience at a
 * cut reads as sound: this is a warning, not a block. When the source runs on
 * past the out point (a trimEnd, a take trimmed in an edit), it says how far
 * the speech goes. A clip with no audio stream, or whose sound has stopped
 * before the cut, has nothing to check.
 */
export function checkSpeechTail(clip: CutClip): SpeechTailFinding | undefined {
  if (clip.problem || !isFile(clip.file) || !hasAudioStream(clip.file)) return undefined;
  const soundEnd = audioStreamDurationSec(clip.file);
  const out = clipOutSec(clip);
  if (!(soundEnd > 0) || out - soundEnd > SPEECH_PAUSE_SEC) return undefined;
  const from = Math.max(clip.inSec, out - 0.4);
  const to = Math.min(soundEnd, out + 0.6);
  if (!(to > from)) return undefined;
  const base = { clip: clip.id, ...(clip.shot !== undefined ? { shot: clip.shot } : {}), outSec: Number(out.toFixed(3)) };
  const atSoundEnd = soundEnd - out <= SPEECH_PAUSE_SEC;
  const quiet = silencesIn(clip.file, from, to - from, -35, atSoundEnd ? SPEECH_END_PAUSE_SEC : SPEECH_PAUSE_SEC);
  if (!quiet) {
    return { ...base, unmeasured: true, message: `${clip.id}: could not read the audio at the cut (${out.toFixed(2)} s); check by ear that no line is cut off.` };
  }
  if (quiet.some(([start, end]) => start <= out + 0.04 && end >= out - 0.02)) return undefined;
  const next = quiet.map(([start]) => start).filter(start => start > out).sort((x, y) => x - y)[0];
  if (next !== undefined) {
    const ms = Math.round((next - out) * 1000);
    return { ...base, runsPastMs: ms, message: `${clip.id}: the speech runs ${ms} ms past the cut at ${out.toFixed(2)} s (it falls silent at ${next.toFixed(2)} s). Run the clip to ${(next + 0.05).toFixed(2)} s, or move the cut.` };
  }
  const runsOn = to - out > 0.05 ? `, and the sound runs on for at least ${(to - out).toFixed(1)} s after it` : '';
  return { ...base, message: `${clip.id}: the clip ends on sound at ${out.toFixed(2)} s, not in silence${runsOn}. If a line is still being spoken there, it is cut off: run the clip to the end of the word.` };
}
