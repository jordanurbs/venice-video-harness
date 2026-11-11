// ---------------------------------------------------------------------------
// Seedance 2.5 draft upgrade
//
// Seedance 2.5 renders go out as 480p drafts by default (resolveSeedanceDraft).
// Once a person approves a take, the upgrade queues it again by the draft's
// queue id and Venice renders the same take at 1080p: seed, composition,
// motion, timing, length and audio carry over; only the fine detail is
// re-rendered. https://docs.venice.ai/guides/media/seedance-2-0#draft-mode-seedance-2-5
//
// The 1080p file takes the draft's path, so assembly, QA and the edit read it
// with no change. The draft is archived -vN, and a montage or multi-shot
// master is cut into its shots again from the 1080p file.
//
// Live behaviour the docs don't state (checked 2026-11-11):
// - The queue still requires `duration`, and `aspect_ratio` on lanes that take
//   one, on the upgrade request; values that differ from the draft are ignored.
// - Media inputs are ignored on the upgrade, so references are not re-sent.
// - The upgrade must use the draft's model, within 7 days of the draft.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { VeniceClient } from '../venice/client.js';
import { completeVideo, pollVideoResult } from '../venice/video.js';
import { appendRecipePass, readShotRecipe, type RecipePassRole } from '../venice/recipe.js';
import { clearPendingJob, findPendingJob, recordPendingJob } from '../venice/job-store.js';
import { SEEDANCE_DRAFT_UPGRADE_RESOLUTION } from 'venice-video-harness/core/venice/models.js';
import type { GenerationUnit, GenerationUnitSegment } from 'venice-video-harness/core/series/types.js';
import { cutMontageIntoShots } from './montage.js';
import { archiveExisting, submitVideoQueue } from './video-generator.js';

const VIDEO_QUOTE_PATH = '/api/v1/video/quote';
const UPGRADE_JOB_TAG = 'draft-upgrade';

export interface DraftTake {
  /** The render that is a draft: a single shot's clip, or a montage / multi-shot master. */
  path: string;
  model: string;
  prompt: string;
  duration: string;
  aspectRatio?: string;
  bitrateMode?: string;
  role: RecipePassRole;
  draft: { taskId: string; expiresAt?: string };
}

export interface DraftUpgradeResult {
  path: string;
  archivedDraft?: string;
  queueId: string;
  /** Shot clips cut again from an upgraded master. */
  recut: string[];
}

/**
 * The take's draft, read from its recipe sidecar: its latest video render, when
 * that render was a draft. Null for a take that was never a draft or that was
 * already upgraded (the upgrade appends a render without a draft).
 */
export async function readDraftTake(path: string): Promise<DraftTake | null> {
  const recipe = await readShotRecipe(path);
  const renders = (recipe?.passes ?? []).filter(pass => pass.kind === 'video-generate');
  const last = renders[renders.length - 1];
  const draft = last?.extra?.draft as DraftTake['draft'] | undefined;
  if (!last || !draft?.taskId || !last.prompt || !last.duration) return null;
  return {
    path,
    model: last.model,
    prompt: last.prompt,
    duration: last.duration,
    aspectRatio: last.aspectRatio,
    bitrateMode: last.extra?.bitrateMode as string | undefined,
    role: last.role,
    draft,
  };
}

export function draftUpgradeBody(take: DraftTake): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: take.model,
    prompt: take.prompt,
    draft_task_id: take.draft.taskId,
    duration: take.duration,
    resolution: SEEDANCE_DRAFT_UPGRADE_RESOLUTION,
  };
  // Image-to-video lanes reject aspect_ratio; the others require it on the upgrade.
  if (take.aspectRatio && !take.model.includes('image-to-video')) body.aspect_ratio = take.aspectRatio;
  if (take.bitrateMode) body.bitrate_mode = take.bitrateMode;
  return body;
}

export function draftExpired(take: DraftTake, now: Date = new Date()): boolean {
  return Boolean(take.draft.expiresAt) && new Date(take.draft.expiresAt!).getTime() <= now.getTime();
}

export async function quoteDraftUpgrade(client: VeniceClient, take: DraftTake): Promise<number> {
  const { prompt: _prompt, bitrate_mode: _bitrate, ...quoteBody } = draftUpgradeBody(take);
  const res = await client.post<{ quote: number }>(VIDEO_QUOTE_PATH, quoteBody);
  return res.quote;
}

function readVideoJson(path: string): { metadata?: Record<string, unknown> } | null {
  const sidecar = path.replace(/\.mp4$/i, '.video.json');
  if (!existsSync(sidecar)) return null;
  try {
    return JSON.parse(readFileSync(sidecar, 'utf-8'));
  } catch {
    return null;
  }
}

/** A cut clip's draft lives on the master it was cut from; anything else is its own take. */
export function resolveDraftTakePath(path: string): string {
  const from = readVideoJson(path)?.metadata?.generatedFromUnit;
  return typeof from === 'string' ? join(dirname(path), from) : path;
}

