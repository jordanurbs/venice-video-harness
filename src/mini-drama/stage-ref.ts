// ---------------------------------------------------------------------------
// stage-ref: edit the reference first, then generate from it (rule 65).
//
// The video model copies a reference's whole composition, not just the thing
// it is bound to: a plate's moored boats come back where the shot needs
// another vessel, a lowered gangway re-stages a departure, and an object
// painted out of moving footage flickers. The fix that works is the same move
// each time: edit a copy of the image on two edit models (gpt-image-2-edit
// tends to keep fine detail, nano-banana-2-edit often gives the better
// close-up), look at both, pick one, then generate from it.
//
// This module is that move as a command:
//   1. The source: a plate view of the shot's location, a frame of a rendered
//      clip, or any image (optionally cropped).
//   2. The edit, on two models at once, each written with provenance and
//      recipe sidecars (rule 39) into the episode's staging/ folder.
//   3. A side-by-side page for a person to pick from.
//   4. The pick, recorded on the shot (`stagingRef`): a `plate` stands in for
//      the view it was edited from in the R2V reference stack; a
//      `start-frame` is the frame the shot is re-generated from, i2v.
//
// The edited image belongs to its shot. The location's own plates are never
// changed: to change a plate for every shot, regenerate the location's
// references.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import type {
  EpisodeScript,
  GenerationPlan,
  GenerationUnit,
  PlateView,
  SeriesState,
  ShotScript,
  ShotStagingRef,
} from 'venice-video-harness/core/series/types.js';
import { MODELS_SUPPORTING_SCENE_IMAGES, MODELS_USING_IMAGE_TAGS } from 'venice-video-harness/core/series/types.js';
import type { MultiEditModel } from 'venice-video-harness/core/venice/types.js';
import { MULTI_EDIT_MODELS, getMaxPositivePromptChars, i2vRejectsFaceStartFrame } from 'venice-video-harness/core/venice/models.js';
import type { VeniceClient } from '../venice/client.js';
import { multiEditImage } from '../venice/multi-edit.js';
import { appendRecipePass } from '../venice/recipe.js';
import { readImageProvenance, writeImageProvenance } from '../venice/provenance.js';
import { sniffImageFormat } from '../venice/image-bytes.js';
import { getEpisodeDir, getLocation, getLocationDir } from '../series/manager.js';
import { resolveVideoModel } from './prompt-builder.js';
import { shouldUseSeedanceKeyframe } from './generation-planner.js';
import { shotKey } from './shot-paths.js';
import { stagingRefPath } from './staging.js';

export type StagingUse = ShotStagingRef['use'];

/**
 * Two edit models with different strengths: gpt-image-2-edit tends to keep
 * fine detail, nano-banana-2-edit often gives the better close-up. A person
 * compares both.
 */
export const DEFAULT_STAGE_REF_MODELS: MultiEditModel[] = ['gpt-image-2-edit', 'nano-banana-2-edit'];
/** /image/multi-edit takes the image to edit plus two more. */
export const MAX_STAGE_REFS = 2;
/**
 * Seconds into a clip cut from a longer render (a montage or multi-shot unit)
 * where `--from-shot` takes its frame by default. Those clips are cut at
 * planned times, which can be about half a second off the rendered cut, so
 * their first frames can belong to the shot before.
 */
export const UNIT_CUT_FRAME_OFFSET_SEC = 0.5;
const VIEWS: PlateView[] = ['north', 'east', 'south', 'west'];
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
/** Long edge of the images sent to the edit models (a 4K plate is scaled down for the request). */
const REQUEST_LONG_EDGE = 2048;

