// ---------------------------------------------------------------------------
// Venice Video Upscale -- topaz-video-upscale (2x / 4x)
//
// Turns a finished render (e.g. episode-NNN-final.mp4 at 720p) into a 4K
// master. Because /video/queue accepts video_url as a base64 data URI and the
// gateway rejects large request bodies with HTTP 413 (observed at ~67MB of
// base64, i.e. ~50MB of video), inputs are split into keyframe-aligned
// chunks with ffmpeg (stream copy -- no quality loss), upscaled
// independently, concatenated (stream copy), and the original audio track is
// remuxed back untouched (Topaz strips audio: the model reports
// `audio: false`).
//
// API gotchas learned live (2026-07-30), encoded here so callers don't
// rediscover them:
// - /video/quote accepts `duration: "Auto"`; /video/queue does NOT -- it
//   requires the input video's real duration in seconds, as a STRING
//   (numbers are rejected with "Expected string, received number").
// - upscale models take `upscale_factor` (2 | 4) instead of `resolution`.
// - Pricing is per input second and identical for 2x and 4x
//   (~$0.12/s at 2520x1080 input), so 4x is the default here.
// - Input duration must not exceed 300s per request (another reason to
//   chunk); chunking also parallelizes nicely.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { VeniceClient } from './client.js';
import { pollVideoResult, completeVideo } from './video.js';
import type { VideoQueueResponse } from './types.js';

export const TOPAZ_VIDEO_UPSCALE_MODEL = 'topaz-video-upscale';

/**
 * Max size of a single chunk file sent as base64 `video_url`.
 * The Venice gateway 413s somewhere above ~50MB of raw video (~67MB base64);
 * 20MB chunks (~27MB base64) queue reliably with headroom.
 */
export const MAX_CHUNK_BYTES = 24 * 1024 * 1024;

/** Default segment length. At typical harness bitrates (~16Mbps 1080p-class),
 * 10s segments stay well under MAX_CHUNK_BYTES. */
export const DEFAULT_SEGMENT_SECONDS = 10;

export interface UpscaleVideoOptions {
  /** Input video path (mp4/mov). */
  inputPath: string;
  /** Output path for the final upscaled file. */
  outputPath: string;
  /** 2 or 4. Same price either way -- default 4. */
  factor?: 2 | 4;
  /** Segment length in seconds for chunking. Default 10. */
  segmentSeconds?: number;
  /** Parallel upscale jobs. Default 3. */
  concurrency?: number;
  /** Working directory for chunks (default: <output dir>/.upscale-work). Removed on success. */
  workDir?: string;
  /** Keep the work dir for debugging. */
  keepWorkDir?: boolean;
  onProgress?: (message: string) => void;
}

export interface UpscaleVideoResult {
  path: string;
  sizeBytes: number;
  chunks: number;
  inputSeconds: number;
  width: number;
  height: number;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function probeDuration(path: string): number {
  return parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).trim());
}

function probeDimensions(path: string): { width: number; height: number } {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', path]).trim();
  const [w, h] = out.split('x').map(Number);
  return { width: w, height: h };
}

function hasAudioStream(path: string): boolean {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path]).trim();
  return out.length > 0;
}

/**
 * Upscale a single chunk that already fits the payload budget.
 * Sends the raw /video/queue body directly: upscale models use
 * `upscale_factor` (not `resolution`) and require the real duration
 * in seconds as a string.
 */
export async function upscaleChunk(
  client: VeniceClient,
  chunkPath: string,
  outPath: string,
  factor: 2 | 4,
  onProgress?: (message: string) => void,
): Promise<void> {
  const duration = probeDuration(chunkPath);
  const data = await readFile(chunkPath);
  const videoUrl = `data:video/mp4;base64,${data.toString('base64')}`;

  const { queue_id } = await client.post<VideoQueueResponse>('/api/v1/video/queue', {
    model: TOPAZ_VIDEO_UPSCALE_MODEL,
    prompt: 'upscale',
    duration: duration.toFixed(2),
    upscale_factor: factor,
    video_url: videoUrl,
  });
  onProgress?.(`${basename(chunkPath)} queued (${queue_id})`);

  const buffer = await pollVideoResult(client, TOPAZ_VIDEO_UPSCALE_MODEL, queue_id, {
    // Upscale outputs are large and never blank -- skip the silent-reject
    // heuristic, which is tuned for generative outputs.
    skipSilentRejectCheck: true,
  });
  await writeFile(outPath, buffer);
  await completeVideo(client, TOPAZ_VIDEO_UPSCALE_MODEL, queue_id);
  onProgress?.(`${basename(chunkPath)} done (${(buffer.length / 1e6).toFixed(0)}MB)`);
}