/** Every take under `dir` whose latest render is a draft. Archives (-vN) never carry a recipe. */
export async function findDraftTakes(dir: string): Promise<DraftTake[]> {
  const found: DraftTake[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'media-library' && !name.startsWith('.')) await walk(path);
      } else if (name.endsWith('.recipe.json')) {
        const take = path.replace(/\.recipe\.json$/, '.mp4');
        if (!existsSync(take)) continue;
        const draft = await readDraftTake(take);
        if (draft) found.push(draft);
      }
    }
  };
  await walk(dir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Cut a multi-shot master into its shots again at the segments it was first cut at. */
function recutSegments(masterPath: string, segments: GenerationUnitSegment[]): string[] {
  const sceneDir = dirname(masterPath);
  return segments.map(segment => {
    const outputPath = join(sceneDir, segment.outputFile);
    archiveExisting(outputPath);
    const ff = spawnSync('ffmpeg', [
      '-y', '-v', 'error', '-ss', String(segment.startOffsetSec), '-i', masterPath, '-t', String(segment.durationSec),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      outputPath,
    ], { encoding: 'utf-8' });
    if (ff.status !== 0) throw new Error(`ffmpeg could not cut ${outputPath} from ${masterPath}: ${ff.stderr?.trim()}`);
    return outputPath;
  });
}

/** Cut an upgraded montage or multi-shot master into its shots, the way its render did. */
function recutMaster(masterPath: string): string[] {
  const meta = readVideoJson(masterPath) as {
    unitId?: string; shotNumbers?: number[]; video?: { model?: string };
    metadata?: { unitType?: string; sceneNumber?: number; montageBeats?: GenerationUnit['montageBeats']; segments?: GenerationUnitSegment[] };
  } | null;
  const unitType = meta?.metadata?.unitType;
  if (unitType === 'montage') {
    const sceneDir = dirname(masterPath);
    const unit = {
      unitId: meta!.unitId ?? basename(masterPath),
      unitType: 'montage',
      shotNumbers: meta!.shotNumbers ?? [],
      outputFile: basename(masterPath),
      model: meta!.video?.model ?? '',
      montageBeats: meta!.metadata!.montageBeats,
      sceneNumber: meta!.metadata!.sceneNumber,
    } as GenerationUnit;
    return cutMontageIntoShots({ montagePath: masterPath, unit, sceneDir, episodeDir: dirname(sceneDir), archiveExisting }).shotPaths;
  }
  if (unitType === 'multishot' && meta?.metadata?.segments?.length) {
    return recutSegments(masterPath, meta.metadata.segments);
  }
  return [];
}

/**
 * Upgrade one approved draft to 1080p. The queue id is recorded before the
 * first poll, so an interrupted upgrade re-attaches on the next run instead of
 * paying twice.
 */
export async function upgradeDraftTake(client: VeniceClient, take: DraftTake): Promise<DraftUpgradeResult> {
  if (draftExpired(take)) {
    throw new Error(`${take.path}: the draft expired ${take.draft.expiresAt} (drafts upgrade for 7 days). Render it again.`);
  }
  const hdPath = take.path.replace(/\.mp4$/i, '.hd-upgrade.mp4');
  const jobKey = resolvePath(hdPath);
  const recorded = await findPendingJob(jobKey);
  let queueId: string;
  let model: string;
  if (recorded && recorded.kind === 'video') {
    console.log(`  Re-attaching to upgrade ${recorded.queueId} — not re-queueing.`);
    ({ queueId, model } = recorded);
  } else {
    const res = await submitVideoQueue(client, take.model, draftUpgradeBody(take), hdPath);
    ({ queue_id: queueId, model } = res);
    await recordPendingJob({ kind: 'video', model, queueId, outputPath: jobKey, prompt: take.prompt, tag: UPGRADE_JOB_TAG });
  }

  const video = await pollVideoResult(client, model, queueId, { prompt: take.prompt, heartbeatPath: jobKey });
  const archivedDraft = archiveExisting(take.path);
  await writeFile(take.path, video);
  await clearPendingJob(jobKey);
  await completeVideo(client, model, queueId);

  await appendRecipePass(take.path, {
    kind: 'video-generate',
    role: take.role,
    model: take.model,
    label: 'draft upgraded to 1080p (same seed, motion and audio)',
    prompt: take.prompt,
    duration: take.duration,
    aspectRatio: take.aspectRatio,
    resolution: SEEDANCE_DRAFT_UPGRADE_RESOLUTION,
    archivedPrevious: archivedDraft,
    extra: { upgradedFromDraft: take.draft.taskId, queueId, ...(take.bitrateMode ? { bitrateMode: take.bitrateMode } : {}) },
  });

  return { path: take.path, archivedDraft, queueId, recut: recutMaster(take.path) };
}
