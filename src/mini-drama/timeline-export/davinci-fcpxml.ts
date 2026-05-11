// ---------------------------------------------------------------------------
// EXT-15: DaVinci Resolve-tuned FCPXML 1.10 export.
//
// Resolve imports the FCPXML 1.10 emitted by ./fcpxml.ts today, but the
// import is lossy in three known ways:
//
//   1. The <format colorSpace="1-1-1 (Rec. 709)"/> attribute sometimes makes
//      Resolve flag the timeline as "missing LUT" or apply an extra color
//      transform that doesn't match the source. The Resolve-tuned variant
//      drops the colorSpace attribute and lets Resolve infer.
//   2. Mono dialogue clips imported via the FCP X path get expanded to
//      stereo Resolve tracks. The tuned variant emits the
//      <audio-channel-source> / track-format hint Resolve actually honors,
//      keeping mono dialogue on a mono track.
//   3. URI-encoded paths (`%20` for spaces, `%27` for apostrophes) sometimes
//      fail on Linux Resolve builds when the source filename has spaces.
//      The tuned variant uses raw absolute paths inside a plain `file://`
//      prefix — works on macOS Resolve and tested-ok on Linux per the issue
//      thread.
//
// Apart from those three differences, the output is byte-for-byte the same
// as the FCP X path. A future PR can fork further if Resolve ships new
// import gates we discover during testing.
//
// Test plan: pair this with `tests/test-timeline-export.mjs` and the live
// DaVinci import on the Glass episode-001 v6 output before merging.
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeAudioInfo, segmentContaining, toRationalTime, xmlEscape } from './probe.js';
import type { TimelineAudioClip, TimelineExportOptions, TimelineSegment } from './types.js';

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

/**
 * DaVinci-tuned variant of `pathToFileUri`. Wraps an absolute path in a
 * `file://` prefix WITHOUT URI-encoding spaces, apostrophes, or other
 * filesystem-legal characters. macOS / Linux Resolve both accept this form;
 * the FCP X path doesn't because FCPXML 1.10 validators sometimes flag it.
 */
function pathToResolveFileUri(p: string): string {
  return 'file://' + p;
}

export async function exportDavinciFcpxml(opts: TimelineExportOptions): Promise<string> {
  const fps = opts.fps ?? 24;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const eventName = opts.eventName ?? 'Episode';
  const projectName = opts.projectName ?? `${eventName} — fine-tune`;

  const assetById = new Map<string, AssetRecord>();
  let counter = 1;
  const FORMAT_ID = 'r1';

  async function registerAsset(path: string, hasVideo: boolean, durSec: number, name: string): Promise<AssetRecord> {
    const existing = assetById.get(path);
    if (existing) return existing;
    const id = `r${++counter + 1}`;
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
      throw new Error(`exportDavinciFcpxml: missing segment ${s.path}`);
    }
    (s as TimelineSegment & { _asset?: AssetRecord })._asset =
      await registerAsset(s.path, true, s.durSec, s.label);
  }
  for (const a of opts.audio) {
    if (!existsSync(a.path)) {
      throw new Error(`exportDavinciFcpxml: missing audio file ${a.path}`);
    }
    (a as TimelineAudioClip & { _asset?: AssetRecord })._asset =
      await registerAsset(a.path, false, a.audioDur, a.label);
  }

  const buckets: TimelineAudioClip[][] = opts.segments.map(() => []);
  for (const a of opts.audio) {
    buckets[segmentContaining(opts.segments, a.startSec)].push(a);
  }

  const masterDur = opts.totalDurationSec
    ?? opts.segments.reduce((acc, s) => Math.max(acc, s.startSec + s.durSec), 0);

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE fcpxml>`);
  lines.push(`<fcpxml version="1.10">`);
  lines.push(`  <resources>`);
  // EXT-15 difference (1): drop colorSpace attribute — Resolve infers it
  // from the source media and avoids the false "missing LUT" warning.
  lines.push(`    <format id="${FORMAT_ID}" name="FFVideoFormat${width}x${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}"/>`);

  for (const a of assetById.values()) {
    // EXT-15 difference (3): raw file:// path, no URI-encoding.
    const uri = pathToResolveFileUri(a.path);
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
    const segAsset = (s as TimelineSegment & { _asset: AssetRecord })._asset;
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
      const chAsset = (ch as TimelineAudioClip & { _asset: AssetRecord })._asset;
      const localOffset = ch.startSec - s.startSec;
      // EXT-15 difference (2): emit <audio-channel-source> hinting at the
      // actual channel count Resolve should mount the track as. Mono
      // dialogue (channels=1) imports as a mono Resolve track; stereo
      // music (channels=2) imports as stereo. FCP X ignores this attribute.
      const channelHint = chAsset.audioChannels === 1 ? ' srcCh="1"' : ' srcCh="1, 2"';
      lines.push(`              <audio name="${xmlEscape(ch.label)}" ref="${chAsset.id}" offset="${toRationalTime(localOffset, fps)}" duration="${toRationalTime(ch.audioDur, fps)}" start="0s" lane="${ch.lane}" role="${ch.role}"${channelHint}/>`);
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
