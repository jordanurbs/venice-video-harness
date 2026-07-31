import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  SeriesState,
  MiniDramaCharacter,
  EpisodeMeta,
  EpisodeScript,
  Location,
} from './types.js';
import {
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
  DEFAULT_LIP_SYNC_MODEL,
  resolveVideoFamilyDefaults,
  type AudioStrategy,
  type VideoFamilyPreference,
} from './types.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CreateSeriesOptions {
  /** Upfront questionnaire: how dialogue reaches the final mix. */
  audioStrategy?: AudioStrategy;
  /** Upfront questionnaire: preferred video model family. */
  videoFamilyPreference?: VideoFamilyPreference;
  /** Directory that contains every series project. */
  workspace?: string;
  /** Broad standalone-CLI creation type. */
  projectType?: 'film' | 'series' | 'product-video' | 'music-video' | 'screenplay';
}

export function createSeries(
  name: string,
  concept: string,
  genre: string,
  setting: string,
  options?: CreateSeriesOptions,
): SeriesState {
  const slug = slugify(name);
  const outputDir = join(resolve(options?.workspace ?? 'output'), slug);
  const now = new Date().toISOString();

  const family = options?.videoFamilyPreference ?? 'auto';
  const familyDefaults = resolveVideoFamilyDefaults(family);

  return {
    name,
    slug,
    concept,
    genre,
    setting,
    ...(options?.projectType ? { projectType: options.projectType } : {}),
    aesthetic: null,
    characters: [],
    episodes: [],
    videoDefaults: {
      actionModel: family === 'auto' ? DEFAULT_ACTION_MODEL : familyDefaults.actionModel,
      atmosphereModel: family === 'auto' ? DEFAULT_ATMOSPHERE_MODEL : familyDefaults.atmosphereModel,
      characterConsistencyModel:
        family === 'auto' ? DEFAULT_CHARACTER_CONSISTENCY_MODEL : familyDefaults.characterConsistencyModel,
      imageDefaults: {
        generationModel: DEFAULT_IMAGE_GENERATION_MODEL,
        editModel: DEFAULT_IMAGE_EDIT_MODEL,
      },
      lipSyncModel: DEFAULT_LIP_SYNC_MODEL,
      ...(options?.audioStrategy ? { audioStrategy: options.audioStrategy } : {}),
      ...(options?.videoFamilyPreference ? { videoFamilyPreference: options.videoFamilyPreference } : {}),
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

  // NOTE: the former `seedanceCompatibility` auto-fill was removed (2026-07)
  // once Venice dropped the Seedance seedream-only face restriction. Seedance
  // now accepts face-bearing input images from any image family, so there is no
  // provenance-driven mode to infer. The field is still honored if an operator
  // sets it explicitly, but nothing sets it automatically anymore.

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

export async function listSeries(workspace = resolve('output')): Promise<{ name: string; slug: string; dir: string }[]> {
  const outputBase = resolve(workspace);
  const results: { name: string; slug: string; dir: string }[] = [];
  if (!existsSync(outputBase)) return results;

  const entries = await readdir(outputBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(outputBase, entry.name);
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

/**
 * Directory for a location's reference assets, mirroring getCharacterDir.
 * Accepts a slug or a display name; slugifies to find the canonical dir and
 * falls back to the raw name for directories created outside the CLI.
 */
export function getLocationDir(series: SeriesState, locationSlugOrName: string): string {
  const safeName = locationSlugOrName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slugPath = join(series.outputDir, 'locations', safeName);
  if (existsSync(slugPath)) return slugPath;
  const rawPath = join(series.outputDir, 'locations', locationSlugOrName);
  if (existsSync(rawPath)) return rawPath;
  return slugPath;
}

export function locationSlugify(name: string): string {
  return slugify(name);
}

/**
 * Directory for composed storyboard blocking plates (StoryboardReference).
 * Plates are series-level assets keyed by slug — slugs are conventionally
 * prefixed with the episode (e.g. "e01-courtyard-chalice-fight") so beats
 * from different episodes never collide.
 */
export function getStoryboardDir(series: SeriesState): string {
  return join(series.outputDir, 'storyboards');
}

/**
 * Absolute path to a storyboard blocking plate by slug. Returns the first
 * existing candidate (slugified, then raw name — mirroring getLocationDir's
 * tolerance for files created outside the CLI), falling back to the
 * canonical slugified path (the write target) when none exists yet.
 * Callers deciding whether to USE the plate should existsSync() the result.
 */
export function getStoryboardRefPath(series: SeriesState, slug: string): string {
  const dir = getStoryboardDir(series);
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  for (const candidate of [join(dir, `${safe}.png`), join(dir, `${slug}.png`)]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, `${safe}.png`);
}

/** Find a location by slug (preferred) or display name. */
export function getLocation(series: SeriesState, slugOrName: string): Location | undefined {
  const needle = slugOrName.toLowerCase();
  return (series.locations ?? []).find(
    l => l.slug.toLowerCase() === needle || l.name.toLowerCase() === needle,
  );
}

/** Insert or replace a location by slug. */
export function addLocation(series: SeriesState, location: Location): void {
  if (!series.locations) series.locations = [];
  const idx = series.locations.findIndex(l => l.slug === location.slug);
  if (idx >= 0) series.locations[idx] = location;
  else series.locations.push(location);
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
