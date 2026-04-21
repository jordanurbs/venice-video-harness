#!/usr/bin/env tsx
/**
 * derive-captions.ts
 *
 * Bundled with the `burn-in-subtitles` workspace skill. Reads a rendered VO
 * audio file, runs ffmpeg silencedetect to find actual phrase boundaries,
 * matches each boundary to a phrase in the project's VO_TEXT array, and
 * prints a drop-in `CAPTIONS` TypeScript array timed against absolute trailer
 * time.
 *
 * Usage:
 *   npx tsx .claude/skills/burn-in-subtitles/scripts/derive-captions.ts \
 *     --vo output/<project>/audio/vo.mp3 \
 *     --vo-text-file scripts/<project>/config.ts \
 *     --vo-delay 1.5 \
 *     [--lead-in 0.1] \
 *     [--linger-after-last 1.5] \
 *     [--max-chars-per-line 53] \
 *     [--silence-db -30] \
 *     [--silence-min 0.18]
 *
 * Pipe the output into a snippet file, then paste into your `config.ts`:
 *   ... > /tmp/captions-snippet.ts
 *
 * The `--vo-text-file` should be a `.ts` file exporting a `VO_TEXT` constant
 * built from a `.join(" ")` of an array literal. The script parses the array
 * literal directly (no transpilation) — keep it simple.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

interface Args {
  vo: string;
  voTextFile: string;
  voDelay: number;
  leadIn: number;
  lingerAfterLast: number;
  maxCharsPerLine: number;
  silenceDb: number;
  silenceMin: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const idx = argv.indexOf(flag);
    if (idx === -1) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing required flag: ${flag}`);
    }
    const v = argv[idx + 1];
    if (!v) throw new Error(`Flag ${flag} has no value`);
    return v;
  };
  return {
    vo: get("--vo"),
    voTextFile: get("--vo-text-file"),
    voDelay: parseFloat(get("--vo-delay")),
    leadIn: parseFloat(get("--lead-in", "0.1")),
    lingerAfterLast: parseFloat(get("--linger-after-last", "1.5")),
    maxCharsPerLine: parseInt(get("--max-chars-per-line", "53"), 10),
    silenceDb: parseFloat(get("--silence-db", "-30")),
    silenceMin: parseFloat(get("--silence-min", "0.18")),
  };
}

interface SpeechSegment {
  start: number;
  end: number;
  duration: number;
}

/** Run ffmpeg silencedetect and parse out speech segments (inverse of silences). */
function detectSpeechSegments(
  voPath: string,
  silenceDb: number,
  silenceMin: number,
): SpeechSegment[] {
  const cmd = `ffmpeg -hide_banner -i "${voPath}" -af "silencedetect=noise=${silenceDb}dB:d=${silenceMin}" -f null - 2>&1`;
  const out = execSync(cmd, { encoding: "utf-8" });

  const silences: Array<{ start: number; end: number }> = [];
  const startRe = /silence_start: ([\d.]+)/;
  const endRe = /silence_end: ([\d.]+) \| silence_duration:/;

  let pendingStart: number | null = null;
  for (const line of out.split("\n")) {
    const sMatch = line.match(startRe);
    if (sMatch) {
      pendingStart = parseFloat(sMatch[1]);
      continue;
    }
    const eMatch = line.match(endRe);
    if (eMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(eMatch[1]) });
      pendingStart = null;
    }
  }

  // Get total duration to bound the last speech segment
  const durOut = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${voPath}"`,
    { encoding: "utf-8" },
  ).trim();
  const totalDuration = parseFloat(durOut);

  // Speech is the inverse of silence
  const segments: SpeechSegment[] = [];
  let cursor = 0;
  for (const sil of silences) {
    if (sil.start > cursor + 0.01) {
      segments.push({
        start: cursor,
        end: sil.start,
        duration: sil.start - cursor,
      });
    }
    cursor = sil.end;
  }
  // Trailing speech (if any) after the last silence
  if (totalDuration > cursor + 0.05) {
    segments.push({
      start: cursor,
      end: totalDuration,
      duration: totalDuration - cursor,
    });
  }

  // Filter out micro-segments under 0.1s (encoder artifacts)
  return segments.filter(s => s.duration >= 0.1);
}

