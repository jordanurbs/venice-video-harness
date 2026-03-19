/**
 * Builds a shot manifest by scanning scene directories for MP4s,
 * running ffprobe for timing data, and reading video.json for metadata.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type {
  ShotManifest,
  ShotManifestEntry,
  SceneManifest,
  TransitionType,
} from './types.js';
import type { ProjectState } from '../config.js';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

/** Map screenplay transition strings to our TransitionType */
function parseTransition(raw?: string): TransitionType {
  if (!raw) return 'cut';
  const t = raw.toUpperCase().trim();
  if (t.includes('DISSOLVE')) return 'dissolve';
  if (t.includes('FADE')) return 'fade';
  if (t.includes('WIPE')) return 'wipe';
  return 'cut';
}

/** Get transition duration in frames based on type */
function transitionFrames(type: TransitionType, fps: number): number {
  switch (type) {
    case 'cut': return 1;
    case 'fade': return Math.round(fps * 0.5); // 0.5s
    case 'dissolve': return Math.round(fps * 0.75); // 0.75s
    case 'wipe': return Math.round(fps * 0.5);
    default: return 1;
  }
}

interface FfprobeResult {
  duration: number;
  fps: number;
  width: number;
  height: number;
}

/** Run ffprobe on an MP4 to get duration, fps, and dimensions */
function probeVideo(filePath: string): FfprobeResult {
  try {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams -select_streams v "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    const data = JSON.parse(raw);
    const stream = data.streams?.[0] ?? {};
    const format = data.format ?? {};

    const duration = parseFloat(format.duration || stream.duration || '0');

    // Parse fps from r_frame_rate (e.g. "24/1")
    let fps = DEFAULT_FPS;
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      if (den && den > 0) fps = num / den;
    }

    return {
      duration,
      fps,
      width: stream.width || DEFAULT_WIDTH,
      height: stream.height || DEFAULT_HEIGHT,
    };
  } catch (err) {
    console.warn(`  ffprobe failed for ${filePath}, using defaults`);
    return { duration: 8, fps: DEFAULT_FPS, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
}

/** Read video.json metadata for a shot */
async function readVideoJson(jsonPath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = await readFile(jsonPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Find all scene directories sorted numerically */
async function findSceneDirs(projectDir: string): Promise<{ dir: string; num: number }[]> {
  const entries = await readdir(projectDir, { withFileTypes: true });
  const sceneDirs: { dir: string; num: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^scene-(\d+)$/);
    if (match) {
      sceneDirs.push({
        dir: join(projectDir, entry.name),
        num: parseInt(match[1], 10),
      });
    }
  }

  return sceneDirs.sort((a, b) => a.num - b.num);
}

/** Find all shot MP4s in a scene directory, sorted by shot number */
async function findShotMp4s(sceneDir: string): Promise<{ path: string; num: number }[]> {
  const entries = await readdir(sceneDir);
  const shots: { path: string; num: number }[] = [];

  for (const entry of entries) {
    const match = entry.match(/^shot-(\d+)\.mp4$/);
    if (match) {
      shots.push({
        path: join(sceneDir, entry),
        num: parseInt(match[1], 10),
      });
    }
  }

  return shots.sort((a, b) => a.num - b.num);
}

export async function buildManifest(project: ProjectState): Promise<ShotManifest> {
  const targetFps = DEFAULT_FPS;
  const projectDir = resolve(project.outputDir);

  console.log(`Scanning ${projectDir} for scene directories...`);
  const sceneDirs = await findSceneDirs(projectDir);

  if (sceneDirs.length === 0) {
    throw new Error('No scene directories found. Run storyboard generation first.');
  }

  console.log(`Found ${sceneDirs.length} scene(s)`);

  const scenes: SceneManifest[] = [];
  let totalShots = 0;

  for (const { dir: sceneDir, num: sceneNum } of sceneDirs) {
    const mp4s = await findShotMp4s(sceneDir);

    if (mp4s.length === 0) {
      console.log(`  Scene ${sceneNum}: no MP4s found, skipping`);
      continue;
    }

    console.log(`  Scene ${sceneNum}: ${mp4s.length} shots`);

    // Find the scene data from project state for heading/mood
    const sceneData = project.scenes.find(s => s.number === sceneNum);

    const shots: ShotManifestEntry[] = [];

    for (const mp4 of mp4s) {
      const probe = probeVideo(mp4.path);
      const videoJsonPath = mp4.path.replace(/\.mp4$/, '.video.json');
      const videoMeta = await readVideoJson(videoJsonPath);

      const transition = parseTransition(videoMeta?.transition as string);
      const durationInFrames = Math.round(probe.duration * targetFps);

      // Build relative path for Remotion public/ dir
      const sceneFolder = `scene-${String(sceneNum).padStart(3, '0')}`;
      const shotFile = `shot-${String(mp4.num).padStart(3, '0')}.mp4`;
      const relativePath = `${sceneFolder}/${shotFile}`;

      shots.push({
        file: relativePath,
        absolutePath: mp4.path,
        sceneNumber: sceneNum,
        shotNumber: mp4.num,
        panelId: (videoMeta?.panelId as string) || `S${sceneNum}-P${mp4.num}`,
        durationSec: probe.duration,
        durationInFrames,
        fps: probe.fps,
        width: probe.width,
        height: probe.height,
        transition,
        transitionDurationInFrames: transitionFrames(transition, targetFps),
        characters: (videoMeta?.characters as string[]) || [],
        dialogue: videoMeta?.dialogue as { character: string; line: string } | undefined,
        cameraMovement: (videoMeta?.cameraMovement as string) || '',
        mood: sceneData?.mood,
      });

      totalShots++;
    }

    // Calculate scene duration (sum of shots minus transition overlaps)
    const shotFrames = shots.reduce((sum, s) => sum + s.durationInFrames, 0);
    // Transitions between shots (not before first shot)
    const transitionOverlap = shots
      .slice(1)
      .reduce((sum, s) => sum + s.transitionDurationInFrames, 0);
    const sceneDurationFrames = shotFrames - transitionOverlap;

    scenes.push({
      sceneNumber: sceneNum,
      heading: sceneData?.heading || `Scene ${sceneNum}`,
      mood: sceneData?.mood || 'neutral',
      shots,
      durationInFrames: sceneDurationFrames,
      durationSec: sceneDurationFrames / targetFps,
    });
  }

  // Total duration: sum of all scene durations plus scene-to-scene transitions
  // Between scenes, we use a 1-second fade
  const sceneTransitionFrames = Math.round(targetFps * 1); // 1s between scenes
  const totalSceneFrames = scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
  const totalSceneTransitions = Math.max(0, scenes.length - 1) * sceneTransitionFrames;
  const totalDurationInFrames = totalSceneFrames - totalSceneTransitions;

  const manifest: ShotManifest = {
    projectName: project.name,
    targetFps,
    targetWidth: DEFAULT_WIDTH,
    targetHeight: DEFAULT_HEIGHT,
    scenes,
    totalDurationInFrames,
    totalDurationSec: totalDurationInFrames / targetFps,
    totalShots,
    createdAt: new Date().toISOString(),
  };

  console.log(`\nManifest built:`);
  console.log(`  Scenes: ${scenes.length}`);
  console.log(`  Total shots: ${totalShots}`);
  console.log(`  Total duration: ${manifest.totalDurationSec.toFixed(1)}s (${totalDurationInFrames} frames @ ${targetFps}fps)`);

  return manifest;
}
