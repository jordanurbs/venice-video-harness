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
//        assembly order (matches cut-qa's lighting-discontinuity check).
//
//   2. VISION (per-unit sampled frames, same intelligence layer as panel QA):
//      - identity: one mid-beat frame per character-bearing shot, sent WITH
//        the character reference sheets — verdict per unit.
//      - cross-unit: the per-unit hero frames sent TOGETHER in one call —
//        "is this the same person in every frame?" This is the check that
//        would have caught canopy-run's three Wrens.
//
// The report lands next to qa-report.json as video-qa-report.json, and
// assemble-episode refuses (without --skip-video-qa) to stitch units that
// have a FLAG-CRITICAL cross-unit verdict.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VeniceClient } from '../venice/client.js';
import type { SeriesState, EpisodeScript } from '../series/types.js';
import { getCharacterDir } from '../series/manager.js';

export type VideoQaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';

export interface UnitFrameSample {
  unitId: string;
  shotNumber: number;
  /** Seconds into the UNIT master where the frame was grabbed. */
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

export function extractFrame(videoPath: string, atSec: number, outPath: string): boolean {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1', outPath,
  ], { encoding: 'utf-8' });
  return r.status === 0 && existsSync(outPath);
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

const toDataUri = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

interface PlanUnitLike {
  unitId: string;
  outputFile: string;
  shotNumbers: number[];
  segments?: Array<{ shotNumber: number; startOffsetSec: number; durationSec: number }>;
}

/**
 * Sample one mid-beat frame per character-bearing shot of each unit.
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
    const masterPath = join(sceneDir, unit.outputFile);
    if (!existsSync(masterPath)) continue;
    const duration = ffprobeDurationSec(masterPath);
    const segments = unit.segments && unit.segments.length > 0
      ? unit.segments
      : [{ shotNumber: unit.shotNumbers[0], startOffsetSec: 0, durationSec: duration }];
    for (const seg of segments) {
      const shot = script.shots.find(s => s.shotNumber === seg.shotNumber);
      if (!shot || shot.characters.length === 0) continue;
      const atSec = Math.min(seg.startOffsetSec + seg.durationSec / 2, Math.max(duration - 0.1, 0));
      const framePath = join(framesDir, `${unit.unitId}-shot-${String(seg.shotNumber).padStart(3, '0')}.png`);
      if (extractFrame(masterPath, atSec, framePath)) {
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
