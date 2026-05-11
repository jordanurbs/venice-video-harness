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
// Threshold reference values (from EXT-2):
//   image: < 30_000 bytes at 1K  -> silent reject
//   video: < 100_000 bytes at 720p/5s -> silent reject
// ---------------------------------------------------------------------------

export const SILENT_REJECT_THRESHOLD_IMAGE = 30_000;
export const SILENT_REJECT_THRESHOLD_VIDEO = 100_000;

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
  buf: Buffer | Uint8Array,
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
  buf: Buffer | Uint8Array,
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
 * Decode a base64 image and assert it is not a silent rejection.
 * Returns the decoded buffer for downstream use.
 */
export function decodeAndAssertImage(
  b64: string,
  ctx: { model: string; prompt?: string; threshold?: number },
): Buffer {
  const buf = Buffer.from(b64, 'base64');
  assertNotSilentRejectImage(buf, ctx);
  return buf;
}