export interface StageCandidate {
  /** 1-based, the number a person picks. */
  index: number;
  model: string;
  /** The edited image, relative to the project; absent when the model failed. */
  path?: string;
  sha256?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface StageSession {
  id: string;
  episode: number;
  shot: string;
  use: StagingUse;
  /** The image that was edited, relative to the project when inside it. */
  source: string;
  /** What the source is, in words ("the north view of Harbour Station", "shot 3's clip at 0.50 s"). */
  sourceNote: string;
  /** Something to check in the source before picking (a frame near a cut). */
  sourceWarning?: string;
  replacesView?: PlateView;
  /** Extra images sent with the edit (image 2, image 3), relative to the project when inside it. */
  refs: string[];
  prompt: string;
  hasFace?: boolean;
  candidates: StageCandidate[];
  createdAt: string;
  picked?: number;
}

export interface StageRefInput {
  episode: number;
  shot: string;
  /** An image, or a video (with `at`). */
  from?: string;
  /** A view of the shot's location. */
  fromPlate?: PlateView;
  /** A rendered shot whose clip gives the frame (scene-001/shot-NNN.mp4). */
  fromShot?: string;
  /**
   * Seconds into a video source. Default 0 (its first frame), except for a
   * clip cut from a longer render: `UNIT_CUT_FRAME_OFFSET_SEC`.
   */
  at?: number;
  /** Crop of the source before the edit, `w:h:x:y` in pixels. */
  crop?: string;
  refs?: string[];
  prompt: string;
  use?: StagingUse;
  /** With `plate`: the view of the shot's location the pick replaces, when the source is not that view's file. */
  replacesView?: PlateView;
  models?: string[];
  /**
   * Whether the image shows a person's face (written to provenance). Default:
   * true when the source or a ref is recorded with a face, false only when
   * all of them are recorded without one, otherwise unknown.
   */
  hasFace?: boolean;
}

// ---- Shots and paths ---------------------------------------------------------

function idOf(shot: Pick<ShotScript, 'shotNumber' | 'shotIdSuffix'>): string {
  return `${shot.shotNumber}${shot.shotIdSuffix ?? ''}`;
}

export function findShot(script: EpisodeScript, id: string): ShotScript | undefined {
  const key = shotKey(id.trim());
  return script.shots.find(shot => shotKey(idOf(shot)) === key);
}

export function stagingDir(series: SeriesState, episode: number, shotId: string): string {
  return join(getEpisodeDir(series, episode), 'staging', `shot-${shotKey(shotId)}`);
}

/** A path relative to the project when it is inside it, else absolute. */
export function projectRelative(series: Pick<SeriesState, 'outputDir'>, path: string): string {
  const rel = relative(series.outputDir, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function projectPath(series: Pick<SeriesState, 'outputDir'>, path: string): string {
  return isAbsolute(path) ? path : join(series.outputDir, path);
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function sessionId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

function parseCrop(crop: string): { width: number; height: number; left: number; top: number } {
  const parts = crop.split(':').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0) || parts[0] === 0 || parts[1] === 0) {
    throw new Error(`--crop takes w:h:x:y in whole pixels (got "${crop}").`);
  }
  return { width: parts[0], height: parts[1], left: parts[2], top: parts[3] };
}

function extractFrameAt(video: string, atSec: number, out: string): void {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(atSec), '-i', video, '-frames:v', '1', out], { encoding: 'utf-8' });
  if (result.status !== 0 || !existsSync(out)) {
    throw new Error(`Could not take a frame at ${atSec}s from ${video}: ${(result.stderr || '').trim().slice(-300) || 'ffmpeg failed'}`);
  }
}

