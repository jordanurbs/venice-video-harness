import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { VeniceClient } from '../venice/client.js';
import { VeniceRequestError } from '../venice/client.js';
import type {
  GenerationPlan,
  GenerationUnit,
  GenerationUnitSegment,
  SeriesState,
  ShotScript,
  VideoElement,
} from '../series/types.js';
import {
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  MODELS_SUPPORTING_END_IMAGE,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_SUPPORTING_PER_REFERENCE_AUDIO,
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  MODELS_USING_IMAGE_TAGS,
  isSeedanceVideoModel,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  getMaxReferenceImages,
} from '../series/types.js';
import { padAudioForModel, probeAudioDurationSec } from '../venice/audio-preflight.js';
import { generateSpeech } from '../venice/audio.js';
import { getCharacterDir, getLocationDir, getLocation } from '../series/manager.js';
import {
  buildMontagePrompt,
  buildMultiShotPrompt,
  buildVideoPrompt,
  resolveVideoModel,
  type MiniDramaVideoPrompt,
} from './prompt-builder.js';
import { cutMontageIntoShots } from './montage.js';
import {
  generateVoiceReference,
  resolveVoiceReferenceAbsPath,
  VOICE_REF_MIN_SEC,
  VOICE_REF_MAX_SEC,
} from './voice-reference.js';
import { mustRenderAsExactLipSync, parseShotDuration } from './generation-planner.js';
import { dialogueFileForShot, shotKey } from './shot-paths.js';
import { getVideoModel, modelSupportsDuration, resolveBitrateMode, type BitrateMode } from '../venice/models.js';
import { appendRecipePass } from '../venice/recipe.js';
import {
  clearPendingJob,
  findPendingJob,
  recordPendingJob,
  touchPendingJob,
} from '../venice/job-store.js';
import {
  abortableSleep,
  isAbortError,
  reportProgress,
  throwIfAborted,
} from '../venice/operation-context.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';
const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';
const VIDEO_COMPLETE_PATH = '/api/v1/video/complete';
const POLL_INTERVAL_MS = 10_000;
const MULTISHOT_RETRY_DELAY_MS = 15_000;
/**
 * Ceiling on a single shot's poll loop. Generous relative to real render times
 * (~30 min worst case) but finite: the loop used to be `while (true)`, so a job
 * that never resolved hung the process forever.
 */
const MAX_POLL_MS = 60 * 60 * 1000;
/** Consecutive /retrieve failures tolerated before abandoning a shot. */
const MAX_CONSECUTIVE_POLL_ERRORS = 6;

/**
 * True when Venice no longer recognises a queue id -- the job was reaped or
 * never existed. Only meaningful for a resumed id; a fresh one just failed.
 */
function isQueueGoneError(error: unknown): boolean {
  return error instanceof VeniceRequestError
    && (error.status === 400 || error.status === 404 || error.status === 410);
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

interface QueueResponse {
  model: string;
  queue_id: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function extractLastFrame(videoPath: string, outputPath: string): void {
  const durationStr = runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    videoPath,
  ]).trim();
  const duration = parseFloat(durationStr);
  const seekTo = Math.max(0, duration - 0.05);

  runCommand('ffmpeg', [
    '-y',
    '-ss',
    String(seekTo),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    outputPath,
  ]);
}

function extractFirstFrame(videoPath: string, outputPath: string): void {
  runCommand('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outputPath,
  ]);
}

function resolveDialogueShotId(shot: ShotScript): string | number {
  return shot.shotIdSuffix ? `${shot.shotNumber}${shot.shotIdSuffix}` : shot.shotNumber;
}

/**
 * Resolves the path to the dialogue MP3 for a shot, generating it inline
 * via Venice TTS if the shot has a locked voice and the file does not yet
 * exist. Returns undefined when the shot has no usable voice and no
 * pre-existing audio — the caller should fall back to letting the video model
 * synthesize audio from the prompt's dialogue block.
 */
async function ensureDialogueAudio(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  audioDir: string,
): Promise<string | undefined> {
  if (!shot.dialogue) return undefined;
  const shotId = resolveDialogueShotId(shot);
  const target = dialogueFileForShot(audioDir, shotId);
  if (existsSync(target)) return target;

  const character = series.characters.find(
    c => c.name.toUpperCase() === shot.dialogue!.character.toUpperCase(),
  );
  if (!character?.voiceId) {
    console.warn(
      `  No locked voice for ${shot.dialogue.character}; skipping inline TTS — the video model will synthesize from the prompt.`,
    );
    return undefined;
  }

  await mkdir(audioDir, { recursive: true });
  console.log(
    `  Inline TTS: shot ${shotKey(shotId)} [${character.name}, voice=${character.voiceName ?? character.voiceId}]`,
  );
  try {
    await generateSpeech(
      client,
      {
        voiceId: character.voiceId,
        text: shot.dialogue.line,
        prompt: character.voiceDescription,
      },
      target,
    );
    return target;
  } catch (err) {
    console.warn(`  Inline TTS failed (${(err as Error).message}); falling back to model-synthesized audio.`);
    return undefined;
  }
}

interface SeedanceKeyframeArtifacts {
  keyframePngPath: string;
  stageAVideoPath: string;
  dialogueAudioPath?: string;
  referenceImagePaths: string[];
}

/**
 * Stage A + Stage B of AGENTS.md rule 32: render a Seedance R2V identity-
 * lock pass (no audio, all character refs) and extract frame 1 as a PNG.
 * Returns paths for both the intermediate video and the keyframe so the
 * caller can wire them into the Wan 2.7 i2v stage and the saved metadata.
 *
 * Throws on any failure; the caller is responsible for falling back to
 * the panel-anchored single-pass render.
 */
async function renderSeedanceKeyframe(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  sceneDir: string,
  outputVideoPath: string,
  previousShot: ShotScript | undefined,
): Promise<SeedanceKeyframeArtifacts> {
  const stageAVideoPath = outputVideoPath.replace(/\.mp4$/, '-r2v-keyframe.mp4');
  const keyframePngPath = outputVideoPath.replace(/\.mp4$/, '-r2v-keyframe.png');

  if (existsSync(keyframePngPath) && existsSync(stageAVideoPath)) {
    console.log(`  Stage A: reusing existing keyframe ${keyframePngPath}`);
    const refs = collectReferenceImagePathsForShot(series, shot);
    return {
      keyframePngPath,
      stageAVideoPath,
      referenceImagePaths: refs,
    };
  }

  // Re-route the shot to Seedance R2V by cloning it with no dialogue and
  // forcing motion to 'high' (the planner skips Wan 2.7 routing on both
  // signals). This re-uses the entire prompt-builder pipeline including
  // the Seedance compatibility pre-flight and image-tag handling.
  const stageAShot: ShotScript = {
    ...shot,
    dialogue: null,
    motion: 'high',
    useReferenceImages: true,
  };
  const stageAPrompt = buildVideoPrompt(stageAShot, series, previousShot);
  // Wan 2.7's audio + R2V's audio metadata don't mix — force off explicitly.
  stageAPrompt.audio = false;

  if (!isSeedanceVideoModel(stageAPrompt.model)) {
    // Defensive: if the series's character consistency model isn't a Seedance
    // family member, we still skip lip-sync at this stage but warn the user
    // since the keyframe may inherit drift from the chosen model.
    console.warn(
      `  Stage A: characterConsistencyModel=${stageAPrompt.model} is not Seedance — keyframe will inherit that model's identity behavior.`,
    );
  }

  const panelPath = getShotPanelPath(sceneDir, resolveDialogueShotId(shot));
  const { elements, referenceImagePaths } = resolveCharacterElements(series, stageAShot, stageAPrompt);

  console.log(`  Stage A/3: ${stageAPrompt.model} keyframe render (identity lock, no audio)`);
  await renderVideoFile(client, {
    prompt: stageAPrompt,
    anchorImagePath: panelPath,
    outputPath: stageAVideoPath,
    elements,
    referenceImagePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    project: series.outputDir,
  });

  console.log(`  Stage B/3: extracting first frame -> ${keyframePngPath}`);
  extractFirstFrame(stageAVideoPath, keyframePngPath);
  if (!existsSync(keyframePngPath)) {
    throw new Error(`Stage B keyframe extraction produced no file at ${keyframePngPath}`);
  }
  await appendRecipePass(keyframePngPath, {
    kind: 'mechanical',
    role: 'mechanical',
    model: 'ffmpeg',
    label: 'keyframe extraction (frame 1 of Seedance R2V identity-lock pass)',
    anchorImagePath: stageAVideoPath,
  });

  return {
    keyframePngPath,
    stageAVideoPath,
    referenceImagePaths: referenceImagePaths ?? [],
  };
}

