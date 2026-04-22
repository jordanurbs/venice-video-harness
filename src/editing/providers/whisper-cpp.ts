/**
 * Whisper.cpp transcriber provider.
 *
 * Shells out to the `whisper-cpp` binary (install via `brew install whisper-cpp`).
 * Extracts audio to 16kHz mono WAV via ffmpeg, runs whisper.cpp with JSON output,
 * and parses word-level timestamps.
 *
 * whisper.cpp output format (--output-json-full):
 *   {
 *     "result": { "language": "en" },
 *     "transcription": [
 *       {
 *         "timestamps": { "from": "00:00:00,000", "to": "00:00:03,400" },
 *         "offsets": { "from": 0, "to": 3400 },
 *         "text": " Hello world.",
 *         "tokens": [
 *           { "offsets": { "from": 0, "to": 400 }, "text": " Hello", ... },
 *           ...
 *         ]
 *       }
 *     ]
 *   }
 *
 * Offsets are in milliseconds from the start of the source.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  TranscriberProvider,
  TranscribeOptions,
  TranscribeResult,
  WordTiming,
} from '../types.js';

interface WhisperCppToken {
  text: string;
  offsets: { from: number; to: number };
  /** Confidence 0..1 (whisper.cpp emits `p` for probability when available). */
  p?: number;
}

interface WhisperCppSegment {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperCppToken[];
}

interface WhisperCppOutput {
  result?: { language?: string };
  transcription: WhisperCppSegment[];
}

const MODEL_FILENAME: Record<NonNullable<TranscribeOptions['modelSize']>, string> = {
  'tiny': 'ggml-tiny.bin',
  'base': 'ggml-base.bin',
  'small': 'ggml-small.bin',
  'medium': 'ggml-medium.bin',
  'large': 'ggml-large-v3.bin',
  'tiny.en': 'ggml-tiny.en.bin',
  'base.en': 'ggml-base.en.bin',
  'small.en': 'ggml-small.en.bin',
  'medium.en': 'ggml-medium.en.bin',
};

/**
 * Search the usual places for a whisper.cpp model file. In order:
 *   1. $WHISPER_CPP_MODELS_DIR / <filename>
 *   2. /opt/homebrew/share/whisper-cpp/<filename>  (Apple Silicon brew)
 *   3. /usr/local/share/whisper-cpp/<filename>     (Intel brew)
 *   4. ~/.cache/whisper.cpp/<filename>
 */
function resolveModelPath(modelSize: NonNullable<TranscribeOptions['modelSize']>): string {
  const filename = MODEL_FILENAME[modelSize];
  const candidates = [
    process.env.WHISPER_CPP_MODELS_DIR
      ? join(process.env.WHISPER_CPP_MODELS_DIR, filename)
      : null,
    `/opt/homebrew/share/whisper-cpp/${filename}`,
    `/usr/local/share/whisper-cpp/${filename}`,
    join(process.env.HOME || '', '.cache', 'whisper.cpp', filename),
  ].filter((x): x is string => x !== null);

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    [
      `whisper.cpp model '${filename}' not found. Searched:`,
      ...candidates.map((c) => `  - ${c}`),
      '',
      'Download via:',
      `  curl -L -o ~/.cache/whisper.cpp/${filename} \\`,
      `    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`,
      '',
      'Or set WHISPER_CPP_MODELS_DIR to a directory that contains the file.',
    ].join('\n'),
  );
}

function resolveWhisperBinary(): string {
  for (const candidate of ['whisper-cli', 'whisper-cpp', 'main']) {
    const r = spawnSync('which', [candidate], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return candidate;
  }
  throw new Error(
    'whisper.cpp binary not found on PATH. Install with:\n' +
      '  brew install whisper-cpp\n' +
      '\n' +
      'This provides the `whisper-cli` binary (newer releases) or `whisper-cpp` (older).',
  );
}

function probeDuration(file: string): number {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`,
    { encoding: 'utf-8' },
  ).trim();
  const d = parseFloat(out);
  if (Number.isNaN(d)) throw new Error(`ffprobe could not read duration from ${file}`);
  return d;
}

function extractWav(file: string, wavPath: string): void {
  execSync(
    `ffmpeg -y -hide_banner -loglevel error -i "${file}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`,
    { stdio: 'inherit' },
  );
}

/**
 * Flatten whisper.cpp segment+token output into a flat word timing stream.
 *
 * whisper.cpp's "tokens" are BPE tokens, not words — they get merged into
 * words by concatenating adjacent tokens until we hit whitespace. For most
 * purposes the segment-level "text" split on whitespace is sufficient and
 * accurate enough; we allocate times proportionally when tokens are missing.
 */
