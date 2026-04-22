#!/usr/bin/env tsx
/**
 * timeline-view.ts
 *
 * Produce a single PNG that summarizes a time range of a video for the
 * LLM: filmstrip across the top, waveform in the middle, word labels
 * and silence-gap markers underneath. Inspired by browser-use/video-use's
 * timeline_view composite.
 *
 * Usage:
 *   npx tsx scripts/timeline-view.ts \
 *     --video output/<project>/final.mp4 \
 *     --start 12.3 --end 16.1 \
 *     [--words output/<project>/edit/final.words.json] \
 *     --out /tmp/tl.png \
 *     [--width 1600] \
 *     [--frames 8]
 *
 * When `--words` is omitted, the composite still has a filmstrip and
 * waveform — useful as a visual check with no transcription.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { WordTiming } from '../src/editing/types.js';

interface Args {
  video: string;
  start: number;
  end: number;
  wordsJson: string | null;
  out: string;
  width: number;
  frames: number;
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
  const optional = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    return argv[idx + 1] ?? null;
  };
  const start = parseFloat(get('--start'));
  const end = parseFloat(get('--end'));
  if (!(end > start)) throw new Error('--end must be greater than --start');
  return {
    video: resolve(get('--video')),
    start,
    end,
    wordsJson: optional('--words'),
    out: resolve(get('--out')),
    width: parseInt(get('--width', '1600'), 10),
    frames: parseInt(get('--frames', '8'), 10),
    silenceDb: parseFloat(get('--silence-db', '-30')),
    silenceMin: parseFloat(get('--silence-min', '0.18')),
  };
}

function extractFilmstrip(
  video: string,
  startSec: number,
  endSec: number,
  frameCount: number,
  stripHeight: number,
  totalWidth: number,
  outPath: string,
): void {
  const duration = endSec - startSec;
  const step = duration / frameCount;
  const perFrameW = Math.floor(totalWidth / frameCount);
  // Extract N frames at evenly spaced offsets, tile them horizontally.
  // Use select + trim approach via a filter_complex with `tile`.
  // Simpler: extract at fps = frameCount / duration and take exactly N frames.
  const fps = frameCount / duration;
  const scale = `scale=${perFrameW}:${stripHeight}:force_original_aspect_ratio=decrease,pad=${perFrameW}:${stripHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const filter = `fps=${fps},${scale},tile=${frameCount}x1`;
  const cmd = [
    'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(startSec),
    '-i', `"${video}"`,
    '-t', String(duration),
    '-frames:v', '1',
    '-vf', `"${filter}"`,
    `"${outPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'inherit' });
}

function extractWaveform(
  video: string,
  startSec: number,
  endSec: number,
  width: number,
  height: number,
  outPath: string,
): void {
  const duration = endSec - startSec;
  const cmd = [
    'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(startSec),
    '-i', `"${video}"`,
    '-t', String(duration),
    '-filter_complex',
    `"[0:a]aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=0x00ff88:split_channels=0"`,
    '-frames:v', '1',
    `"${outPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'inherit' });
}

interface SilenceSpan {
  startSec: number;
  endSec: number;
}

function detectSilences(
  video: string,
  startSec: number,
  endSec: number,
  silenceDb: number,
  silenceMin: number,
): SilenceSpan[] {
  const duration = endSec - startSec;
  const cmd = [
    'ffmpeg', '-hide_banner', '-nostats',
    '-ss', String(startSec),
    '-i', `"${video}"`,
    '-t', String(duration),
    '-af', `"silencedetect=noise=${silenceDb}dB:d=${silenceMin}"`,
    '-f', 'null', '-',
    '2>&1',
  ].join(' ');
  const out = execSync(cmd, { encoding: 'utf-8' });
  const silences: SilenceSpan[] = [];
  const lines = out.split('\n');
  let pending: number | null = null;
  for (const line of lines) {
    const s = line.match(/silence_start: ([\d.]+)/);
    if (s) {
      pending = parseFloat(s[1]);
      continue;
    }
    const e = line.match(/silence_end: ([\d.]+) \| silence_duration:/);
    if (e && pending !== null) {
      silences.push({ startSec: pending + startSec, endSec: parseFloat(e[1]) + startSec });
      pending = null;
    }
  }
  return silences;
}

interface WordsJson {
  words: Array<WordTiming & { speaker?: string }>;
}

function loadWords(path: string | null): Array<WordTiming & { speaker?: string }> {
  if (!path) return [];
  if (!existsSync(path)) {
    console.error(`[timeline-view] --words file not found: ${path} (proceeding without word labels)`);
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as WordsJson;
  return parsed.words ?? [];
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build an SVG overlay with word labels and silence-gap markers.
 * Rendered on top of the waveform strip by sharp.
 */