/** Parse VO_TEXT array literal from a .ts file. */
function parseVoTextPhrases(voTextFile: string): string[] {
  const src = readFileSync(voTextFile, "utf-8");
  // Match: export const VO_TEXT = [ ... ].join(" ");
  // We want the array literal — anything between `VO_TEXT = [` and `]`
  const startIdx = src.indexOf("VO_TEXT");
  if (startIdx === -1) throw new Error(`No VO_TEXT export found in ${voTextFile}`);
  const arrStart = src.indexOf("[", startIdx);
  if (arrStart === -1) throw new Error(`VO_TEXT is not declared as an array in ${voTextFile}`);
  // Find matching closing bracket
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd === -1) throw new Error(`Unclosed array literal in ${voTextFile}`);

  const arrayBody = src.slice(arrStart + 1, arrEnd);
  // Extract each string literal (handles ", ', and template literals — keep simple, expect ")
  const phrases: string[] = [];
  const stringRe = /"((?:\\"|[^"])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(arrayBody))) {
    phrases.push(m[1].replace(/\\"/g, '"'));
  }
  return phrases;
}

/** Approximate syllable count for a phrase (used for sub-segment splitting). */
function syllableCount(text: string): number {
  // Crude but good enough: count vowel groups per word, min 1 per word.
  return text
    .toLowerCase()
    .split(/\s+/)
    .reduce((acc, word) => {
      const cleaned = word.replace(/[^a-z]/g, "");
      if (!cleaned) return acc;
      const matches = cleaned.match(/[aeiouy]+/g);
      return acc + Math.max(1, matches ? matches.length : 1);
    }, 0);
}

/**
 * Split a long phrase at the most natural break closest to the midpoint.
 *
 * Priority of break candidates (best first):
 *   1. Punctuation breaks (`,` `;` em-dash en-dash)
 *   2. Ellipsis `...`
 *   3. Word boundary (last resort)
 *
 * Returns null only if the phrase is a single word that cannot be split.
 */
function splitPhraseAtMidpoint(phrase: string): [string, string] | null {
  // Try break-types in priority order. For each type, collect candidates that
  // would produce non-empty left AND right halves, pick the one closest to the
  // midpoint. Fall through to the next type only if no usable candidate exists.
  type BreakKind = "punct" | "ellipsis" | "whitespace";
  const passes: Array<{ kind: BreakKind; pattern: RegExp; pickIdx: (m: RegExpExecArray) => number }> = [
    { kind: "punct",      pattern: /[,;—–]/g,  pickIdx: (m) => m.index + 1 },
    { kind: "ellipsis",   pattern: /\.{3,}/g,  pickIdx: (m) => m.index + m[0].length },
    { kind: "whitespace", pattern: /\s+/g,     pickIdx: (m) => m.index },
  ];

  for (const pass of passes) {
    const cands: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = pass.pattern.exec(phrase))) {
      const splitAfter = pass.pickIdx(m);
      const left = phrase.slice(0, splitAfter).trim();
      const right = phrase.slice(splitAfter).trim();
      if (left && right) cands.push(splitAfter);
    }
    if (cands.length === 0) continue;
    const mid = phrase.length / 2;
    cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    const splitAfter = cands[0];
    return [phrase.slice(0, splitAfter).trim(), phrase.slice(splitAfter).trim()];
  }
  return null;
}

interface Caption {
  text: string;
  start: number;
  end: number;
}

