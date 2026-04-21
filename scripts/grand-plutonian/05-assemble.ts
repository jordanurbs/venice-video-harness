/**
 * STAGE 5 — Final assembly
 *
 * Step A: Concatenate shots 1-6 → silent video track with title cards burned in
 *         on Shot 1 (CHAPTER ONE / THE DEPARTURE) and Shot 6 (THE GRAND PLUTONIAN
 *         / THIS WINTER — A FILM ABOUT LEAVING).
 * Step B: Mix VO (-3dB, starts at 1.5s), music bed (-16dB, looped), SFX (-22dB,
 *         looped) under the silent video → trailer-final.mp4.
 *
 * Pure ffmpeg — no Venice calls. Re-runnable; outputs go to output/grand-plutonian/.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PROJECT_DIR,
  SHOTS_DIR,
  AUDIO_DIR,
  BUILD_DIR,
  SHOTLIST,
  MIX,
  CAPTIONS,
} from "./config.js";
import { banner } from "./utils.js";

const run = promisify(execFile);
const FORCE = process.argv.includes("--force");

// Font picked from /System/Library/Fonts/ — tested with drawtext above.
const FONT = "Avenir Next";

// Title card layouts. Each line in a beat can either participate in a "stack"
// (top-anchored or center-anchored, with gapAbove between lines) OR have its
// own per-line `anchor` (pixel-y or "top"/"bottom"/"center") that overrides
// stack positioning. Lines that share the same beat share one fade envelope.
interface TitleLine {
  text: string;
  size: number;
  /** Gap above this line (px). Default 18. Used only when line is in stack. */
  gapAbove?: number;
  /**
   * Per-line vertical anchor. If omitted, the line participates in the beat's
   * stackPosition layout. If set:
   *   - "top"    → y = TOP_MARGIN
   *   - "bottom" → y = CANVAS_H - BOTTOM_MARGIN - text height
   *   - number   → y = that pixel value (top edge of text)
   */
  anchor?: "top" | "bottom" | number;
}

interface TitleBeat {
  shotNum: number;
  lines: TitleLine[];
  fadeInAt: number;
  fadeOutEnd?: number;
  stackPosition: "top" | "center";
  /**
   * Optional: extend this shot by N extra seconds via tpad (freeze last frame).
   * Used for Shot 6 to hold the title card while the longer VO resolves.
   */
  freezeExtraSec?: number;
}

const CANVAS_W = 1280;
const CANVAS_H = 720;
const TOP_MARGIN = 80;          // padding from top edge for "top"-anchored lines
const BOTTOM_MARGIN = 60;       // padding from bottom edge for "bottom"-anchored lines

/** Extra seconds to freeze on Shot 6's last frame so VO can resolve. */
const SHOT6_FREEZE_SEC = 3.5;

const TITLE_BEATS: TitleBeat[] = [
  // Shot 1 — chapter card SPLIT: CHAPTER ONE at top (extra padding),
  //                              THE DEPARTURE at bottom under the train.
  {
    shotNum: 1,
    lines: [
      { text: "CHAPTER ONE",   size: 120, anchor: "top" },
      // Bumped up ~7% of canvas (~50px) from previous "bottom" anchor (y≈570) → y=520.
      { text: "THE DEPARTURE", size: 90,  anchor: 520 },
    ],
    fadeInAt: 0.6,
    fadeOutEnd: 4.2,
    stackPosition: "top",       // unused since both lines have explicit anchors
  },
  // Shot 6 — three-line feature title card, vertically centered.
  // Main size 108 is the largest that fits "THE GRAND PLUTONIAN" (19 chars)
  // in a 1280px canvas without clipping the leading T or trailing N.
  // freezeExtraSec extends the shot via tpad so the title holds for the full
  // VO + a moment of silence after.
  {
    shotNum: 6,
    lines: [
      { text: "THE GRAND PLUTONIAN", size: 108 },
      { text: "A Most Peculiar Departure from the Federal Reserve", size: 40, gapAbove: 24 },
    ],
    fadeInAt: 0.8,
    stackPosition: "center",
    freezeExtraSec: SHOT6_FREEZE_SEC,
  },
];

