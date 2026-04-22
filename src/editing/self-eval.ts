/**
 * Self-evaluation driver for the editing pipeline.
 *
 * The cut-qa agent (`.claude/agents/cut-qa.md`) is the intelligent layer;
 * this module is the mechanical layer that:
 *   1. Enumerates cut boundaries from an EDL
 *   2. Runs each boundary through the six programmatic checks
 *   3. Produces a `CutQaReport` consumable by the agent
 *   4. Persists iterations to `session.json`
 *
 * The agent then reads the report, proposes fixes, and the orchestrator
 * applies them and re-renders. Hard cap: 3 iterations.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CutQaFinding,
  CutQaReport,
  EditSession,
  Edl,
  EdlClip,
  Take,
  WordTiming,
} from './types.js';
import { detectTruncation } from './aligner.js';
import { effectiveDurationSec } from './edl.js';

export const MAX_ITERATIONS = 3;

export interface CutBoundary {
  index: number;
  trailerTimeSec: number;
  outgoingClip: EdlClip;
  incomingClip: EdlClip;
}

/** Cumulative trailer-time position of each clip boundary. */
export function enumerateCutBoundaries(edl: Edl): CutBoundary[] {
  const boundaries: CutBoundary[] = [];
  let cursor = 0;
  for (let i = 0; i < edl.clips.length; i++) {
    const clip = edl.clips[i];
    if (i > 0) {
      boundaries.push({
        index: i,
        trailerTimeSec: cursor,
        outgoingClip: edl.clips[i - 1],
        incomingClip: clip,
      });
    }
    cursor += effectiveDurationSec(clip);
    if (i > 0 && clip.transitionIn && clip.transitionIn !== 'cut') {
      cursor -= (clip.transitionMs ?? 250) / 1000;
    }
  }
  return boundaries;
}

// ---------------------------------------------------------------------------
// Check: aspect regression
// ---------------------------------------------------------------------------

export interface AspectSpec {
  width: number;
  height: number;
}

const ASPECT_MAP: Record<'16:9' | '9:16' | '1:1', AspectSpec> = {
  '16:9': { width: 16, height: 9 },
  '9:16': { width: 9, height: 16 },
  '1:1': { width: 1, height: 1 },
};