function videoDurationSec(video: string): number | undefined {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf-8' });
  const sec = parseFloat((result.stdout || '').trim());
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

/** The unit a clip was cut from (`generatedFromUnit` in its .video.json), when it was cut from one. */
export function clipCutFromUnit(clip: string): string | undefined {
  const metaPath = clip.replace(/\.mp4$/i, '.video.json');
  if (!existsSync(metaPath)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { metadata?: { generatedFromUnit?: unknown } };
    return typeof meta.metadata?.generatedFromUnit === 'string' ? meta.metadata.generatedFromUnit : undefined;
  } catch {
    return undefined;
  }
}

// ---- The source ----------------------------------------------------------------

export interface StageSource {
  /** Absolute path of the image the models edit. */
  path: string;
  /** The image the source was made from before any crop: its provenance is the lineage. */
  lineagePath: string;
  note: string;
  /** Something to check in the source before picking. */
  warning?: string;
  use: StagingUse;
  replacesView?: PlateView;
}

/** Which view of the shot's location an image is, when it is one of its plate files. */
function plateViewOf(series: SeriesState, shot: ShotScript, image: string): PlateView | undefined {
  const loc = shot.location ? getLocation(series, shot.location) : undefined;
  if (!loc) return undefined;
  const dir = getLocationDir(series, loc.slug);
  return VIEWS.find(view => existsSync(join(dir, `${view}.png`)) && sameFile(join(dir, `${view}.png`), image));
}

/**
 * Resolve the image to edit, writing a frame or a crop into the session
 * folder when needed. A plate source defaults to `plate` (it stands in for
 * that view); a frame defaults to `start-frame`.
 */
export async function prepareStageSource(
  series: SeriesState,
  script: EpisodeScript,
  shot: ShotScript,
  input: StageRefInput,
  sessionDir: string,
): Promise<StageSource> {
  const given = [input.from, input.fromPlate, input.fromShot].filter(value => value !== undefined && value !== '');
  if (given.length !== 1) throw new Error('Name one source: --from <image or video>, --from-plate <view>, or --from-shot <id>.');
  if (input.at !== undefined && (!Number.isFinite(input.at) || input.at < 0)) throw new Error(`--at is a time in seconds, 0 or more (got ${input.at}).`);
  await mkdir(sessionDir, { recursive: true });

  let source: StageSource;
  if (input.fromPlate) {
    if (!VIEWS.includes(input.fromPlate)) throw new Error(`--from-plate is north, east, south or west (got "${input.fromPlate}").`);
    const loc = shot.location ? getLocation(series, shot.location) : undefined;
    if (!loc) throw new Error(`Shot ${idOf(shot)} has no location${shot.location ? ` "${shot.location}" in the project` : ''}, so it has no plates.`);
    const path = join(getLocationDir(series, loc.slug), `${input.fromPlate}.png`);
    if (!existsSync(path)) throw new Error(`No ${input.fromPlate} plate for ${loc.slug} at ${path} (generate-location-references makes the plates).`);
    source = { path, lineagePath: path, note: `the ${input.fromPlate} view of ${loc.name}`, use: 'plate', replacesView: input.fromPlate };
  } else if (input.fromShot) {
    const target = findShot(script, input.fromShot);
    if (!target) throw new Error(`Shot ${input.fromShot} is not in episode ${input.episode}.`);
    const clip = join(getEpisodeDir(series, input.episode), 'scene-001', `shot-${shotKey(idOf(target))}.mp4`);
    if (!existsSync(clip)) throw new Error(`Shot ${idOf(target)} has no rendered clip at ${clip}.`);
    // A clip cut from a longer render starts where the plan said the shot
    // starts, which can be a little before the render's own cut: its first
    // frames may belong to the shot before. Take the frame a little later.
    const unit = input.at === undefined ? clipCutFromUnit(clip) : undefined;
    let at = input.at ?? 0;
    let warning: string | undefined;
    if (unit) {
      const duration = videoDurationSec(clip);
      at = duration ? Math.min(UNIT_CUT_FRAME_OFFSET_SEC, duration / 2) : UNIT_CUT_FRAME_OFFSET_SEC;
      warning = `Shot ${idOf(target)}'s clip was cut from ${unit} at a planned time, so its first frames can belong to the shot before; the frame is taken at ${at.toFixed(2)} s. Check the source on the pick page (or pass --at).`;
    }
    const frame = join(sessionDir, 'source.png');
    extractFrameAt(clip, at, frame);
    source = { path: frame, lineagePath: frame, note: `shot ${idOf(target)}'s clip at ${at.toFixed(2)} s`, use: 'start-frame', ...(warning ? { warning } : {}) };
  } else {
    const path = resolve(input.from!);
    if (!existsSync(path)) throw new Error(`Source not found: ${path}`);
    if (VIDEO_EXT.test(path)) {
      const at = input.at ?? 0;
      const frame = join(sessionDir, 'source.png');
      extractFrameAt(path, at, frame);
      source = { path: frame, lineagePath: frame, note: `${basename(path)} at ${at.toFixed(2)} s`, use: 'start-frame' };
    } else {
      const view = plateViewOf(series, shot, path);
      const loc = view && shot.location ? getLocation(series, shot.location) : undefined;
      if (view && loc) {
        source = { path, lineagePath: path, note: `the ${view} view of ${loc.name}`, use: 'plate', replacesView: view };
      } else if (projectRelative(series, path) === path) {
        // Outside the project: keep a copy with the session, so the project holds every input.
        const copy = join(sessionDir, `source${extname(path).toLowerCase() || '.png'}`);
        await copyFile(path, copy);
        source = { path: copy, lineagePath: path, note: `${basename(path)} (copied from ${path})`, use: 'start-frame' };
      } else {
        source = { path, lineagePath: path, note: projectRelative(series, path), use: 'start-frame' };
      }
    }
  }

  if (input.crop) {
    const box = parseCrop(input.crop);
    const meta = await sharp(source.path).metadata();
    if (!meta.width || !meta.height || box.left + box.width > meta.width || box.top + box.height > meta.height) {
      throw new Error(`--crop ${input.crop} falls outside the ${meta.width}x${meta.height} source.`);
    }
    const cropped = join(sessionDir, 'source-crop.png');
    await sharp(source.path).extract(box).png().toFile(cropped);
    source = { ...source, path: cropped, note: `${source.note}, cropped ${input.crop}` };
  }
  if (input.use) source = { ...source, use: input.use };
  if (input.replacesView) {
    if (!VIEWS.includes(input.replacesView)) throw new Error(`--replaces is north, east, south or west (got "${input.replacesView}").`);
    source = { ...source, replacesView: input.replacesView };
  }
  if (source.use === 'start-frame') source = { ...source, replacesView: undefined };
  return source;
}

// ---- The edit --------------------------------------------------------------------

async function requestDataUri(path: string): Promise<string> {
  const bytes = await readFile(path);
  const meta = await sharp(bytes).metadata();
  const long = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (long > REQUEST_LONG_EDGE) {
    const scaled = await sharp(bytes).resize({ width: REQUEST_LONG_EDGE, height: REQUEST_LONG_EDGE, fit: 'inside' }).png().toBuffer();
    return `data:image/png;base64,${scaled.toString('base64')}`;
  }
  const { mime } = sniffImageFormat(bytes);
  return `data:${mime === 'application/octet-stream' ? 'image/png' : mime};base64,${bytes.toString('base64')}`;
}

/**
 * Write a model's result as PNG with the source's aspect ratio: a result whose
 * ratio is off by more than 1% (a square return) is centre-cropped back.
 */
async function writeCandidate(bytes: Buffer, out: string, sourceAspect: number): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  let image = sharp(bytes);
  if (width && height && Math.abs(width / height - sourceAspect) / sourceAspect > 0.01) {
    const cropW = width / height > sourceAspect ? Math.round(height * sourceAspect) : width;
    const cropH = width / height > sourceAspect ? height : Math.round(width / sourceAspect);
    image = sharp(bytes).extract({ left: Math.round((width - cropW) / 2), top: Math.round((height - cropH) / 2), width: cropW, height: cropH });
  }
  const info = await image.png().toFile(out);
  return { width: info.width, height: info.height };
}

