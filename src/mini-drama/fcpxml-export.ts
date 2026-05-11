// ---------------------------------------------------------------------------
// EXT-14: FCPXML 1.10 export.
//
// Emits a Final Cut Pro X 1.10 XML that imports cleanly with:
//   - one <format> declaration sized to the series' aspect ratio + fps
//   - one <asset> per unique video segment AND per unique audio file, each
//     with a child <media-rep kind="original-media" src="file://...">.
//     (FCPXML 1.10 puts src on <media-rep>, NOT on <asset> itself — putting
//     it on <asset> fails DTD validation.)
//   - per-asset audioRate + audioChannels probed from each file
//   - primary storyline: one <asset-clip> per video segment in sequence, with
//     <adjust-volume amount="-96dB"/> to mute the segment's silent audio
//   - connected audio MUST be children of their containing primary clip (NOT
//     siblings on the spine). Each child <audio> uses lane="-N" (negative =
//     connected below primary) and an offset expressed in the parent's local
//     media time (= timeline offset − parent's spine offset).
//   - lane plan: -1 dialogue (role dialogue.dialogue), -2 SFX (effects.effects),
//     -3 music (music.music).
//   - time format: rational `<frames>/<fps>s` (e.g. 4345/24s = 181.04s @24fps).
//     Snap to frame boundary.
//
// Working reference: scripts/glass-export-fcpxml-v6.mjs.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Types ----------------------------------------------------------------

export interface FcpxmlSegment {
  /** Path to the video file (mp4). */
  path: string;
  /** Display label. */
  label: string;
  /** Duration in seconds. */
  durSec: number;
  /** Timeline start in seconds. */
  startSec: number;
}

export interface FcpxmlAudioClip {
  /** Path to the audio file (mp3/wav/m4a). */
  path: string;
  /** Display label. */
  label: string;
  /** Timeline start in seconds. */
  startSec: number;
  /** Duration in seconds. */
  audioDur: number;
  /** Lane number (negative = connected below primary). */
  lane: -1 | -2 | -3;
  /** FCP X role. */
  role: 'dialogue.dialogue' | 'effects.effects' | 'music.music';
}

export interface FcpxmlExportOptions {
  outputPath: string;
  /** Video segments in spine order. Caller is responsible for ordering. */
  segments: FcpxmlSegment[];
  /** Connected audio clips. */
  audio: FcpxmlAudioClip[];
  /** Total sequence duration. Defaults to the cumulative segment duration. */
  totalDurationSec?: number;
  /** Frames per second. Defaults to 24. */
  fps?: number;
  /** Sequence width in pixels. Defaults to 1920. */
  width?: number;
  /** Sequence height in pixels. Defaults to 1080. */
  height?: number;
  /** Library / event name. Defaults to "Episode". */
  eventName?: string;
  /** Project name. Defaults to "<eventName> — fine-tune". */
  projectName?: string;
}

// ---- Helpers --------------------------------------------------------------

/**
 * Format a duration in seconds as the rational `<frames>/<fps>s` form that
 * FCPXML 1.10 expects. Always snaps to the nearest frame boundary.
 */
export function toRationalTime(seconds: number, fps: number): string {
  const frames = Math.max(0, Math.round(seconds * fps));
  return `${frames}/${fps}s`;
}

function pathToFileUri(p: string): string {
  return 'file://' + encodeURI(p).replace(/'/g, '%27');
}

function xmlEscape(s: string): string {
  return String(s).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]!));
}

async function probeAudioInfo(path: string): Promise<{ durSec: number; sampleRate: number; channels: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    path,
  ]);
  const j = JSON.parse(stdout);
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  return {
    durSec: parseFloat(a?.duration ?? j.format.duration),
    sampleRate: parseInt(a?.sample_rate ?? 48000, 10),
    channels: parseInt(a?.channels ?? 2, 10),
  };
}

interface AssetRecord {
  id: string;
  name: string;
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durRt: string;
  audioRate: number;
  audioChannels: number;
}

// ---- Export ---------------------------------------------------------------

/**
 * Emit an FCPXML 1.10 file. Returns the output path.
 *
 * The function is pure orchestration — segment timing and audio placement
 * decisions must already be made by the caller. The standard placement
 * pattern (shot-anchored offsets from EXT-8 + music cues from EXT-4) builds
 * the inputs naturally.
 */