function collectReferenceImagePathsForShot(
  series: SeriesState,
  shot: ShotScript,
  modelId: string = DEFAULT_CHARACTER_CONSISTENCY_MODEL,
): string[] {
  const budget = getMaxReferenceImages(modelId);
  const resolved = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;
  if (resolved.length === 0) return [];
  return resolved
    .slice(0, budget)
    .flatMap(c => {
      const dir = getCharacterDir(series, c.name);
      return ['front.png', 'three-quarter.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p));
    })
    .slice(0, budget);
}

function imageToDataUri(imagePath: string, mimeType = 'image/png'): string {
  const buffer = readFileSync(imagePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Resolve the best location reference image for a shot. Closer shot types
 * (close-up / reaction / insert) prefer the medium ref; everything else
 * prefers the wide establishing ref. Falls back through the other angles.
 * Returns undefined when the shot has no location or no ref images exist.
 */
function getLocationRefPath(series: SeriesState, shot: ShotScript): string | undefined {
  if (!shot.location) return undefined;
  const loc = getLocation(series, shot.location);
  if (!loc) return undefined;
  const dir = getLocationDir(series, loc.slug);
  // Wide (hero plate) first, then the derived same-room angles, then legacy
  // ladder names for pre-2026-08-13 projects.
  const order = ['wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png'];
  for (const f of order) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Fold a location reference into the character reference_image_urls for a
 * Seedance / HappyHorse R2V shot. Characters come first (one ref per
 * character to keep the @ImageN mapping aligned with the prompt's
 * characterElements), then the location takes the last free slot within the
 * per-model budget (9 on Seedance R2V / HappyHorse 1.1 R2V).
 *
 * LEGACY fallback: shots whose prompt carries a full `referenceSlots` plan
 * (the normal path on @Image-tag models) never reach this — the slot plan
 * already interleaves characters, storyboard plates, and location angles.
 */
function foldLocationIntoReferences(
  series: SeriesState,
  shot: ShotScript,
  prompt: MiniDramaVideoPrompt,
  locationRefPath: string,
  existingCharRefs: string[] | undefined,
): string[] {
  const budget = getMaxReferenceImages(prompt.model);
  // One image per character, ordered to match the prompt's @Image1..@ImageN.
  const slotNames = (prompt.characterElements && prompt.characterElements.length > 0)
    ? prompt.characterElements.map(s => s.characterName)
    : shot.characters;
  const charRefs = slotNames
    .map(name => {
      const dir = getCharacterDir(series, name);
      return ['front.png', 'three-quarter.png']
        .map(f => join(dir, f))
        .find(p => existsSync(p));
    })
    .filter((p): p is string => Boolean(p));

  if (charRefs.length >= budget) {
    console.warn(`  ⚠ Location ref for "${shot.location}" dropped: character refs already fill the ${budget}-image budget.`);
    return existingCharRefs ?? charRefs.slice(0, budget);
  }
  console.log(`  Location ref -> reference_image_urls slot @Image${charRefs.length + 1} (${shot.location})`);
  return [...charRefs, locationRefPath].slice(0, budget);
}

async function persistCharacterJson(series: SeriesState, character: SeriesState['characters'][number]): Promise<void> {
  const dir = getCharacterDir(series, character.name);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'character.json'), JSON.stringify(character, null, 2), 'utf-8');
}

/**
 * Ensure the dialogue speaker for a shot has a voice-donor reference clip when
 * the shot routes to a reference-audio-capable model and voice references
 * aren't disabled. Auto-generates one via seed-audio-1-0 (mirrors the inline
 * TTS pattern in ensureDialogueAudio) and persists it to character.json so the
 * prompt builder picks it up. Best-effort — a failure just skips the ref.
 */
export async function ensureVoiceReferenceForShot(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  previousShot: ShotScript | undefined,
): Promise<void> {
  if (series.videoDefaults.voiceReferenceForDialogue === false) return;
  if (!shot.dialogue) return;
  const speaker = shot.dialogue.character.toUpperCase();
  if (speaker === 'NARRATOR' || speaker === 'V.O.' || speaker === 'VO') return;

  const resolution = resolveVideoModel(shot, series, previousShot);
  if (!MODELS_SUPPORTING_REFERENCE_AUDIO.has(resolution.modelId)) return;

  const character = series.characters.find(c => c.name.toUpperCase() === speaker);
  if (!character) return;

  const abs = resolveVoiceReferenceAbsPath(series, character);
  if (character.voiceReferencePath && abs && existsSync(abs)) return; // already present

  try {
    const { relPath, model } = await generateVoiceReference(client, series, character);
    character.voiceReferencePath = relPath;
    character.voiceReferenceModel = model;
    await persistCharacterJson(series, character);
  } catch (err) {
    console.warn(`  ⚠ Voice reference generation failed for ${character.name} (${(err as Error).message}); shot will fall back to the [Char, voiceDesc] text.`);
  }
}

function resolveVoiceReferencePaths(
  series: SeriesState,
  prompt: MiniDramaVideoPrompt,
): string[] {
  if (!prompt.voiceReferenceSlots || prompt.voiceReferenceSlots.length === 0) return [];
  return [...prompt.voiceReferenceSlots]
    .sort((a, b) => a.audioIndex - b.audioIndex)
    .map(slot => {
      const char = series.characters.find(
        c => c.name.toUpperCase() === slot.characterName.toUpperCase(),
      );
      const abs = char ? resolveVoiceReferenceAbsPath(series, char) : undefined;
      return abs && existsSync(abs) ? abs : undefined;
    })
    .filter((p): p is string => Boolean(p));
}

function getVideoDuration(path: string): number {
  const out = runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]).trim();
  return parseFloat(out);
}

function archiveExisting(outputPath: string): void {
  if (!existsSync(outputPath)) return;

  let version = 1;
  let archivePath = outputPath.replace(/\.mp4$/, `-v${version}.mp4`);
  while (existsSync(archivePath)) {
    version += 1;
    archivePath = outputPath.replace(/\.mp4$/, `-v${version}.mp4`);
  }

  renameSync(outputPath, archivePath);
  console.log(`  Archived previous: ${archivePath}`);
}