export function validateStageModels(models: string[], prompt: string): MultiEditModel[] {
  if (!prompt.trim()) throw new Error('The edit needs a prompt (--prompt or --prompt-file): what to change, and what to keep exactly as it is.');
  const known = new Set<string>(MULTI_EDIT_MODELS);
  const unknown = models.filter(model => !known.has(model));
  if (unknown.length) throw new Error(`Not a multi-edit model: ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`);
  const tooLong = models.filter(model => prompt.length > getMaxPositivePromptChars(model));
  if (tooLong.length) {
    throw new Error(`The prompt is ${prompt.length} characters; ${tooLong.map(model => `${model} takes ${getMaxPositivePromptChars(model)}`).join(', ')}. Shorten it.`);
  }
  return models as MultiEditModel[];
}

/**
 * Whether an edited image may show a face, for its provenance. An explicit
 * answer (--face / --no-face) wins. Otherwise a face recorded in any input
 * (the source or a --ref) means the result may show one, and the result is
 * face-free only when every input is recorded face-free. Anything else is
 * unknown, which the face checks (anti-pattern 31, rule 62) treat as "may
 * show one".
 */
export function stagedHasFace(explicit: boolean | undefined, inputs: Array<boolean | undefined>): boolean | undefined {
  if (explicit !== undefined) return explicit;
  if (inputs.some(face => face === true)) return true;
  if (inputs.length > 0 && inputs.every(face => face === false)) return false;
  return undefined;
}

/**
 * Run one staging edit: the source on every model at once, each result written
 * with provenance and recipe sidecars, then the session file and the pick page.
 * A model that fails (a refusal, a silent reject) is recorded and the others
 * still land.
 */
