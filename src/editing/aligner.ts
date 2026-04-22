/**
 * Ground-truth script alignment for Venice-generated content.
 *
 * When we already know the exact spoken text (from `ShotScript.vo` or a
 * TTS script), we can produce more accurate word timings than pure ASR by
 * mapping the script's canonical words onto whisper.cpp's detected word
 * timings via longest-common-subsequence alignment.
 *
 * The output is still a `WordTiming[]`, but the `word` field is the
 * script's canonical word (with correct capitalization / punctuation)
 * rather than whisper's best guess. Unmatched script words are linearly
 * interpolated between their neighbors.
 *
 * This matters in practice because TTS voices often produce subtle
 * mispronunciations or swallowed words that whisper transcribes as
 * homophones ("their" vs "there", "a" vs "uh"). For editing purposes
 * we want the script's words — that's what the captions, shot manifest,
 * and VO_TEXT array refer to.
 */

import type { WordTiming } from './types.js';

export interface AlignOptions {
  /**
   * How to treat script words that whisper didn't emit at all. With
   * `interpolate` (default), unmatched words are given proportional
   * timings between their aligned neighbors. With `drop`, they're
   * omitted entirely (useful for truncation detection).
   */
  onMissing?: 'interpolate' | 'drop';
}

function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9']/g, '')
    .replace(/'/g, '');
}

function tokenizeScript(script: string): string[] {
  return script
    .replace(/\.{2,}/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Build an LCS-style alignment matrix between script words and ASR words
 * on normalized forms. Returns parallel arrays of matched indices.
 */
function alignLcs(
  scriptWords: string[],
  asrWords: WordTiming[],
): Array<{ scriptIdx: number; asrIdx: number }> {
  const a = scriptWords.map(normalize);
  const b = asrWords.map((w) => normalize(w.word));
  const m = a.length;
  const n = b.length;

  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] && b[j - 1] && a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const out: Array<{ scriptIdx: number; asrIdx: number }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && a[i - 1]) {
      out.push({ scriptIdx: i - 1, asrIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}

/**
 * Align a ground-truth script against whisper word timings.
 */
export function alignScriptToWords(
  script: string,
  asrWords: WordTiming[],
  options: AlignOptions = {},
): WordTiming[] {
  const onMissing = options.onMissing ?? 'interpolate';
  const scriptWords = tokenizeScript(script);
  if (scriptWords.length === 0 || asrWords.length === 0) return [];

  const matches = alignLcs(scriptWords, asrWords);

  // Produce timings per script word.
  const timings: Array<WordTiming | null> = new Array(scriptWords.length).fill(null);

  // Copy timings from matched ASR words (script wording wins).
  for (const { scriptIdx, asrIdx } of matches) {
    const asr = asrWords[asrIdx];
    timings[scriptIdx] = {
      word: scriptWords[scriptIdx],
      startSec: asr.startSec,
      endSec: asr.endSec,
      confidence: asr.confidence,
    };
  }

  if (onMissing === 'drop') {
    return timings.filter((t): t is WordTiming => t !== null);
  }

  // Interpolate missing timings based on surrounding anchors.
  const firstMatched = timings.findIndex((t) => t !== null);
  const lastMatched = (() => {
    for (let k = timings.length - 1; k >= 0; k--) if (timings[k]) return k;
    return -1;
  })();
  if (firstMatched === -1) {
    // Nothing matched — fall back to linear distribution across ASR span.
    const firstAsr = asrWords[0];
    const lastAsr = asrWords[asrWords.length - 1];
    const span = Math.max(0.001, lastAsr.endSec - firstAsr.startSec);
    const per = span / scriptWords.length;
    return scriptWords.map((w, k) => ({
      word: w,
      startSec: firstAsr.startSec + k * per,
      endSec: firstAsr.startSec + (k + 1) * per,
    }));
  }

  // Extrapolate before the first matched word.
  if (firstMatched > 0 && timings[firstMatched]) {
    const anchor = timings[firstMatched]!;
    const pre = firstMatched;
    // Assume ~0.28s per pre-word if no earlier ASR — conservative.
    const avg = 0.28;
    for (let k = 0; k < firstMatched; k++) {
      const offset = (firstMatched - k) * avg;
      timings[k] = {
        word: scriptWords[k],
        startSec: Math.max(0, anchor.startSec - offset),
        endSec: Math.max(0, anchor.startSec - offset + avg * 0.8),
      };
    }
  }

  // Extrapolate after the last matched word.
  if (lastMatched !== -1 && lastMatched < scriptWords.length - 1 && timings[lastMatched]) {
    const anchor = timings[lastMatched]!;
    const avg = 0.28;
    for (let k = lastMatched + 1; k < scriptWords.length; k++) {
      const offset = (k - lastMatched) * avg;
      timings[k] = {
        word: scriptWords[k],
        startSec: anchor.endSec + offset - avg,
        endSec: anchor.endSec + offset,
      };
    }
  }

  // Interpolate gaps between matched words.
  for (let k = 0; k < timings.length; k++) {
    if (timings[k]) continue;
    // Find anchor before and after.
    let before = k - 1;
    while (before >= 0 && !timings[before]) before--;
    let after = k + 1;
    while (after < timings.length && !timings[after]) after++;
    if (before < 0 || after >= timings.length) continue;
    const b = timings[before]!;
    const a = timings[after]!;
    const span = Math.max(0.001, a.startSec - b.endSec);
    const slots = after - before;
    const localIdx = k - before;
    const per = span / slots;
    timings[k] = {
      word: scriptWords[k],
      startSec: b.endSec + (localIdx - 1) * per,
      endSec: b.endSec + localIdx * per,
    };
  }

  return timings.filter((t): t is WordTiming => t !== null);
}

/**
 * Detect VO truncation: returns the portion of the script (if any) that
 * could not be aligned to ASR words because the audio ended before it.
 * Useful as a VO-truncation check (CLAUDE.md anti-pattern, rule 26).
 */
export function detectTruncation(
  script: string,
  asrWords: WordTiming[],
): { truncated: boolean; lostWords: string[]; lastAlignedSec: number } {
  const scriptWords = tokenizeScript(script);
  if (scriptWords.length === 0) {
    return { truncated: false, lostWords: [], lastAlignedSec: 0 };
  }
  if (asrWords.length === 0) {
    return { truncated: true, lostWords: scriptWords, lastAlignedSec: 0 };
  }
  const matches = alignLcs(scriptWords, asrWords);
  if (matches.length === 0) {
    return { truncated: true, lostWords: scriptWords, lastAlignedSec: 0 };
  }
  const lastMatch = matches[matches.length - 1];
  const lost = scriptWords.slice(lastMatch.scriptIdx + 1);
  // Treat as truncated only if more than 5% of script words are lost and
  // the lost tail is more than 2 words (avoid false positives on single
  // trailing filler).
  const lossRatio = lost.length / scriptWords.length;
  const truncated = lost.length > 2 && lossRatio > 0.05;
  return {
    truncated,
    lostWords: lost,
    lastAlignedSec: asrWords[lastMatch.asrIdx].endSec,
  };
}