function saveJson(path: string, data: unknown): Promise<void> {
  return writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

async function logFailedRequest(
  outputPath: string,
  body: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const logDir = dirname(outputPath);
  const logFile = join(logDir, 'failed-requests.log');
  const timestamp = new Date().toISOString();

  const sanitizedBody = { ...body };
  if (sanitizedBody.image_url && typeof sanitizedBody.image_url === 'string' && sanitizedBody.image_url.length > 200) {
    sanitizedBody.image_url = `${(sanitizedBody.image_url as string).slice(0, 80)}...[${(sanitizedBody.image_url as string).length} chars]`;
  }
  if (sanitizedBody.end_image_url && typeof sanitizedBody.end_image_url === 'string' && sanitizedBody.end_image_url.length > 200) {
    sanitizedBody.end_image_url = `${(sanitizedBody.end_image_url as string).slice(0, 80)}...[${(sanitizedBody.end_image_url as string).length} chars]`;
  }

  let errorDetail: Record<string, unknown>;
  if (error instanceof VeniceRequestError) {
    errorDetail = { status: error.status, message: error.message, body: error.body };
  } else if (error instanceof Error) {
    errorDetail = { message: error.message };
  } else {
    errorDetail = { raw: String(error) };
  }

  const entry = {
    timestamp,
    targetOutput: outputPath,
    promptLength: (body.prompt as string)?.length,
    request: sanitizedBody,
    error: errorDetail,
  };

  await appendFile(logFile, JSON.stringify(entry, null, 2) + '\n---\n', 'utf-8');
  console.warn(`  Failed request logged to: ${logFile}`);
}

export interface RenderVideoOptions {
  prompt: MiniDramaVideoPrompt;
  /** Start-frame image. Omitted in pure reference mode (slot-plan renders). */
  anchorImagePath?: string;
  outputPath: string;
  endFrameImagePath?: string;
  elements?: VideoElement[];
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  negativePrompt?: string;
  /**
   * Pre-encoded data URL for `audio_url`. Used by callers that already
   * encoded the audio themselves. Prefer `audioPath` for new callsites —
   * it runs the Wan 2.7 audio pre-flight pad.
   */
  audioUrl?: string;
  /**
   * Path to a dialogue audio file for `audio_url`.
   * When supplied, the audio is probed against the model's
   * `minAudioInputSec` and padded with trailing silence if needed.
   * The resolved path is then encoded as a data URL into `audio_url`.
   */
  audioPath?: string;
  videoUrl?: string;
  aspectRatio?: string;
  /**
   * Output encoding bitrate mode. Only attached for models that accept it
   * (Seedance 2.x); Seedance 2.5 defaults to `'high'` for a large fidelity
   * gain at no extra cost. Pass `'standard'` to opt back into smaller files.
   */
  bitrateMode?: BitrateMode;
  /** Seedance compatibility strategy when images aren't seedream-originated. */
  seedanceCompatibility?: 'prompt' | 'fallback' | 'launder';
  /**
   * Voice-donor reference clips (on-disk paths), ordered to match the prompt's
   * @Audio1, @Audio2, … bindings. Sent as `reference_audio_urls` only when the
   * effective model supports reference audio AND at least one reference image
   * is present (Venice rejects audio-only reference audio).
   */
  voiceReferencePaths?: string[];
  /** Project directory, recorded on the pending job for `venice-video queue`. */
  project?: string;
  episode?: number;
  /**
   * Ignore any recorded in-flight queue id for this output and generate fresh.
   * Set automatically when a resumed job turns out to be gone on Venice's side.
   */
  forceRequeue?: boolean;
  /**
   * Explicit output resolution override. Honored ONLY when the effective model
   * actually lists it (so a bad value can't 400), otherwise the model-family
   * default below applies. The loop-preview engine passes `480P` here to render
   * MiniMax H3 Max Turbo drafts on the cheap tier, which the auto-pin never
   * selects (it forces `768P` for every `minimax-h3-max*` id).
   */
  resolution?: string;
}

function fileToDataUri(filePath: string, mimeType = 'image/png'): string | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  const buffer = readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export async function renderVideoFile(
  client: VeniceClient,
  options: RenderVideoOptions,
): Promise<string> {
  const { prompt, anchorImagePath, outputPath, endFrameImagePath,
    elements, referenceImagePaths, sceneImagePaths,
    negativePrompt, audioUrl, audioPath, videoUrl, voiceReferencePaths } = options;
  await mkdir(dirname(outputPath), { recursive: true });

  // NOTE: the former Seedance seedream-provenance pre-flight gate was removed
  // (2026-07). Venice dropped the restriction that Seedance 2.0 only accepts
  // face-bearing input images produced by seedream-v5-lite / -edit — it now
  // accepts face-bearing images from any image family — so there is nothing to
  // check, reroute, or launder before building the body. The Seedance face
  // *consent* attestation (409 needs_consent) is a separate mechanism and is
  // still handled at queue time below.
  const effectiveModel = prompt.model;

  // Pure reference mode (2026-07-30): on @Image-tag R2V models with a full
  // slot plan, the references carry ALL consistency — character sheets,
  // storyboard blocking plates, and location angles. No start image is sent;
  // a start frame would fight the blocking plate for compositional authority
  // and re-introduce the panel-drift problem R2V exists to solve. Shots with
  // no references at all (rare: no characters, no location, no storyboard)
  // still anchor on the panel.
  const hasSlotPlan = (prompt.referenceSlots?.length ?? 0) > 0;
  const refsOnly = hasSlotPlan
    && MODELS_USING_IMAGE_TAGS.has(effectiveModel)
    && Boolean(referenceImagePaths && referenceImagePaths.length > 0);

  const body: Record<string, unknown> = {
    model: effectiveModel,
    prompt: prompt.prompt,
    duration: prompt.duration,
    audio: prompt.audio,
  };

  // Models with audioConfigurable:false (e.g. HappyHorse 1.1) return HTTP 400
  // when the `audio` field is present with a non-default value — probed
  // 2026-07-30 (`audio: false` 400'd on happyhorse-1-1-reference-to-video).
  // Omit the field entirely for those models.
  const modelSpecForAudio = getVideoModel(effectiveModel);
  if (modelSpecForAudio && modelSpecForAudio.audioConfigurable === false) {
    if (prompt.audio === false) {
      console.warn(`  ⚠ ${effectiveModel} does not support audio toggling; omitting audio:false (model output will include native audio).`);
    }
    delete body.audio;
  }

  if (refsOnly) {
    console.log('  Start frame: none (pure reference mode — refs carry consistency)');
  } else if (anchorImagePath && existsSync(anchorImagePath)) {
    body.image_url = imageToDataUri(anchorImagePath);
  } else {
    console.warn(`  ⚠ No start image available (${anchorImagePath ?? 'none'}) and not in reference mode — request may fail on i2v models.`);
  }

  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }

  if (endFrameImagePath && existsSync(endFrameImagePath) && MODELS_SUPPORTING_END_IMAGE.has(effectiveModel)) {
    body.end_image_url = imageToDataUri(endFrameImagePath);
  }

  // Explicit override wins, but only when the model actually lists it —
  // otherwise a stray value would 400 the render. Falls through to the
  // family defaults below when absent or unsupported. The loop-preview engine
  // uses this to pin MiniMax H3 Max Turbo to its 480P draft tier.
  const resolutionOverride = options.resolution;
  const overrideSpec = resolutionOverride ? getVideoModel(effectiveModel) : undefined;
  if (resolutionOverride && overrideSpec?.resolutions.includes(resolutionOverride)) {
    body.resolution = resolutionOverride;
  } else if (resolutionOverride) {
    console.warn(`  ⚠ Resolution override ${resolutionOverride} not valid for ${effectiveModel}; using the model default.`);
  }

  if (body.resolution !== undefined) {
    // Already pinned by the override above.
  } else if (effectiveModel.includes('seedance')) {
    body.resolution = '720p';
  } else if (effectiveModel.includes('minimax-h3-max')) {
    // H3 Max / Max Turbo top out at 768P and reject 2K outright. This branch
    // MUST stay above the `minimax-h3` one — the substring match below would
    // otherwise pin them to 2K and 400 every render. 480P exists as a draft
    // tier but is not auto-selected; 768P is the finish resolution.
    body.resolution = '768P';
  } else if (effectiveModel.includes('minimax-h3')) {
    // 2K is H3's only resolution — anything else is a hard 400.
    body.resolution = '2K';
  } else if (effectiveModel.includes('veo')) {
    body.resolution = '720p';
  } else if (effectiveModel.includes('wan-2.6') || effectiveModel.includes('wan-2.5')) {
    body.resolution = '1080p';
  } else if (effectiveModel.includes('ltx-2')) {
    body.resolution = '1080p';
  } else if (effectiveModel.includes('sora-2-pro')) {
    body.resolution = '1080p';
  } else if (effectiveModel.includes('sora-2')) {
    body.resolution = '720p';
  }

  // bitrate_mode: Seedance 2.5 encodes at 'high' by default — ~5-6x the
  // bitrate for a sharp, artifact-free file at no extra token cost. Other
  // families don't accept the field, so resolveBitrateMode returns undefined
  // and it's left off the body.
  const bitrateMode = resolveBitrateMode(effectiveModel, options.bitrateMode);
  if (bitrateMode) body.bitrate_mode = bitrateMode;

  // Seedance image-to-video inherits aspect from the start image and
  // returns HTTP 400 if aspect_ratio is provided. Reference-to-video and
  // text-to-video Seedance variants do accept aspect_ratio.
  if (
    effectiveModel.includes('reference-to-video')
    || (effectiveModel.includes('seedance') && !effectiveModel.includes('image-to-video'))
  ) {
    body.aspect_ratio = options.aspectRatio ?? '16:9';
  }

  // audio_url attach with Wan 2.7 minimum-duration pre-flight.
  // - `audioPath` (preferred for new callers) runs ffprobe + ffmpeg apad to
  //   pad short dialogue to the model's minAudioInputSec before encoding.
  // - `audioUrl` (legacy) is taken at face value; the silent-reject guard
  //   on the rendered video will surface a downstream failure if the audio
  //   was too short. Migrate callers to `audioPath` when possible.
  // - `wan-2-7-reference-to-video` uses per_reference_audio inside elements
  //   instead of a global audio_url — see element loop below.
  if (MODELS_SUPPORTING_AUDIO_INPUT.has(effectiveModel)) {
    if (audioPath) {
      try {
        const result = await padAudioForModel({ model: effectiveModel, audioPath });
        if (result.padded) {
          console.log(`  Padded ${audioPath} -> ${result.outputPath} (${result.durationSec.toFixed(2)}s) for ${effectiveModel}.`);
        }
        body.audio_url = fileToDataUri(result.outputPath, 'audio/mpeg') ?? audioUrl;
      } catch (err) {
        console.warn(`  Wan audio pre-flight failed (${(err as Error).message}). Falling back to raw audioUrl.`);
        if (audioUrl) body.audio_url = audioUrl;
      }
    } else if (audioUrl) {
      body.audio_url = audioUrl;
    }
  } else if (audioPath || audioUrl) {
    // Model doesn't accept audio_url — drop quietly rather than 400.
    // For per-reference-audio R2V models, the audio attaches per element below.
    if (!MODELS_SUPPORTING_PER_REFERENCE_AUDIO.has(effectiveModel)) {
      console.warn(`  Model ${effectiveModel} does not accept audio_url; dropping audio attach.`);
    }
  }

  if (videoUrl) {
    body.video_url = videoUrl;
  }

  if (elements && elements.length > 0 && MODELS_SUPPORTING_ELEMENTS.has(effectiveModel)) {
    const supportsPerRefAudio = MODELS_SUPPORTING_PER_REFERENCE_AUDIO.has(effectiveModel);
    const apiElements = await Promise.all(elements.map(async el => {
      const out: Record<string, unknown> = {};
      if (el.frontalImageUrl) {
        out.frontal_image_url = el.frontalImageUrl.startsWith('data:')
          ? el.frontalImageUrl
          : fileToDataUri(el.frontalImageUrl) ?? el.frontalImageUrl;
      }
      if (el.referenceImageUrls && el.referenceImageUrls.length > 0) {
        out.reference_image_urls = el.referenceImageUrls.map(url =>
          url.startsWith('data:') ? url : (fileToDataUri(url) ?? url),
        );
      }
      if (el.videoUrl) out.video_url = el.videoUrl;
      // per-reference audio for Wan 2.7 R2V — each element drives
      // a different character's lip-sync. Run the same pad pre-flight here.
      if (supportsPerRefAudio) {
        if (el.audioPath) {
          try {
            const result = await padAudioForModel({ model: effectiveModel, audioPath: el.audioPath });
            if (result.padded) {
              console.log(`  [per-ref] Padded ${el.audioPath} -> ${result.outputPath} for ${effectiveModel}.`);
            }
            const uri = fileToDataUri(result.outputPath, 'audio/mpeg');
            if (uri) out.audio_url = uri;
            else if (el.audioUrl) out.audio_url = el.audioUrl;
          } catch (err) {
            console.warn(`  [per-ref] audio pre-flight failed (${(err as Error).message}); using raw audioUrl.`);
            if (el.audioUrl) out.audio_url = el.audioUrl;
          }
        } else if (el.audioUrl) {
          out.audio_url = el.audioUrl;
        }
      }
      return out;
    }));
    body.elements = apiElements;
    console.log(`  Elements: ${apiElements.length} character/object reference(s)`);
  }

  if (referenceImagePaths && referenceImagePaths.length > 0
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(effectiveModel)) {
    const refBudget = getMaxReferenceImages(effectiveModel);
    if (referenceImagePaths.length > refBudget) {
      console.warn(`  ⚠ ${referenceImagePaths.length} reference images exceed ${effectiveModel}'s ${refBudget}-image budget; truncating (check the slot allocator).`);
    }
    body.reference_image_urls = referenceImagePaths
      .slice(0, refBudget)
      .map(p => p.startsWith('data:') ? p : (fileToDataUri(p) ?? p))
      .filter(Boolean);
    console.log(`  Reference images (@Image1..@Image${(body.reference_image_urls as string[]).length}): ${(body.reference_image_urls as string[]).length}`);
  }

  if (sceneImagePaths && sceneImagePaths.length > 0
    && MODELS_SUPPORTING_SCENE_IMAGES.has(effectiveModel)) {
    body.scene_image_urls = sceneImagePaths
      .slice(0, 4)
      .map(p => p.startsWith('data:') ? p : (fileToDataUri(p) ?? p))
      .filter(Boolean);
    console.log(`  Scene images: ${(body.scene_image_urls as string[]).length}`);
  }

  // Voice-donor reference audio (@Audio1, @Audio2, …). Gated on model support
  // AND the presence of ≥1 reference image (Venice rejects audio-only). Each
  // clip must be 2-15s with an aggregate ≤15s across ≤3 clips; out-of-budget
  // clips are dropped with a warning so the render still proceeds.
  if (voiceReferencePaths && voiceReferencePaths.length > 0
    && MODELS_SUPPORTING_REFERENCE_AUDIO.has(effectiveModel)) {
    const hasReferenceImage = Array.isArray(body.reference_image_urls)
      && (body.reference_image_urls as string[]).length > 0;
    if (!hasReferenceImage) {
      console.warn('  ⚠ Voice references present but no reference image — dropping (Venice rejects audio-only reference audio).');
    } else {
      const accepted: string[] = [];
      let aggregateSec = 0;
      for (const p of voiceReferencePaths) {
        if (accepted.length >= 3) {
          console.warn(`  ⚠ Voice reference budget: >3 clips, dropping extras.`);
          break;
        }
        if (p.startsWith('data:')) { accepted.push(p); continue; }
        if (!existsSync(p)) { console.warn(`  ⚠ Voice reference missing on disk, skipping: ${p}`); continue; }
        let durSec: number;
        try {
          durSec = await probeAudioDurationSec(p);
        } catch (err) {
          console.warn(`  ⚠ Could not probe voice reference (${(err as Error).message}); skipping ${p}`);
          continue;
        }
        if (durSec < VOICE_REF_MIN_SEC || durSec > VOICE_REF_MAX_SEC) {
          console.warn(`  ⚠ Voice reference ${p} is ${durSec.toFixed(2)}s (must be ${VOICE_REF_MIN_SEC}-${VOICE_REF_MAX_SEC}s); skipping.`);
          continue;
        }
        if (aggregateSec + durSec > VOICE_REF_MAX_SEC) {
          console.warn(`  ⚠ Voice reference aggregate would exceed ${VOICE_REF_MAX_SEC}s; skipping ${p}.`);
          continue;
        }
        const mime = p.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
        const uri = fileToDataUri(p, mime);
        if (uri) { accepted.push(uri); aggregateSec += durSec; }
      }
      if (accepted.length > 0) {
        body.reference_audio_urls = accepted;
        console.log(`  Reference audio (@Audio1..@Audio${accepted.length}): ${accepted.length} voice clip(s), ${aggregateSec.toFixed(2)}s total`);
      }
    }
  } else if (voiceReferencePaths && voiceReferencePaths.length > 0) {
    console.warn(`  ⚠ Model ${effectiveModel} does not support reference_audio_urls; dropping ${voiceReferencePaths.length} voice reference(s).`);
  }

  if (options.aspectRatio && body.aspect_ratio && body.aspect_ratio !== options.aspectRatio) {
    console.warn(`  ⚠ Aspect ratio mismatch: sending ${body.aspect_ratio} but series expects ${options.aspectRatio}`);
  }

  if (prompt.characterElements && prompt.characterElements.length > 0
    && !effectiveModel.includes('reference-to-video')) {
    console.warn(`  ⚠ Shot has characters but model ${effectiveModel} is NOT R2V — character identity may drift`);
  }

  console.log(`  Queueing video: model=${effectiveModel}, duration=${prompt.duration}, aspect=${body.aspect_ratio ?? 'default'}, prompt=${(prompt.prompt).length} chars`);

  // Re-attach to an in-flight generation for this exact output rather than
  // paying for it again. Populated by a previous run that was interrupted
  // mid-poll (Ctrl-C, crash, closed terminal). See venice/job-store.ts.
  const jobKey = resolvePath(outputPath);
  const recordedJob = options.forceRequeue ? undefined : await findPendingJob(jobKey);
  if (recordedJob && recordedJob.kind === 'video') {
    console.log(`  Re-attaching to in-flight job ${recordedJob.queueId} (${recordedJob.model}) — not re-queueing.`);
    return pollRenderedVideo(client, {
      ...options,
      queueId: recordedJob.queueId,
      model: recordedJob.model,
      effectiveModel,
      body,
      resumed: true,
    });
  }

  let queueResponse: QueueResponse;
  try {
    queueResponse = await client.post<QueueResponse>(VIDEO_QUEUE_PATH, body);
  } catch (err) {
    // Seedance face-media consent flow (two-call attestation).
    // A 409 needs_consent is non-charging; resubmitting the identical body
    // with consents.seedance (all three booleans true) accepts the
    // policy_text returned in the 409. See
    // https://docs.venice.ai/guides/media/seedance-face-consent
    const isNeedsConsent = err instanceof VeniceRequestError
      && err.status === 409
      && (err.body as { error?: { code?: string } } | undefined)?.error?.code === 'needs_consent';
    if (isNeedsConsent) {
      console.log('  Seedance face consent requested (409 needs_consent) — resubmitting with attestation.');
      const consentBody = {
        ...body,
        consents: {
          seedance: {
            confirmed_terms_and_privacy: true,
            confirmed_legal_right: true,
            confirmed_screening_acknowledged: true,
          },
        },
      };
      try {
        queueResponse = await client.post<QueueResponse>(VIDEO_QUEUE_PATH, consentBody);
      } catch (consentErr) {
        if (consentErr instanceof VeniceRequestError) {
          console.error(`  Venice queue error after consent (HTTP ${consentErr.status}): ${consentErr.message}`);
          console.error(`  Error body: ${JSON.stringify(consentErr.body, null, 2)}`);
        }
        await logFailedRequest(outputPath, consentBody, consentErr);
        throw consentErr;
      }
    } else {
      if (err instanceof VeniceRequestError) {
        console.error(`  Venice queue error (HTTP ${err.status}): ${err.message}`);
        console.error(`  Error body: ${JSON.stringify(err.body, null, 2)}`);
      }
      await logFailedRequest(outputPath, body, err);
      throw err;
    }
  }

  const { queue_id, model } = queueResponse;
  console.log(`  Queue ID: ${queue_id}`);
  await recordPendingJob({
    kind: 'video',
    model,
    queueId: queue_id,
    outputPath: jobKey,
    project: options.project,
    episode: options.episode,
    prompt: prompt.prompt,
  });

  return pollRenderedVideo(client, {
    ...options,
    queueId: queue_id,
    model,
    effectiveModel,
    body,
    resumed: false,
  });
}

