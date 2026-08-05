// ---------------------------------------------------------------------------
// Keep WORKSHOP.html current as production runs.
//
// The treatment page used to be written once, by the workshop, and then go
// stale the moment the first panel rendered. Everything after that only existed
// as console output that scrolled away and as files buried under
// episodes/episode-NNN/scene-001/.
//
// `refreshTreatment` re-renders the page from whatever is on disk right now:
// the pipeline stage, the next command, and per-shot panels, clips, dialogue
// and QA verdicts. Pipeline commands call it when they finish, so refreshing
// the browser tab shows the run's progress.
//
// It is deliberately incapable of failing a production command -- every path
// is guarded and the worst case is a page that is one step out of date.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEpisodeDir, loadEpisodeScript } from '../series/manager.js';
import type { EpisodeScript, SeriesState, ShotScript } from '../series/types.js';
import { collectProjectStatus, qualifyCommand, type EpisodeStatus } from '../session/status.js';
import { PANEL_THUMBNAIL_PX, ThumbnailCache } from './thumbnails.js';
import { DEFAULT_INTELLIGENCE_MODEL, describeIntelligence } from '../venice/text-models.js';
import {
  buildReferenceThumbnails,
  getWorkshopPath,
  loadWorkshop,
  renderWorkshopHtml,
  renderWorkshopMarkdown,
  type WorkshopDraft,
} from './workshop.js';

export type QaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';

export interface ShotArtifacts {
  /** Zero-padded shot id, including any inserted-shot suffix (e.g. `003b`). */
  key: string;
  panelPath?: string;
  panelThumbnail?: string;
  clipPath?: string;
  clipThumbnail?: string;
  dialoguePath?: string;
  qaVerdict?: QaVerdict;
  qaIssues?: string[];
}

export interface TreatmentProgress {
  refreshedAt: string;
  episode: number;
  stage: string;
  /** Copy-pasteable, project-qualified. Undefined when the episode is done. */
  nextCommand?: string;
  shotCount: number;
  panelCount: number;
  videoCount: number;
  dialogueCount: number;
  hasMusic: boolean;
  scriptApproved: boolean;
  qaReported: boolean;
  qaApproved: boolean;
  finalCutPath?: string;
  shots: ReadonlyMap<string, ShotArtifacts>;
  /** Other episodes in the project, for a compact roll-up. Empty for one-offs. */
  otherEpisodes: ReadonlyArray<Pick<EpisodeStatus, 'episode' | 'title' | 'stage'>>;
}

/** Zero-padded shot id: `3` → `003`, or `003b` for an inserted shot. */
export function shotKey(shot: Pick<ShotScript, 'shotNumber' | 'shotIdSuffix'>): string {
  return String(shot.shotNumber).padStart(3, '0') + (shot.shotIdSuffix ?? '');
}

interface QaReport {
  results?: Array<{ shotNumber: number; verdict: QaVerdict; issues?: string[] }>;
}

async function readQaReport(episodeDir: string): Promise<Map<number, { verdict: QaVerdict; issues: string[] }>> {
  const path = join(episodeDir, 'qa-report.json');
  const verdicts = new Map<number, { verdict: QaVerdict; issues: string[] }>();
  if (!existsSync(path)) return verdicts;
  try {
    const report = JSON.parse(await readFile(path, 'utf-8')) as QaReport;
    for (const result of report.results ?? []) {
      verdicts.set(result.shotNumber, { verdict: result.verdict, issues: result.issues ?? [] });
    }
  } catch {
    // A half-written report just means no verdicts this pass.
  }
  return verdicts;
}

/**
 * Reads the artifacts that exist for one episode right now.
 *
 * Panels and clips get inline thumbnails; a rendered clip supersedes its panel
 * in the page, because seeing the shot move is the point of that stage.
 */