function buildAnnotationSvg(
  width: number,
  height: number,
  startSec: number,
  endSec: number,
  words: Array<WordTiming & { speaker?: string }>,
  silences: SilenceSpan[],
): string {
  const duration = endSec - startSec;
  const secToX = (s: number) => ((s - startSec) / duration) * width;

  const elems: string[] = [];

  // Background stripe behind labels for contrast
  elems.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="0.75" />`,
  );

  // Silence markers — vertical translucent red bands
  for (const sil of silences) {
    const x1 = Math.max(0, secToX(sil.startSec));
    const x2 = Math.min(width, secToX(sil.endSec));
    const w = Math.max(1, x2 - x1);
    elems.push(
      `<rect x="${x1.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="#ff3366" fill-opacity="0.18" />`,
    );
    elems.push(
      `<line x1="${x1.toFixed(1)}" y1="0" x2="${x1.toFixed(1)}" y2="${height}" stroke="#ff3366" stroke-width="1" stroke-opacity="0.8" stroke-dasharray="4 3" />`,
    );
  }

  // Time ticks every 1s
  const firstTick = Math.ceil(startSec);
  for (let t = firstTick; t <= endSec; t++) {
    const x = secToX(t);
    elems.push(
      `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="8" stroke="white" stroke-width="1" stroke-opacity="0.5" />`,
    );
    elems.push(
      `<text x="${x.toFixed(1)}" y="20" fill="white" fill-opacity="0.8" font-family="Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle">${t.toFixed(0)}s</text>`,
    );
  }

  // Word labels — stagger into 2 rows to avoid overlap
  const inRange = words.filter((w) => w.endSec >= startSec && w.startSec <= endSec);
  const rowHeight = 14;
  const rowBase = 36;
  let lastXRow0 = -9999;
  let lastXRow1 = -9999;
  for (const w of inRange) {
    const wx = secToX(w.startSec);
    const wEnd = secToX(w.endSec);
    // Word tick (bottom-pointing)
    elems.push(
      `<line x1="${wx.toFixed(1)}" y1="24" x2="${wx.toFixed(1)}" y2="32" stroke="#00ff88" stroke-width="1" stroke-opacity="0.9" />`,
    );
    // Word box shading — light green
    elems.push(
      `<rect x="${wx.toFixed(1)}" y="${(rowBase - 2).toFixed(1)}" width="${Math.max(1, wEnd - wx).toFixed(1)}" height="2" fill="#00ff88" fill-opacity="0.6" />`,
    );
    const text = escapeSvgText(w.word);
    const approxW = text.length * 5 + 6;
    let row: 0 | 1 = 0;
    if (wx < lastXRow0 + approxW) {
      row = 1;
      if (wx < lastXRow1 + approxW) row = 0;
    }
    if (row === 0) lastXRow0 = wx;
    else lastXRow1 = wx;
    const ty = rowBase + 8 + row * rowHeight;
    elems.push(
      `<text x="${wx.toFixed(1)}" y="${ty.toFixed(1)}" fill="white" font-family="Helvetica, Arial, sans-serif" font-size="10" text-anchor="start">${text}</text>`,
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    elems.join('\n'),
    `</svg>`,
  ].join('\n');
}

function buildHeaderSvg(
  width: number,
  height: number,
  video: string,
  startSec: number,
  endSec: number,
  silences: SilenceSpan[],
  words: Array<WordTiming & { speaker?: string }>,
): string {
  const dur = (endSec - startSec).toFixed(2);
  const silenceTotal = silences.reduce((acc, s) => acc + (s.endSec - s.startSec), 0).toFixed(2);
  const wordCount = words.filter((w) => w.endSec >= startSec && w.startSec <= endSec).length;
  const short = video.length > 60 ? `...${video.slice(-57)}` : video;
  const title = `${escapeSvgText(short)}   |   ${startSec.toFixed(2)}s - ${endSec.toFixed(2)}s  (${dur}s)   |   words ${wordCount}   |   silence ${silenceTotal}s`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#111" />`,
    `<text x="12" y="${(height * 0.65).toFixed(1)}" fill="white" font-family="Helvetica, Arial, sans-serif" font-size="13">${title}</text>`,
    `</svg>`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.video)) {
    throw new Error(`--video not found: ${args.video}`);
  }

  const headerH = 28;
  const filmH = 140;
  const waveH = 120;
  const annH = 90;
  const totalH = headerH + filmH + waveH + annH;

  const tmp = mkdtempSync(join(tmpdir(), 'tl-view-'));
  const filmPath = join(tmp, 'film.png');
  const wavePath = join(tmp, 'wave.png');

  try {
    extractFilmstrip(args.video, args.start, args.end, args.frames, filmH, args.width, filmPath);
    extractWaveform(args.video, args.start, args.end, args.width, waveH, wavePath);

    const words = loadWords(args.wordsJson);
    const silences = detectSilences(args.video, args.start, args.end, args.silenceDb, args.silenceMin);

    const headerSvg = buildHeaderSvg(args.width, headerH, args.video, args.start, args.end, silences, words);
    const annSvg = buildAnnotationSvg(args.width, annH, args.start, args.end, words, silences);

    const canvas = sharp({
      create: {
        width: args.width,
        height: totalH,
        channels: 4,
        background: { r: 17, g: 17, b: 17, alpha: 1 },
      },
    });

    const composite = await canvas
      .composite([
        { input: Buffer.from(headerSvg), top: 0, left: 0 },
        { input: filmPath, top: headerH, left: 0 },
        { input: wavePath, top: headerH + filmH, left: 0 },
        { input: Buffer.from(annSvg), top: headerH + filmH + waveH, left: 0 },
      ])
      .png()
      .toBuffer();

    mkdirSync(dirname(args.out), { recursive: true });
    await sharp(composite).toFile(args.out);
    console.error(`[timeline-view] Wrote ${args.out}`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// Verify sharp binding works before running — emits a clearer error than
// the composite call's internal assertion.
spawnSync('node', ['-e', 'require("sharp")'], { stdio: 'ignore' });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
