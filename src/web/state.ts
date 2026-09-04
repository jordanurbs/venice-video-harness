// ---------------------------------------------------------------------------
// Project state for the web UI -- one JSON document per project.
//
// Reuses the same readers the treatment page is built from
// (collectProjectStatus, loadWorkshop, loadEpisodeScript) so the browser and
// WORKSHOP.html can never disagree about where an episode stands. Media paths
// are returned relative to the project dir so the client can turn them into
// /media/<project>/<rel> URLs.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadSeries, listSeries, loadEpisodeScript, getEpisodeDir } from '../series/manager.js';
import type { SeriesState, EpisodeScript } from '../series/types.js';
import { collectProjectStatus, type ProjectStatus } from '../session/status.js';
import { loadWorkshop, type WorkshopDraft } from '../mini-drama/workshop.js';
import { shotKey } from '../mini-drama/treatment.js';
import type { LoopManifest } from '../mini-drama/loop-engine.js';
import type { StreamManifest } from '../mini-drama/stream-engine.js';

export interface ProjectListEntry {
  name: string;
  slug: string;
  dir: string;
}

export interface ShotMedia {
  key: string;
  shotNumber: number;
  panel?: string;
  clip?: string;
  dialogue?: string;
  qaVerdict?: string;
  qaIssues?: string[];
  /**
   * Reference-usage summary from the panel's recipe sidecar: which character
   * identities were anchored to real reference bytes at draft/refine time and
   * which fell back to prompt text. Undefined for panels with no recorded
   * usage (pre-2026-08-11 drafts, or no-character shots).
   */
  refUsage?: {
    base: string;
    anchored: string[];
    textOnly: string[];
  };
  /**
   * Character/location reference images this panel was DRAFTED or REFINED
   * from (per its recipe sidecar) that no longer exist on disk — i.e. they
   * were archived/removed after the panel was made. A non-empty list means
   * the panel still depicts the old reference and should be regenerated.
   * Labels are the reference's last two path segments (e.g.
   * "detectives-study/medium.png"). Video-render passes are excluded: they
   * feed the .mp4, not the .png panel.
   */
  staleRefs?: string[];
}

export interface UnitMedia {
  unitId: string;
  file?: string;
  shotNumbers: number[];
  model?: string;
  prompt?: string;
}

export interface EpisodeState {
  episode: number;
  script: EpisodeScript | null;
  scriptVersions: number[];
  qaReport: unknown;
  videoQaReport: unknown;
  generationPlan: unknown;
  shots: ShotMedia[];
  units: UnitMedia[];
  finalCut?: string;
  music?: string;
  /** Loop-preview state, when `venice-video loop` has run for this episode. */
  loop?: LoopManifest;
  /** Stream state, when `venice-video stream` has run for this episode. */
  stream?: StreamManifest;
}

export interface ProjectState {
  series: SeriesState;
  status: ProjectStatus | null;
  workshop: WorkshopDraft | null;
  episodes: EpisodeState[];
  characters: Array<{
    name: string;
    dir: string;
    art: string[];
    angles: AngleArt[];
    gender?: string;
    age?: string;
    description?: string;
    wardrobe?: string;
    voiceLocked: boolean;
  }>;
  locations: Array<{ name: string; slug: string; art: string[]; angles: AngleArt[] }>;
}

async function readJsonIfExists(path: string): Promise<unknown> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir)).filter(name => pattern.test(name)).sort();
  } catch {
    return [];
  }
}

export async function listProjects(workspaceDir: string): Promise<ProjectListEntry[]> {
  return listSeries(workspaceDir);
}

interface QaReportShape {
  results?: Array<{ shotNumber: number; verdict?: string; issues?: string[] }>;
}

interface GenerationPlanShape {
  units?: Array<{
    unitId?: string;
    outputFile?: string;
    shotNumbers?: number[];
    model?: string;
  }>;
}