export async function collectTreatmentProgress(
  series: SeriesState,
  script: EpisodeScript,
  episode: number,
  cache: ThumbnailCache,
): Promise<TreatmentProgress | undefined> {
  const status = await collectProjectStatus(series.outputDir);
  if (!status) return undefined;
  const episodeStatus = status.episodes.find(item => item.episode === episode);

  const episodeDir = getEpisodeDir(series, episode);
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  const verdicts = await readQaReport(episodeDir);

  const shots = new Map<string, ShotArtifacts>();
  for (const shot of script.shots) {
    const key = shotKey(shot);
    const panelPath = join(sceneDir, `shot-${key}.png`);
    const clipPath = join(sceneDir, `shot-${key}.mp4`);
    const dialoguePath = join(audioDir, `dialogue-shot-${key}.mp3`);
    const qa = verdicts.get(shot.shotNumber);

    const artifacts: ShotArtifacts = { key };
    if (existsSync(panelPath)) {
      artifacts.panelPath = panelPath;
      artifacts.panelThumbnail = await cache.get(panelPath, PANEL_THUMBNAIL_PX);
    }
    if (existsSync(clipPath)) {
      artifacts.clipPath = clipPath;
      artifacts.clipThumbnail = await cache.get(clipPath, PANEL_THUMBNAIL_PX, 'video');
    }
    if (existsSync(dialoguePath)) artifacts.dialoguePath = dialoguePath;
    if (qa) {
      artifacts.qaVerdict = qa.verdict;
      artifacts.qaIssues = qa.issues;
    }
    shots.set(key, artifacts);
  }

  const finalCutPath = join(episodeDir, `episode-${String(episode).padStart(3, '0')}-final.mp4`);

  return {
    refreshedAt: new Date().toISOString(),
    episode,
    stage: episodeStatus?.stage ?? 'not started',
    nextCommand: episodeStatus?.nextCommand
      ? qualifyCommand(episodeStatus.nextCommand, series.outputDir)
      : status.nextCommand
        ? qualifyCommand(status.nextCommand, series.outputDir)
        : undefined,
    shotCount: script.shots.length,
    panelCount: [...shots.values()].filter(item => item.panelPath).length,
    videoCount: [...shots.values()].filter(item => item.clipPath).length,
    dialogueCount: [...shots.values()].filter(item => item.dialoguePath).length,
    hasMusic: existsSync(join(audioDir, 'music.mp3')),
    shots,
    scriptApproved: episodeStatus?.scriptApproved ?? false,
    qaReported: episodeStatus?.qaReported ?? false,
    qaApproved: episodeStatus?.qaApproved ?? false,
    finalCutPath: existsSync(finalCutPath) ? finalCutPath : undefined,
    otherEpisodes: status.episodes
      .filter(item => item.episode !== episode)
      .map(item => ({ episode: item.episode, title: item.title, stage: item.stage })),
  };
}

export interface RefreshTreatmentOptions {
  /** Defaults to the episode the workshop draft describes. */
  episode?: number;
  /** Print the page path when the refresh succeeds. */
  announce?: boolean;
}

/**
 * Re-render WORKSHOP.html and WORKSHOP.md from current on-disk state.
 *
 * Never throws and never touches workshop.json -- the draft is the workshop's
 * to revise. Returns the page path when it rewrote one, otherwise undefined
 * (a project with no workshop draft simply has no treatment page).
 */
export async function refreshTreatment(
  series: SeriesState,
  options: RefreshTreatmentOptions = {},
): Promise<string | undefined> {
  try {
    const draft = await loadWorkshop(series);
    if (!draft) return undefined;

    const episode = options.episode ?? draft.script.episode ?? 1;
    // Prefer the live script: it carries shots added by `insert-shot` and any
    // edits made after the workshop was approved.
    const live = await loadEpisodeScript(series, episode);
    const script = live ?? draft.script;

    const cache = await ThumbnailCache.open(series.outputDir);
    const progress = await collectTreatmentProgress(series, script, episode, cache);
    const references = await buildReferenceThumbnails(draft.inputs.referenceSources ?? [], cache);
    await cache.save();

    const rendered: WorkshopDraft = { ...draft, script };
    const htmlPath = join(series.outputDir, 'WORKSHOP.html');
    await writeFile(
      htmlPath,
      renderWorkshopHtml(
        rendered,
        references,
        progress,
        describeIntelligence(series.intelligence?.model ?? DEFAULT_INTELLIGENCE_MODEL),
      ),
      'utf-8',
    );
    await writeFile(join(series.outputDir, 'WORKSHOP.md'), renderWorkshopMarkdown(rendered, progress), 'utf-8');

    if (options.announce) console.log(`Treatment updated: ${htmlPath}`);
    return htmlPath;
  } catch {
    // The treatment page is a convenience. A production command must never
    // fail because a thumbnail could not be encoded.
    return undefined;
  }
}

/** True when the project has a treatment page worth refreshing. */
export function hasTreatment(series: Pick<SeriesState, 'outputDir'>): boolean {
  return existsSync(getWorkshopPath(series));
}