// ---- Helpers --------------------------------------------------------------

function beatForShot(num: number): TitleBeat | undefined {
  return TITLE_BEATS.find(b => b.shotNum === num);
}

/**
 * Absolute y (px from top) for each line.
 *
 * - Lines with explicit `anchor` are positioned independently:
 *     "top"    → TOP_MARGIN
 *     "bottom" → CANVAS_H - BOTTOM_MARGIN - line.size
 *     number   → that pixel value (top edge of text box)
 *
 * - Lines without an `anchor` participate in the beat's stackPosition layout,
 *   stacked top→bottom with each line's `gapAbove`.
 */
function computeLineYs(beat: TitleBeat): number[] {
  const ys: number[] = new Array(beat.lines.length).fill(0);

  // First pass: place anchored lines.
  const stackedIndices: number[] = [];
  for (let i = 0; i < beat.lines.length; i++) {
    const line = beat.lines[i];
    if (line.anchor === "top") {
      ys[i] = TOP_MARGIN;
    } else if (line.anchor === "bottom") {
      ys[i] = CANVAS_H - BOTTOM_MARGIN - line.size;
    } else if (typeof line.anchor === "number") {
      ys[i] = line.anchor;
    } else {
      stackedIndices.push(i);
    }
  }

  // Second pass: stack the remaining lines.
  if (stackedIndices.length > 0) {
    const sizes = stackedIndices.map(i => beat.lines[i].size);
    const gaps = stackedIndices.map((i, idx) => (idx === 0 ? 0 : (beat.lines[i].gapAbove ?? 18)));
    const totalHeight = sizes.reduce((a, s) => a + s, 0) + gaps.reduce((a, g) => a + g, 0);
    const y0 = beat.stackPosition === "top"
      ? TOP_MARGIN
      : Math.round((CANVAS_H - totalHeight) / 2);
    let cursor = y0;
    for (let k = 0; k < stackedIndices.length; k++) {
      cursor += gaps[k];
      ys[stackedIndices[k]] = cursor;
      cursor += sizes[k];
    }
  }

  return ys;
}

/**
 * Write small text files to disk for ffmpeg's `textfile=` param — avoids
 * all shell-escaping nightmares (em-dashes, quotes, unicode, etc.).
 */
async function writeTitleTextFiles(): Promise<void> {
  await mkdir(BUILD_DIR, { recursive: true });
  for (const beat of TITLE_BEATS) {
    for (let i = 0; i < beat.lines.length; i++) {
      await writeFile(
        join(BUILD_DIR, `title-${beat.shotNum}-line${i}.txt`),
        beat.lines[i].text,
        "utf-8",
      );
    }
  }
}

/**
 * For one shot file, return an ffmpeg filter chain that:
 *   - (if no title beat) passes through untouched, just scaled to 1280x720
 *   - (with title beat) overlays two text layers with alpha fade envelope
 *
 * `labelIn` / `labelOut` are the stream labels.
 */
/** Per-shot output duration AFTER any tpad freeze extension. */
function shotEffectiveDuration(shotNum: number): number {
  const beat = beatForShot(shotNum);
  return SHOT_BASE_DURATION + (beat?.freezeExtraSec ?? 0);
}

/** Cumulative offset (sec) where each shot starts in the final concat. */
function shotStartOffset(shotIndex: number): number {
  let acc = 0;
  for (let i = 0; i < shotIndex; i++) {
    acc += shotEffectiveDuration(SHOTLIST[i].num);
  }
  return acc;
}

const SHOT_BASE_DURATION = 5.04; // matches actual Seedance output for every shot

