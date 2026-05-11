// ---------------------------------------------------------------------------
// EXT-15: Adobe Premiere Pro export via Final Cut Pro 7 XML (xmeml v5).
//
// Premiere imports xmeml v5 natively via File > Import > XML… The format is
// Apple's predecessor to FCPXML — different shape, same idea. Differences
// from the FCPXML 1.10 path this module mirrors:
//
//   - Root is <xmeml version="5"> with <sequence> directly inside. No
//     <library> / <event> / <project> wrapper.
//   - Times are integer FRAMES, not the rational <frames>/<fps>s form.
//   - Rate appears as <rate><ntsc>FALSE</ntsc><timebase>24</timebase></rate>.
//   - Connected audio is a separate <media><audio> block with <track>
//     elements, NOT children of video clips.
//   - One <track> per lane: V1 for video, A1 dialogue, A2 SFX, A3 music.
//   - Each unique source file gets a <file id="..."> the first time it
//     appears. Subsequent <clipitem> references reuse it via <file id="..."/>.
//
// References used to derive this format:
//   - "Final Cut Pro X XML Interchange Format" — Apple developer docs.
//   - Adobe Premiere "Import a Final Cut Pro project" support article.
// Both confirm xmeml v5 as the canonical Premiere import format.
//
// Open question (flag in PR body): test live import in Premiere on a real
// machine before merge — frame-count math is sensitive to ntsc-vs-drop-frame
// nuance that's hard to verify without the actual NLE.
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileUri, probeAudioInfo, toFrames, xmlEscape } from './probe.js';
import type { TimelineAudioClip, TimelineExportOptions, TimelineSegment } from './types.js';

interface FileRecord {
  id: string;
  name: string;
  path: string;
  durFrames: number;
  hasVideo: boolean;
  sampleRate: number;
  channels: number;
}

/**
 * Map the format-neutral lane to a Premiere audio-track index (1-based).
 *
 *   lane -1 (dialogue) -> A1
 *   lane -2 (SFX)      -> A2
 *   lane -3 (music)    -> A3
 */
function laneToTrackIndex(lane: TimelineAudioClip['lane']): number {
  if (lane === -1) return 1;
  if (lane === -2) return 2;
  return 3;
}

