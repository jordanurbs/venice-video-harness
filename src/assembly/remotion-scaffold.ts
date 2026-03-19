/**
 * Scaffolds a complete Remotion project inside the project's output directory.
 * Generates package.json, tsconfig, and all React components from the manifest.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ShotManifest, SceneManifest, ShotManifestEntry } from './types.js';

export interface ScaffoldResult {
  remotionDir: string;
  manifestPath: string;
  entryPoint: string;
  /** The directory to pass as --public-dir (the project output dir with real MP4s) */
  publicDir: string;
}

/** Ensure a directory exists */
async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function scaffoldRemotionProject(
  projectOutputDir: string,
  manifest: ShotManifest,
): Promise<ScaffoldResult> {
  const remotionDir = join(projectOutputDir, 'remotion');
  const srcDir = join(remotionDir, 'src');
  // Use the project output dir itself as the public dir --
  // it already contains scene-NNN/shot-NNN.mp4 files in the right structure.
  // Remotion's --public-dir flag will point here.
  const publicDir = resolve(projectOutputDir);

  console.log(`\nScaffolding Remotion project at ${remotionDir}`);

  // Create directory structure
  await ensureDir(srcDir);

  // Write manifest
  const manifestPath = join(remotionDir, 'shot-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Wrote shot-manifest.json');

  // Write all project files
  await writeFile(join(remotionDir, 'package.json'), generatePackageJson(manifest));
  await writeFile(join(remotionDir, 'tsconfig.json'), generateTsConfig());
  await writeFile(join(srcDir, 'index.ts'), generateEntryPoint());
  await writeFile(join(srcDir, 'Root.tsx'), generateRoot(manifest));
  await writeFile(join(srcDir, 'Film.tsx'), generateFilm());
  await writeFile(join(srcDir, 'Scene.tsx'), generateScene());
  await writeFile(join(srcDir, 'types.ts'), generateClientTypes());
  console.log('Wrote Remotion source files');

  return {
    remotionDir,
    manifestPath,
    entryPoint: join(srcDir, 'index.ts'),
    publicDir,
  };
}

// ── File generators ──────────────────────────────────────────────────

function generatePackageJson(manifest: ShotManifest): string {
  const pkg = {
    name: `${manifest.projectName}-remotion`,
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      preview: 'npx remotion preview src/index.ts',
      render: `npx remotion render src/index.ts Film --codec=h264 --crf=18`,
      'render:scene': 'echo "Usage: npm run render:scene -- SceneN"',
    },
    dependencies: {
      '@remotion/cli': '^4.0.0',
      '@remotion/transitions': '^4.0.0',
      '@remotion/renderer': '^4.0.0',
      '@remotion/bundler': '^4.0.0',
      react: '^18.3.0',
      'react-dom': '^18.3.0',
      remotion: '^4.0.0',
    },
    devDependencies: {
      '@types/react': '^18.3.0',
      typescript: '^5.7.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'preserve',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      outDir: 'dist',
    },
    include: ['src/**/*'],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function generateEntryPoint(): string {
  return `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
`;
}

function generateRoot(manifest: ShotManifest): string {
  // Build per-scene compositions + full film composition
  const sceneComps = manifest.scenes
    .map((scene) => {
      const id = `Scene${scene.sceneNumber}`;
      return `      <Composition
        id="${id}"
        component={Film}
        durationInFrames={${scene.durationInFrames}}
        fps={${manifest.targetFps}}
        width={${manifest.targetWidth}}
        height={${manifest.targetHeight}}
        defaultProps={{
          scenes: manifest.scenes.filter((s) => s.sceneNumber === ${scene.sceneNumber}),
          fps: ${manifest.targetFps},
          sceneTransitionFrames: SCENE_TRANSITION_FRAMES,
        }}
      />`;
    })
    .join('\n');

  return `import React from "react";
import { Composition } from "remotion";
import { Film } from "./Film";
import manifest from "../shot-manifest.json";
import type { ShotManifest } from "./types";

const typedManifest = manifest as unknown as ShotManifest;
const SCENE_TRANSITION_FRAMES = ${manifest.targetFps}; // 1s between scenes

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Film"
        component={Film}
        durationInFrames={${manifest.totalDurationInFrames}}
        fps={${manifest.targetFps}}
        width={${manifest.targetWidth}}
        height={${manifest.targetHeight}}
        defaultProps={{
          scenes: typedManifest.scenes,
          fps: ${manifest.targetFps},
          sceneTransitionFrames: SCENE_TRANSITION_FRAMES,
        }}
      />
${sceneComps}
    </>
  );
};
`;
}

function generateFilm(): string {
  return `import React from "react";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Scene } from "./Scene";
import type { SceneManifest } from "./types";

interface FilmProps {
  scenes: SceneManifest[];
  fps: number;
  sceneTransitionFrames: number;
}

export const Film: React.FC<FilmProps> = ({
  scenes,
  fps,
  sceneTransitionFrames,
}) => {
  return (
    <TransitionSeries>
      {scenes.map((scene, i) => (
        <React.Fragment key={scene.sceneNumber}>
          <TransitionSeries.Sequence durationInFrames={scene.durationInFrames}>
            <Scene scene={scene} fps={fps} />
          </TransitionSeries.Sequence>
          {i < scenes.length - 1 && (
            <TransitionSeries.Transition
              presentation={fade()}
              timing={linearTiming({
                durationInFrames: sceneTransitionFrames,
              })}
            />
          )}
        </React.Fragment>
      ))}
    </TransitionSeries>
  );
};
`;
}

function generateScene(): string {
  return `import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import type { SceneManifest, TransitionType } from "./types";

interface SceneProps {
  scene: SceneManifest;
  fps: number;
}

function getPresentation(type: TransitionType) {
  switch (type) {
    case "fade":
    case "dissolve":
      return fade();
    case "wipe":
      return slide({ direction: "from-right" });
    case "cut":
    default:
      return fade(); // 1-frame fade = hard cut
  }
}

export const Scene: React.FC<SceneProps> = ({ scene, fps }) => {
  const { shots } = scene;

  return (
    <TransitionSeries>
      {shots.map((shot, i) => (
        <React.Fragment key={shot.panelId}>
          <TransitionSeries.Sequence durationInFrames={shot.durationInFrames}>
            <AbsoluteFill style={{ backgroundColor: "black" }}>
              <OffthreadVideo
                src={staticFile(shot.file)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            </AbsoluteFill>
          </TransitionSeries.Sequence>
          {i < shots.length - 1 && (
            <TransitionSeries.Transition
              presentation={getPresentation(shots[i + 1].transition)}
              timing={linearTiming({
                durationInFrames: shots[i + 1].transitionDurationInFrames,
              })}
            />
          )}
        </React.Fragment>
      ))}
    </TransitionSeries>
  );
};
`;
}

function generateClientTypes(): string {
  return `/** Shared types for Remotion components -- mirrors assembly/types.ts */

export type TransitionType = "cut" | "fade" | "dissolve" | "wipe";

export interface ShotManifestEntry {
  file: string;
  sceneNumber: number;
  shotNumber: number;
  panelId: string;
  durationSec: number;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  transition: TransitionType;
  transitionDurationInFrames: number;
  characters: string[];
  dialogue?: { character: string; line: string };
  cameraMovement: string;
  mood?: string;
}

export interface SceneManifest {
  sceneNumber: number;
  heading: string;
  mood: string;
  shots: ShotManifestEntry[];
  durationInFrames: number;
  durationSec: number;
}

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
`;
}