export async function runStageRef(
  client: VeniceClient,
  series: SeriesState,
  script: EpisodeScript,
  input: StageRefInput,
): Promise<{ session: StageSession; sessionDir: string; pickPage: string }> {
  const shot = findShot(script, input.shot);
  if (!shot) throw new Error(`Shot ${input.shot} is not in episode ${input.episode}.`);
  const models = validateStageModels(input.models?.length ? input.models : DEFAULT_STAGE_REF_MODELS, input.prompt);
  const refs = (input.refs ?? []).map(ref => resolve(ref));
  if (refs.length > MAX_STAGE_REFS) throw new Error(`An edit takes the image plus ${MAX_STAGE_REFS} more (got ${refs.length} --ref).`);
  for (const ref of refs) if (!existsSync(ref)) throw new Error(`Reference not found: ${ref}`);

  let id = sessionId();
  const root = stagingDir(series, input.episode, idOf(shot));
  for (let n = 2; existsSync(join(root, id)); n++) id = `${sessionId()}-${n}`;
  const sessionDir = join(root, id);
  const source = await prepareStageSource(series, script, shot, input, sessionDir);
  const sourceProvenance = await readImageProvenance(source.lineagePath);
  const refProvenance = await Promise.all(refs.map(ref => readImageProvenance(ref)));
  const hasFace = stagedHasFace(input.hasFace, [sourceProvenance?.hasFace, ...refProvenance.map(p => p?.hasFace)]);
  const sourceMeta = await sharp(source.path).metadata();
  const sourceAspect = (sourceMeta.width ?? 16) / (sourceMeta.height ?? 9);

  // Inputs outside the project are copied in, so the session holds everything it used.
  const refPaths: string[] = [];
  for (const [index, ref] of refs.entries()) {
    if (projectRelative(series, ref) !== ref) { refPaths.push(ref); continue; }
    const copy = join(sessionDir, `ref-${index + 2}${extname(ref).toLowerCase() || '.png'}`);
    await copyFile(ref, copy);
    refPaths.push(copy);
  }

  const baseImage = await requestDataUri(source.path);
  const referenceImages = await Promise.all(refPaths.map(requestDataUri));
  const sessionRel = projectRelative(series, sessionDir);
  const results = await Promise.allSettled(models.map(model => multiEditImage(client, {
    model, prompt: input.prompt, baseImage, referenceImages,
  })));

  const candidates: StageCandidate[] = [];
  for (const [i, result] of results.entries()) {
    const model = models[i];
    const index = i + 1;
    if (result.status === 'rejected') {
      candidates.push({ index, model, error: (result.reason as Error)?.message?.split('\n')[0] ?? String(result.reason) });
      continue;
    }
    const out = join(sessionDir, `${index}-${model}.png`);
    const size = await writeCandidate(result.value, out, sourceAspect);
    // The edit continues the source's lineage (a plate made by gpt-image-2, then this edit).
    if (sourceProvenance) {
      await writeImageProvenance(out, sourceProvenance.generationModel, sourceProvenance.editModels ?? [], hasFace === undefined ? {} : { hasFace });
    }
    await appendRecipePass(out, {
      kind: 'multi-edit',
      role: 'content',
      model,
      label: `stage-ref: ${source.use} for shot ${idOf(shot)}`,
      prompt: input.prompt,
      referenceImagePaths: [source.path, ...refPaths],
      extra: { stageRef: { session: sessionRel, shot: idOf(shot), use: source.use, source: projectRelative(series, source.path), sourceNote: source.note } },
    }, { provenance: 'edit', ...(hasFace === undefined ? {} : { hasFace }) });
    candidates.push({ index, model, path: projectRelative(series, out), sha256: sha256Of(out), ...size });
  }

  const session: StageSession = {
    id,
    episode: input.episode,
    shot: idOf(shot),
    use: source.use,
    source: projectRelative(series, source.path),
    sourceNote: source.note,
    ...(source.warning ? { sourceWarning: source.warning } : {}),
    ...(source.replacesView ? { replacesView: source.replacesView } : {}),
    refs: refPaths.map(ref => projectRelative(series, ref)),
    prompt: input.prompt,
    ...(hasFace === undefined ? {} : { hasFace }),
    candidates,
    createdAt: new Date().toISOString(),
  };
  const pickPage = await writeSession(series, sessionDir, session);
  return { session, sessionDir, pickPage };
}

