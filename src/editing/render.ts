/**
 * EDL renderer.
 *
 * Turns an Edl into a single mp4 file via ffmpeg. Produces 30ms audio
 * fades at every cut boundary (video-use's "no pops" rule). Supports
 * hard cuts, crossfades, and fade-to-black transitions.
 *
 * Archive-first per workspace rule `.cursor/rules/shot-asset-safety.mdc`:
 * any existing output file is renamed to `<stem>-v<N>.<ext>` before the
 * new render lands.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  DEFAULT_AUDIO_FADE_MS,
  DEFAULT_TRANSITION_MS,
  effectiveDurationSec,
  validateEdl,
} from './edl.js';
import type { Edl, EdlClip, Take } from './types.js';

export interface RenderOptions {
  /** Optional destination for the output file. Default: `<editDir>/final-edit.mp4`. */
  outputPath?: string;
  /** Skip archiving the prior version. Default false (always archive). */
  skipArchive?: boolean;
  /** Dry-run — print the ffmpeg invocation without executing. */
  dryRun?: boolean;
  /**
   * Only re-render a specific clip by index. When set, the renderer writes
   * a partial mp4 at `<outputStem>.clip-<N>.mp4` that the caller can splice
   * via a secondary concat. This supports anti-pattern E4 (don't re-render
   * the whole edit to fix one clip).
   */
  onlyClipIndex?: number;
}

export interface RenderResult {
  outputPath: string;
  archivedPath: string | null;
  filterGraph: string;
  command: string;
  durationEstSec: number;
}

/** Archive existing output as `<stem>-v<N>.<ext>` and return the new path. */
function archiveExisting(path: string): string | null {
  if (!existsSync(path)) return null;
  const ext = extname(path);
  const stem = basename(path, ext);
  const dir = dirname(path);
  let n = 1;
  let candidate = join(dir, `${stem}-v${n}${ext}`);
  while (existsSync(candidate)) {
    n += 1;
    candidate = join(dir, `${stem}-v${n}${ext}`);
  }
  renameSync(path, candidate);
  return candidate;
}

/**
 * Build the filter_complex graph for an EDL.
 *
 * Each input is labeled [N:v] [N:a]. For each clip we:
 *   1. Trim the video + audio to the clip range
 *   2. Apply head/tail trim for filler removal
 *   3. Apply per-clip fades (the 30ms audio fade + any crossfade/fade-to-black)
 *   4. Chain into xfade (video) and acrossfade (audio) for crossfades,
 *      or plain concat for hard cuts.
 *
 * We keep the graph explicit rather than clever — maintainability wins over
 * filter-length golf.
 */
function buildFilterGraph(
  edl: Edl,
  takeById: Map<string, Take>,
): { graph: string; inputFiles: string[]; totalDurSec: number; finalVLabel: string; finalALabel: string } {
  const inputFiles: string[] = [];
  const inputIndexByFile = new Map<string, number>();
  const getInputIndex = (file: string): number => {
    if (inputIndexByFile.has(file)) return inputIndexByFile.get(file)!;
    const idx = inputFiles.length;
    inputFiles.push(file);
    inputIndexByFile.set(file, idx);
    return idx;
  };

  const fadeSec = edl.audioFadeMs / 1000;
  const filters: string[] = [];

  // Stage 1: per-clip trimmed + faded streams.
  const clipVLabels: string[] = [];
  const clipALabels: string[] = [];
  let totalDurSec = 0;

  edl.clips.forEach((clip, i) => {
    const take = takeById.get(clip.sourceId);
    if (!take) throw new Error(`Unknown sourceId ${clip.sourceId} at clip ${i}`);
    const fileIdx = getInputIndex(take.file);

    const trimStartAdjust = (clip.trimStartMs ?? 0) / 1000;
    const trimEndAdjust = (clip.trimEndMs ?? 0) / 1000;
    const startSec = clip.startSec + trimStartAdjust;
    const endSec = clip.endSec - trimEndAdjust;
    const durSec = Math.max(0, endSec - startSec);
    totalDurSec += durSec;

    const vIn = `${fileIdx}:v`;
    const aIn = `${fileIdx}:a`;

    // Video: trim + setpts + ensure consistent format / fps
    const vTrim = `[${vIn}]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS,format=yuv420p[v${i}t]`;
    filters.push(vTrim);

    // Audio: atrim + asetpts + always apply a small head/tail fade to kill pops
    const aFadeOut = Math.min(fadeSec, durSec / 3);
    const aFadeOutStart = Math.max(0, durSec - aFadeOut);
    const aTrim = `[${aIn}]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeSec.toFixed(3)},afade=t=out:st=${aFadeOutStart.toFixed(3)}:d=${aFadeOut.toFixed(3)}[a${i}t]`;
    filters.push(aTrim);

    clipVLabels.push(`[v${i}t]`);
    clipALabels.push(`[a${i}t]`);
  });

  // Stage 2: apply color grade if present.
  let gradedVLabels = clipVLabels;
  if (edl.colorGrade?.filter) {
    gradedVLabels = clipVLabels.map((label, i) => {
      const out = `[v${i}g]`;
      filters.push(`${label}${edl.colorGrade!.filter}${out}`);
      return out;
    });
  }

  // Stage 3: chain clips via concat or xfade/acrossfade.
  //
  // If every transitionIn is 'cut', we can use the single concat filter which
  // is faster. Otherwise we iteratively xfade + acrossfade.
  const allHardCuts = edl.clips.every(
    (c, i) => i === 0 || !c.transitionIn || c.transitionIn === 'cut',
  );

  let finalVLabel: string;
  let finalALabel: string;

  if (allHardCuts) {
    const concatInputs = gradedVLabels
      .map((vl, i) => `${vl}${clipALabels[i]}`)
      .join('');
    filters.push(
      `${concatInputs}concat=n=${edl.clips.length}:v=1:a=1[vcat][acat]`,
    );
    finalVLabel = '[vcat]';
    finalALabel = '[acat]';
  } else {
    // Iterative xfade chain. xfade's "offset" is the time (in the first stream)
    // at which the transition begins. For clip 0 that's (dur0 - t_ms/1000).
    let prevV = gradedVLabels[0];
    let prevA = clipALabels[0];
    let runningDur = effectiveDurationSec(edl.clips[0]);

    for (let i = 1; i < edl.clips.length; i++) {
      const clip = edl.clips[i];
      const tMs =
        clip.transitionIn && clip.transitionIn !== 'cut'
          ? clip.transitionMs ?? DEFAULT_TRANSITION_MS
          : 0;
      const tSec = tMs / 1000;
      const clipDur = effectiveDurationSec(clip);

      if (tMs === 0) {
        const outV = `[vc${i}]`;
        const outA = `[ac${i}]`;
        filters.push(`${prevV}${gradedVLabels[i]}concat=n=2:v=1:a=0${outV}`);
        filters.push(`${prevA}${clipALabels[i]}concat=n=2:v=0:a=1${outA}`);
        prevV = outV;
        prevA = outA;
        runningDur += clipDur;
      } else {
        const offset = Math.max(0, runningDur - tSec);
        const transition = clip.transitionIn === 'fade-to-black' ? 'fadeblack' : 'fade';
        const outV = `[vx${i}]`;
        const outA = `[ax${i}]`;
        filters.push(
          `${prevV}${gradedVLabels[i]}xfade=transition=${transition}:duration=${tSec.toFixed(3)}:offset=${offset.toFixed(3)}${outV}`,
        );
        filters.push(
          `${prevA}${clipALabels[i]}acrossfade=d=${tSec.toFixed(3)}:c1=tri:c2=tri${outA}`,
        );
        prevV = outV;
        prevA = outA;
        runningDur = runningDur - tSec + clipDur;
        totalDurSec -= tSec;
      }
    }

    finalVLabel = prevV;
    finalALabel = prevA;
  }

  return {
    graph: filters.join(';'),
    inputFiles,
    totalDurSec,
    finalVLabel,
    finalALabel,
  };
}