/**
 * Upscale a full video of any size:
 * split (stream copy) -> upscale chunks (parallel) -> concat (stream copy)
 * -> remux original audio.
 */
export async function upscaleVideo(
  client: VeniceClient,
  options: UpscaleVideoOptions,
): Promise<UpscaleVideoResult> {
  const {
    inputPath,
    outputPath,
    factor = 4,
    segmentSeconds = DEFAULT_SEGMENT_SECONDS,
    concurrency = 3,
    keepWorkDir = false,
    onProgress,
  } = options;

  if (!existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const workDir = options.workDir ?? join(dirname(outputPath), '.upscale-work');
  mkdirSync(workDir, { recursive: true });

  const inputSeconds = probeDuration(inputPath);
  onProgress?.(`Input: ${inputSeconds.toFixed(1)}s -- splitting into ~${segmentSeconds}s chunks`);

  // Split video-only at keyframe boundaries (stream copy: lossless).
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', inputPath,
    '-an', '-c:v', 'copy',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1',
    join(workDir, 'chunk-%03d.mp4'),
  ]);

  const chunks: string[] = [];
  for (let i = 0; ; i++) {
    const p = join(workDir, `chunk-${String(i).padStart(3, '0')}.mp4`);
    if (!existsSync(p)) break;
    chunks.push(p);
  }
  if (chunks.length === 0) throw new Error('ffmpeg produced no chunks');

  for (const chunk of chunks) {
    const size = readFileSync(chunk).length;
    if (size > MAX_CHUNK_BYTES) {
      throw new Error(
        `Chunk ${basename(chunk)} is ${(size / 1e6).toFixed(0)}MB > ${(MAX_CHUNK_BYTES / 1e6).toFixed(0)}MB budget -- ` +
        `re-run with a smaller --segment-seconds (current: ${segmentSeconds})`,
      );
    }
  }
  onProgress?.(`${chunks.length} chunks, upscaling ${factor}x with concurrency ${concurrency}`);

  // Simple worker pool. Chunks that already have an output are skipped, so an
  // interrupted run resumes without re-paying for finished segments.
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const idx = next++;
      const chunk = chunks[idx];
      const out = chunk.replace('chunk-', 'up-');
      if (existsSync(out)) { onProgress?.(`${basename(out)} exists, skipping`); continue; }
      await upscaleChunk(client, chunk, out, factor, onProgress);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

  // Concat upscaled chunks (stream copy) and remux the original audio.
  const concatList = join(workDir, 'concat.txt');
  writeFileSync(concatList, chunks.map(c => `file '${basename(c).replace('chunk-', 'up-')}'`).join('\n') + '\n');

  const audioArgs = hasAudioStream(inputPath)
    ? ['-i', inputPath, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k']
    : ['-map', '0:v', '-c:v', 'copy'];
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatList,
    ...audioArgs,
    outputPath,
  ]);

  const { width, height } = probeDimensions(outputPath);
  const sizeBytes = readFileSync(outputPath).length;
  onProgress?.(`Final: ${outputPath} (${width}x${height}, ${(sizeBytes / 1e6).toFixed(0)}MB)`);

  if (!keepWorkDir) rmSync(workDir, { recursive: true, force: true });

  return { path: outputPath, sizeBytes, chunks: chunks.length, inputSeconds, width, height };
}

/**
 * Rough cost estimate without a quote round-trip: ~$0.12 per input second
 * (same for 2x and 4x), measured live 2026-07-30 on 2520x1080 input.
 */
export function estimateUpscaleCostUsd(inputSeconds: number): number {
  return inputSeconds * 0.12;
}