// ---- Sessions --------------------------------------------------------------------

async function writeSession(series: SeriesState, sessionDir: string, session: StageSession): Promise<string> {
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify(session, null, 2));
  const page = join(sessionDir, 'pick.html');
  await writeFile(page, renderPickPage(series, sessionDir, session));
  return page;
}

export function readStageSession(sessionDir: string): StageSession | null {
  const path = join(sessionDir, 'session.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StageSession;
  } catch {
    return null;
  }
}

/** A shot's staging sessions, oldest first. */
export function listStageSessions(series: SeriesState, episode: number, shotId: string): Array<{ dir: string; session: StageSession }> {
  const root = stagingDir(series, episode, shotId);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map(name => ({ dir: join(root, name), session: readStageSession(join(root, name)) }))
    .filter((entry): entry is { dir: string; session: StageSession } => Boolean(entry.session));
}

// ---- The pick --------------------------------------------------------------------

/**
 * Record a candidate as the shot's staging ref: by number, by model id, or an
 * image file a person made some other way (copied into the session). `use`
 * (and `replacesView`) override the session's: a plate edit can be picked as
 * a start frame. The shot then renders on its own (`mustStaySingle`), and a
 * clip not rendered from the pick is rendered again by the next
 * generate-videos.
 */
export async function pickStagingRef(
  series: SeriesState,
  script: EpisodeScript,
  shotId: string,
  pick: string,
  options: { session?: string; use?: StagingUse; replacesView?: PlateView } = {},
): Promise<{ ref: ShotStagingRef; session: StageSession; sessionDir: string }> {
  const shot = findShot(script, shotId);
  if (!shot) throw new Error(`Shot ${shotId} is not in episode ${script.episode}.`);
  if (options.use && options.use !== 'plate' && options.use !== 'start-frame') throw new Error('--use is plate or start-frame.');
  if (options.replacesView && !VIEWS.includes(options.replacesView)) throw new Error(`--replaces is north, east, south or west (got "${options.replacesView}").`);
  const sessions = listStageSessions(series, script.episode, idOf(shot));
  const entry = options.session
    ? sessions.find(item => item.session.id === options.session)
    : sessions[sessions.length - 1];
  if (!entry) {
    throw new Error(options.session
      ? `No stage-ref session ${options.session} for shot ${idOf(shot)}.`
      : `Shot ${idOf(shot)} has no stage-ref session yet. Run stage-ref with a source and a prompt first.`);
  }
  const { session, dir } = entry;

  let candidate = /^\d+$/.test(pick)
    ? session.candidates.find(item => item.index === Number(pick))
    : session.candidates.find(item => item.model === pick);
  if (!candidate && existsSync(resolve(pick))) {
    const file = resolve(pick);
    const index = Math.max(0, ...session.candidates.map(item => item.index)) + 1;
    const out = join(dir, `${index}-picked${extname(file).toLowerCase() || '.png'}`);
    await copyFile(file, out);
    await appendRecipePass(out, {
      kind: 'mechanical', role: 'content', model: 'manual',
      label: `stage-ref: picked by hand for shot ${idOf(shot)} (from ${basename(file)})`,
      extra: { stageRef: { session: projectRelative(series, dir), shot: idOf(shot), use: session.use, from: file } },
    });
    candidate = { index, model: 'manual', path: projectRelative(series, out), sha256: sha256Of(out) };
    session.candidates.push(candidate);
  }
  if (!candidate?.path) {
    const usable = session.candidates.filter(item => item.path).map(item => `${item.index} (${item.model})`);
    throw new Error(`No candidate "${pick}" in session ${session.id}${candidate?.error ? ` (${candidate.model} failed: ${candidate.error})` : ''}. Pick one of: ${usable.join(', ') || 'none; run the edit again'}.`);
  }
  const imagePath = projectPath(series, candidate.path);
  if (!existsSync(imagePath)) throw new Error(`The candidate image is gone: ${imagePath}`);

  const use = options.use ?? session.use;
  const replacesView = use === 'plate' ? (options.replacesView ?? session.replacesView) : undefined;
  const before = shot.stagingRef ? shot.stagingRef.mustStaySingleBefore : shot.mustStaySingle;
  const ref: ShotStagingRef = {
    path: candidate.path,
    use,
    source: session.source,
    ...(replacesView ? { replacesView } : {}),
    model: candidate.model,
    prompt: session.prompt,
    sha256: sha256Of(imagePath),
    session: projectRelative(series, dir),
    pickedAt: new Date().toISOString(),
    ...(before === undefined ? {} : { mustStaySingleBefore: before }),
  };
  shot.stagingRef = ref;
  shot.mustStaySingle = true;
  session.picked = candidate.index;
  await writeSession(series, dir, session);
  return { ref, session, sessionDir: dir };
}