export function renderEdl(
  edl: Edl,
  takes: Take[],
  options: RenderOptions = {},
): RenderResult {
  const errs = validateEdl(edl, takes);
  if (errs.length > 0) {
    throw new Error(
      `EDL validation failed:\n${errs.map((e) => `  clip ${e.clipIndex}: ${e.message}`).join('\n')}`,
    );
  }

  const takeById = new Map(takes.map((t) => [t.id, t]));

  // Filter down to a single clip in onlyClipIndex mode.
  let workEdl = edl;
  let outputPath = resolve(options.outputPath ?? 'output/edit/final-edit.mp4');
  if (options.onlyClipIndex !== undefined) {
    const onlyIdx = options.onlyClipIndex;
    if (onlyIdx < 0 || onlyIdx >= edl.clips.length) {
      throw new Error(`onlyClipIndex ${onlyIdx} out of range`);
    }
    workEdl = {
      ...edl,
      clips: [edl.clips[onlyIdx]],
    };
    const ext = extname(outputPath);
    const stem = basename(outputPath, ext);
    outputPath = join(dirname(outputPath), `${stem}.clip-${onlyIdx}${ext}`);
  }

  const { graph, inputFiles, totalDurSec, finalVLabel, finalALabel } = buildFilterGraph(
    workEdl,
    takeById,
  );

  mkdirSync(dirname(outputPath), { recursive: true });

  let archived: string | null = null;
  if (!options.skipArchive) {
    archived = archiveExisting(outputPath);
  }

  const inputArgs = inputFiles.flatMap((f) => ['-i', `"${f}"`]);
  // Always append trailing passthroughs that emit stable [vout] / [aout]
  // labels regardless of which chain path (concat vs xfade) produced them.
  const remappedGraph = `${graph};${finalVLabel}null[vout];${finalALabel}aformat=sample_rates=48000:channel_layouts=stereo[aout]`;

  const outputArgs = [
    '-map', '"[vout]"',
    '-map', '"[aout]"',
    '-c:v', workEdl.output.videoCodec,
    '-preset', 'slow',
    '-crf', String(workEdl.output.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', workEdl.output.audioCodec,
    '-b:a', '192k',
    '-movflags', '+faststart',
  ];
  if (workEdl.output.fps) outputArgs.push('-r', String(workEdl.output.fps));
  if (workEdl.output.width && workEdl.output.height) {
    outputArgs.push('-s', `${workEdl.output.width}x${workEdl.output.height}`);
  }

  const cmd = [
    'ffmpeg',
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', `"${remappedGraph}"`,
    ...outputArgs,
    `"${outputPath}"`,
  ].join(' ');

  const result: RenderResult = {
    outputPath,
    archivedPath: archived,
    filterGraph: remappedGraph,
    command: cmd,
    durationEstSec: totalDurSec,
  };

  if (options.dryRun) {
    return result;
  }

  execSync(cmd, { stdio: 'inherit' });
  return result;
}
