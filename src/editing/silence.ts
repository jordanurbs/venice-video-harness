/**
 * Silence-gap and filler-word detection.
 *
 * Built on the same `ffmpeg silencedetect` pattern used by
 * `.claude/skills/burn-in-subtitles/scripts/derive-captions.ts`. Reused here
 * rather than duplicated.
 *
 * Filler words are identified from word-level transcripts (not audio), so
 * this module pairs with `src/editing/packer.ts` output.
 */

import { execSync } from 'node:child_process';
import type { WordTiming } from './types.js';

export interface SilenceSpan {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface DetectSilencesOptions {
  silenceDb?: number;
  silenceMin?: number;
  /** Optional time range; if omitted, runs on the whole file. */
  startSec?: number;
  endSec?: number;
}

/**
 * Run ffmpeg silencedetect and parse the silence spans. Defaults match the
 * burn-in-subtitles skill's recommendations for Kokoro-style VO.
 */
export function detectSilences(
  file: string,
  options: DetectSilencesOptions = {},
): SilenceSpan[] {
  const silenceDb = options.silenceDb ?? -30;
  const silenceMin = options.silenceMin ?? 0.18;

  const rangeArgs: string[] = [];
  if (options.startSec !== undefined) {
    rangeArgs.push('-ss', String(options.startSec));
  }

  const durationFlag: string[] = [];
  if (options.startSec !== undefined && options.endSec !== undefined) {
    durationFlag.push('-t', String(options.endSec - options.startSec));
  }

  const cmd = [
    'ffmpeg',
    '-hide_banner',
    '-nostats',
    ...rangeArgs,
    '-i',
    `"${file}"`,
    ...durationFlag,
    '-af',
    `"silencedetect=noise=${silenceDb}dB:d=${silenceMin}"`,
    '-f',
    'null',
    '-',
    '2>&1',
  ].join(' ');

  const offset = options.startSec ?? 0;
  const out = execSync(cmd, { encoding: 'utf-8' });
  const spans: SilenceSpan[] = [];
  let pending: number | null = null;
  for (const line of out.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    if (s) {
      pending = parseFloat(s[1]) + offset;
      continue;
    }
    const e = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);
    if (e && pending !== null) {
      const endSec = parseFloat(e[1]) + offset;
      spans.push({
        startSec: pending,
        endSec,
        durationSec: parseFloat(e[2]),
      });
      pending = null;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Filler-word detection
// ---------------------------------------------------------------------------

/**
 * Default filler-word lexicon. "you know" and "i mean" are handled as
 * bigrams via the multi-word detector below.
 *
 * Intentionally excluded:
 *  - `...` (three dots) — Kokoro intentional breath gap (anti-pattern E2)
 *  - `so` / `well` / `okay` — too often content-bearing for general removal
 */
export const DEFAULT_FILLER_UNIGRAMS = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  'erm',
  'ah',
  'hmm',
  'mm',
  'mhm',
]);

export const DEFAULT_FILLER_BIGRAMS: Array<[string, string]> = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
];

export interface FillerMatch {
  startSec: number;
  endSec: number;
  text: string;
  /** Preferred trim — includes a small padding window so we cut cleanly. */
  trimStartSec: number;
  trimEndSec: number;
  kind: 'filler-unigram' | 'filler-bigram';
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '');
}

export interface DetectFillersOptions {
  unigrams?: Set<string>;
  bigrams?: Array<[string, string]>;
  /** Padding around each filler for cleaner trims (seconds). */
  paddingSec?: number;
  /**
   * Minimum gap between a filler and the next content word for the filler
   * to be a safe trim candidate. Prevents clipping adjacent content.
   */
  minGapSec?: number;
}

/**
 * Scan a word stream for filler words and bigrams, returning trim
 * candidates with padded boundaries. The caller decides which to apply —
 * never auto-trim without user confirmation (anti-pattern E2).
 */
export function detectFillers(
  words: WordTiming[],
  options: DetectFillersOptions = {},
): FillerMatch[] {
  const unigrams = options.unigrams ?? DEFAULT_FILLER_UNIGRAMS;
  const bigrams = options.bigrams ?? DEFAULT_FILLER_BIGRAMS;
  const padding = options.paddingSec ?? 0.04;
  const minGap = options.minGapSec ?? 0.05;

  const matches: FillerMatch[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const token = normalize(w.word);

    // Bigram match
    if (i + 1 < words.length) {
      const next = words[i + 1];
      const bg: [string, string] = [token, normalize(next.word)];
      const isBigram = bigrams.some(([a, b]) => a === bg[0] && b === bg[1]);
      if (isBigram) {
        const gapAfter =
          i + 2 < words.length ? words[i + 2].startSec - next.endSec : Infinity;
        if (gapAfter >= minGap) {
          matches.push({
            startSec: w.startSec,
            endSec: next.endSec,
            text: `${w.word} ${next.word}`,
            trimStartSec: Math.max(0, w.startSec - padding),
            trimEndSec: next.endSec + padding,
            kind: 'filler-bigram',
          });
          i++; // consume both words
          continue;
        }
      }
    }

    if (unigrams.has(token)) {
      const gapBefore = i > 0 ? w.startSec - words[i - 1].endSec : Infinity;
      const gapAfter =
        i + 1 < words.length ? words[i + 1].startSec - w.endSec : Infinity;
      if (gapBefore >= minGap && gapAfter >= minGap) {
        matches.push({
          startSec: w.startSec,
          endSec: w.endSec,
          text: w.word,
          trimStartSec: Math.max(0, w.startSec - padding),
          trimEndSec: w.endSec + padding,
          kind: 'filler-unigram',
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Cut-candidate suggestion
// ---------------------------------------------------------------------------

export interface CutCandidate {
  atSec: number;
  kind: 'silence' | 'sentence-end' | 'phrase-end';
  scoreSec: number;
}

/**
 * Suggest cut points within a take: silence midpoints, sentence endings,
 * and phrase endings. Score = estimated time to the next content word
 * (larger scores are safer cuts).
 */
export function suggestCutCandidates(
  silences: SilenceSpan[],
  words: WordTiming[],
): CutCandidate[] {
  const candidates: CutCandidate[] = [];

  for (const sil of silences) {
    if (sil.durationSec < 0.2) continue;
    candidates.push({
      atSec: sil.startSec + sil.durationSec / 2,
      kind: 'silence',
      scoreSec: sil.durationSec,
    });
  }

  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    const next = words[i + 1];
    const gap = next.startSec - w.endSec;
    const endsHard = /[.!?]$/.test(w.word);
    const endsSoft = /[,;:]$/.test(w.word);
    if (endsHard && gap >= 0.15) {
      candidates.push({
        atSec: w.endSec + gap / 2,
        kind: 'sentence-end',
        scoreSec: gap,
      });
    } else if (endsSoft && gap >= 0.25) {
      candidates.push({
        atSec: w.endSec + gap / 2,
        kind: 'phrase-end',
        scoreSec: gap,
      });
    }
  }

  candidates.sort((a, b) => a.atSec - b.atSec);
  return candidates;
}