/** Remove the shot's staging ref and restore its `mustStaySingle`. Returns the removed ref. */
export function clearStagingRef(shot: ShotScript): ShotStagingRef | null {
  const ref = shot.stagingRef;
  if (!ref) return null;
  delete shot.stagingRef;
  if (ref.mustStaySingleBefore === undefined) delete shot.mustStaySingle;
  else shot.mustStaySingle = ref.mustStaySingleBefore;
  return ref;
}

export function describeStagingRef(ref: ShotStagingRef): string {
  const role = ref.use === 'plate'
    ? `plate${ref.replacesView ? ` (replaces the ${ref.replacesView} view)` : ''}`
    : 'start frame (re-generated i2v)';
  return `${role}: ${ref.path} by ${ref.model}, picked ${ref.pickedAt.slice(0, 16).replace('T', ' ')}`;
}

/**
 * What a person should know about the shot's lane before the next
 * generate-videos: whether the lane can use the pick at all, and the MiniMax
 * face-start-frame failure (anti-pattern 31). generate-videos refuses what it
 * cannot render from the pick; this says so at pick time.
 */
export async function stagingLaneNotes(series: SeriesState, shot: ShotScript): Promise<string[]> {
  const ref = shot.stagingRef;
  if (!ref) return [];
  const lane = resolveVideoModel(shot, series).modelId;
  if (ref.use === 'start-frame') {
    if (!i2vRejectsFaceStartFrame(lane)) return [];
    const provenance = await readImageProvenance(stagingRefPath(series, ref));
    return [provenance?.hasFace === false
      ? `${lane} is a MiniMax image-to-video lane: it fails server-side, after billing, on a start frame that shows a face (anti-pattern 31). This pick is recorded as showing no face, so it will render; make sure it shows none.`
      : `${lane} is a MiniMax image-to-video lane: it fails server-side, after billing, on a start frame that shows a face (anti-pattern 31). This pick may show one, so generate-videos will refuse the shot. Put the shot on a Seedance lane, or, if the frame shows no face, edit again with --no-face (or set "hasFace": false in ${ref.path.replace(/\.(png|jpe?g|webp)$/i, '.provenance.json')}).`];
  }
  if (MODELS_USING_IMAGE_TAGS.has(lane) || shouldUseSeedanceKeyframe(shot, series.videoDefaults)) return [];
  if (MODELS_SUPPORTING_SCENE_IMAGES.has(lane)) {
    return [`${lane} takes the pick as a scene image, but still starts from the shot's panel, which was drawn on the plate before the edit. If the panel shows what the edit removed, stage the panel as a start frame instead (stage-ref --from <panel> --use start-frame).`];
  }
  return [`${lane} sends no location reference, so generate-videos will refuse this plate pick. Pick it as a start frame instead (--pick <n> --use start-frame), or route the shot to an R2V lane with @Image tags.`];
}

// ---- Packaging -------------------------------------------------------------------

/**
 * The generation units a change to the script removes, and the units it adds.
 * A pick makes its shot a single, so a montage or multi-shot run it was in is
 * split, and the shots around it land in units with new names.
 */
export function unitChanges(before: GenerationPlan, after: GenerationPlan): { removed: GenerationUnit[]; added: GenerationUnit[] } {
  const key = (unit: GenerationUnit) => `${unit.unitId}|${unit.unitType}|${unit.shotNumbers.join(',')}`;
  const beforeKeys = new Set(before.units.map(key));
  const afterKeys = new Set(after.units.map(key));
  return {
    removed: before.units.filter(unit => !afterKeys.has(key(unit))),
    added: after.units.filter(unit => !beforeKeys.has(key(unit))),
  };
}

