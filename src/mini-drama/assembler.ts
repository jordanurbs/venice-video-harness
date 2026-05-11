import { readdir, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { existsSync, writeFileSync, unlinkSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ShotScript, MusicCueSpec } from '../series/types.js';
import {
  renderMusicCuesTrack,
  resolveMusicCues,
  buildMusicHoldExpr,
  applyMusicHoldAutomation,
  type PlacementMap,
} from './music-cues.js';

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
  /**
   * EXT-4: ordered list of per-act music cues. When supplied (and non-empty),
   * the assembler renders them with crossfades and uses the resulting track
   * as the music bed in place of `musicPath`. The legacy single-bed path is
   * preserved for back-compat.
   */
  musicCues?: MusicCueSpec[];
  /**
   * Optional shot-id placement map (string keys, zero-padded for numeric
   * ids per EXT-8). When omitted, the assembler derives it from the
   * normalized clip durations using each clip's filename as the shot id.
   * Caller can pass an explicit map when the clip order doesn't match the
   * shot ids (e.g. multi-shot bundles).
   */
  placementMap?: PlacementMap;
  /**
   * EXT-12: shot list used to derive musicHold automation. When omitted,
   * automation is skipped.
   */
  shots?: ShotScript[];
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

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function getVideoDuration(path: string): number {
  const out = runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]).trim();
  return parseFloat(out);
}

/**
 * EXT-4 fallback: derive a placement map from the post-normalization clip
 * list when the caller didn't supply an explicit one. Each clip is expected
 * to be named `shot-NNN.mp4` or `shot-NNNb.mp4` per EXT-8 conventions.
 *
 * If the filename can't be parsed as a shot id, the clip is given an
 * auto-incremented numeric key so the assembler still emits *something*
 * rather than skipping a cue silently.
 */
function derivePlacementMapFromClips(clipPaths: string[]): PlacementMap {
  const map: PlacementMap = {};
  let cursor = 0;
  for (let i = 0; i < clipPaths.length; i++) {
    const filename = basename(clipPaths[i], '.mp4');
    const dur = getVideoDuration(clipPaths[i]);
    let key: string;
    const match = filename.match(/^shot-(\d+)([a-zA-Z]*)/);
    if (match) {
      key = String(match[1]).padStart(3, '0') + match[2];
    } else {
      key = String(i + 1).padStart(3, '0');
    }
    map[key] = { startSec: cursor, endSec: cursor + dur };
    cursor += dur;
  }
  return map;
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
  const ffmpegArgs: string[] = ['-y'];

  if (trim?.trimStart && trim.trimStart > 0) {
    ffmpegArgs.push('-ss', String(trim.trimStart));
  }

  ffmpegArgs.push('-i', inputPath);

  if (trim?.trimEnd && trim.trimEnd > 0) {
    const duration = getVideoDuration(inputPath);
    const endTime = duration - trim.trimEnd - (trim.trimStart ?? 0);
    if (endTime > 0) {
      ffmpegArgs.push('-t', String(endTime));
    }
  }

  if (trim?.flip) {
    filters.push('hflip');
  }

  if (filters.length > 0) {
    ffmpegArgs.push('-vf', filters.join(','));
  }
  ffmpegArgs.push(
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    '-r',
    '24',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    '192k',
    outputPath,
  );

  runCommand('ffmpeg', ffmpegArgs);
}

