// ---------------------------------------------------------------------------
// Shared post-processing for /image/multi-edit results.
//
// Venice multi-edit always returns 1024x1024 PNG (sometimes WebP bytes in
// PNG clothing) regardless of input dimensions. Every consumer of multi-edit
// output — the panel fixer's repair passes AND the reference-drafted panel
// path — needs the same two steps:
//
//   1. ensureRealPng     — transcode WebP-disguised-as-PNG to real PNG
//   2. restoreAspectRatio — center-crop the 1:1 output back to the panel's
//                           aspect ratio and scale to target dimensions
//
// Extracted from mini-drama/panel-fixer.ts (2026-08-11) so panel drafting
// via multi-edit (the fix for generateWithReferences never sending reference
// bytes) shares one implementation instead of duplicating the crop math.
//
// WARNING (inherited from panel-fixer): for 16:9 targets the 1:1→16:9 crop
// removes ~25% from top and bottom. Close-up face shots can lose foreheads
// and chins — callers should warn or route close-ups differently.
// ---------------------------------------------------------------------------

import { readFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** Read `WxH` for an image file via ffprobe. Returns null when unparsable. */
export function getImageDimensions(filePath: string): [number, number] | null {
  const info = runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0:s=x',
    filePath,
  ]).trim();
  const match = info.match(/^(\d+)x(\d+)$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Convert WebP-disguised PNGs to real PNGs in place (Venice returns WebP
 * internally). Ensures multi-edit gets proper PNG input and dimensions
 * parse correctly.
 */
export async function ensureRealPng(filePath: string): Promise<void> {
  const raw = await readFile(filePath);
  const isWebp =
    raw.length >= 12 &&
    raw.subarray(0, 4).toString('ascii') === 'RIFF' &&
    raw.subarray(8, 12).toString('ascii') === 'WEBP';
  if (isWebp) {
    const tmpPath = filePath.replace(/\.png$/, '-webp-conv.png');
    runCommand('ffmpeg', ['-i', filePath, '-y', tmpPath]);
    await rename(tmpPath, filePath);
  }
}

/**
 * Center-crop `filePath` to the target aspect ratio, then scale to the
 * target dimensions (lanczos). No-op when the ratios already match.
 */
export async function restoreAspectRatio(
  filePath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<void> {
  const dims = getImageDimensions(filePath);
  if (!dims) return;
  const [curW, curH] = dims;
  if (curW === targetWidth && curH === targetHeight) return;

  const targetRatio = targetWidth / targetHeight;
  const curRatio = curW / curH;

  // Only crop if aspect ratios actually differ
  if (Math.abs(targetRatio - curRatio) < 0.01) return;

  let cropW: number, cropH: number;
  if (targetRatio < curRatio) {
    // Target is taller (e.g. 9:16) -- crop width, keep height
    cropH = curH;
    cropW = Math.round(curH * targetRatio);
  } else {
    // Target is wider -- crop height, keep width
    cropW = curW;
    cropH = Math.round(curW / targetRatio);
  }

  const cropX = Math.round((curW - cropW) / 2);
  const cropY = Math.round((curH - cropH) / 2);

  const tmpPath = filePath.replace(/\.png$/, '-crop-tmp.png');
  runCommand('ffmpeg', [
    '-i',
    filePath,
    '-vf',
    `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${targetWidth}:${targetHeight}:flags=lanczos`,
    '-y',
    tmpPath,
  ]);
  await rename(tmpPath, filePath);
  console.log(`  Restored aspect ratio: ${curW}x${curH} → ${targetWidth}x${targetHeight}`);
}

/**
 * Parse an `"W:H"` aspect-ratio string into target pixel dimensions at the
 * given long-edge budget (default 1376, the harness's 1K panel long edge).
 * Returns null for unparsable input.
 */
export function aspectRatioToDimensions(
  aspectRatio: string,
  longEdge = 1376,
): [number, number] | null {
  const m = aspectRatio.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  if (w >= h) {
    return [longEdge, Math.round((longEdge * h) / w / 2) * 2];
  }
  return [Math.round((longEdge * w) / h / 2) * 2, longEdge];
}
