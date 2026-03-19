import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  SeriesState,
  MiniDramaCharacter,
  EpisodeMeta,
  EpisodeScript,
} from './types.js';
import {
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
} from './types.js';

const OUTPUT_BASE = resolve('output');

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createSeries(
  name: string,
  concept: string,
  genre: string,
  setting: string,
): SeriesState {
  const slug = slugify(name);
  const outputDir = join(OUTPUT_BASE, slug);
  const now = new Date().toISOString();

  return {
    name,
    slug,
    concept,
    genre,
    setting,
    aesthetic: null,
    characters: [],
    episodes: [],
    videoDefaults: {
      actionModel: DEFAULT_ACTION_MODEL,
      atmosphereModel: DEFAULT_ATMOSPHERE_MODEL,
      characterConsistencyModel: DEFAULT_CHARACTER_CONSISTENCY_MODEL,
    },
    outputDir,
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveSeries(series: SeriesState): Promise<void> {
  if (!existsSync(series.outputDir)) {
    await mkdir(series.outputDir, { recursive: true });
  }
  series.updatedAt = new Date().toISOString();
  const filePath = join(series.outputDir, 'series.json');
  await writeFile(filePath, JSON.stringify(series, null, 2), 'utf-8');
}

export async function loadSeries(outputDir: string): Promise<SeriesState | null> {
  const filePath = join(outputDir, 'series.json');
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as SeriesState;
}

export async function listSeries(): Promise<{ name: string; slug: string; dir: string }[]> {
  const results: { name: string; slug: string; dir: string }[] = [];
  if (!existsSync(OUTPUT_BASE)) return results;

  const entries = await readdir(OUTPUT_BASE, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(OUTPUT_BASE, entry.name);
    const seriesFile = join(dir, 'series.json');
    if (!existsSync(seriesFile)) continue;
    try {
      const raw = await readFile(seriesFile, 'utf-8');
      const data = JSON.parse(raw) as SeriesState;
      results.push({ name: data.name, slug: data.slug, dir });
    } catch {
      // skip invalid
    }
  }
  return results;
}

export function addCharacter(series: SeriesState, character: MiniDramaCharacter): void {
  const existing = series.characters.findIndex(
    c => c.name.toUpperCase() === character.name.toUpperCase(),
  );
  if (existing >= 0) {
    series.characters[existing] = character;
  } else {
    series.characters.push(character);
  }
}

export function getCharacter(series: SeriesState, name: string): MiniDramaCharacter | undefined {
  return series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
}

export function addEpisode(series: SeriesState, title: string): EpisodeMeta {
  const number = series.episodes.length + 1;
  const episode: EpisodeMeta = {
    number,
    title,
    status: 'draft',
  };
  series.episodes.push(episode);
  return episode;
}

export function getEpisodeDir(series: SeriesState, episodeNumber: number): string {
  return join(series.outputDir, 'episodes', `episode-${String(episodeNumber).padStart(3, '0')}`);
}

export function getCharacterDir(series: SeriesState, characterName: string): string {
  const safeName = characterName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return join(series.outputDir, 'characters', safeName);
}

export async function saveEpisodeScript(
  series: SeriesState,
  script: EpisodeScript,
): Promise<string> {
  const episodeDir = getEpisodeDir(series, script.episode);
  if (!existsSync(episodeDir)) {
    await mkdir(episodeDir, { recursive: true });
  }
  const filePath = join(episodeDir, 'script.json');

  if (existsSync(filePath)) {
    let version = 1;
    let archivePath = join(episodeDir, `script-v${version}.json`);
    while (existsSync(archivePath)) {
      version++;
      archivePath = join(episodeDir, `script-v${version}.json`);
    }
    await rename(filePath, archivePath);
  }

  await writeFile(filePath, JSON.stringify(script, null, 2), 'utf-8');
  return filePath;
}

export async function loadEpisodeScript(
  series: SeriesState,
  episodeNumber: number,
): Promise<EpisodeScript | null> {
  const episodeDir = getEpisodeDir(series, episodeNumber);
  const filePath = join(episodeDir, 'script.json');
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as EpisodeScript;
}
