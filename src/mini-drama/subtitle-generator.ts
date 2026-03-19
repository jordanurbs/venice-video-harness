import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ShotScript } from '../series/types.js';

export interface SubtitleEntry {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)s$/);
  return match ? parseInt(match[1]) : 5;
}

function getActualShotDuration(sceneDir: string | undefined, shotNumber: number, fallbackDuration: string): number {
  if (!sceneDir) return parseDuration(fallbackDuration);

  const videoPath = join(sceneDir, `shot-${String(shotNumber).padStart(3, '0')}.mp4`);
  if (!existsSync(videoPath)) return parseDuration(fallbackDuration);

  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf-8' },
    ).trim();
    const duration = parseFloat(out);
    return Number.isFinite(duration) ? duration : parseDuration(fallbackDuration);
  } catch {
    return parseDuration(fallbackDuration);
  }
}

export function generateSubtitles(shots: ShotScript[], sceneDir?: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  let currentTime = 0;
  let index = 1;

  for (const shot of shots) {
    const shotDuration = getActualShotDuration(sceneDir, shot.shotNumber, shot.duration);

    if (shot.dialogue) {
      const words = shot.dialogue.line.split(/\s+/);
      const wordsPerSecond = 2.5;
      const speakDuration = Math.min(words.length / wordsPerSecond + 0.5, shotDuration - 0.3);

      // AI dialogue usually starts well after the cut; bias subtitles as late as
      // possible while still letting the full line finish before the shot ends.
      const startOffset = Math.max(0.3, shotDuration - speakDuration - 0.15);
      const start = currentTime + startOffset;
      const end = currentTime + startOffset + speakDuration;

      if (words.length <= 8) {
        entries.push({
          index: index++,
          startTime: formatSrtTime(start),
          endTime: formatSrtTime(end),
          text: shot.dialogue.line,
        });
      } else {
        const mid = Math.ceil(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const halfDuration = speakDuration / 2;

        entries.push({
          index: index++,
          startTime: formatSrtTime(start),
          endTime: formatSrtTime(start + halfDuration),
          text: firstHalf,
        });
        entries.push({
          index: index++,
          startTime: formatSrtTime(start + halfDuration),
          endTime: formatSrtTime(end),
          text: secondHalf,
        });
      }
    }

    currentTime += shotDuration;
  }

  return entries;
}

export function subtitlesToSrt(entries: SubtitleEntry[]): string {
  return entries
    .map(e => `${e.index}\n${e.startTime} --> ${e.endTime}\n${e.text}\n`)
    .join('\n');
}

export async function saveSrt(entries: SubtitleEntry[], outputPath: string): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  const srtContent = subtitlesToSrt(entries);
  await writeFile(outputPath, srtContent, 'utf-8');
  return outputPath;
}

export function burnSubtitles(
  inputVideo: string,
  srtPath: string,
  outputVideo: string,
): void {
  const escapedSrt = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:');

  const subtitleFilter = [
    `subtitles='${escapedSrt}'`,
    'force_style=\'',
    'FontName=Arial,',
    'FontSize=22,',
    'Bold=1,',
    'PrimaryColour=&H00FFFFFF,',
    'OutlineColour=&H00000000,',
    'BackColour=&H80000000,',
    'Outline=2,',
    'Shadow=1,',
    'Alignment=2,',
    'MarginV=150',
    '\'',
  ].join('');

  execSync(
    `ffmpeg -y -i "${inputVideo}" -vf "${subtitleFilter}" -c:a copy "${outputVideo}"`,
    { stdio: 'pipe' },
  );
}