interface PollRenderedVideoOptions extends RenderVideoOptions {
  queueId: string;
  /** Model as Venice echoed it back from /queue -- /retrieve keys on this. */
  model: string;
  /** Model actually used for the render, for recipe/provenance output. */
  effectiveModel: string;
  /** The queue request body, kept for failure diagnostics. */
  body: Record<string, unknown>;
  /** True when the queue id came from the pending-job registry, not a fresh queue. */
  resumed: boolean;
}

/**
 * Poll a queued video to completion, save it, and write its recipe sidecar.
 *
 * Split out of renderVideoFile so a resumed queue id can enter the same path
 * without re-queueing. Cancellation propagates (the shell's Ctrl-C leaves the
 * pending-job record in place so the next run re-attaches), while a resumed id
 * Venice has already reaped falls back to a fresh generation.
 */
async function pollRenderedVideo(
  client: VeniceClient,
  options: PollRenderedVideoOptions,
): Promise<string> {
  const {
    prompt, anchorImagePath, outputPath, endFrameImagePath,
    elements, referenceImagePaths, sceneImagePaths,
    negativePrompt, audioPath, voiceReferencePaths,
    queueId: queue_id, model, effectiveModel, body, resumed,
  } = options;
  const jobKey = resolvePath(outputPath);

  let elapsed = 0;
  let consecutiveErrors = 0;
  while (true) {
    throwIfAborted();
    if (elapsed >= MAX_POLL_MS) {
      throw new Error(
        `Timed out after ${Math.round(MAX_POLL_MS / 60_000)} min waiting for ${model} (${queue_id}). `
        + `The job is still recorded — re-run to re-attach, or drop it with \`venice-video queue clear\`.`,
      );
    }
    await abortableSleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    try {
      const result = await client.postBinaryOrJson<{ status: string; execution_duration?: number }>(
        VIDEO_RETRIEVE_PATH,
        { model, queue_id },
      );
      consecutiveErrors = 0;

      if (Buffer.isBuffer(result.value)) {
        const videoBuffer = result.value;

        archiveExisting(outputPath);

        await writeFile(outputPath, videoBuffer);
        await clearPendingJob(jobKey);
        console.log(`  Video saved: ${outputPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB, ${(elapsed / 1000).toFixed(0)}s)`);

        try {
          await client.post(VIDEO_COMPLETE_PATH, { model, queue_id });
        } catch { /* cleanup is optional */ }

        // Recipe sidecar: log the resolved video call with stable on-disk
        // paths (never data: URIs) so a finishing agent can replay or
        // continue this shot. `elements` mapping goes in `extra` since it
        // carries per-character frontal/reference structure.
        const isPath = (p?: string): p is string => !!p && !p.startsWith('data:');
        await appendRecipePass(outputPath, {
          kind: 'video-generate',
          role: (prompt.characterElements && prompt.characterElements.length > 0)
            || (referenceImagePaths && referenceImagePaths.length > 0)
            || (elements && elements.length > 0)
            ? 'identity' : 'content',
          model: effectiveModel,
          label: effectiveModel !== prompt.model
            ? `video render (fallback from ${prompt.model})`
            : 'video render',
          prompt: prompt.prompt,
          negativePrompt,
          duration: prompt.duration,
          aspectRatio: (body.aspect_ratio as string | undefined) ?? options.aspectRatio,
          resolution: body.resolution as string | undefined,
          anchorImagePath: isPath(anchorImagePath) ? anchorImagePath : undefined,
          endImagePath: isPath(endFrameImagePath) ? endFrameImagePath : undefined,
          audioPath: isPath(audioPath) ? audioPath : undefined,
          referenceImagePaths: referenceImagePaths?.filter(isPath),
          extra: {
            audio: prompt.audio,
            ...(body.bitrate_mode ? { bitrateMode: body.bitrate_mode } : {}),
            ...(voiceReferencePaths && voiceReferencePaths.length > 0
              ? { voiceReferencePaths: voiceReferencePaths.filter(isPath) } : {}),
            ...(sceneImagePaths && sceneImagePaths.length > 0
              ? { sceneImagePaths: sceneImagePaths.filter(isPath) } : {}),
            ...(elements && elements.length > 0
              ? {
                elements: elements.map(el => ({
                  frontalImageUrl: isPath(el.frontalImageUrl) ? el.frontalImageUrl : undefined,
                  referenceImageUrls: el.referenceImageUrls?.filter(isPath),
                  audioPath: isPath(el.audioPath) ? el.audioPath : undefined,
                })),
              } : {}),
          },
        });

        return outputPath;
      }

      const status = result.value as { status: string; execution_duration?: number };
      const pct = status.execution_duration
        ? `${(status.execution_duration / 1000).toFixed(0)}s elapsed`
        : '';
      await touchPendingJob(jobKey);
      reportProgress({ phase: 'poll', detail: `${status.status} ${pct}`.trim() });
      process.stdout.write(`\r  Polling... ${status.status} ${pct}   `);
    } catch (err) {
      if (isAbortError(err)) throw err;

      // A resumed queue id Venice has already reaped can never complete —
      // without this the loop below would retry it forever.
      if (resumed && isQueueGoneError(err)) {
        console.warn(`\n  ⚠ Recorded job ${queue_id} is gone on Venice's side; queueing a fresh generation.`);
        await clearPendingJob(jobKey);
        return renderVideoFile(client, { ...options, forceRequeue: true });
      }

      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new Error(
          `Polling ${model} (${queue_id}) failed ${consecutiveErrors} times in a row; giving up. `
          + `Last error: ${(err as Error).message ?? err}`,
        );
      }
      console.warn(`  Poll error ${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS} (will retry): ${err}`);
    }
  }
}