function filterChainForShot(
  shot: typeof SHOTLIST[number],
  labelIn: string,
  labelOut: string,
): string {
  const beat = beatForShot(shot.num);

  // tpad to freeze the last frame for additional N seconds (Shot 6 only, today).
  const freezeExtra = beat?.freezeExtraSec ?? 0;
  const tpadFilter = freezeExtra > 0
    ? `,tpad=stop_mode=clone:stop_duration=${freezeExtra}`
    : "";

  if (!beat) {
    return `[${labelIn}]scale=${CANVAS_W}:${CANVAS_H},setsar=1${tpadFilter},format=yuv420p[${labelOut}]`;
  }

  const duration = SHOT_BASE_DURATION + freezeExtra;
  const fadeInDur = 0.5;
  const fadeOutDur = 0.6;
  const fadeOutEnd = beat.fadeOutEnd ?? duration;
  const fadeOutStart = fadeOutEnd - fadeOutDur;
  const fadeInEnd = beat.fadeInAt + fadeInDur;

  // Shared alpha envelope: all lines in a beat fade in/out together.
  // (commas inside the alpha='...' value don't act as filter separators)
  const alphaExpr =
    `if(lt(t,${beat.fadeInAt}),0,` +
    `if(lt(t,${fadeInEnd}),(t-${beat.fadeInAt})/${fadeInDur},` +
    `if(lt(t,${fadeOutStart}),1,` +
    `if(lt(t,${fadeOutEnd}),1-(t-${fadeOutStart})/${fadeOutDur},0))))`;

  const ys = computeLineYs(beat);
  const drawtexts = beat.lines.map((line, i) => {
    const txtPath = join(BUILD_DIR, `title-${beat.shotNum}-line${i}.txt`);
    // Pure white text, no outline / border, alpha-faded. Centered horizontally.
    return (
      `drawtext=font='${FONT}':textfile='${txtPath}':fontsize=${line.size}` +
      `:fontcolor=white` +
      `:alpha='${alphaExpr}'` +
      `:x=(w-text_w)/2:y=${ys[i]}`
    );
  });

  return `[${labelIn}]scale=${CANVAS_W}:${CANVAS_H},setsar=1${tpadFilter},${drawtexts.join(",")},format=yuv420p[${labelOut}]`;
}

// ---- Caption track (burned-in subtitles) ---------------------------------

const CAPTION_FONT_SIZE = 38;
const CAPTION_ALPHA = 0.85;
const CAPTION_BOTTOM_MARGIN = 50;

/**
 * Build a single drawtext expression that renders ALL captions on the
 * concatenated stream. Each caption is gated by `enable='between(t,...)'`,
 * `t` being the time on the concatenated stream (post-tpad).
 */
function buildCaptionFilter(): string {
  return CAPTIONS.map((c, i) => {
    const txtPath = join(BUILD_DIR, `caption-${i}.txt`);
    return (
      `drawtext=font='${FONT}':textfile='${txtPath}':fontsize=${CAPTION_FONT_SIZE}` +
      `:fontcolor=white@${CAPTION_ALPHA}` +
      `:x=(w-text_w)/2:y=h-text_h-${CAPTION_BOTTOM_MARGIN}` +
      `:enable='between(t,${c.start},${c.end})'`
    );
  }).join(",");
}

async function writeCaptionTextFiles(): Promise<void> {
  await mkdir(BUILD_DIR, { recursive: true });
  for (let i = 0; i < CAPTIONS.length; i++) {
    await writeFile(join(BUILD_DIR, `caption-${i}.txt`), CAPTIONS[i].text, "utf-8");
  }
}

// ---- Step A: concat + burn in titles -------------------------------------

