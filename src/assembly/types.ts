/**
 * Types for the Remotion assembly pipeline.
 */

export interface ShotManifestEntry {
  /** Relative path from remotion public/ dir, e.g. "scene-001/shot-001.mp4" */
  file: string;
  /** Absolute path to the source MP4 */
  absolutePath: string;
  /** Scene number */
  sceneNumber: number;
  /** Shot number within scene */
  shotNumber: number;
  /** Panel ID, e.g. "S1-P1" */
  panelId: string;
  /** Duration in seconds (from ffprobe) */
  durationSec: number;
  /** Duration in frames at target FPS */
  durationInFrames: number;
  /** Video FPS (from ffprobe) */
  fps: number;
  /** Video width */
  width: number;
  /** Video height */
  height: number;
  /** Transition type from video.json metadata */
  transition: TransitionType;
  /** Transition duration in frames */
  transitionDurationInFrames: number;
  /** Characters in this shot */
  characters: string[];
  /** Dialogue if present */
  dialogue?: { character: string; line: string };
  /** Camera movement description */
  cameraMovement: string;
  /** Mood of the scene */
  mood?: string;
}

export type TransitionType = 'cut' | 'fade' | 'dissolve' | 'wipe';

export interface ShotManifest {
  projectName: string;
  targetFps: number;
  targetWidth: number;
  targetHeight: number;
  scenes: SceneManifest[];
  totalDurationInFrames: number;
  totalDurationSec: number;
  totalShots: number;
  createdAt: string;
}

export interface SceneManifest {
  sceneNumber: number;
  heading: string;
  mood: string;
  shots: ShotManifestEntry[];
  durationInFrames: number;
  durationSec: number;
}

export interface RemotionProjectConfig {
  projectDir: string;
  publicDir: string;
  srcDir: string;
  manifest: ShotManifest;
}
