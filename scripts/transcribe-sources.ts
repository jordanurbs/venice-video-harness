#!/usr/bin/env tsx
/**
 * transcribe-sources.ts
 *
 * Walks a folder of audio/video files and produces:
 *   - `<source>.words.json` next to each source (or in --out-dir)
 *   - `takes_packed.md` aggregating all sources as a 12KB LLM-readable pack
 *
 * Usage:
 *   npx tsx scripts/transcribe-sources.ts \
 *     --dir output/<project>/shots \
 *     --out output/<project>/edit/takes_packed.md \
 *     [--model base.en] \
 *     [--language en] \
 *     [--include '*.mp4,*.mov,*.wav,*.mp3'] \
 *     [--aligned-from scripts/<project>/config.ts] \
 *     [--speaker-map scripts/<project>/speaker-map.json]
 *
 * Ground-truth alignment mode (`--aligned-from`): if the target file exports
 * `VO_TEXT` (parsed via the same logic as derive-captions.ts) the transcriber
 * runs in aligned mode and maps whisper's detected words onto the canonical
 * script words. Use this for Venice-generated content where you have the
 * script.
 *
 * Speaker map (`--speaker-map`): optional JSON `{ "<basename>": "Character Name" }`
 * to label each source with its speaker. Defaults to `S0` for all sources.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { WhisperCppProvider } from '../src/editing/providers/whisper-cpp.js';
import { alignScriptToWords, detectTruncation } from '../src/editing/aligner.js';
import {
  buildTake,
  writeTakesPack,
  writeWordsJson,
  wordsJsonPathFor,
} from '../src/editing/packer.js';
import type { TakesPack, WordTiming } from '../src/editing/types.js';

interface Args {
  dir: string;
  out: string;
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'tiny.en' | 'base.en' | 'small.en' | 'medium.en';
  language: string;
  include: string[];
  alignedFrom: string | null;
  speakerMap: string | null;
  wordsOutDir: string | null;
  label: string | null;
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
  const optional = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    const v = argv[idx + 1];
    return v ?? null;
  };
  const include = get('--include', '*.mp4,*.mov,*.m4a,*.wav,*.mp3,*.mkv,*.webm')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const modelRaw = get('--model', 'base.en');
  const validModels = ['tiny', 'base', 'small', 'medium', 'large', 'tiny.en', 'base.en', 'small.en', 'medium.en'];
  if (!validModels.includes(modelRaw)) {
    throw new Error(`Invalid --model ${modelRaw}. Expected one of: ${validModels.join(', ')}`);
  }
  return {
    dir: resolve(get('--dir')),
    out: resolve(get('--out')),
    model: modelRaw as Args['model'],
    language: get('--language', 'auto'),
    include,
    alignedFrom: optional('--aligned-from'),
    speakerMap: optional('--speaker-map'),
    wordsOutDir: optional('--words-out-dir'),
    label: optional('--label'),
  };
}

function matchesAnyGlob(name: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    const regex = new RegExp(
      '^' +
        pat
          .split(/([*?])/g)
          .map((part) => {
            if (part === '*') return '.*';
            if (part === '?') return '.';
            return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          })
          .join('') +
        '$',
      'i',
    );
    if (regex.test(name)) return true;
  }
  return false;
}

function listSources(dir: string, patterns: string[]): string[] {
  if (!existsSync(dir)) {
    throw new Error(`--dir does not exist: ${dir}`);
  }
  const s = statSync(dir);
  if (!s.isDirectory()) {
    throw new Error(`--dir is not a directory: ${dir}`);
  }
  const entries = readdirSync(dir);
  const matches: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    if (matchesAnyGlob(entry, patterns)) matches.push(full);
  }
  matches.sort((a, b) => a.localeCompare(b));
  return matches;
}

function loadSpeakerMap(path: string): Record<string, string> {
  const abs = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`--speaker-map does not exist: ${abs}`);
  }
  const raw = readFileSync(abs, 'utf-8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--speaker-map must be a JSON object');
  }
  return parsed;
}

/**
 * Parse a VO_TEXT array literal from a .ts config file (same algorithm
 * as derive-captions.ts, duplicated to avoid cross-script imports).
 */
function loadVoTextScript(file: string): string {
  const src = readFileSync(file, 'utf-8');
  const startIdx = src.indexOf('VO_TEXT');
  if (startIdx === -1) {
    throw new Error(`No VO_TEXT export found in ${file}`);
  }
  const arrStart = src.indexOf('[', startIdx);
  if (arrStart === -1) {
    throw new Error(`VO_TEXT is not an array in ${file}`);
  }
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd === -1) throw new Error(`Unclosed array literal in ${file}`);
  const body = src.slice(arrStart + 1, arrEnd);
  const phrases: string[] = [];
  const stringRe = /"((?:\\"|[^"])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(body))) {
    phrases.push(m[1].replace(/\\"/g, '"'));
  }
  return phrases.join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const provider = new WhisperCppProvider();
  await provider.assertAvailable();

  const sources = listSources(args.dir, args.include);
  if (sources.length === 0) {
    console.error(
      `[transcribe-sources] No sources matched in ${args.dir} for patterns: ${args.include.join(', ')}`,
    );
    process.exit(1);
  }
  console.error(`[transcribe-sources] Found ${sources.length} sources in ${args.dir}`);

  const speakerMap = args.speakerMap ? loadSpeakerMap(args.speakerMap) : null;
  const script = args.alignedFrom ? loadVoTextScript(resolve(args.alignedFrom)) : null;

  const pack: TakesPack = {
    takes: [],
    generatedAt: new Date().toISOString(),
    sourceLabel: args.label ?? args.dir,
  };

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    console.error(`[transcribe-sources] (${i + 1}/${sources.length}) ${basename(source)}`);

    const result = await provider.transcribe(source, {
      modelSize: args.model,
      language: args.language === 'auto' ? undefined : args.language,
    });

    let words: WordTiming[] = result.words;
    let mode: 'asr' | 'aligned' = 'asr';
    if (script) {
      const aligned = alignScriptToWords(script, words);
      if (aligned.length > 0) {
        words = aligned;
        mode = 'aligned';
      }
      const trunc = detectTruncation(script, result.words);
      if (trunc.truncated) {
        console.error(
          `[transcribe-sources]   WARNING: possible VO truncation — ${trunc.lostWords.length} script words after ${trunc.lastAlignedSec.toFixed(2)}s. Lost tail: "${trunc.lostWords.slice(0, 10).join(' ')}${trunc.lostWords.length > 10 ? '...' : ''}"`,
        );
      }
    }

    const speaker =
      speakerMap?.[basename(source)] ??
      speakerMap?.[basename(source, extname(source))] ??
      'S0';

    const take = buildTake({
      file: source,
      words,
      durationSec: result.durationSec,
      transcriber: result.transcriberLabel,
      ordinal: i,
      mode,
      defaultSpeaker: speaker,
    });

    const wordsOutDir = args.wordsOutDir ? resolve(args.wordsOutDir) : args.dir;
    const wordsPath = wordsJsonPathFor(source, wordsOutDir);
    writeWordsJson(take, wordsPath);
    console.error(
      `[transcribe-sources]   -> ${wordsPath} (${take.phrases.length} phrases)`,
    );

    pack.takes.push(take);
  }

  writeTakesPack(pack, args.out);
  const totalPhrases = pack.takes.reduce((acc, t) => acc + t.phrases.length, 0);
  console.error(
    `[transcribe-sources] Wrote ${args.out} (${pack.takes.length} takes, ${totalPhrases} phrases)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