function resolveCharacterElements(
  series: SeriesState,
  shot: ShotScript,
  prompt: MiniDramaVideoPrompt,
): { elements?: VideoElement[]; referenceImagePaths?: string[] } {
  // @Image-tag models with a slot plan: the plan IS the reference array.
  // Push in exactly the slot order so the prompt's @ImageN bindings match
  // (characters, storyboard blocking plate, location angles, extra angles).
  if (prompt.referenceSlots && prompt.referenceSlots.length > 0
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model)) {
    const paths = prompt.referenceSlots
      .map(slot => slot.path)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots.length) {
      console.warn('  ⚠ Reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    return { referenceImagePaths: paths.length > 0 ? paths : undefined };
  }

  if (!shot.characters || shot.characters.length === 0) return {};

  const resolvedChars = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;

  if (resolvedChars.length === 0) return {};

  const charDirFn = (name: string) => getCharacterDir(series, name);

  const autoElements = prompt.modelResolution?.autoUseElements ?? false;
  const autoRefs = prompt.modelResolution?.autoUseReferenceImages ?? false;

  if ((prompt.characterElements && prompt.characterElements.length > 0 || autoElements)
    && MODELS_SUPPORTING_ELEMENTS.has(prompt.model)) {
    const slots = prompt.characterElements && prompt.characterElements.length > 0
      ? prompt.characterElements
      : resolvedChars.slice(0, 2).map((char, index) => ({
        characterName: char.name,
        elementIndex: index + 1,
      }));

    const elements: VideoElement[] = slots.map(slot => {
      const dir = charDirFn(slot.characterName);
      const frontal = join(dir, 'front.png');
      const refs = ['three-quarter.png', 'profile.png', 'back.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p))
        .slice(0, 3);

      return {
        frontalImageUrl: existsSync(frontal) ? frontal : undefined,
        referenceImageUrls: refs.length > 0 ? refs : undefined,
      };
    });
    return { elements };
  }

  if ((shot.useReferenceImages || autoRefs)
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model)) {
    const budget = getMaxReferenceImages(prompt.model);
    const paths = resolvedChars
      .slice(0, budget)
      .flatMap(c => {
        const dir = charDirFn(c.name);
        return ['front.png', 'three-quarter.png']
          .map(f => join(dir, f))
          .filter(p => existsSync(p));
      })
      .slice(0, budget);
    return { referenceImagePaths: paths.length > 0 ? paths : undefined };
  }

  return {};
}

export interface ShotReferenceInputs {
  elements?: VideoElement[];
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  voiceReferencePaths: string[];
  /** True when an @Image slot plan resolved to ≥1 on-disk reference. */
  hasSlotPlan: boolean;
}

/**
 * Resolve every reference-bearing input for a shot's render — character
 * elements / `reference_image_urls`, scene images, the location environment
 * fold, and voice-donor clips — from the already-built video prompt. Extracted
 * from `renderSingleShotUnit` so other callers (the loop-preview engine's
 * create mode) resolve the SAME reference stack the real pipeline does, instead
 * of a divergent copy. Pure w.r.t. Venice (reads disk only); voice-donor
 * GENERATION stays in `ensureVoiceReferenceForShot`, called before this.
 */
export function resolveShotReferenceInputs(
  series: SeriesState,
  shot: ShotScript,
  videoPrompt: MiniDramaVideoPrompt,
): ShotReferenceInputs {
  const resolved = resolveCharacterElements(series, shot, videoPrompt);
  const elements = resolved.elements;
  let referenceImagePaths = resolved.referenceImagePaths;
  let sceneImagePaths = shot.sceneImagePaths?.filter(p => existsSync(p));
  const hasSlotPlan = (videoPrompt.referenceSlots?.length ?? 0) > 0
    && (referenceImagePaths?.length ?? 0) > 0;

  // Location environment references. The slot plan already interleaves location
  // angles for @Image-tag models; this legacy fold only runs when no plan
  // exists. Kling O3 R2V takes environment refs via scene_image_urls; hand-set
  // sceneImagePaths always win.
  const locationRefPath = getLocationRefPath(series, shot);
  if (locationRefPath) {
    if (MODELS_SUPPORTING_SCENE_IMAGES.has(videoPrompt.model)) {
      if (!sceneImagePaths || sceneImagePaths.length === 0) {
        sceneImagePaths = [locationRefPath];
        console.log(`  Location ref -> scene_image_urls (${shot.location})`);
      }
    } else if (!hasSlotPlan && videoPrompt.locationEnvSlot) {
      referenceImagePaths = foldLocationIntoReferences(
        series, shot, videoPrompt, locationRefPath, referenceImagePaths,
      );
    }
  }

  // Voice-donor clips in the exact order the prompt's @AudioN slots expect.
  const voiceReferencePaths = resolveVoiceReferencePaths(series, videoPrompt);

  return { elements, referenceImagePaths, sceneImagePaths, voiceReferencePaths, hasSlotPlan };
}

function getShotPanelPath(sceneDir: string, shotId: number | string): string {
  return join(sceneDir, `shot-${shotKey(shotId)}.png`);
}

function getShotVideoPath(sceneDir: string, shotId: number | string): string {
  return join(sceneDir, `shot-${shotKey(shotId)}.mp4`);
}

function chooseAnchorImagePath(
  unit: GenerationUnit,
  sceneDir: string,
  unitOutputPath: string,
  previousRenderedShotPath?: string,
  explicitPanelPath?: string,
): string {
  const firstShotNumber = unit.shotNumbers[0];
  const panelPath = explicitPanelPath ?? getShotPanelPath(sceneDir, firstShotNumber);

  if (unit.startFrameStrategy === 'previous-last-frame'
    && previousRenderedShotPath
    && existsSync(previousRenderedShotPath)) {
    const lastFramePath = unitOutputPath.replace(/\.mp4$/, '-lastframe.png');
    extractLastFrame(previousRenderedShotPath, lastFramePath);
    console.log('  Start frame: chained from previous rendered shot');
    return lastFramePath;
  }

  console.log('  Start frame: panel image');
  return panelPath;
}

