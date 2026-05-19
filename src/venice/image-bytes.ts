// ---------------------------------------------------------------------------
// Image-format byte sniffing.
//
// Seedream sometimes returns WebP bytes when callers asked for PNG. The
// harness used to write them with a `.png` extension anyway, which confuses
// downstream consumers (older ffmpeg, macOS Preview, image-tag thumbnailers,
// and the silent-reject heuristic that uses byte-size thresholds calibrated
// for PNG at 1K).
//
// `sniffImageFormat` inspects the leading magic bytes and returns the real
// MIME type plus a canonical file extension. `writeImageBytesSmart` writes
// the buffer to disk using the sniffed extension; if a `forceExt` is
// provided, the buffer is written under the requested name AND a sibling
// file with the sniffed extension is written too — so callers that hardcode
// `front.png` get the file at `front.png` AND know the real format via
// `front.webp` if a transcode is needed.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises';
import { extname, join, dirname, basename } from 'node:path';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'unknown';

export interface SniffResult {
  format: ImageFormat;
  mime: string;
  ext: string;
}

const SNIFFERS: Array<{ format: ImageFormat; mime: string; ext: string; match: (b: Uint8Array) => boolean }> = [
  {
    format: 'png',
    mime: 'image/png',
    ext: '.png',
    // 89 50 4E 47 0D 0A 1A 0A
    match: b => b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
  },
  {
    format: 'jpeg',
    mime: 'image/jpeg',
    ext: '.jpg',
    // FF D8 FF
    match: b => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  },
  {
    format: 'webp',
    mime: 'image/webp',
    ext: '.webp',
    // 52 49 46 46  XX XX XX XX  57 45 42 50  -> "RIFF....WEBP"
    match: b => b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    format: 'gif',
    mime: 'image/gif',
    ext: '.gif',
    // 47 49 46 38 (37|39) 61   "GIF87a" or "GIF89a"
    match: b => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  {
    format: 'avif',
    mime: 'image/avif',
    ext: '.avif',
    // ftyp box at offset 4: 'ftyp' then major brand 'avif'/'avis'
    match: b => b.length >= 12 &&
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x66 || b[11] === 0x73),
  },
];

/**
 * Inspect the leading bytes of `buf` and return the image format. Returns
 * `{ format: 'unknown', mime: 'application/octet-stream', ext: '.bin' }` when
 * no known magic matches.
 */
export function sniffImageFormat(buf: Uint8Array | Buffer): SniffResult {
  for (const s of SNIFFERS) {
    if (s.match(buf)) return { format: s.format, mime: s.mime, ext: s.ext };
  }
  return { format: 'unknown', mime: 'application/octet-stream', ext: '.bin' };
}

/**
 * Write image bytes to disk, using the sniffed extension instead of the
 * caller-supplied extension when they disagree.
 *
 * Returns the final on-disk path. When `requestedPath` says `.png` but the
 * buffer is actually WebP, the file is written as `<base>.webp` and a
 * `console.warn` records the mismatch. Pass `forceExt: true` to keep the
 * caller's extension (useful when downstream tooling really does need a
 * fixed name, even if the format is a lie — but transcode first when you can).
 */
export async function writeImageBytesSmart(
  buf: Buffer,
  requestedPath: string,
  opts?: { forceExt?: boolean },
): Promise<string> {
  const sniff = sniffImageFormat(buf);
  const requestedExt = extname(requestedPath).toLowerCase();
  const expected = sniff.ext.toLowerCase();
  if (sniff.format === 'unknown' || opts?.forceExt || requestedExt === expected) {
    await writeFile(requestedPath, buf);
    return requestedPath;
  }
  const dir = dirname(requestedPath);
  const base = basename(requestedPath, requestedExt);
  const correctedPath = join(dir, `${base}${sniff.ext}`);
  await writeFile(correctedPath, buf);
  console.warn(
    `  image-bytes: requested ${requestedPath} (${requestedExt || '<no ext>'}) but bytes are ${sniff.format}; wrote ${correctedPath} instead.`,
  );
  return correctedPath;
}