export async function exportFcpxml(opts: FcpxmlExportOptions): Promise<string> {
  const fps = opts.fps ?? 24;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const eventName = opts.eventName ?? 'Episode';
  const projectName = opts.projectName ?? `${eventName} — fine-tune`;

  // 1. Build assets. One asset per unique file path.
  const assetById = new Map<string, AssetRecord>();
  let counter = 1; // r1 is reserved for the <format>; assets start at r2.
  const FORMAT_ID = 'r1';

  async function registerAsset(path: string, hasVideo: boolean, durSec: number, name: string): Promise<AssetRecord> {
    const existing = assetById.get(path);
    if (existing) return existing;
    const id = `r${++counter + 1}`; // r2, r3, ...
    let audioRate = 48000;
    let audioChannels = 2;
    try {
      const info = await probeAudioInfo(path);
      audioRate = info.sampleRate;
      audioChannels = info.channels;
    } catch { /* best-effort */ }
    const rec: AssetRecord = {
      id, name, path,
      hasVideo,
      hasAudio: true,
      durRt: toRationalTime(durSec, fps),
      audioRate,
      audioChannels,
    };
    assetById.set(path, rec);
    return rec;
  }

  for (const s of opts.segments) {
    if (!existsSync(s.path)) {
      throw new Error(`exportFcpxml: missing segment ${s.path}`);
    }
    (s as FcpxmlSegment & { _asset?: AssetRecord })._asset =
      await registerAsset(s.path, true, s.durSec, s.label);
  }
  for (const a of opts.audio) {
    if (!existsSync(a.path)) {
      throw new Error(`exportFcpxml: missing audio file ${a.path}`);
    }
    (a as FcpxmlAudioClip & { _asset?: AssetRecord })._asset =
      await registerAsset(a.path, false, a.audioDur, a.label);
  }

  // 2. Bucket connected audio under the segment that contains its startSec.
  function segmentContaining(timeSec: number): number {
    for (let i = 0; i < opts.segments.length; i++) {
      const s = opts.segments[i];
      if (timeSec >= s.startSec && timeSec < s.startSec + s.durSec) return i;
    }
    return opts.segments.length - 1; // clamp past-end to the last segment
  }
  const buckets: FcpxmlAudioClip[][] = opts.segments.map(() => []);
  for (const a of opts.audio) {
    buckets[segmentContaining(a.startSec)].push(a);
  }

  // 3. Emit XML.
  const masterDur = opts.totalDurationSec
    ?? opts.segments.reduce((acc, s) => Math.max(acc, s.startSec + s.durSec), 0);
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE fcpxml>`);
  lines.push(`<fcpxml version="1.10">`);
  lines.push(`  <resources>`);
  lines.push(`    <format id="${FORMAT_ID}" name="FFVideoFormat${width}x${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`);

  for (const a of assetById.values()) {
    const uri = pathToFileUri(a.path);
    const hasVideo = a.hasVideo ? '1' : '0';
    const formatAttr = a.hasVideo ? ` format="${FORMAT_ID}"` : '';
    lines.push(`    <asset id="${a.id}" name="${xmlEscape(a.name)}" start="0s" duration="${a.durRt}" hasVideo="${hasVideo}" hasAudio="1"${formatAttr} audioSources="1" audioChannels="${a.audioChannels}" audioRate="${a.audioRate}">`);
    lines.push(`      <media-rep kind="original-media" src="${uri}"/>`);
    lines.push(`    </asset>`);
  }
  lines.push(`  </resources>`);

  lines.push(`  <library>`);
  lines.push(`    <event name="${xmlEscape(eventName)}">`);
  lines.push(`      <project name="${xmlEscape(projectName)}">`);
  lines.push(`        <sequence format="${FORMAT_ID}" duration="${toRationalTime(masterDur, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  lines.push(`          <spine>`);

  for (let i = 0; i < opts.segments.length; i++) {
    const s = opts.segments[i];
    const segAsset = (s as FcpxmlSegment & { _asset: AssetRecord })._asset;
    const children = buckets[i];
    const open = `            <asset-clip name="${xmlEscape(s.label)}" ref="${segAsset.id}" offset="${toRationalTime(s.startSec, fps)}" duration="${toRationalTime(s.durSec, fps)}" start="0s" tcFormat="NDF" audioRole="dialogue.dialogue"`;
    if (children.length === 0) {
      lines.push(open + `>`);
      lines.push(`              <adjust-volume amount="-96dB"/>`);
      lines.push(`            </asset-clip>`);
      continue;
    }
    lines.push(open + `>`);
    lines.push(`              <adjust-volume amount="-96dB"/>`);
    for (const ch of children) {
      const chAsset = (ch as FcpxmlAudioClip & { _asset: AssetRecord })._asset;
      const localOffset = ch.startSec - s.startSec;
      lines.push(`              <audio name="${xmlEscape(ch.label)}" ref="${chAsset.id}" offset="${toRationalTime(localOffset, fps)}" duration="${toRationalTime(ch.audioDur, fps)}" start="0s" lane="${ch.lane}" role="${ch.role}"/>`);
    }
    lines.push(`            </asset-clip>`);
  }

  lines.push(`          </spine>`);
  lines.push(`        </sequence>`);
  lines.push(`      </project>`);
  lines.push(`    </event>`);
  lines.push(`  </library>`);
  lines.push(`</fcpxml>`);

  await mkdir(dirname(opts.outputPath), { recursive: true });
  await writeFile(opts.outputPath, lines.join('\n') + '\n', 'utf-8');
  return opts.outputPath;
}
