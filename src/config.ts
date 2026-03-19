import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Scene } from './parsers/scene-extractor.js';
import type { CharacterDescription } from './characters/describer.js';
import type { CharacterLock } from './characters/reference-manager.js';
import type { AestheticProfile } from './storyboard/prompt-builder.js';

export interface ProjectState {
  name: string;
  screenplayPath: string;
  outputDir: string;
  scenes: Scene[];
  characters: CharacterDescription[];
  characterLocks: CharacterLock[];
  aesthetic: AestheticProfile | null;
  completedScenes: number[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_AESTHETIC: AestheticProfile = {
  style: 'Cinematic photography',
  palette: 'warm natural palette',
  lighting: 'natural lighting with subtle film grain',
  lensCharacteristics: 'anamorphic lens characteristics, shallow depth of field',
  filmStock: '35mm Kodak Vision3 500T',
};

export function createDefaultAesthetic(): AestheticProfile {
  return { ...DEFAULT_AESTHETIC };
}

export function createProject(name: string, screenplayPath: string, outputBase: string): ProjectState {
  const outputDir = join(outputBase, name.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const now = new Date().toISOString();
  return {
    name,
    screenplayPath,
    outputDir,
    scenes: [],
    characters: [],
    characterLocks: [],
    aesthetic: null,
    completedScenes: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveProject(state: ProjectState): Promise<void> {
  if (!existsSync(state.outputDir)) {
    await mkdir(state.outputDir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();

  // Save state without base64 image data (those are stored as files)
  const serializable = {
    ...state,
    characterLocks: state.characterLocks.map(lock => ({
      ...lock,
      referenceImages: {
        front: '[saved to disk]',
        threeQuarter: '[saved to disk]',
        profile: '[saved to disk]',
        fullBody: '[saved to disk]',
      },
    })),
  };
  await writeFile(
    join(state.outputDir, 'project.json'),
    JSON.stringify(serializable, null, 2),
  );
}

export async function loadProject(outputDir: string): Promise<ProjectState | null> {
  const projectFile = join(outputDir, 'project.json');
  if (!existsSync(projectFile)) return null;
  const data = await readFile(projectFile, 'utf-8');
  return JSON.parse(data) as ProjectState;
}

export function getVeniceApiKey(): string {
  const key = process.env.VENICE_API_KEY;
  if (!key) {
    throw new Error('VENICE_API_KEY environment variable is required. Set it in .env or export it.');
  }
  return key;
}