async function buildSilentVideo(): Promise<string> {
  banner("STAGE 5A — Concatenate + title overlays");
  const outPath = join(BUILD_DIR, "silent.mp4");
  if (existsSync(outPath) && !FORCE) {
    console.log(`  ✓ exists: build/silent.mp4 (skipping — use --force to rebuild)`);
    return outPath;
  }

  await writeTitleTextFiles();
  await writeCaptionTextFiles();
  await mkdir(BUILD_DIR, { recursive: true });

  // Build filter_complex: per-shot drawtext → concat → caption track
  const filters: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < SHOTLIST.length; i++) {
    const shot = SHOTLIST[i];
    const labelIn = `${i}:v`;
    const labelOut = `v${i}`;
    filters.push(filterChainForShot(shot, labelIn, labelOut));
    concatInputs.push(`[${labelOut}]`);
  }
  filters.push(`${concatInputs.join("")}concat=n=${SHOTLIST.length}:v=1:a=0[vcat]`);
  // Burn captions on the concatenated stream so timings are absolute.
  filters.push(`[vcat]${buildCaptionFilter()}[vout]`);

  const inputs: string[] = [];
  for (const shot of SHOTLIST) {
    inputs.push("-i", join(SHOTS_DIR, `shot-${String(shot.num).padStart(3, "0")}.mp4`));
  }

  const args = [
    "-y", "-hide_banner",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    outPath,
  ];

  console.log("  Running ffmpeg concat + drawtext ...");
  const t0 = Date.now();
  const { stderr } = await run("ffmpeg", args).catch(e => {
    console.error("ffmpeg stderr:", e.stderr?.toString?.() ?? e);
    throw e;
  });
  void stderr;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✨ build/silent.mp4 (${dt}s)`);
  return outPath;
}

// ---- Step B: mix audio ---------------------------------------------------

async function mixFinal(silentVideo: string): Promise<string> {
  banner("STAGE 5B — Audio mix");
  const outPath = join(PROJECT_DIR, "trailer-final.mp4");
  if (existsSync(outPath) && !FORCE) {
    console.log(`  ✓ exists: trailer-final.mp4 (skipping — use --force to rebuild)`);
    return outPath;
  }

  const voPath = join(AUDIO_DIR, "vo.mp3");
  const musicPath = join(AUDIO_DIR, "music.mp3");
  const sfxPath = join(AUDIO_DIR, "sfx.mp3");

  if (!existsSync(voPath) || !existsSync(musicPath) || !existsSync(sfxPath)) {
    throw new Error("Missing audio files — run Stage 4 first.");
  }

  // Mix plan:
  //  - VO starts at 1.5s, played at MIX.voDb
  //  - Music starts at 0, looped/padded to total duration, at MIX.musicDb, with fade in/out
  //  - SFX looped to total duration, at MIX.sfxDb, with fade in/out
  //  - Video = silent.mp4 (already includes any tpad freeze extensions)

  // Total target duration = sum of effective shot durations (post-tpad)
  const targetSec = SHOTLIST.reduce((acc, s) => acc + shotEffectiveDuration(s.num), 0);
  console.log(`  Target audio mix duration: ${targetSec.toFixed(2)}s`);

  const filter = [
    // VO: delay, volume
    `[0:a]adelay=1500|1500,volume=${db(MIX.voDb)}[vo]`,
    // Music: loop to cover full duration, fade in/out, volume
    `[1:a]aloop=loop=-1:size=2e9,atrim=0:${targetSec},afade=t=in:st=0:d=1.5,afade=t=out:st=${targetSec - 1.5}:d=1.5,volume=${db(MIX.musicDb)}[mus]`,
    // SFX: loop to cover full duration, fade in/out, volume
    `[2:a]aloop=loop=-1:size=2e9,atrim=0:${targetSec},afade=t=in:st=0:d=1.5,afade=t=out:st=${targetSec - 1.5}:d=1.5,volume=${db(MIX.sfxDb)}[sfx]`,
    // Mix them
    `[vo][mus][sfx]amix=inputs=3:duration=longest:normalize=0[aout]`,
  ].join(";");

  const args = [
    "-y", "-hide_banner",
    "-i", voPath,        // [0:a]
    "-i", musicPath,     // [1:a]
    "-i", sfxPath,       // [2:a]
    "-i", silentVideo,   // [3:v]
    "-filter_complex", filter,
    "-map", "3:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outPath,
  ];

  console.log("  Mixing VO + music + SFX under silent video ...");
  const t0 = Date.now();
  const { stderr } = await run("ffmpeg", args).catch(e => {
    console.error("ffmpeg stderr:", e.stderr?.toString?.() ?? e);
    throw e;
  });
  void stderr;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✨ trailer-final.mp4 (${dt}s)`);
  return outPath;
}

function db(level: number): string {
  // ffmpeg volume= accepts raw decibel value like "-6dB"
  return `${level}dB`;
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const silent = await buildSilentVideo();
  const final = await mixFinal(silent);
  banner("STAGE 5 COMPLETE");
  console.log(`\n🎬 Final trailer: ${resolve(final)}`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