export async function exportPremiereXml(opts: TimelineExportOptions): Promise<string> {
  const fps = opts.fps ?? 24;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const sequenceName = opts.projectName ?? opts.eventName ?? 'Episode';

  // 1. Register every unique source file as a <file> entry. Premiere
  //    references each <file> by id from each <clipitem>; only the first
  //    appearance carries the full <pathurl> block.
  let counter = 0;
  const fileById = new Map<string, FileRecord>();

  async function registerFile(path: string, hasVideo: boolean, durSec: number, name: string): Promise<FileRecord> {
    const existing = fileById.get(path);
    if (existing) return existing;
    const id = `file-${++counter}`;
    let sampleRate = 48000;
    let channels = 2;
    try {
      const info = await probeAudioInfo(path);
      sampleRate = info.sampleRate;
      channels = info.channels;
    } catch { /* best-effort — keep defaults */ }
    const rec: FileRecord = {
      id, name, path,
      durFrames: toFrames(durSec, fps),
      hasVideo,
      sampleRate,
      channels,
    };
    fileById.set(path, rec);
    return rec;
  }

  for (const s of opts.segments) {
    if (!existsSync(s.path)) {
      throw new Error(`exportPremiereXml: missing segment ${s.path}`);
    }
    (s as TimelineSegment & { _file?: FileRecord })._file =
      await registerFile(s.path, true, s.durSec, s.label);
  }
  for (const a of opts.audio) {
    if (!existsSync(a.path)) {
      throw new Error(`exportPremiereXml: missing audio file ${a.path}`);
    }
    (a as TimelineAudioClip & { _file?: FileRecord })._file =
      await registerFile(a.path, false, a.audioDur, a.label);
  }

  // 2. Bucket audio clips by Premiere track index.
  const audioByTrack: Record<number, TimelineAudioClip[]> = { 1: [], 2: [], 3: [] };
  for (const a of opts.audio) {
    audioByTrack[laneToTrackIndex(a.lane)].push(a);
  }

  const masterDurSec = opts.totalDurationSec
    ?? opts.segments.reduce((acc, s) => Math.max(acc, s.startSec + s.durSec), 0);
  const masterDurFrames = toFrames(masterDurSec, fps);

  // 3. Track files that have already emitted their <pathurl>. Subsequent
  //    references in <clipitem> use the bare <file id="..."/> form.
  const emittedFiles = new Set<string>();

  function fileElement(rec: FileRecord, includePath: boolean, durFrames: number): string[] {
    if (!includePath) {
      return [`              <file id="${rec.id}"/>`];
    }
    const uri = pathToFileUri(rec.path);
    const lines = [
      `              <file id="${rec.id}">`,
      `                <name>${xmlEscape(rec.name)}</name>`,
      `                <pathurl>${uri}</pathurl>`,
      `                <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`,
      `                <duration>${rec.durFrames}</duration>`,
      `                <media>`,
    ];
    if (rec.hasVideo) {
      lines.push(`                  <video>`);
      lines.push(`                    <samplecharacteristics>`);
      lines.push(`                      <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`);
      lines.push(`                      <width>${width}</width>`);
      lines.push(`                      <height>${height}</height>`);
      lines.push(`                    </samplecharacteristics>`);
      lines.push(`                  </video>`);
    }
    lines.push(`                  <audio>`);
    lines.push(`                    <samplecharacteristics>`);
    lines.push(`                      <depth>16</depth>`);
    lines.push(`                      <samplerate>${rec.sampleRate}</samplerate>`);
    lines.push(`                    </samplecharacteristics>`);
    lines.push(`                    <channelcount>${rec.channels}</channelcount>`);
    lines.push(`                  </audio>`);
    lines.push(`                </media>`);
    lines.push(`              </file>`);
    // Suppress full pathurl on subsequent references to this same file.
    emittedFiles.add(rec.id);
    return lines;
  }

  // 4. Emit XML.
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE xmeml>`);
  lines.push(`<xmeml version="5">`);
  lines.push(`  <sequence id="seq-1">`);
  lines.push(`    <name>${xmlEscape(sequenceName)}</name>`);
  lines.push(`    <duration>${masterDurFrames}</duration>`);
  lines.push(`    <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`);
  lines.push(`    <media>`);

  // --- Video track (V1) ---
  lines.push(`      <video>`);
  lines.push(`        <format>`);
  lines.push(`          <samplecharacteristics>`);
  lines.push(`            <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`);
  lines.push(`            <width>${width}</width>`);
  lines.push(`            <height>${height}</height>`);
  lines.push(`          </samplecharacteristics>`);
  lines.push(`        </format>`);
  lines.push(`        <track>`);

  for (let i = 0; i < opts.segments.length; i++) {
    const s = opts.segments[i];
    const rec = (s as TimelineSegment & { _file: FileRecord })._file;
    const startFr = toFrames(s.startSec, fps);
    const endFr = startFr + toFrames(s.durSec, fps);
    const includePath = !emittedFiles.has(rec.id);
    lines.push(`          <clipitem id="vclip-${i + 1}">`);
    lines.push(`            <name>${xmlEscape(s.label)}</name>`);
    lines.push(`            <duration>${rec.durFrames}</duration>`);
    lines.push(`            <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`);
    lines.push(`            <start>${startFr}</start>`);
    lines.push(`            <end>${endFr}</end>`);
    lines.push(`            <in>0</in>`);
    lines.push(`            <out>${toFrames(s.durSec, fps)}</out>`);
    for (const ln of fileElement(rec, includePath, rec.durFrames)) lines.push(ln);
    lines.push(`          </clipitem>`);
  }

  lines.push(`        </track>`);
  lines.push(`      </video>`);

  // --- Audio tracks (A1 dialogue, A2 SFX, A3 music) ---
  lines.push(`      <audio>`);
  for (const trackIdx of [1, 2, 3]) {
    lines.push(`        <track>`);
    let clipNum = 0;
    for (const a of audioByTrack[trackIdx]) {
      const rec = (a as TimelineAudioClip & { _file: FileRecord })._file;
      const startFr = toFrames(a.startSec, fps);
      const endFr = startFr + toFrames(a.audioDur, fps);
      const includePath = !emittedFiles.has(rec.id);
      clipNum += 1;
      lines.push(`          <clipitem id="a${trackIdx}-clip-${clipNum}">`);
      lines.push(`            <name>${xmlEscape(a.label)}</name>`);
      lines.push(`            <duration>${rec.durFrames}</duration>`);
      lines.push(`            <rate><ntsc>FALSE</ntsc><timebase>${fps}</timebase></rate>`);
      lines.push(`            <start>${startFr}</start>`);
      lines.push(`            <end>${endFr}</end>`);
      lines.push(`            <in>0</in>`);
      lines.push(`            <out>${toFrames(a.audioDur, fps)}</out>`);
      for (const ln of fileElement(rec, includePath, rec.durFrames)) lines.push(ln);
      lines.push(`          </clipitem>`);
    }
    lines.push(`        </track>`);
  }
  lines.push(`      </audio>`);
  lines.push(`    </media>`);
  lines.push(`  </sequence>`);
  lines.push(`</xmeml>`);

  await mkdir(dirname(opts.outputPath), { recursive: true });
  await writeFile(opts.outputPath, lines.join('\n') + '\n', 'utf-8');
  return opts.outputPath;
}
