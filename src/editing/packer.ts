/**
 * Packer: collapses word streams into phrases and renders takes_packed.md.
 *
 * The pack is the primary LLM surface for editing. Keep it compact — target
 * ~12KB per 40 minutes of source audio. The format matches the one used by
 * browser-use/video-use so experience across projects transfers directly.
 *
 * Phrase boundary heuristics, in order:
 *   1. Gap between consecutive words > `silenceGapSec` (default 0.45s)
 *   2. Hard sentence punctuation followed by any gap (. ! ?)
 *   3. Soft punctuation (, ; :) only when followed by > 0.30s gap
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, extname } from 'node:path';
import type {
  AudioEvent,
  Take,
  TakePhrase,
  TakesPack,
  WordTiming,
} from './types.js';

export interface PackOptions {
  silenceGapSec?: number;
  maxPhraseSec?: number;
  /**
   * Minimum character length for a phrase to appear in the pack — shorter
   * fragments get merged into the next phrase.
   */
  minPhraseChars?: number;
}

const DEFAULT_OPTIONS: Required<PackOptions> = {
  silenceGapSec: 0.45,
  maxPhraseSec: 12.0,
  minPhraseChars: 4,
};

/**
 * Derive a stable 5-char hex id (e.g. `C0103`) from the file path. The
 * leading `C` matches video-use's naming. Stable across runs so EDLs
 * survive re-transcription.
 */
export function deriveTakeId(file: string, ordinal: number): string {
  const hash = createHash('sha1').update(file).digest('hex');
  // Use first 4 hex chars + ordinal to avoid collisions on very large source folders.
  const prefix = hash.slice(0, 4).toUpperCase();
  return `C${prefix.slice(0, 3)}${String(ordinal).padStart(1, '0')}`;
}

function groupWordsIntoPhrases(
  words: WordTiming[],
  speaker: string,
  options: Required<PackOptions>,
): TakePhrase[] {
  if (words.length === 0) return [];

  const phrases: TakePhrase[] = [];
  let current: WordTiming[] = [words[0]];

  const pushPhrase = () => {
    if (current.length === 0) return;
    const startSec = current[0].startSec;
    const endSec = current[current.length - 1].endSec;
    const text = current.map((w) => w.word).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    phrases.push({
      speaker,
      startSec,
      endSec,
      text,
      words: current,
    });
    current = [];
  };

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const w = words[i];
    const gap = w.startSec - prev.endSec;
    const prevText = prev.word.trim();
    const endsHard = /[.!?]$/.test(prevText);
    const endsSoft = /[,;:]$/.test(prevText);
    const phraseDur = w.startSec - current[0].startSec;

    const boundary =
      gap >= options.silenceGapSec ||
      (endsHard && gap >= 0.08) ||
      (endsSoft && gap >= 0.30) ||
      phraseDur >= options.maxPhraseSec;

    if (boundary) {
      pushPhrase();
    }
    current.push(w);
  }
  pushPhrase();

  // Merge fragments shorter than minPhraseChars into the following phrase.
  const merged: TakePhrase[] = [];
  for (const p of phrases) {
    if (p.text.length < options.minPhraseChars && merged.length > 0) {
      const last = merged[merged.length - 1];
      last.endSec = p.endSec;
      last.text = `${last.text} ${p.text}`.trim();
      last.words = [...last.words, ...p.words];
    } else {
      merged.push(p);
    }
  }

  return merged;
}

export interface BuildTakeInput {
  file: string;
  words: WordTiming[];
  durationSec: number;
  transcriber: string;
  ordinal: number;
  mode: 'asr' | 'aligned';
  defaultSpeaker?: string;
  /** Pre-computed phrase-level speaker labels when diarization is available. */
  phraseSpeakers?: string[];
  audioEvents?: AudioEvent[];
  packOptions?: PackOptions;
}

export function buildTake(input: BuildTakeInput): Take {
  const opts: Required<PackOptions> = { ...DEFAULT_OPTIONS, ...(input.packOptions ?? {}) };
  const speaker = input.defaultSpeaker ?? 'S0';
  let phrases = groupWordsIntoPhrases(input.words, speaker, opts);

  if (input.phraseSpeakers && input.phraseSpeakers.length === phrases.length) {
    phrases = phrases.map((p, i) => ({ ...p, speaker: input.phraseSpeakers![i] }));
  }

  return {
    id: deriveTakeId(input.file, input.ordinal),
    file: input.file,
    durationSec: input.durationSec,
    phrases,
    audioEvents: input.audioEvents ?? [],
    transcribedAt: new Date().toISOString(),
    transcriber: input.transcriber,
    mode: input.mode,
  };
}

function formatTimestamp(sec: number): string {
  return sec.toFixed(2).padStart(6, '0');
}

/**
 * Render a TakesPack to markdown. Each take becomes a `##` heading with
 * bracketed phrase timestamps inside — the exact format video-use uses.
 */
export function renderTakesPack(pack: TakesPack): string {
  const lines: string[] = [];
  lines.push('# Takes Pack');
  lines.push('');
  lines.push(`Generated: ${pack.generatedAt}`);
  lines.push(`Source: ${pack.sourceLabel}`);
  lines.push(`Takes: ${pack.takes.length}`);
  lines.push('');
  lines.push(
    'Format: each take is a heading with per-phrase `[start-end] speaker text` lines. ' +
      'Times are in seconds from the start of the source file. Speaker labels are from ' +
      'diarization (or the script) when available, otherwise `S0` single-speaker.',
  );
  lines.push('');

  for (const take of pack.takes) {
    const dur = take.durationSec.toFixed(1);
    const phraseCount = take.phrases.length;
    const fileRel = basename(take.file);
    lines.push(`## ${take.id}  (duration: ${dur}s, ${phraseCount} phrases)`);
    lines.push(`file: ${fileRel}`);
    if (take.mode === 'aligned') lines.push('mode: aligned (ground-truth script)');
    lines.push('');
    for (const p of take.phrases) {
      lines.push(
        `  [${formatTimestamp(p.startSec)}-${formatTimestamp(p.endSec)}] ${p.speaker} ${p.text}`,
      );
    }
    for (const ev of take.audioEvents) {
      lines.push(
        `  [${formatTimestamp(ev.startSec)}-${formatTimestamp(ev.endSec)}] _audio_ ${ev.label}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeTakesPack(pack: TakesPack, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderTakesPack(pack), 'utf-8');
}

/** Write `<source>.words.json` next to a take for programmatic consumers. */
export function writeWordsJson(take: Take, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const payload = {
    takeId: take.id,
    file: take.file,
    durationSec: take.durationSec,
    transcribedAt: take.transcribedAt,
    transcriber: take.transcriber,
    mode: take.mode,
    words: take.phrases.flatMap((p) => p.words.map((w) => ({ ...w, speaker: p.speaker }))),
    phrases: take.phrases.map((p) => ({
      speaker: p.speaker,
      startSec: p.startSec,
      endSec: p.endSec,
      text: p.text,
    })),
    audioEvents: take.audioEvents,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function wordsJsonPathFor(sourceFile: string, editDir: string): string {
  const stem = basename(sourceFile, extname(sourceFile));
  return `${editDir}/${stem}.words.json`;
}