function deriveCaptions(args: Args): Caption[] {
  const segments = detectSpeechSegments(args.vo, args.silenceDb, args.silenceMin);
  const phrases = parseVoTextPhrases(args.voTextFile);

  console.error(`[derive-captions] Detected ${segments.length} speech segments`);
  console.error(`[derive-captions] VO_TEXT has ${phrases.length} phrases`);

  if (segments.length === 0) {
    throw new Error(
      "No speech segments detected. Try lowering --silence-db (e.g. -28) or --silence-min (e.g. 0.12)",
    );
  }

  // Map phrases to segments. Strategies:
  //   - If counts match exactly: 1-to-1 mapping
  //   - If segments > phrases: a phrase contains an internal pause that got detected;
  //     leave segments unmerged but the phrase's caption rows expand to cover them
  //   - If segments < phrases: some phrases got merged because Kokoro didn't honor a pause;
  //     still produce one caption per phrase by interpolating sub-segment timings
  //
  // For robustness, we walk in lockstep — each phrase consumes one segment by default.
  // If there are leftover segments after the last phrase, they're appended onto the last caption.
  // If there are extra phrases beyond available segments, the user gets a warning.

  const captions: Caption[] = [];
  const phraseCount = phrases.length;
  const segCount = segments.length;

  if (segCount < phraseCount) {
    console.error(
      `[derive-captions] WARNING: fewer segments (${segCount}) than phrases (${phraseCount}). ` +
        "Some phrases may have been merged. Re-author VO with cleaner pauses if captions feel off.",
    );
  }

  // Walk: assign each phrase to one segment, in order.
  // If extra segments remain after consuming all phrases, attach them to the last phrase
  // (commonly happens when the last phrase has internal pauses).
  for (let i = 0; i < phraseCount; i++) {
    const phrase = phrases[i];
    const seg = segments[i];
    if (!seg) {
      console.error(`[derive-captions] WARNING: no segment for phrase ${i + 1}: "${phrase}"`);
      continue;
    }
    captions.push({
      text: phrase,
      start: seg.start,
      end: seg.end,
    });
  }

  // If there are more segments than phrases, extend the last phrase's caption end to cover them.
  if (segCount > phraseCount && captions.length > 0) {
    const lastSeg = segments[segCount - 1];
    captions[captions.length - 1].end = lastSeg.end;
  }

  // Now: recursively split any caption whose text exceeds the max-chars-per-line budget.
  function splitRecursively(cap: Caption, depth = 0): Caption[] {
    if (cap.text.length <= args.maxCharsPerLine || depth >= 3) return [cap];
    const split = splitPhraseAtMidpoint(cap.text);
    if (!split) {
      console.error(
        `[derive-captions] WARNING: phrase exceeds ${args.maxCharsPerLine} chars with no break candidate: "${cap.text}"`,
      );
      return [cap];
    }
    const [left, right] = split;
    const leftSyl = syllableCount(left);
    const rightSyl = syllableCount(right);
    const totalSyl = leftSyl + rightSyl || 1;
    const splitTime = cap.start + (cap.end - cap.start) * (leftSyl / totalSyl);
    const leftCap: Caption = { text: left, start: cap.start, end: splitTime };
    const rightCap: Caption = { text: right, start: splitTime, end: cap.end };
    return [...splitRecursively(leftCap, depth + 1), ...splitRecursively(rightCap, depth + 1)];
  }
  const splitCaptions: Caption[] = captions.flatMap((c) => splitRecursively(c));

  // Convert from VO time to trailer time, apply lead-in, and pin ends back-to-back.
  const trailerCaptions: Caption[] = splitCaptions.map((c) => ({
    text: c.text,
    start: args.voDelay + c.start - args.leadIn,
    end: args.voDelay + c.end,
  }));

  // Pin ends to next.start - 0.05 so caps are back-to-back without overlap or gap.
  for (let i = 0; i < trailerCaptions.length - 1; i++) {
    trailerCaptions[i].end = trailerCaptions[i + 1].start - 0.05;
  }
  // Final caption lingers `lingerAfterLast` seconds past end of speech.
  if (trailerCaptions.length > 0) {
    const lastSeg = segments[segments.length - 1];
    trailerCaptions[trailerCaptions.length - 1].end =
      args.voDelay + lastSeg.end + args.lingerAfterLast;
  }

  // Round to 2 decimals for clean TS output
  return trailerCaptions.map((c) => ({
    text: c.text,
    start: Math.round(c.start * 100) / 100,
    end: Math.round(c.end * 100) / 100,
  }));
}

function formatCaptionsArray(captions: Caption[]): string {
  const maxTextLen = Math.max(...captions.map((c) => c.text.length));
  const padTo = Math.min(maxTextLen + 4, 80);
  const lines = captions.map((c) => {
    const t = JSON.stringify(c.text) + ",";
    const padded = t.padEnd(padTo, " ");
    return `  { text: ${padded} start: ${c.start.toFixed(2).padStart(6)}, end: ${c.end.toFixed(2).padStart(6)} },`;
  });
  return [
    "/**",
    " * Caption rows (auto-derived by .claude/skills/burn-in-subtitles/scripts/derive-captions.ts).",
    " * Re-derive whenever the VO file changes — never hand-edit timings.",
    " */",
    "export const CAPTIONS: Array<{ text: string; start: number; end: number }> = [",
    ...lines,
    "];",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const captions = deriveCaptions(args);
  console.log(formatCaptionsArray(captions));
}

main();