function chooseEndFrameImagePath(
  unit: GenerationUnit,
  sceneDir: string,
  nextShotNumber?: number,
): string | undefined {
  if (unit.endFrameStrategy !== 'next-panel-target' || nextShotNumber === undefined) {
    console.log('  End frame: natural');
    return undefined;
  }

  const nextPanelPath = getShotPanelPath(sceneDir, nextShotNumber);
  if (!existsSync(nextPanelPath)) {
    console.log('  End frame: natural (next panel missing)');
    return undefined;
  }

  console.log(`  End frame: targeting shot-${String(nextShotNumber).padStart(3, '0')}`);
  return nextPanelPath;
}

async function saveSingleShotMetadata(
  series: SeriesState,
  shot: ShotScript,
  videoPath: string,
  videoPrompt: MiniDramaVideoPrompt,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  const videoJsonPath = videoPath.replace(/\.mp4$/, '.video.json');
  await saveJson(videoJsonPath, {
    panelId: `E${series.episodes.length}-S${shot.shotNumber}`,
    shotNumber: shot.shotNumber,
    video: {
      model: videoPrompt.model,
      prompt: videoPrompt.prompt,
      duration: videoPrompt.duration,
      audio: videoPrompt.audio,
    },
    metadata: {
      characters: shot.characters,
      dialogue: shot.dialogue,
      sfx: shot.sfx,
      transition: shot.transition,
      cameraMovement: shot.cameraMovement,
      ...extraMetadata,
    },
  });
}