function segmentsToWords(segments: WhisperCppSegment[]): WordTiming[] {
  const words: WordTiming[] = [];

  for (const seg of segments) {
    const segStartSec = seg.offsets.from / 1000;
    const segEndSec = seg.offsets.to / 1000;
    const segDur = Math.max(0.001, segEndSec - segStartSec);

    // Prefer token-level timestamps when available (whisper.cpp with
    // --word-thold and --max-len 1 emits per-word tokens).
    const tokenWords: WordTiming[] = [];
    if (seg.tokens && seg.tokens.length > 0) {
      // Merge tokens into words at whitespace boundaries.
      let buf: { text: string; from: number; to: number; p?: number } | null = null;
      for (const tok of seg.tokens) {
        const text = tok.text;
        // whisper.cpp emits [_BEG_], [_TT_XX], <|...|> special tokens; skip them.
        if (text.startsWith('[_') || text.startsWith('<|')) continue;
        const isWordStart = text.startsWith(' ') || buf === null;
        const trimmed = text.trim();
        if (!trimmed) continue;

        if (isWordStart) {
          if (buf) {
            tokenWords.push({
              word: buf.text,
              startSec: buf.from / 1000,
              endSec: buf.to / 1000,
              confidence: buf.p,
            });
          }
          buf = { text: trimmed, from: tok.offsets.from, to: tok.offsets.to, p: tok.p };
        } else if (buf) {
          buf.text += trimmed;
          buf.to = tok.offsets.to;
          if (tok.p !== undefined && buf.p !== undefined) {
            buf.p = Math.min(buf.p, tok.p);
          }
        }
      }
      if (buf) {
        tokenWords.push({
          word: buf.text,
          startSec: buf.from / 1000,
          endSec: buf.to / 1000,
          confidence: buf.p,
        });
      }
    }

    if (tokenWords.length > 0) {
      words.push(...tokenWords);
      continue;
    }

    // Fallback: split segment text evenly across its duration.
    const plainWords = seg.text
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    if (plainWords.length === 0) continue;
    const per = segDur / plainWords.length;
    for (let i = 0; i < plainWords.length; i++) {
      words.push({
        word: plainWords[i],
        startSec: segStartSec + i * per,
        endSec: segStartSec + (i + 1) * per,
      });
    }
  }

  return words;
}

export class WhisperCppProvider implements TranscriberProvider {
  readonly id = 'whisper-cpp';

  async assertAvailable(): Promise<void> {
    resolveWhisperBinary();
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
    if (r.status !== 0) {
      throw new Error('ffmpeg not found on PATH. Install via `brew install ffmpeg`.');
    }
  }

  async transcribe(file: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    const modelSize = options.modelSize ?? 'base.en';
    const language = options.language ?? 'auto';
    const wordThold = options.wordThreshold ?? 0.01;
    const threads = options.threads ?? Math.max(1, Math.min(8, Number(process.env.WHISPER_THREADS) || 4));

    const binary = resolveWhisperBinary();
    const modelPath = resolveModelPath(modelSize);
    const durationSec = probeDuration(file);

    const tmp = mkdtempSync(join(tmpdir(), 'whisper-cpp-'));
    const wav = join(tmp, 'audio.wav');
    const jsonBase = join(tmp, 'out');
    const jsonPath = `${jsonBase}.json`;

    try {
      extractWav(file, wav);

      const args = [
        '--model', modelPath,
        '--file', wav,
        '--output-json-full',
        '--output-file', jsonBase,
        '--word-thold', String(wordThold),
        '--max-len', '1',
        '--threads', String(threads),
        '--print-progress',
      ];
      if (language !== 'auto') {
        args.push('--language', language);
      }

      const r = spawnSync(binary, args, { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error(`${binary} exited with code ${r.status}`);
      }

      if (!existsSync(jsonPath)) {
        throw new Error(`whisper.cpp did not produce ${jsonPath}`);
      }
      const raw = readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as WhisperCppOutput;
      const words = segmentsToWords(parsed.transcription ?? []);
      const text = words.map((w) => w.word).join(' ');
      const detectedLang = parsed.result?.language ?? (language === 'auto' ? 'en' : language);

      return {
        words,
        text,
        language: detectedLang,
        durationSec,
        transcriberLabel: `whisper-cpp:${modelSize}`,
      };
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
