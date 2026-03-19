import { readdir, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { existsSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { ShotScript } from '../series/types.js';

export interface ShotTrim {
  shotNumber: number;
  trimStart?: number;
  trimEnd?: number;
  flip?: boolean;
}

export interface AssemblyOptions {
  videoFiles: string[];
  outputPath: string;
  srtPath?: string;
  musicPath?: string;
  musicVolume?: number;
  /** Continuous ambient bed (e.g. rain loop) mixed under all clips for audio continuity */
  ambientBedPath?: string;
  ambientBedVolume?: number;
  dialogueDir?: string;
  nativeAudioVolume?: number;
  /** Per-shot trim/flip metadata from script.json */
  shotTrims?: ShotTrim[];
  /** Optional title that fades in over the ending of the assembled episode */
  endingTitleOverlay?: {
    text: string;
    fadeInSec?: number;
    holdSec?: number;
  };
}

function getVideoDuration(path: string): number {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`,
    { encoding: 'utf-8' },
  ).trim();
  return parseFloat(out);
}

/**
 * Normalize a single clip to consistent encoding params.
 * Kling outputs can have subtle codec/container differences that cause
 * concat duration errors when using `-c copy`. Re-encoding to identical
 * params (h264/aac, 24fps, 44100Hz stereo) eliminates this.
 *
 * Also applies trimStart, trimEnd, and flip if specified.
 */
function normalizeClip(
  inputPath: string,
  outputPath: string,
  trim?: ShotTrim,
): void {
  const filters: string[] = [];
  const inputArgs: string[] = [];

  if (trim?.trimStart && trim.trimStart > 0) {
    inputArgs.push(`-ss ${trim.trimStart}`);
  }

  if (trim?.trimEnd && trim.trimEnd > 0) {
    const duration = getVideoDuration(inputPath);
    const endTime = duration - trim.trimEnd - (trim.trimStart ?? 0);
    if (endTime > 0) {
      inputArgs.push(`-t ${endTime}`);
    }
  }

  if (trim?.flip) {
    filters.push('hflip');
  }

  const filterArg = filters.length > 0 ? `-vf "${filters.join(',')}"` : '';
  const inputStr = inputArgs.join(' ');

  execSync(
    `ffmpeg -y ${inputStr} -i "${inputPath}" ${filterArg} ` +
    `-c:v libx264 -preset fast -crf 18 -r 24 ` +
    `-c:a aac -ar 44100 -ac 2 -b:a 192k ` +
    `"${outputPath}"`,
    { stdio: 'pipe' },
  );
}

function replaceDialogueInShot(
  videoPath: string,
  dialoguePath: string,
  outputPath: string,
  nativeVolume: number,
): void {
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${dialoguePath}" ` +
    `-filter_complex "[0:a]volume=${nativeVolume}[native];[1:a]volume=1.0[tts];[native][tts]amix=inputs=2:duration=first:dropout_transition=0.5[aout]" ` +
    `-map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputPath}"`,
    { stdio: 'pipe' },
  );
}

export async function assembleEpisode(options: AssemblyOptions): Promise<string> {
  const {
    videoFiles,
    outputPath,
    srtPath,
    musicPath,
    musicVolume = 0.15,
    ambientBedPath,
    ambientBedVolume = 0.3,
    dialogueDir,
    nativeAudioVolume = 0.2,
    shotTrims = [],
    endingTitleOverlay,
  } = options;

  await mkdir(dirname(outputPath), { recursive: true });

  const trimMap = new Map(shotTrims.map(t => [t.shotNumber, t]));

  // ── Step 1: Normalize all clips to identical encoding ──
  const normDir = join(dirname(outputPath), '.tmp-norm');
  await mkdir(normDir, { recursive: true });

  console.log(`  Normalizing ${videoFiles.length} clips...`);
  const normalizedFiles: string[] = [];

  for (const videoPath of videoFiles) {
    const shotName = basename(videoPath, '.mp4');
    const shotNumStr = shotName.replace('shot-', '');
    const shotNum = parseInt(shotNumStr, 10);
    const normPath = join(normDir, `${shotName}.mp4`);
    const trim = trimMap.get(shotNum);

    const trimInfo: string[] = [];
    if (trim?.trimStart) trimInfo.push(`trim start ${trim.trimStart}s`);
    if (trim?.trimEnd) trimInfo.push(`trim end ${trim.trimEnd}s`);
    if (trim?.flip) trimInfo.push('flip');

    normalizeClip(videoPath, normPath, trim);
    normalizedFiles.push(normPath);

    const info = trimInfo.length > 0 ? ` (${trimInfo.join(', ')})` : '';
    console.log(`    ${shotName}${info}`);
  }

  // ── Step 2: Replace dialogue if TTS files exist ──
  let processedFiles = normalizedFiles;

  if (dialogueDir && existsSync(dialogueDir)) {
    console.log(`  Replacing dialogue with Venice TTS (native audio ducked to ${Math.round(nativeAudioVolume * 100)}%)...`);
    const tmpDir = join(dirname(outputPath), '.tmp-dialogue-mix');
    await mkdir(tmpDir, { recursive: true });

    processedFiles = [];
    for (const videoPath of normalizedFiles) {
      const shotName = basename(videoPath, '.mp4');
      const shotNum = shotName.replace('shot-', '');
      const dialoguePath = join(dialogueDir, `dialogue-shot-${shotNum}.mp3`);

      if (existsSync(dialoguePath)) {
        const processedPath = join(tmpDir, `${shotName}-voiced.mp4`);
        replaceDialogueInShot(videoPath, dialoguePath, processedPath, nativeAudioVolume);
        processedFiles.push(processedPath);
        console.log(`    ${shotName}: dialogue replaced`);
      } else {
        processedFiles.push(videoPath);
      }
    }
  }

  // ── Step 3: Concatenate ──
  const concatPath = join(normDir, 'concat.txt');
  const lines = processedFiles.map(f => `file '${f}'`).join('\n');
  writeFileSync(concatPath, lines, 'utf-8');

  const concatenatedPath = outputPath.replace(/\.mp4$/, '-raw.mp4');
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -c copy -movflags +faststart "${concatenatedPath}"`,
    { stdio: 'pipe' },
  );

  const concatDur = getVideoDuration(concatenatedPath);
  console.log(`  Concatenated ${processedFiles.length} clips -> ${concatDur.toFixed(1)}s`);

  let currentInput = concatenatedPath;

  // ── Step 4: Mix in ambient bed (looped to duration) ──
  if (ambientBedPath && existsSync(ambientBedPath)) {
    const withAmbientPath = outputPath.replace(/\.mp4$/, '-with-ambient.mp4');
    // Loop the ambient clip to cover full video duration, mix under native audio
    execSync(
      `ffmpeg -y -i "${currentInput}" -stream_loop -1 -i "${ambientBedPath}" ` +
      `-filter_complex "[1:a]volume=${ambientBedVolume}[ambient];[0:a][ambient]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map 0:v -map "[aout]" -c:v copy -c:a aac "${withAmbientPath}"`,
      { stdio: 'pipe' },
    );
    console.log(`  Mixed in ambient bed at ${Math.round(ambientBedVolume * 100)}% volume (looped)`);
    currentInput = withAmbientPath;
  }

  // ── Step 5: Mix in background music ──
  if (musicPath && existsSync(musicPath)) {
    const withMusicPath = outputPath.replace(/\.mp4$/, '-with-music.mp4');
    execSync(
      `ffmpeg -y -i "${currentInput}" -i "${musicPath}" ` +
      `-filter_complex "[1:a]volume=${musicVolume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map 0:v -map "[aout]" -c:v copy -c:a aac "${withMusicPath}"`,
      { stdio: 'pipe' },
    );
    console.log(`  Mixed in background music at ${Math.round(musicVolume * 100)}% volume`);
    currentInput = withMusicPath;
  }

  // ── Step 5.5: Fade title over the ending of the last shot ──
  if (endingTitleOverlay?.text?.trim()) {
    const withTitlePath = outputPath.replace(/\.mp4$/, '-with-title.mp4');
    const totalDuration = getVideoDuration(currentInput);
    const fadeInSec = endingTitleOverlay.fadeInSec ?? 1.2;
    const holdSec = endingTitleOverlay.holdSec ?? 1.8;
    const overlayStart = Math.max(0, totalDuration - holdSec);
    const escapedText = endingTitleOverlay.text.replace(/'/g, "\\'").replace(/:/g, '\\:');
    const fontPath = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

    const titleFilter = [
      `drawtext=fontfile='${fontPath}':text='${escapedText}':fontcolor=0xD66BFF@0.22:fontsize=104:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${overlayStart}),0,if(lt(t,${overlayStart + fadeInSec}),(t-${overlayStart})/${fadeInSec},1))'`,
      `drawtext=fontfile='${fontPath}':text='${escapedText}':fontcolor=0x7EF9FF@0.35:fontsize=98:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${overlayStart}),0,if(lt(t,${overlayStart + fadeInSec}),(t-${overlayStart})/${fadeInSec},1))'`,
      `drawtext=fontfile='${fontPath}':text='${escapedText}':fontcolor=white:fontsize=92:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${overlayStart}),0,if(lt(t,${overlayStart + fadeInSec}),(t-${overlayStart})/${fadeInSec},1))'`,
    ].join(',');

    execSync(
      `ffmpeg -y -i "${currentInput}" -vf "${titleFilter}" -c:v libx264 -preset fast -crf 18 -c:a copy "${withTitlePath}"`,
      { stdio: 'pipe' },
    );
    console.log(`  Faded in ending title "${endingTitleOverlay.text}" over final ${holdSec.toFixed(1)}s`);
    currentInput = withTitlePath;
  }

  // ── Step 6: Burn subtitles ──
  if (srtPath && existsSync(srtPath)) {
    // Save no-subtitles version as backup
    const noSubsPath = outputPath.replace(/\.mp4$/, '-nosubs.mp4');
    execSync(`cp "${currentInput}" "${noSubsPath}"`, { stdio: 'pipe' });

    const escapedSrt = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const subtitleFilter = [
      `subtitles='${escapedSrt}'`,
      `:force_style='`,
      `FontName=D-DIN Condensed,`,
      `FontSize=11,`,
      `PrimaryColour=&H00FFFFFF,`,
      `OutlineColour=&H00000000,`,
      `BorderStyle=1,`,
      `Outline=0.8,`,
      `Shadow=0,`,
      `Alignment=2,`,
      `MarginV=100,`,
      `Spacing=0.5`,
      `'`,
    ].join('');

    execSync(
      `ffmpeg -y -i "${currentInput}" -vf "${subtitleFilter}" ` +
      `-c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}"`,
      { stdio: 'pipe' },
    );
    console.log(`  Burned subtitles (backup at ${basename(noSubsPath)})`);
  } else {
    if (currentInput !== outputPath) {
      execSync(`cp "${currentInput}" "${outputPath}"`, { stdio: 'pipe' });
    }
  }

  // ── Cleanup ──
  try {
    if (existsSync(normDir)) rmSync(normDir, { recursive: true, force: true });
    if (existsSync(concatenatedPath)) unlinkSync(concatenatedPath);
    const withAmbientPath = outputPath.replace(/\.mp4$/, '-with-ambient.mp4');
    if (existsSync(withAmbientPath)) unlinkSync(withAmbientPath);
    const withMusicPath = outputPath.replace(/\.mp4$/, '-with-music.mp4');
    if (existsSync(withMusicPath)) unlinkSync(withMusicPath);
    const withTitlePath = outputPath.replace(/\.mp4$/, '-with-title.mp4');
    if (existsSync(withTitlePath)) unlinkSync(withTitlePath);
    const tmpDialogue = join(dirname(outputPath), '.tmp-dialogue-mix');
    if (existsSync(tmpDialogue)) rmSync(tmpDialogue, { recursive: true, force: true });
  } catch { /* best-effort */ }

  const finalDur = getVideoDuration(outputPath);
  const finalSize = execSync(`ls -lh "${outputPath}"`, { encoding: 'utf-8' }).split(/\s+/)[4];
  console.log(`  Final episode: ${outputPath} (${finalDur.toFixed(1)}s, ${finalSize})`);
  return outputPath;
}

export async function collectShotVideos(sceneDir: string): Promise<string[]> {
  if (!existsSync(sceneDir)) return [];

  const entries = await readdir(sceneDir);
  return entries
    .filter(f => /^shot-\d{3}\.mp4$/.test(f))
    .sort()
    .map(f => join(sceneDir, f));
}