function splitRenderedUnitIntoShots(
  unitOutputPath: string,
  unit: GenerationUnit,
  shotsByNumber: Map<number, ShotScript>,
  sceneDir: string,
): GenerationUnitSegment[] {
  const renderedDuration = getVideoDuration(unitOutputPath);
  const plannedTotal = unit.shotNumbers.reduce((sum, shotNumber) => {
    const shot = shotsByNumber.get(shotNumber);
    return sum + (shot ? parseShotDuration(shot.duration) : 0);
  }, 0);

  let offset = 0;
  const segments: GenerationUnitSegment[] = [];

  for (let index = 0; index < unit.shotNumbers.length; index++) {
    const shotNumber = unit.shotNumbers[index];
    const shot = shotsByNumber.get(shotNumber);
    if (!shot) continue;

    const outputPath = getShotVideoPath(sceneDir, shotNumber);
    const isLast = index === unit.shotNumbers.length - 1;
    const durationSec = isLast
      ? Math.max(0.1, renderedDuration - offset)
      : Math.max(0.1, renderedDuration * (parseShotDuration(shot.duration) / plannedTotal));

    archiveExisting(outputPath);
    runCommand('ffmpeg', [
      '-y',
      '-ss',
      String(offset),
      '-i',
      unitOutputPath,
      '-t',
      String(durationSec),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      outputPath,
    ]);

    segments.push({
      shotNumber,
      startOffsetSec: Number(offset.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      outputFile: `shot-${String(shotNumber).padStart(3, '0')}.mp4`,
    });

    offset += durationSec;
  }

  return segments;
}

async function renderSingleShotUnit(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  unit: GenerationUnit,
  sceneDir: string,
  previousRenderedShotPath: string | undefined,
  nextShotNumber: number | undefined,
  previousShot?: ShotScript,
  episodeAudioMix?: import('../series/types.js').AudioMixDefaults,
): Promise<string[]> {
  // Suffixed inserts ("3b") must key their own panel/video files — using the
  // bare shotNumber here made every suffixed shot collide with its base shot
  // (path resolved to shot-003.*), so inserts were silently skipped as
  // "video exists".
  const shotId = resolveDialogueShotId(shot);
  const panelPath = getShotPanelPath(sceneDir, shotId);
  // A missing panel is only fatal for shots that will actually anchor on it.
  // Refs-only shots (Seedance R2V slot plan) don't send a start image, so the
  // decision to skip is deferred until after the prompt/references resolve.
  const panelExists = existsSync(panelPath);

  const videoPath = getShotVideoPath(sceneDir, shotId);
  if (existsSync(videoPath)) {
    console.log(`  Shot ${shotKey(shotId)}: video exists, skipping`);
    unit.renderedDurationSec = getVideoDuration(videoPath);
    unit.segments = [{
      shotNumber: shot.shotNumber,
      startOffsetSec: 0,
      durationSec: unit.renderedDurationSec,
      outputFile: `shot-${shotKey(shotId)}.mp4`,
    }];
    return [videoPath];
  }

  // Ensure the dialogue speaker has a voice-donor reference clip before the
  // prompt is built, so buildVideoPrompt can emit the @AudioN binding (A2/A3).
  await ensureVoiceReferenceForShot(client, series, shot, previousShot);

  const videoPrompt = buildVideoPrompt(shot, series, previousShot, episodeAudioMix);
  if (!videoPrompt.audio && shot.dialogue) {
    const reason = shot.nativeAudio === 'mute'
      ? 'shot.nativeAudio=mute'
      : episodeAudioMix?.suppressModelNarration
        ? 'episode.audioMix.suppressModelNarration'
        : shot.dialogue.character?.toUpperCase() === 'NARRATOR'
          ? 'NARRATOR shot (auto)'
          : 'unknown';
    console.log(`  Audio: model-native disabled (${reason})`);
  }
  unit.model = videoPrompt.model;

  if (videoPrompt.modelResolution) {
    const res = videoPrompt.modelResolution;
    console.log(`  Model: ${res.modelId}${res.upgraded ? ` (upgraded: ${res.reason})` : ''}`);
    if (res.autoUseElements) console.log('  Auto-enabled: elements (character identity anchoring)');
    if (res.autoUseReferenceImages) console.log('  Auto-enabled: reference images');
  }

  const { elements, referenceImagePaths, sceneImagePaths, voiceReferencePaths, hasSlotPlan } =
    resolveShotReferenceInputs(series, shot, videoPrompt);

  // Refs-only shots (Seedance R2V slot plan) don't anchor on the panel, so a
  // missing panel is fine there. Everything else still requires it.
  if (!panelExists && !hasSlotPlan) {
    console.warn(`  Panel not found: ${panelPath}, skipping shot ${shotId}`);
    return [];
  }

  let anchorImagePath = chooseAnchorImagePath(unit, sceneDir, videoPath, previousRenderedShotPath, panelPath);
  const endFramePath = chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  // --- AGENTS.md rule 32: Seedance R2V keyframe pipeline ---
  // Only for lip-sync models with no `reference_image_urls` lane (Wan 2.7
  // i2v), whose sole identity anchor is the single `image_url` keyframe. We
  // render a Seedance R2V identity-lock pass first, extract frame 1, and use
  // that frame as the keyframe. The planner skips this entirely when the
  // lip-sync model is itself an R2V lane.
  let keyframeArtifacts: SeedanceKeyframeArtifacts | undefined;
  let dialogueAudioPath: string | undefined;
  let stageAFailed = false;
  let stageAFailureReason: string | undefined;
  if (unit.useSeedanceKeyframe === true) {
    try {
      keyframeArtifacts = await renderSeedanceKeyframe(
        client,
        series,
        shot,
        sceneDir,
        videoPath,
        previousShot,
      );
      anchorImagePath = keyframeArtifacts.keyframePngPath;
    } catch (err) {
      stageAFailed = true;
      stageAFailureReason = err instanceof Error ? err.message : String(err);
      console.warn(
        `  ⚠ Seedance R2V keyframe pipeline failed (${stageAFailureReason}); falling back to panel-anchored single-pass render.`,
      );
      keyframeArtifacts = undefined;
      anchorImagePath = chooseAnchorImagePath(unit, sceneDir, videoPath, previousRenderedShotPath, panelPath);
    }
  }

  // Exact lip-sync: wire the dialogue MP3 into `audio_url` so the model
  // follows the real recording instead of synthesizing a voice. This is the
  // step that actually produces the lip-sync, so it runs for every
  // audio-input-capable route — the keyframed Wan 2.7 i2v path and the
  // in-family R2V path (Seedance 2.x, MiniMax H3) alike.
  if (!stageAFailed
    && mustRenderAsExactLipSync(shot, series.videoDefaults)
    && MODELS_SUPPORTING_AUDIO_INPUT.has(videoPrompt.model)) {
    const audioDir = join(dirname(sceneDir), 'audio');
    console.log(`  Locating dialogue audio for ${videoPrompt.model} lip-sync`);
    dialogueAudioPath = await ensureDialogueAudio(client, series, shot, audioDir);
  }

  const savedPath = await renderVideoFile(client, {
    prompt: videoPrompt,
    anchorImagePath,
    outputPath: videoPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    sceneImagePaths,
    audioPath: dialogueAudioPath,
    voiceReferencePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    project: series.outputDir,
  });

  const durationSec = getVideoDuration(savedPath);
  unit.renderedDurationSec = durationSec;
  unit.segments = [{
    shotNumber: shot.shotNumber,
    startOffsetSec: 0,
    durationSec,
    outputFile: `shot-${shotKey(shotId)}.mp4`,
  }];

  const extraMetadata: Record<string, unknown> = { generationUnit: unit.unitId };
  if (keyframeArtifacts) {
    extraMetadata.seedanceKeyframe = {
      stageAVideo: relativeForMetadata(savedPath, keyframeArtifacts.stageAVideoPath),
      keyframePng: relativeForMetadata(savedPath, keyframeArtifacts.keyframePngPath),
      keyframeModel: unit.keyframeModel,
      dialogueAudio: dialogueAudioPath
        ? relativeForMetadata(savedPath, dialogueAudioPath)
        : null,
    };
  } else if (unit.useSeedanceKeyframe === true && stageAFailed) {
    extraMetadata.seedanceKeyframe = {
      attempted: true,
      success: false,
      reason: stageAFailureReason,
    };
  }

  await saveSingleShotMetadata(series, shot, savedPath, videoPrompt, extraMetadata);
  return [savedPath];
}

function relativeForMetadata(anchorPath: string, target: string): string {
  // Both anchorPath and target live in the same scene dir; return the
  // basename for compactness while preserving uniqueness within the dir.
  if (dirname(anchorPath) === dirname(target)) {
    return target.slice(dirname(target).length + 1);
  }
  return target;
}

async function renderMultiShotUnit(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  unit: GenerationUnit,
  sceneDir: string,
  previousRenderedShotPath: string | undefined,
  nextShotNumber: number | undefined,
): Promise<string[]> {
  const shotOutputPaths = shots.map(shot => getShotVideoPath(sceneDir, shot.shotNumber));
  if (shotOutputPaths.every(path => existsSync(path))) {
    console.log(`  ${unit.unitId}: shot outputs exist, skipping`);
    let offset = 0;
    unit.segments = shotOutputPaths.map((path, index) => {
      const durationSec = getVideoDuration(path);
      const segment: GenerationUnitSegment = {
        shotNumber: shots[index].shotNumber,
        startOffsetSec: Number(offset.toFixed(3)),
        durationSec: Number(durationSec.toFixed(3)),
        outputFile: `shot-${String(shots[index].shotNumber).padStart(3, '0')}.mp4`,
      };
      offset += durationSec;
      return segment;
    });
    unit.renderedDurationSec = offset;
    return shotOutputPaths;
  }

  const unitOutputPath = join(sceneDir, unit.outputFile);
  const prompt = buildMultiShotPrompt(shots, unit, series);
  unit.model = prompt.model;

  // Reference-first multi-shot (Seedance R2V default): pure reference mode.
  // The slot plan carries all consistency; no panel anchor is needed or sent
  // (renderVideoFile omits image_url when a slot plan is present on an
  // @Image-tag model). Legacy i2v overrides still anchor on the first panel.
  const hasSlotPlan = (prompt.referenceSlots?.length ?? 0) > 0
    && MODELS_USING_IMAGE_TAGS.has(prompt.model);

  const firstPanelPath = getShotPanelPath(sceneDir, shots[0].shotNumber);
  if (!existsSync(firstPanelPath) && !hasSlotPlan) {
    console.warn(`  Panel not found: ${firstPanelPath}, skipping unit ${unit.unitId}`);
    return [];
  }

  const anchorImagePath = hasSlotPlan
    ? undefined
    : chooseAnchorImagePath(unit, sceneDir, unitOutputPath, previousRenderedShotPath);
  const endFramePath = hasSlotPlan
    ? undefined
    : chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  if (prompt.modelResolution) {
    console.log(`  Model: ${prompt.model} (${prompt.modelResolution.reason})`);
  }

  // Resolve elements and references for multi-shot — same identity anchoring as single shots
  const allCharNames = Array.from(new Set(shots.flatMap(s => s.characters)));
  const resolvedChars = allCharNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;

  const charDirFn2 = (name: string) => getCharacterDir(series, name);

  let elements: VideoElement[] | undefined;
  let referenceImagePaths: string[] | undefined;

  if (hasSlotPlan) {
    // Push reference_image_urls in EXACTLY the slot-plan order so the
    // prompt's @ImageN bindings match the request array (same invariant as
    // resolveCharacterElements on the single-shot path).
    const paths = prompt.referenceSlots!
      .map(slot => slot.path)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots!.length) {
      console.warn('  ⚠ Multi-shot reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    referenceImagePaths = paths.length > 0 ? paths : undefined;
    if (referenceImagePaths) {
      console.log(`  Multi-shot slot plan: ${referenceImagePaths.length} reference(s) (pure reference mode)`);
    }
  } else if (prompt.characterElements && prompt.characterElements.length > 0
    && MODELS_SUPPORTING_ELEMENTS.has(prompt.model)) {
    elements = prompt.characterElements.map(slot => {
      const dir = charDirFn2(slot.characterName);
      const frontal = join(dir, 'front.png');
      const refs = ['three-quarter.png', 'profile.png', 'back.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p))
        .slice(0, 3);
      return {
        frontalImageUrl: existsSync(frontal) ? frontal : undefined,
        referenceImageUrls: refs.length > 0 ? refs : undefined,
      };
    });
    console.log(`  ${unit.unitId}: elements enabled for ${prompt.characterElements.map(s => s.characterName).join(', ')}`);
  } else if (MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model) && resolvedChars.length > 0) {
    referenceImagePaths = resolvedChars
      .flatMap(c => {
        const dir = charDirFn2(c.name);
        return ['front.png', 'three-quarter.png']
          .map(f => join(dir, f))
          .filter(p => existsSync(p));
      })
      .slice(0, 4);
    if (referenceImagePaths.length === 0) referenceImagePaths = undefined;
  }

  // Voice-donor clips for the unit's dialogue speakers, in @AudioN order
  // (only used by reference-audio-capable models with ≥1 reference image).
  const voiceReferencePaths = resolveVoiceReferencePaths(series, prompt);

  const savedUnitPath = await renderVideoFile(client, {
    prompt,
    anchorImagePath,
    outputPath: unitOutputPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    voiceReferencePaths: voiceReferencePaths.length > 0 ? voiceReferencePaths : undefined,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    project: series.outputDir,
  });

  const segments = splitRenderedUnitIntoShots(savedUnitPath, unit, new Map(shots.map(shot => [shot.shotNumber, shot])), sceneDir);
  const shotPaths: string[] = [];

  for (const segment of segments) {
    const shot = shots.find(item => item.shotNumber === segment.shotNumber);
    if (!shot) continue;
    const shotPath = join(sceneDir, segment.outputFile);
    shotPaths.push(shotPath);

    await saveSingleShotMetadata(series, shot, shotPath, {
      ...prompt,
      duration: shot.duration,
    }, {
      generationUnit: unit.unitId,
      generatedFromUnit: unit.outputFile,
      unitStartOffsetSec: segment.startOffsetSec,
      unitDurationSec: segment.durationSec,
    });
  }

  unit.renderedDurationSec = Number(getVideoDuration(savedUnitPath).toFixed(3));
  unit.segments = segments;
  await saveJson(savedUnitPath.replace(/\.mp4$/, '.video.json'), {
    unitId: unit.unitId,
    shotNumbers: unit.shotNumbers,
    video: prompt,
    metadata: {
      unitType: unit.unitType,
      segments,
      decisionReasons: unit.decisionReasons,
    },
  });

  return shotPaths;
}

/**
 * Render a montage unit: ONE single-pass generation (Seedance 2.5, up to 30s)
 * prompted with the timestamped SEQUENCE beat list, then cut at the same
 * timestamps into per-shot clips — canonical `shot-NNN.mp4` files for the
 * assembler AND organized copies in `media-library/scene-NN/` (with the
 * uncut master and a manifest) for hand editing / the Venice Video Creator.
 */
async function renderMontageUnit(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  unit: GenerationUnit,
  sceneDir: string,
): Promise<string[]> {
  const shotOutputPaths = shots.map(shot => getShotVideoPath(sceneDir, shot.shotNumber));
  const episodeDir = dirname(sceneDir);
  const unitOutputPath = join(sceneDir, unit.outputFile);

  if (existsSync(unitOutputPath) && shotOutputPaths.every(path => existsSync(path))) {
    console.log(`  ${unit.unitId}: montage master and shot cuts exist, skipping`);
    let offset = 0;
    unit.segments = shotOutputPaths.map((path, index) => {
      const durationSec = getVideoDuration(path);
      const segment: GenerationUnitSegment = {
        shotNumber: shots[index].shotNumber,
        startOffsetSec: Number(offset.toFixed(3)),
        durationSec: Number(durationSec.toFixed(3)),
        outputFile: `shot-${shotKey(shots[index].shotNumber)}.mp4`,
      };
      offset += durationSec;
      return segment;
    });
    unit.renderedDurationSec = Number(getVideoDuration(unitOutputPath).toFixed(3));
    return shotOutputPaths;
  }

  const prompt = buildMontagePrompt(shots, unit, series);
  unit.model = prompt.model;

  if (prompt.modelResolution) {
    console.log(`  Model: ${prompt.model} (${prompt.modelResolution.reason})`);
  }

  // Pure reference mode — same invariant as the multi-shot lane: push
  // reference_image_urls in EXACTLY the slot-plan order so @ImageN bindings
  // match the request array.
  let referenceImagePaths: string[] | undefined;
  if ((prompt.referenceSlots?.length ?? 0) > 0) {
    const paths = prompt.referenceSlots!
      .map(slot => slot.path)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots!.length) {
      console.warn('  ⚠ Montage reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    referenceImagePaths = paths.length > 0 ? paths : undefined;
    if (referenceImagePaths) {
      console.log(`  Montage slot plan: ${referenceImagePaths.length} reference(s) (pure reference mode, ${getMaxReferenceImages(prompt.model)}-image budget)`);
    }
  }

  const voiceReferencePaths = resolveVoiceReferencePaths(series, prompt);

  const savedUnitPath = await renderVideoFile(client, {
    prompt,
    anchorImagePath: undefined,
    outputPath: unitOutputPath,
    referenceImagePaths,
    voiceReferencePaths: voiceReferencePaths.length > 0 ? voiceReferencePaths : undefined,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    project: series.outputDir,
  });

  // Cut at the planned beat boundaries — the same timestamps the prompt's
  // SEQUENCE block declared.
  const { shotPaths, libraryPaths, segments } = cutMontageIntoShots({
    montagePath: savedUnitPath,
    unit,
    shotsByNumber: new Map(shots.map(shot => [shot.shotNumber, shot])),
    sceneDir,
    episodeDir,
    archiveExisting,
  });
  console.log(`  Media library: ${libraryPaths.length} cut(s) + master → ${join(episodeDir, 'media-library', `scene-${String(unit.sceneNumber ?? 1).padStart(2, '0')}`)}`);

  for (const segment of segments) {
    const shot = shots.find(item => item.shotNumber === segment.shotNumber);
    if (!shot) continue;
    await saveSingleShotMetadata(series, shot, join(sceneDir, segment.outputFile), {
      ...prompt,
      duration: shot.duration,
    }, {
      generationUnit: unit.unitId,
      generatedFromUnit: unit.outputFile,
      unitStartOffsetSec: segment.startOffsetSec,
      unitDurationSec: segment.durationSec,
      montageScene: unit.sceneNumber,
    });
  }

  unit.renderedDurationSec = Number(getVideoDuration(savedUnitPath).toFixed(3));
  unit.segments = segments;
  await saveJson(savedUnitPath.replace(/\.mp4$/, '.video.json'), {
    unitId: unit.unitId,
    shotNumbers: unit.shotNumbers,
    video: prompt,
    metadata: {
      unitType: unit.unitType,
      sceneNumber: unit.sceneNumber,
      montageBeats: unit.montageBeats,
      segments,
      decisionReasons: unit.decisionReasons,
    },
  });

  return shotPaths;
}

async function renderMultiShotUnitUntilSuccess(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  unit: GenerationUnit,
  sceneDir: string,
  previousRenderedShotPath: string | undefined,
  nextShotNumber: number | undefined,
): Promise<string[]> {
  let attempt = 1;

  while (true) {
    try {
      if (attempt > 1) {
        console.log(`  ${unit.unitId}: retrying multi-shot render (attempt ${attempt})`);
      }

      return await renderMultiShotUnit(
        client,
        series,
        shots,
        unit,
        sceneDir,
        previousRenderedShotPath,
        nextShotNumber,
      );
    } catch (err) {
      if (err instanceof VeniceRequestError) {
        console.warn(`  ${unit.unitId}: multi-shot attempt ${attempt} failed (HTTP ${err.status}): ${err.message}`);
        console.warn(`  Error body: ${JSON.stringify(err.body, null, 2)}`);
      } else {
        console.warn(`  ${unit.unitId}: multi-shot attempt ${attempt} failed - ${err}`);
      }
      console.warn(`  ${unit.unitId}: keeping multi-shot strategy, retrying in ${(MULTISHOT_RETRY_DELAY_MS / 1000).toFixed(0)}s`);
      attempt += 1;
      await sleep(MULTISHOT_RETRY_DELAY_MS);
    }
  }
}

export interface GenerateEpisodeVideosResult {
  videoPaths: string[];
  plan: GenerationPlan;
}

/**
 * Pre-flight check that every shot's requested duration is renderable on the
 * model it was routed to. Throws a single error listing all violations so the
 * operator can fix the script in one pass rather than fail-and-retry against
 * Venice (which returns HTTP 422 deep into the queue call with a generic
 * message).
 *
 * Examples this catches:
 *   - duration: "16s" routed to seedance-2-0-* (max 15s)
 *   - duration: "12s" routed to veo3.1-fast-image-to-video (max 8s)
 *   - duration: "8s" routed to wan-2-7-reference-to-video (max 10s, but step
 *     restriction — 8s not in [5s, 10s])
 */
export function assertShotDurationsValid(
  shots: ShotScript[],
  plan: GenerationPlan,
): void {
  type Violation = {
    shotNumber: number;
    duration: string;
    durationSec: number;
    model: string;
    maxSec: number;
    allowed: string[];
  };
  const violations: Violation[] = [];

  const shotById = new Map(shots.map(s => [s.shotNumber, s]));
  for (const unit of plan.units) {
    const model = unit.model;
    const modelSpec = getVideoModel(model);
    if (!modelSpec) {
      // Unknown model — registry may be stale. Don't block; the API will
      // surface the real error if the model is actually missing.
      continue;
    }
    // Montage units render as ONE generation: per-shot durations are beat
    // windows inside it, not renderable clips, so only the unit's total
    // duration is validated against the model ladder.
    if (unit.unitType === 'montage') {
      const unitSec = parseShotDuration(unit.duration);
      if (unitSec > modelSpec.maxDurationSec || !modelSpec.durations.includes(unit.duration)) {
        violations.push({
          shotNumber: unit.shotNumbers[0],
          duration: unit.duration,
          durationSec: unitSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
      }
      continue;
    }
    for (const shotNum of unit.shotNumbers) {
      const shot = shotById.get(shotNum);
      if (!shot) continue;
      const requestedSec = parseShotDuration(shot.duration);
      if (!Number.isFinite(requestedSec) || requestedSec <= 0) continue;
      if (requestedSec > modelSpec.maxDurationSec) {
        violations.push({
          shotNumber: shotNum,
          duration: shot.duration,
          durationSec: requestedSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
        continue;
      }
      // The model may have a stepped duration ladder (e.g. Wan 2.7 R2V only
      // accepts 5s/10s). Use modelSupportsDuration for the loose
      // (under-the-ceiling) check, then a strict membership check when the
      // model exposes an explicit ladder. Strict check catches 8s on Wan 2.7
      // R2V which modelSupportsDuration's lenient fallback would let through.
      const passesLenient = modelSupportsDuration(model, shot.duration);
      const passesStrict = modelSpec.durations.length === 0
        || modelSpec.durations.includes(shot.duration);
      if (!passesLenient || !passesStrict) {
        violations.push({
          shotNumber: shotNum,
          duration: shot.duration,
          durationSec: requestedSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
      }
    }
  }

  if (violations.length === 0) return;
  const lines = violations.map(v =>
    `  shot ${v.shotNumber}: duration "${v.duration}" (${v.durationSec}s) exceeds model "${v.model}" ceiling ${v.maxSec}s (allowed: ${v.allowed.join(', ') || '<none>'})`,
  );
  throw new Error(
    `Shot duration preflight failed for ${violations.length} shot(s):\n${lines.join('\n')}\n` +
    `Edit script.json and re-run, or update the model registry in src/venice/models.ts if the ceiling has changed.`,
  );
}

export async function generateEpisodeVideos(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  sceneDir: string,
  plan: GenerationPlan,
  episodeAudioMix?: import('../series/types.js').AudioMixDefaults,
): Promise<GenerateEpisodeVideosResult> {
  // Fail fast on duration / model mismatches before any Venice queue call.
  assertShotDurationsValid(shots, plan);

  const videoPaths: string[] = [];
  // Suffixed inserts ("13b") share their base shotNumber, so a Map keyed by
  // shotNumber collapses "13" and "13b" onto one entry and the base shot is
  // silently skipped as "video exists" (the insert's video). The plan is
  // built from `shots` in order with each shot in exactly one unit, so we
  // resolve unit shots with a sequential cursor instead; the Map remains
  // only as a fallback for hand-edited plans.
  const shotsByNumber = new Map(shots.map(shot => [shot.shotNumber, shot]));
  let shotCursor = 0;
  let previousRenderedShotPath: string | undefined;
  let previousShot: ShotScript | undefined;

  for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
    const unit = plan.units[unitIndex];
    const unitShots = unit.shotNumbers
      .map(shotNumber => {
        const candidate = shots[shotCursor];
        if (candidate && candidate.shotNumber === shotNumber) {
          shotCursor += 1;
          return candidate;
        }
        return shotsByNumber.get(shotNumber);
      })
      .filter((shot): shot is ShotScript => Boolean(shot));
    const nextUnit = plan.units[unitIndex + 1];
    const nextShotNumber = nextUnit?.shotNumbers[0];

    if (unitShots.length === 0) continue;

    // Feeds the shell's `/jobs` view, so a backgrounded episode render reports
    // "unit 3/12 shot 5" instead of only whatever the current poll is doing.
    reportProgress({
      phase: 'render',
      current: unitIndex + 1,
      total: plan.units.length,
      detail: `unit ${unitIndex + 1}/${plan.units.length} · shot ${unitShots[0].shotNumber}`,
    });

    try {
      const savedPaths = unit.unitType === 'single'
        ? await renderSingleShotUnit(
          client,
          series,
          unitShots[0],
          unit,
          sceneDir,
          previousRenderedShotPath,
          nextShotNumber,
          previousShot,
          episodeAudioMix,
        )
        : unit.unitType === 'montage'
          ? await renderMontageUnit(
            client,
            series,
            unitShots,
            unit,
            sceneDir,
          )
          : await renderMultiShotUnitUntilSuccess(
            client,
            series,
            unitShots,
            unit,
            sceneDir,
            previousRenderedShotPath,
            nextShotNumber,
          );

      if (savedPaths.length > 0) {
        videoPaths.push(...savedPaths);
        previousRenderedShotPath = savedPaths[savedPaths.length - 1];
      }
      previousShot = unitShots[unitShots.length - 1];
      console.log('');
    } catch (err) {
      throw err;
    }
  }

  return { videoPaths, plan };
}