function replaceDialogueInShot(
  videoPath: string,
  dialoguePath: string,
  outputPath: string,
  nativeVolume: number,
): void {
  runCommand('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-i',
    dialoguePath,
    '-filter_complex',
    `[0:a]volume=${nativeVolume}[native];[1:a]volume=1.0[tts];[native][tts]amix=inputs=2:duration=first:dropout_transition=0.5[aout]`,
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    outputPath,
  ]);
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
  runCommand('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    concatenatedPath,
  ]);

  const concatDur = getVideoDuration(concatenatedPath);
  console.log(`  Concatenated ${processedFiles.length} clips -> ${concatDur.toFixed(1)}s`);

  let currentInput = concatenatedPath;

  // ── Step 3.5: Build the per-act music bed (EXT-4 / EXT-12) ──
  // When `musicCues` are supplied, render an ordered ffmpeg crossfade track
  // and use it as the music bed in place of `musicPath`. The legacy single-
  // bed path is preserved when no cues are supplied. musicHold automation is
  // layered on top via a `volume=` expression so cue audio doesn't have to
  // be re-rendered when only the automation changes.
  let effectiveMusicPath = musicPath;
  if (options.musicCues && options.musicCues.length > 0) {
    const placementMap = options.placementMap ?? derivePlacementMapFromClips(processedFiles);
    const resolved = resolveMusicCues(
      options.musicCues,
      placementMap,
      cue => cue.audioPath,
    );
    if (resolved.length > 0) {
      const cuesTrackPath = outputPath.replace(/\.mp4$/, '-music-cues.mp3');
      await renderMusicCuesTrack({
        cues: resolved,
        outputPath: cuesTrackPath,
        totalDurationSec: concatDur,
      });
      let bedPath: string = cuesTrackPath;
      if (options.shots) {
        const holdExpr = buildMusicHoldExpr(options.shots, placementMap);
        if (holdExpr) {
          const automatedPath = outputPath.replace(/\.mp4$/, '-music-cues-auto.mp3');
          await applyMusicHoldAutomation({
            inputPath: cuesTrackPath,
            outputPath: automatedPath,
            volumeExpr: holdExpr,
          });
          bedPath = automatedPath;
          console.log(`  Applied musicHold automation (${holdExpr.length} chars)`);
        }
      }
      effectiveMusicPath = bedPath;
      console.log(`  Music cues: ${resolved.length} segment(s) crossfaded -> ${basename(bedPath)}`);
    } else {
      console.warn('  Music cues: no cues resolved against placement map; falling back to musicPath.');
    }
  }

  // ── Step 4: Mix in ambient bed (looped to duration) ──
  if (ambientBedPath && existsSync(ambientBedPath)) {
    const withAmbientPath = outputPath.replace(/\.mp4$/, '-with-ambient.mp4');
    // Loop the ambient clip to cover full video duration, mix under native audio
    runCommand('ffmpeg', [
      '-y',
      '-i',
      currentInput,
      '-stream_loop',
      '-1',
      '-i',
      ambientBedPath,
      '-filter_complex',
      `[1:a]volume=${ambientBedVolume}[ambient];[0:a][ambient]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      withAmbientPath,
    ]);
    console.log(`  Mixed in ambient bed at ${Math.round(ambientBedVolume * 100)}% volume (looped)`);
    currentInput = withAmbientPath;
  }

  // ── Step 5: Mix in background music ──
  // Per EXT-4, when music cues were used, their per-cue gain (-22 dB by
  // default) is already baked into `effectiveMusicPath`. Skip the extra
  // `volume=musicVolume` multiplier in that case to avoid double-attenuating.
  if (effectiveMusicPath && existsSync(effectiveMusicPath)) {
    const withMusicPath = outputPath.replace(/\.mp4$/, '-with-music.mp4');
    const cuesBaked = effectiveMusicPath !== musicPath;
    const musicFilter = cuesBaked
      ? `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      : `[1:a]volume=${musicVolume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    runCommand('ffmpeg', [
      '-y',
      '-i',
      currentInput,
      '-i',
      effectiveMusicPath,
      '-filter_complex',
      musicFilter,
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      withMusicPath,
    ]);
    const label = cuesBaked ? 'cues-baked' : `${Math.round(musicVolume * 100)}% volume`;
    console.log(`  Mixed in background music (${label})`);
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

    runCommand('ffmpeg', [
      '-y',
      '-i',
      currentInput,
      '-vf',
      titleFilter,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-c:a',
      'copy',
      withTitlePath,
    ]);
    console.log(`  Faded in ending title "${endingTitleOverlay.text}" over final ${holdSec.toFixed(1)}s`);
    currentInput = withTitlePath;
  }

  // ── Step 6: Burn subtitles ──
  if (srtPath && existsSync(srtPath)) {
    // Save no-subtitles version as backup
    const noSubsPath = outputPath.replace(/\.mp4$/, '-nosubs.mp4');
    copyFileSync(currentInput, noSubsPath);

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

    runCommand('ffmpeg', [
      '-y',
      '-i',
      currentInput,
      '-vf',
      subtitleFilter,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-c:a',
      'copy',
      outputPath,
    ]);
    console.log(`  Burned subtitles (backup at ${basename(noSubsPath)})`);
  } else {
    if (currentInput !== outputPath) {
      copyFileSync(currentInput, outputPath);
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
  const finalBytes = statSync(outputPath).size;
  const finalSizeMb = (finalBytes / (1024 * 1024)).toFixed(1);
  console.log(`  Final episode: ${outputPath} (${finalDur.toFixed(1)}s, ${finalSizeMb} MB)`);
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