async function collectEpisodeState(
  series: SeriesState,
  episode: number,
  projectDir: string,
): Promise<EpisodeState> {
  const episodeDir = getEpisodeDir(series, episode);
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');

  const script = await loadEpisodeScript(series, episode);
  const qaReport = await readJsonIfExists(join(episodeDir, 'qa-report.json'));
  const videoQaReport = await readJsonIfExists(join(episodeDir, 'video-qa-report.json'));
  const generationPlan = await readJsonIfExists(join(episodeDir, 'generation-plan.json'));

  const versionFiles = await listFiles(episodeDir, /^script-v(\d+)\.json$/);
  const scriptVersions = versionFiles
    .map(name => Number.parseInt(name.replace(/^script-v(\d+)\.json$/, '$1'), 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const verdicts = new Map<number, { verdict?: string; issues?: string[] }>();
  for (const result of (qaReport as QaReportShape | null)?.results ?? []) {
    verdicts.set(result.shotNumber, { verdict: result.verdict, issues: result.issues });
  }

  const rel = (abs: string) => relative(projectDir, abs);
  const shots: ShotMedia[] = [];
  for (const shot of script?.shots ?? []) {
    const key = shotKey(shot);
    const panelPath = join(sceneDir, 'shot-' + key + '.png');
    const clipPath = join(sceneDir, 'shot-' + key + '.mp4');
    const dialoguePath = join(audioDir, 'dialogue-shot-' + key + '.mp3');
    const qa = verdicts.get(shot.shotNumber);

    // Reference-usage summary: the LAST recorded referenceUsage in the
    // panel's recipe wins (a fix/refine pass supersedes the draft).
    let refUsage: ShotMedia['refUsage'];
    const recipe = await readJsonIfExists(panelPath.replace(/\.png$/, '.recipe.json')) as {
      passes?: Array<{
        kind?: string;
        label?: string;
        referenceImagePaths?: string[];
        extra?: { referenceUsage?: ShotMedia['refUsage'] };
      }>;
    } | null;
    const passes = recipe?.passes ?? [];
    for (const pass of passes) {
      if (pass.extra?.referenceUsage) refUsage = pass.extra.referenceUsage;
    }

    // Removed-reference detection. The recipe is append-only ACROSS
    // regenerations, so a force-rebuilt panel keeps the archived panel's older
    // passes (which may point at since-removed refs). Restrict staleness to the
    // CURRENT panel: the passes at/after the most recent "draft" pass — a base
    // generation or a reference-drafted panel edit. Video-render passes feed
    // the .mp4, not the .png, so they never count.
    let lastDraftStart = 0;
    passes.forEach((pass, index) => {
      const isDraft = pass.kind === 'generate'
        || (pass.kind === 'multi-edit' && /reference-drafted (?:establishing )?panel/i.test(pass.label ?? ''));
      if (isDraft) lastDraftStart = index;
    });
    const removedRefs = new Set<string>();
    for (const pass of passes.slice(lastDraftStart)) {
      if (pass.kind === 'video-generate') continue;
      for (const abs of pass.referenceImagePaths ?? []) {
        const norm = abs.replace(/\\/g, '/');
        if (!norm.includes('/characters/') && !norm.includes('/locations/')) continue;
        if (!existsSync(abs)) removedRefs.add(norm.split('/').slice(-2).join('/'));
      }
    }
    const panelExists = existsSync(panelPath);

    shots.push({
      key,
      shotNumber: shot.shotNumber,
      panel: panelExists ? rel(panelPath) : undefined,
      clip: existsSync(clipPath) ? rel(clipPath) : undefined,
      dialogue: existsSync(dialoguePath) ? rel(dialoguePath) : undefined,
      qaVerdict: qa?.verdict,
      qaIssues: qa?.issues,
      refUsage,
      staleRefs: panelExists && removedRefs.size > 0 ? [...removedRefs].sort() : undefined,
    });
  }

  const units: UnitMedia[] = [];
  for (const unit of (generationPlan as GenerationPlanShape | null)?.units ?? []) {
    if (!unit.unitId) continue;
    const filePath = unit.outputFile ? join(sceneDir, unit.outputFile) : undefined;
    let prompt: string | undefined;
    const videoSidecar = await readJsonIfExists(join(sceneDir, unit.unitId + '.video.json')) as
      | { video?: { prompt?: string } }
      | null;
    if (videoSidecar?.video?.prompt) prompt = videoSidecar.video.prompt;
    units.push({
      unitId: unit.unitId,
      file: filePath && existsSync(filePath) ? rel(filePath) : undefined,
      shotNumbers: unit.shotNumbers ?? [],
      model: unit.model,
      prompt,
    });
  }

  const padded = String(episode).padStart(3, '0');
  const finalCutPath = join(episodeDir, 'episode-' + padded + '-final.mp4');
  const musicPath = join(audioDir, 'music.mp3');
  const loop = await readJsonIfExists(join(episodeDir, 'loop', 'loop-manifest.json')) as
    | LoopManifest
    | null;
  const stream = await readJsonIfExists(join(episodeDir, 'stream', 'stream-manifest.json')) as
    | StreamManifest
    | null;

  return {
    episode,
    script,
    scriptVersions,
    qaReport,
    videoQaReport,
    generationPlan,
    shots,
    units,
    finalCut: existsSync(finalCutPath) ? rel(finalCutPath) : undefined,
    music: existsSync(musicPath) ? rel(musicPath) : undefined,
    loop: loop ?? undefined,
    stream: stream ?? undefined,
  };
}

const ART_PATTERN = /\.(png|webp|jpg|jpeg)$/i;

export interface AngleArt {
  /** Angle name: front/three-quarter/profile/full-body or wide/medium/detail. */
  angle: string;
  /** Project-relative image path, when the angle has been generated. */
  image?: string;
  /** The positive prompt used, from the .prompt.json sidecar (characters only). */
  prompt?: string;
  /**
   * The entity's locked description changed since this art was generated
   * (workshop revision or manual edit) — the image depicts the OLD look and
   * should be regenerated or archived.
   */
  stale?: boolean;
}

const CHARACTER_ANGLES = ['front', 'three-quarter', 'profile', 'full-body'];
// wide (hero plate) + derived same-room angles; legacy ladder names kept so
// pre-2026-08-13 projects still show their art.
const LOCATION_ANGLES = ['wide', 'angle-2', 'angle-3', 'angle-4', 'medium', 'detail'];

/**
 * Staleness: was this art generated from the entity's CURRENT description?
 *
 * Every reference generation writes the exact positive prompt into the
 * angle's .prompt.json sidecar, and that prompt embeds the entity's locked
 * description verbatim. So if the current description no longer appears in
 * the sidecar prompt (normalized, prefix-matched to survive the prompt-length
 * cap), the description changed after generation — a workshop revision or a
 * manual edit — and the image depicts the old look.
 */
function isArtStale(currentDescription: string | undefined, sidecarPrompt: string | undefined): boolean {
  if (!currentDescription || !sidecarPrompt) return false;
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = normalize(currentDescription).slice(0, 120);
  if (needle.length < 20) return false; // too short to be meaningful evidence
  return !normalize(sidecarPrompt).includes(needle);
}

/**
 * Per-angle art + prompt sidecar for one entity directory. Canonical angles
 * always appear (even ungenerated); custom angles — extra coverage generated
 * with a non-canonical name — appear when their file exists.
 */
async function collectAngleArt(
  entityDir: string,
  projectDir: string,
  angleNames: string[],
  currentDescription?: string,
): Promise<AngleArt[]> {
  const names = [...angleNames];
  if (existsSync(entityDir)) {
    try {
      const canonical = new Set(angleNames);
      const extras = (await readdir(entityDir))
        .filter(f =>
          /\.png$/i.test(f)
          && !f.includes('archive')
          && !f.includes('-pre-')
          && !f.includes('anchor')
          && !canonical.has(f.replace(/\.png$/i, '')))
        .map(f => f.replace(/\.png$/i, ''))
        .sort();
      names.push(...extras);
    } catch {
      // Unreadable dir behaves like an empty one.
    }
  }

  const out: AngleArt[] = [];
  for (const angle of names) {
    const png = join(entityDir, angle + '.png');
    const webp = join(entityDir, angle + '.webp');
    const image = existsSync(png) ? png : existsSync(webp) ? webp : undefined;
    const sidecar = await readJsonIfExists(join(entityDir, angle + '.prompt.json')) as
      | { prompt?: string }
      | null;
    out.push({
      angle,
      image: image ? relative(projectDir, image) : undefined,
      prompt: sidecar?.prompt,
      stale: image ? isArtStale(currentDescription, sidecar?.prompt) || undefined : undefined,
    });
  }
  return out;
}

export async function collectProjectState(projectDir: string): Promise<ProjectState | null> {
  const series = await loadSeries(projectDir);
  if (!series) return null;
  // The stored outputDir can be stale after a project moves; trust the
  // directory the caller found series.json in.
  series.outputDir = projectDir;

  const status = await collectProjectStatus(projectDir);
  const workshop = await loadWorkshop(series);

  const episodes: EpisodeState[] = [];
  for (const meta of series.episodes) {
    episodes.push(await collectEpisodeState(series, meta.number, projectDir));
  }

  // Characters: union of series.json entries and on-disk directories, so a
  // character created without reference art (quick-script path) still shows
  // up — with an empty art list the UI can act on.
  const characters: ProjectState['characters'] = [];
  const charsDir = join(projectDir, 'characters');
  const seenCharDirs = new Set<string>();
  const slugifyName = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const character of series.characters ?? []) {
    const dirName = slugifyName(character.name);
    seenCharDirs.add(dirName);
    const dir = join(charsDir, dirName);
    const art = (await listFiles(dir, ART_PATTERN))
      .filter(name => !name.includes('-pre-') && !name.includes('archive'))
      .map(name => relative(projectDir, join(dir, name)));
    characters.push({
      name: character.name,
      dir: dirName,
      art,
      angles: await collectAngleArt(
        dir,
        projectDir,
        CHARACTER_ANGLES,
        (character as { description?: string }).description,
      ),
      gender: (character as { gender?: string }).gender,
      age: (character as { age?: string }).age,
      description: (character as { description?: string }).description,
      wardrobe: (character as { wardrobe?: string }).wardrobe,
      voiceLocked: Boolean((character as { voiceId?: string }).voiceId),
    });
  }
  if (existsSync(charsDir)) {
    for (const entry of await readdir(charsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seenCharDirs.has(entry.name)) continue;
      const dir = join(charsDir, entry.name);
      const art = (await listFiles(dir, ART_PATTERN))
        .filter(name => !name.includes('-pre-') && !name.includes('archive'))
        .map(name => relative(projectDir, join(dir, name)));
      const charJson = await readJsonIfExists(join(dir, 'character.json')) as { name?: string } | null;
      characters.push({
        name: charJson?.name ?? entry.name,
        dir: entry.name,
        art,
        angles: await collectAngleArt(dir, projectDir, CHARACTER_ANGLES),
        voiceLocked: false,
      });
    }
  }

  // Locations: same union — series.json first, then orphan directories.
  const locations: ProjectState['locations'] = [];
  const locsDir = join(projectDir, 'locations');
  const seenLocDirs = new Set<string>();
  for (const location of series.locations ?? []) {
    seenLocDirs.add(location.slug);
    const dir = join(locsDir, location.slug);
    const art = (await listFiles(dir, ART_PATTERN))
      .map(name => relative(projectDir, join(dir, name)));
    locations.push({
      name: location.name,
      slug: location.slug,
      art,
      angles: await collectAngleArt(dir, projectDir, LOCATION_ANGLES, location.description),
    });
  }
  if (existsSync(locsDir)) {
    for (const entry of await readdir(locsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seenLocDirs.has(entry.name)) continue;
      const dir = join(locsDir, entry.name);
      const art = (await listFiles(dir, ART_PATTERN))
        .map(name => relative(projectDir, join(dir, name)));
      locations.push({
        name: entry.name,
        slug: entry.name,
        art,
        angles: await collectAngleArt(dir, projectDir, LOCATION_ANGLES),
      });
    }
  }

  return { series, status, workshop, episodes, characters, locations };
}
