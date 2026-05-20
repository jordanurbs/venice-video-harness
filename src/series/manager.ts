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
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
  DEFAULT_LIP_SYNC_MODEL,
  recommendedSeedanceCompatibility,
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
      imageDefaults: {
        generationModel: DEFAULT_IMAGE_GENERATION_MODEL,
        editModel: DEFAULT_IMAGE_EDIT_MODEL,
      },
      seedanceCompatibility: 'prompt',
      lipSyncModel: DEFAULT_LIP_SYNC_MODEL,
    },
    outputDir,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Read every `characters/*\/character.json` on disk and return the resulting
 * array. This is the authoritative source of truth — the in-memory
 * `series.characters` is allowed to drift (commands sometimes mutate it
 * accidentally), but the per-character JSON files are written once by
 * `add-character` and only changed by explicit user action.
 *
 * Returns an empty array when the characters/ directory doesn't exist yet.
 */
export async function loadCharactersFromDisk(
  outputDir: string,
): Promise<MiniDramaCharacter[]> {
  const charsDir = join(outputDir, 'characters');
  if (!existsSync(charsDir)) return [];
  const out: MiniDramaCharacter[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(charsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const charJsonPath = join(charsDir, entry.name, 'character.json');
    if (!existsSync(charJsonPath)) continue;
    try {
      const raw = await readFile(charJsonPath, 'utf-8');
      const character = JSON.parse(raw) as MiniDramaCharacter;
      if (character && typeof character.name === 'string') {
        out.push(character);
      }
    } catch {
      // Skip malformed character.json — log to stderr so it's visible.
      console.warn(`  loadCharactersFromDisk: skipped malformed ${charJsonPath}`);
    }
  }
  return out;
}

export async function saveSeries(series: SeriesState): Promise<void> {
  if (!existsSync(series.outputDir)) {
    await mkdir(series.outputDir, { recursive: true });
  }
  series.updatedAt = new Date().toISOString();
  const filePath = join(series.outputDir, 'series.json');

  // Auto-fill `seedanceCompatibility` from the registered image-generation
  // model. The PNW field-guide hit a 422 because seedanceCompatibility was
  // unset and the default planner couldn't decide what to do with a
  // nano-banana panel bound for Seedance R2V. The auto-fill only runs when
  // the operator hasn't already set the field, so explicit overrides win.
  const imageGen = series.videoDefaults.imageDefaults?.generationModel;
  const recommended = recommendedSeedanceCompatibility(imageGen);
  if (recommended && !series.videoDefaults.seedanceCompatibility) {
    series.videoDefaults.seedanceCompatibility = recommended;
    console.log(`  series: auto-set seedanceCompatibility="${recommended}" from imageDefaults.generationModel="${imageGen}".`);
  } else if (
    recommended
    && series.videoDefaults.seedanceCompatibility
    && series.videoDefaults.seedanceCompatibility !== recommended
  ) {
    console.warn(
      `  series: operator-set seedanceCompatibility="${series.videoDefaults.seedanceCompatibility}" disagrees with the registry recommendation "${recommended}" for imageDefaults.generationModel="${imageGen}". Keeping operator value.`,
    );
  }

  // Rebuild `characters[]` from the on-disk per-character JSON files. This
  // closes a recurring data-loss bug where storyboard-episode / qa-approve /
  // other commands would load series.json, mutate one field, and save the
  // whole document back with an empty characters[] because they'd never
  // populated that field in their working copy. The per-character JSON files
  // are the single source of truth.
  try {
    const fromDisk = await loadCharactersFromDisk(series.outputDir);
    if (fromDisk.length > 0) {
      // Merge: prefer disk entries, but keep any in-memory characters that
      // don't yet have a disk record (e.g. the caller just created the
      // character in-process and hasn't written the json yet).
      const diskByName = new Map(fromDisk.map(c => [c.name.toUpperCase(), c]));
      const merged: MiniDramaCharacter[] = [...fromDisk];
      for (const inMem of series.characters) {
        if (!diskByName.has(inMem.name.toUpperCase())) merged.push(inMem);
      }
      series.characters = merged;
    }
  } catch (err) {
    console.warn(`  saveSeries: characters merge from disk failed (${(err as Error).message}); writing in-memory copy as-is.`);
  }

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
  const slugPath = join(series.outputDir, 'characters', safeName);
  if (existsSync(slugPath)) return slugPath;
  // Fall back to raw character name (handles directories created outside the CLI)
  const rawPath = join(series.outputDir, 'characters', characterName);
  if (existsSync(rawPath)) return rawPath;
  return slugPath;
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