export function describeUnit(unit: GenerationUnit): string {
  return `${unit.unitId} (${unit.unitType}, shot${unit.shotNumbers.length > 1 ? 's' : ''} ${unit.shotNumbers.join(', ')})`;
}

// ---- The pick page ---------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pickCommand(series: SeriesState, session: StageSession, pick: string): string {
  return `venice-video stage-ref -p "${series.outputDir}" -e ${session.episode} --shot ${session.shot} --pick ${pick} --session ${session.id}`;
}

/** The side-by-side page: the source, every candidate, and the command that picks each. */
export function renderPickPage(series: SeriesState, sessionDir: string, session: StageSession): string {
  const src = (path: string) => encodeURI(relative(sessionDir, projectPath(series, path)));
  const use = session.use === 'plate'
    ? `Plate: the pick stands in for ${session.replacesView ? `the ${session.replacesView} view` : 'its source'} in the shot's references (R2V).`
    : 'Start frame: the shot is re-generated from the pick (i2v), keeping its place, people, light and lens.';
  const cards = session.candidates.map(candidate => {
    const picked = session.picked === candidate.index;
    if (!candidate.path) {
      return `<figure class="card failed"><div class="none">${escapeHtml(candidate.model)} failed</div><figcaption><b>${candidate.index}. ${escapeHtml(candidate.model)}</b><p class="muted">${escapeHtml(candidate.error ?? 'no image')}</p></figcaption></figure>`;
    }
    return `<figure class="card${picked ? ' picked' : ''}"><a href="${src(candidate.path)}"><img src="${src(candidate.path)}" alt="${escapeHtml(candidate.model)}"></a><figcaption><b>${candidate.index}. ${escapeHtml(candidate.model)}</b>${picked ? ' <span class="pill">picked</span>' : ''}<p class="muted">${candidate.width ?? '?'}x${candidate.height ?? '?'}</p><code>${escapeHtml(pickCommand(series, session, String(candidate.index)))}</code></figcaption></figure>`;
  }).join('\n');
  const refs = session.refs.map((ref, i) => `<figure class="ref"><img src="${src(ref)}" alt="image ${i + 2}"><figcaption>image ${i + 2}: ${escapeHtml(basename(ref))}</figcaption></figure>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shot ${escapeHtml(session.shot)}: staging ref</title>
<style>
:root{--bg:#0c0e12;--panel:#141820;--line:#29303d;--text:#f2efe7;--muted:#9da5b4;--accent:#7cb7ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1500px,calc(100% - 40px));margin:auto;padding:40px 0 80px}h1{font-size:24px;margin:0 0 6px}p{margin:4px 0}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px;margin-top:22px}
.card{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}.card.picked{border-color:var(--accent)}
.card img{display:block;width:100%;height:auto}.card figcaption{padding:12px 14px}.none{padding:60px;text-align:center;color:var(--muted)}
code{display:block;margin-top:8px;padding:8px;background:#0b0d11;border:1px solid var(--line);border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--accent)}
.pill{border:1px solid var(--accent);color:var(--accent);border-radius:99px;padding:1px 8px;font-size:12px}
.prompt{margin-top:14px;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;white-space:pre-wrap}
.warn{margin-top:10px;color:#f0c674}
.refs{display:flex;gap:12px;margin-top:12px}.ref{margin:0;width:200px}.ref img{width:100%;border-radius:6px;border:1px solid var(--line)}.ref figcaption{font-size:12px;color:var(--muted)}
</style></head><body><main>
<h1>Shot ${escapeHtml(session.shot)}: pick a staging ref</h1>
<p>${escapeHtml(use)}</p>
<p class="muted">Edited from ${escapeHtml(session.sourceNote)}. Session ${escapeHtml(session.id)}. The pick is used for this shot only; the location's plates are not changed.</p>
${session.sourceWarning ? `<p class="warn">${escapeHtml(session.sourceWarning)}</p>` : ''}
<div class="prompt">${escapeHtml(session.prompt)}</div>
${refs ? `<div class="refs">${refs}</div>` : ''}
<div class="grid">
<figure class="card"><a href="${src(session.source)}"><img src="${src(session.source)}" alt="source"></a><figcaption><b>Source</b><p class="muted">${escapeHtml(session.sourceNote)} (image 1)</p></figcaption></figure>
${cards}
</div>
</main></body></html>
`;
}
