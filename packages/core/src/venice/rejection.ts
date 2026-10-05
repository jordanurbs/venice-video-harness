// ---------------------------------------------------------------------------
// Silent-rejection guard for Venice API responses.
//
// Venice's image and video endpoints sometimes return HTTP 200 with a tiny
// placeholder (7-byte WebP, sub-100KB MP4) when content moderation silently
// rejects a prompt. Downstream pipelines then process the placeholder as if
// it were real media. This module exposes:
//
//   - byte-size thresholds for image and video responses,
//   - a typed `VeniceRejectionError` callers can catch and rephrase against,
//   - `assertNotSilentReject{Image,Video}` helpers that throw before writing
//     placeholder bytes to disk.
//
// Threshold reference values (from ):
//   image: < 30_000 bytes at 1K  -> silent reject
//   video: < 100_000 bytes at 720p/5s -> silent reject
// ---------------------------------------------------------------------------

export const SILENT_REJECT_THRESHOLD_IMAGE = 30_000;
export const SILENT_REJECT_THRESHOLD_VIDEO = 100_000;

/**
 * Per-resolution image thresholds. The flat 30_000 ceiling lets some real
 * rejections slip through at 1K (the LEGISLATOR profile in the PNW
 * field-guide came back as a ~2 KB refusal stub which is well under 30 KB
 * but we need a wider margin at 1K to catch noisier rejections that still
 * compress lower than a real photo). Conversely small-resolution outputs
 * can legitimately be under 30 KB.
 *
 * Lookup with `thresholdForResolution(res)`; unknown values fall back to
 * the flat default.
 */
export const SILENT_REJECT_THRESHOLDS_BY_RESOLUTION: Record<string, number> = {
  '512x512': 20_000,
  '512': 20_000,
  '720p': 30_000,
  '1K': 50_000,
  '1k': 50_000,
  '1080p': 75_000,
  '2K': 150_000,
  '2k': 150_000,
  '4K': 400_000,
  '4k': 400_000,
};

export function thresholdForResolution(res?: string): number {
  if (!res) return SILENT_REJECT_THRESHOLD_IMAGE;
  return SILENT_REJECT_THRESHOLDS_BY_RESOLUTION[res] ?? SILENT_REJECT_THRESHOLD_IMAGE;
}

export interface VeniceRejectionInfo {
  model: string;
  prompt?: string;
  byteSize: number;
  threshold: number;
  kind: 'image' | 'video';
  message?: string;
}

export class VeniceRejectionError extends Error {
  readonly kind: 'image' | 'video';
  readonly model: string;
  readonly prompt?: string;
  readonly byteSize: number;
  readonly threshold: number;

  constructor(info: VeniceRejectionInfo) {
    const detail =
      info.message ??
      `Response under threshold (${info.byteSize}b < ${info.threshold}b) — silent moderation reject suspected`;
    super(`[VeniceRejection:${info.kind}] ${info.model} :: ${detail}`);
    this.name = 'VeniceRejectionError';
    this.kind = info.kind;
    this.model = info.model;
    this.prompt = info.prompt;
    this.byteSize = info.byteSize;
    this.threshold = info.threshold;
  }
}

/**
 * Throw if an image buffer is below the silent-reject threshold.
 *
 * Pass the decoded image bytes (NOT the base64 string). The threshold is
 * calibrated for 1K outputs; smaller resolutions may need an override.
 */
export function assertNotSilentRejectImage(
  buf: Uint8Array,
  ctx: { model: string; prompt?: string; threshold?: number },
): void {
  const threshold = ctx.threshold ?? SILENT_REJECT_THRESHOLD_IMAGE;
  if (buf.length < threshold) {
    throw new VeniceRejectionError({
      kind: 'image',
      model: ctx.model,
      prompt: ctx.prompt,
      byteSize: buf.length,
      threshold,
    });
  }
}

/**
 * Throw if a video buffer is below the silent-reject threshold.
 *
 * Pass the downloaded MP4 bytes. Threshold calibrated for 720p/5s clips;
 * very short or low-resolution clips may need an override.
 */
export function assertNotSilentRejectVideo(
  buf: Uint8Array,
  ctx: { model: string; prompt?: string; threshold?: number },
): void {
  const threshold = ctx.threshold ?? SILENT_REJECT_THRESHOLD_VIDEO;
  if (buf.length < threshold) {
    throw new VeniceRejectionError({
      kind: 'video',
      model: ctx.model,
      prompt: ctx.prompt,
      byteSize: buf.length,
      threshold,
    });
  }
}

/**
 * Decode base64 to bytes without Node's `Buffer`, so this module runs in a
 * browser as well as the CLI. `atob` is available in Node >= 16 and every
 * browser.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Decode a base64 image and assert it is not a silent rejection.
 * Returns the decoded bytes for downstream use. Callers in Node that need a
 * `Buffer` can wrap with `Buffer.from(bytes)` (zero-copy).
 */
export function decodeAndAssertImage(
  b64: string,
  ctx: { model: string; prompt?: string; threshold?: number },
): Uint8Array {
  const bytes = base64ToBytes(b64);
  assertNotSilentRejectImage(bytes, ctx);
  return bytes;
}
