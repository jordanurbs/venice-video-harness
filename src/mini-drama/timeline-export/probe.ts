// ---------------------------------------------------------------------------
// Format-neutral helpers shared across all timeline exporters.
//
// Pure utilities — no exporter-specific logic. The FCPXML, Premiere, and
// DaVinci exporters all share these.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative as relPath } from 'node:path';
import type { TimelineSegment } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Convert a duration in seconds to FCPXML's rational form, snapped to the
 * nearest frame boundary.
 *
 * Example: `toRationalTime(181.04, 24)` → `"4345/24s"`.
 */
export function toRationalTime(seconds: number, fps: number): string {
  const frames = Math.max(0, Math.round(seconds * fps));
  return `${frames}/${fps}s`;
}

/**
 * Convert a duration in seconds to an integer frame count.
 *
 * Premiere's xmeml v5 uses integer frames for `start` / `end` / `in` / `out`
 * fields — NOT the rational FCPXML form.
 */
export function toFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
}

/**
 * Convert a filesystem path to a `file://` URI. URI-encodes spaces and most
 * special characters but leaves `/` and `:` alone.
 *
 * Used by FCPXML 1.10 (`<media-rep src>`) and Premiere xmeml v5 (`<pathurl>`).
 * The DaVinci exporter has its own variant that avoids URI encoding for
 * non-ASCII paths on Linux Resolve versions.
 */
export function pathToFileUri(p: string): string {
  return 'file://' + encodeURI(p).replace(/'/g, '%27');
}

/**
 * Build the `src` value for a media reference, either an absolute `file://`
 * URI or a path RELATIVE to the XML document's directory.
 *
 * Relative form (e.g. `./scene-001/shot-001.mp4`) is what makes an exported
 * timeline portable: Apple's FCPXML `media-rep` spec explicitly allows a URL
 * "relative to the location of the FCPXML document", and DaVinci Resolve /
 * Premiere honor it too. As long as the `.fcpxml` travels with its media in
 * the same relative layout (the harness always writes it beside `scene-001/`
 * and `audio/`), the media resolves on any machine. Absolute paths never
 * survive a move without a manual relink.
 *
 * @param relativeTo  When set, emit a relative path from this directory.
 *                    When omitted, emit an absolute `file://` URI.
 * @param encode      URI-encode the result (true for FCPXML/Premiere; false
 *                    for the DaVinci variant, which takes raw paths).
 */
export function pathToMediaSrc(
  p: string,
  opts: { relativeTo?: string; encode?: boolean } = {},
): string {
  const { relativeTo, encode = true } = opts;
  if (relativeTo) {
    let rel = relPath(relativeTo, p);
    // Keep URL slashes; on macOS/Linux path.relative already uses '/'.
    rel = rel.split(/[\\/]/).join('/');
    if (!rel.startsWith('.') && !rel.startsWith('/')) rel = `./${rel}`;
    return encode ? encodeURI(rel).replace(/'/g, '%27') : rel;
  }
  return encode ? 'file://' + encodeURI(p).replace(/'/g, '%27') : 'file://' + p;
}

/**
 * Escape a string for inclusion in XML text or attribute values.
 *
 * Handles the five XML entity characters. Suitable for both element content
 * and attribute values; the result is safe to drop into either context.
 */
export function xmlEscape(s: string): string {
  return String(s).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]!));
}

/**
 * ffprobe wrapper returning normalized audio info for a single file.
 *
 * Returns sane defaults (48 kHz / stereo) if the probe fails or the file
 * has no audio stream. The FCPXML 1.10 exporter requires both
 * `audioRate` and `audioChannels` on every `<asset>` declaration; lying
 * about either is fine as long as the values exist.
 */
export async function probeAudioInfo(path: string): Promise<{
  durSec: number;
  sampleRate: number;
  channels: number;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    path,
  ]);
  const j = JSON.parse(stdout);
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  return {
    durSec: parseFloat(a?.duration ?? j.format.duration ?? '0'),
    sampleRate: parseInt(a?.sample_rate ?? '48000', 10),
    channels: parseInt(a?.channels ?? '2', 10),
  };
}

/**
 * Locate the spine segment index that contains a given timeline timestamp.
 *
 * Past-end timestamps clamp to the last segment so off-by-frame audio
 * placement at the very end of the episode still emits a clip rather than
 * being dropped.
 */
export function segmentContaining(segments: TimelineSegment[], timeSec: number): number {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (timeSec >= s.startSec && timeSec < s.startSec + s.durSec) return i;
  }
  return Math.max(0, segments.length - 1);
}