export function checkAspectRegression(
  renderedPath: string,
  expectedRatio: '16:9' | '9:16' | '1:1',
): CutQaFinding[] {
  if (!existsSync(renderedPath)) return [];
  const raw = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${renderedPath}"`,
    { encoding: 'utf-8' },
  ).trim();
  const [wStr, hStr] = raw.split(',');
  const w = parseInt(wStr, 10);
  const h = parseInt(hStr, 10);
  if (!w || !h) {
    return [
      {
        kind: 'aspect-regression',
        atSec: 0,
        severity: 'warn',
        message: `Could not read video dimensions from ${renderedPath}`,
      },
    ];
  }
  const actualRatio = w / h;
  const expected = ASPECT_MAP[expectedRatio];
  const expectedRatioVal = expected.width / expected.height;
  const delta = Math.abs(actualRatio - expectedRatioVal);
  if (delta > 0.01) {
    return [
      {
        kind: 'aspect-regression',
        atSec: 0,
        severity: 'fail',
        message: `Output is ${w}x${h} (ratio ${actualRatio.toFixed(3)}) but series is ${expectedRatio} (ratio ${expectedRatioVal.toFixed(3)}). Delta ${delta.toFixed(3)}.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Check: visual jump at boundary
// ---------------------------------------------------------------------------

function extractFrameHash(file: string, atSec: number): number[] {
  // Extract a small PNG and hash it with a crude 16x16 dhash.
  // Using ffmpeg's grayscale downscale avoids pulling in an imaging library.
  const tmp = `/tmp/cq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pgm`;
  try {
    execSync(
      `ffmpeg -y -hide_banner -loglevel error -ss ${atSec} -i "${file}" -frames:v 1 -vf "scale=16:16,format=gray" "${tmp}"`,
      { stdio: 'inherit' },
    );
    const buf = readFileSync(tmp);
    // PGM header: P5\n<w> <h>\n255\n<binary>
    // Find end of header — second newline after the magic.
    let offset = 0;
    let newlines = 0;
    while (offset < buf.length && newlines < 3) {
      if (buf[offset] === 0x0a) newlines++;
      offset++;
    }
    const pixels = buf.slice(offset);
    const arr = Array.from(pixels.slice(0, 256));
    return arr;
  } finally {
    try {
      execSync(`rm -f "${tmp}"`);
    } catch {
      // ignore
    }
  }
}

function hashDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return 256;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let bitsDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const bitA = a[i] >= meanA ? 1 : 0;
    const bitB = b[i] >= meanB ? 1 : 0;
    if (bitA !== bitB) bitsDiff++;
  }
  return bitsDiff;
}

export function checkVisualJump(
  renderedPath: string,
  boundaries: CutBoundary[],
): CutQaFinding[] {
  if (!existsSync(renderedPath)) return [];
  const findings: CutQaFinding[] = [];
  for (const b of boundaries) {
    // Skip transitions with crossfades — the blend smooths any hash delta.
    if (b.incomingClip.transitionIn && b.incomingClip.transitionIn !== 'cut') continue;
    const outgoing = extractFrameHash(renderedPath, Math.max(0, b.trailerTimeSec - 0.04));
    const incoming = extractFrameHash(renderedPath, b.trailerTimeSec);
    const dist = hashDistance(outgoing, incoming);
    if (dist >= 64) {
      findings.push({
        kind: 'visual-jump',
        atSec: b.trailerTimeSec,
        clipIndex: b.index,
        severity: 'warn',
        message: `Frame hash distance ${dist}/256 between outgoing and incoming clips at cut ${b.index}. Probable visual jump.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check: VO truncation against ground-truth script
// ---------------------------------------------------------------------------

export function checkVoTruncation(
  script: string,
  asrWords: WordTiming[],
): CutQaFinding[] {
  const r = detectTruncation(script, asrWords);
  if (!r.truncated) return [];
  const preview = r.lostWords.slice(0, 12).join(' ');
  return [
    {
      kind: 'vo-truncation',
      atSec: r.lastAlignedSec,
      severity: 'fail',
      message: `VO ended at ${r.lastAlignedSec.toFixed(2)}s but script has ${r.lostWords.length} unaligned words after: "${preview}${r.lostWords.length > 12 ? '...' : ''}". Likely doubled-ellipsis bug (CLAUDE.md rule 26).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Check: audio pop at boundary
// ---------------------------------------------------------------------------

export function checkAudioPops(
  renderedPath: string,
  boundaries: CutBoundary[],
  fadeMs: number,
): CutQaFinding[] {
  if (!existsSync(renderedPath)) return [];
  const findings: CutQaFinding[] = [];
  for (const b of boundaries) {
    // Scan a 100ms window centered at the boundary, excluding the fade region.
    const winStart = Math.max(0, b.trailerTimeSec - 0.05);
    const winDur = 0.1;
    try {
      const out = execSync(
        `ffmpeg -hide_banner -nostats -ss ${winStart} -i "${renderedPath}" -t ${winDur} -af "astats=metadata=1:reset=1" -f null - 2>&1 | grep -E "Peak level"`,
        { encoding: 'utf-8' },
      );
      // Parse peak level dB (rough)
      const m = out.match(/Peak level dB: ([-\d.]+)/);
      if (m) {
        const peak = parseFloat(m[1]);
        if (peak > -6 && fadeMs < 50) {
          findings.push({
            kind: 'audio-pop',
            atSec: b.trailerTimeSec,
            clipIndex: b.index,
            severity: 'fail',
            message: `Peak ${peak.toFixed(1)} dBFS at cut ${b.index}. Audio fade (${fadeMs}ms) did not catch this click.`,
          });
        }
      }
    } catch {
      // astats parse failure is non-fatal
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check: lighting discontinuity
// ---------------------------------------------------------------------------

function measureMeanLuma(file: string, atSec: number): number | null {
  try {
    const out = execSync(
      `ffmpeg -hide_banner -nostats -ss ${atSec} -i "${file}" -frames:v 1 -vf "signalstats" -f null - 2>&1 | grep "YAVG"`,
      { encoding: 'utf-8' },
    );
    const m = out.match(/YAVG:([\d.]+)/);
    if (m) return parseFloat(m[1]) / 255;
  } catch {
    return null;
  }
  return null;
}

export function checkLightingDiscontinuity(
  renderedPath: string,
  boundaries: CutBoundary[],
): CutQaFinding[] {
  if (!existsSync(renderedPath)) return [];
  const findings: CutQaFinding[] = [];
  for (const b of boundaries) {
    const before = measureMeanLuma(renderedPath, Math.max(0, b.trailerTimeSec - 0.04));
    const after = measureMeanLuma(renderedPath, b.trailerTimeSec + 0.04);
    if (before === null || after === null) continue;
    const delta = Math.abs(before - after);
    if (delta > 0.18) {
      findings.push({
        kind: 'lighting-discontinuity',
        atSec: b.trailerTimeSec,
        clipIndex: b.index,
        severity: 'warn',
        message: `Mean luma delta ${delta.toFixed(3)} at cut ${b.index} (before=${before.toFixed(2)}, after=${after.toFixed(2)}). Possible lighting mismatch.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export interface RunCutQaInput {
  renderedPath: string;
  edl: Edl;
  takes: Take[];
  iteration: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  /** Ground-truth script for VO truncation check. */
  groundTruthScript?: string;
  /** ASR words from the rendered output (pre-transcribed) for truncation check. */
  renderedAsrWords?: WordTiming[];
}

export function runCutQa(input: RunCutQaInput): CutQaReport {
  const boundaries = enumerateCutBoundaries(input.edl);
  const findings: CutQaFinding[] = [];

  if (input.aspectRatio) {
    findings.push(...checkAspectRegression(input.renderedPath, input.aspectRatio));
  }
  findings.push(...checkVisualJump(input.renderedPath, boundaries));
  findings.push(...checkLightingDiscontinuity(input.renderedPath, boundaries));
  findings.push(...checkAudioPops(input.renderedPath, boundaries, input.edl.audioFadeMs));

  if (input.groundTruthScript && input.renderedAsrWords) {
    findings.push(...checkVoTruncation(input.groundTruthScript, input.renderedAsrWords));
  }

  const passed = findings.every((f) => f.severity !== 'fail');

  return {
    iteration: input.iteration,
    generatedAt: new Date().toISOString(),
    findings,
    passed,
  };
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export function loadSession(path: string): EditSession | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as EditSession;
}

export function saveSession(session: EditSession, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  session.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8');
}

export function summarizeReport(report: CutQaReport): string {
  if (report.findings.length === 0) {
    return `cut-qa iteration ${report.iteration} — 0 findings — PASS`;
  }
  const fails = report.findings.filter((f) => f.severity === 'fail');
  const warns = report.findings.filter((f) => f.severity === 'warn');
  const lines: string[] = [];
  lines.push(
    `cut-qa iteration ${report.iteration} — ${report.findings.length} findings — ${report.passed ? 'PASS (warnings only)' : 'FAIL'}`,
  );
  if (fails.length > 0) {
    lines.push('');
    lines.push(`FAIL (${fails.length}):`);
    for (const f of fails) {
      lines.push(`  - [${f.kind}] at ${f.atSec.toFixed(2)}s: ${f.message}`);
    }
  }
  if (warns.length > 0) {
    lines.push('');
    lines.push(`WARN (${warns.length}):`);
    for (const f of warns) {
      lines.push(`  - [${f.kind}] at ${f.atSec.toFixed(2)}s: ${f.message}`);
    }
  }
  return lines.join('\n');
}
