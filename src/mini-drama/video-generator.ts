import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  MODELS_USING_IMAGE_TAGS,
  isSeedanceVideoModel,
} from '../series/types.js';
import { getCharacterDir } from '../series/manager.js';
import {
  buildKlingMultiShotPrompt,
  buildVideoPrompt,
  type MiniDramaVideoPrompt,
} from './prompt-builder.js';
import { parseShotDuration } from './generation-planner.js';
import { ensureSeedanceCompatibility } from '../venice/seedance-preflight.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';
const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';
const VIDEO_COMPLETE_PATH = '/api/v1/video/complete';
const POLL_INTERVAL_MS = 10_000;
const MULTISHOT_RETRY_DELAY_MS = 15_000;

interface QueueResponse {
  model: string;
  queue_id: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function extractLastFrame(videoPath: string, outputPath: string): void {
  const durationStr = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf-8' },
  ).trim();
  const duration = parseFloat(durationStr);
  const seekTo = Math.max(0, duration - 0.05);

  execSync(
    `ffmpeg -y -ss ${seekTo} -i "${videoPath}" -frames:v 1 "${outputPath}"`,
    { stdio: 'pipe' },
  );
}

function imageToDataUri(imagePath: string, mimeType = 'image/png'): string {
  const buffer = readFileSync(imagePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function getVideoDuration(path: string): number {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`,
    { encoding: 'utf-8' },
  ).trim();
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

interface RenderVideoOptions {
  prompt: MiniDramaVideoPrompt;
  anchorImagePath: string;
  outputPath: string;
  endFrameImagePath?: string;
  elements?: VideoElement[];
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  negativePrompt?: string;
  audioUrl?: string;
  videoUrl?: string;
  aspectRatio?: string;
  /** Seedance compatibility strategy when images aren't seedream-originated. */
  seedanceCompatibility?: 'prompt' | 'fallback' | 'launder';
}

function fileToDataUri(filePath: string, mimeType = 'image/png'): string | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  const buffer = readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function renderVideoFile(
  client: VeniceClient,
  options: RenderVideoOptions,
): Promise<string> {
  const { prompt, anchorImagePath, outputPath, endFrameImagePath,
    elements, referenceImagePaths, sceneImagePaths,
    negativePrompt, audioUrl, videoUrl } = options;
  await mkdir(dirname(outputPath), { recursive: true });

  // ── Seedance 2.0 pre-flight ─────────────────────────────────────────────
  // Seedance blocks requests whose input images were not produced by
  // seedream-v5-lite / seedream-v5-lite-edit. We check provenance against
  // every file path being sent before the body is built — if the user has
  // pre-existing (e.g. nano-banana-generated) assets, we either reroute
  // the shot or launder the images through seedream-v5-lite-edit.
  let effectiveModel = prompt.model;
  if (isSeedanceVideoModel(prompt.model)) {
    const elementsFrontalPaths = (elements ?? [])
      .map(el => el.frontalImageUrl)
      .filter((p): p is string => typeof p === 'string' && !p.startsWith('data:'));
    const elementsReferencePaths = (elements ?? [])
      .flatMap(el => el.referenceImageUrls ?? [])
      .filter(p => !p.startsWith('data:'));

    const action = await ensureSeedanceCompatibility(client, prompt.model, {
      imageUrl: anchorImagePath,
      endImageUrl: endFrameImagePath,
      referenceImagePaths: referenceImagePaths?.filter(p => !p.startsWith('data:')),
      sceneImagePaths: sceneImagePaths?.filter(p => !p.startsWith('data:')),
      elementsFrontalPaths,
      elementsReferencePaths,
    }, { mode: options.seedanceCompatibility });

    if (action.type === 'fallback') {
      console.warn(`  ${action.reason}`);
      effectiveModel = action.newModel;
    } else if (action.type === 'laundered') {
      console.log(`  Laundered ${action.lauderedPaths.length} image(s); proceeding with ${prompt.model}.`);
    }
  }

  const body: Record<string, unknown> = {
    model: effectiveModel,
    prompt: prompt.prompt,
    duration: prompt.duration,
    image_url: imageToDataUri(anchorImagePath),
    audio: prompt.audio,
  };

  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }

  if (endFrameImagePath && existsSync(endFrameImagePath) && MODELS_SUPPORTING_END_IMAGE.has(effectiveModel)) {
    body.end_image_url = imageToDataUri(endFrameImagePath);
  }

  if (effectiveModel.includes('seedance')) {
    body.resolution = '720p';
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

  if (effectiveModel.includes('reference-to-video') || effectiveModel.includes('seedance')) {
    body.aspect_ratio = options.aspectRatio ?? '16:9';
  }

  if (audioUrl && MODELS_SUPPORTING_AUDIO_INPUT.has(effectiveModel)) {
    body.audio_url = audioUrl;
  }

  if (videoUrl) {
    body.video_url = videoUrl;
  }

  if (elements && elements.length > 0 && MODELS_SUPPORTING_ELEMENTS.has(effectiveModel)) {
    const apiElements = elements.map(el => {
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
      return out;
    });
    body.elements = apiElements;
    console.log(`  Elements: ${apiElements.length} character/object reference(s)`);
  }

  if (referenceImagePaths && referenceImagePaths.length > 0
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(effectiveModel)) {
    body.reference_image_urls = referenceImagePaths
      .slice(0, 4)
      .map(p => p.startsWith('data:') ? p : (fileToDataUri(p) ?? p))
      .filter(Boolean);
    console.log(`  Reference images: ${(body.reference_image_urls as string[]).length}`);
  }

  if (sceneImagePaths && sceneImagePaths.length > 0
    && MODELS_SUPPORTING_SCENE_IMAGES.has(effectiveModel)) {
    body.scene_image_urls = sceneImagePaths
      .slice(0, 4)
      .map(p => p.startsWith('data:') ? p : (fileToDataUri(p) ?? p))
      .filter(Boolean);
    console.log(`  Scene images: ${(body.scene_image_urls as string[]).length}`);
  }

  if (options.aspectRatio && body.aspect_ratio && body.aspect_ratio !== options.aspectRatio) {
    console.warn(`  ⚠ Aspect ratio mismatch: sending ${body.aspect_ratio} but series expects ${options.aspectRatio}`);
  }

  if (prompt.characterElements && prompt.characterElements.length > 0
    && !effectiveModel.includes('reference-to-video')) {
    console.warn(`  ⚠ Shot has characters but model ${effectiveModel} is NOT R2V — character identity may drift`);
  }

  console.log(`  Queueing video: model=${effectiveModel}, duration=${prompt.duration}, aspect=${body.aspect_ratio ?? 'default'}, prompt=${(prompt.prompt).length} chars`);

  let queueResponse: QueueResponse;
  try {
    queueResponse = await client.post<QueueResponse>(VIDEO_QUEUE_PATH, body);
  } catch (err) {
    if (err instanceof VeniceRequestError) {
      console.error(`  Venice queue error (HTTP ${err.status}): ${err.message}`);
      console.error(`  Error body: ${JSON.stringify(err.body, null, 2)}`);
    }
    await logFailedRequest(outputPath, body, err);
    throw err;
  }

  const { queue_id, model } = queueResponse;
  console.log(`  Queue ID: ${queue_id}`);

  let elapsed = 0;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    try {
      const response = await fetch(`https://api.venice.ai/api/v1/video/retrieve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        },
        body: JSON.stringify({ model, queue_id }),
      });

      if (response.headers.get('content-type')?.includes('video/mp4')) {
        const videoBuffer = Buffer.from(await response.arrayBuffer());

        archiveExisting(outputPath);

        await writeFile(outputPath, videoBuffer);
        console.log(`  Video saved: ${outputPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB, ${(elapsed / 1000).toFixed(0)}s)`);

        try {
          await client.post(VIDEO_COMPLETE_PATH, { model, queue_id });
        } catch { /* cleanup is optional */ }

        return outputPath;
      }

      const status = (await response.json()) as { status: string; execution_duration?: number };
      const pct = status.execution_duration
        ? `${(status.execution_duration / 1000).toFixed(0)}s elapsed`
        : '';
      process.stdout.write(`\r  Polling... ${status.status} ${pct}   `);
    } catch (err) {
      console.warn(`  Poll error (will retry): ${err}`);
    }
  }
}

function resolveCharacterElements(
  series: SeriesState,
  shot: ShotScript,
  prompt: MiniDramaVideoPrompt,
): { elements?: VideoElement[]; referenceImagePaths?: string[] } {
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
    const paths = resolvedChars
      .slice(0, 4)
      .flatMap(c => {
        const dir = charDirFn(c.name);
        return ['front.png', 'three-quarter.png']
          .map(f => join(dir, f))
          .filter(p => existsSync(p));
      })
      .slice(0, 4);
    return { referenceImagePaths: paths.length > 0 ? paths : undefined };
  }

  return {};
}

function getShotPanelPath(sceneDir: string, shotNumber: number): string {
  return join(sceneDir, `shot-${String(shotNumber).padStart(3, '0')}.png`);
}

function getShotVideoPath(sceneDir: string, shotNumber: number): string {
  return join(sceneDir, `shot-${String(shotNumber).padStart(3, '0')}.mp4`);
}

function chooseAnchorImagePath(
  unit: GenerationUnit,
  sceneDir: string,
  unitOutputPath: string,
  previousRenderedShotPath?: string,
): string {
  const firstShotNumber = unit.shotNumbers[0];
  const panelPath = getShotPanelPath(sceneDir, firstShotNumber);

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
    execSync(
      `ffmpeg -y -ss ${offset} -i "${unitOutputPath}" -t ${durationSec} ` +
      `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -b:a 192k "${outputPath}"`,
      { stdio: 'pipe' },
    );

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
): Promise<string[]> {
  const panelPath = getShotPanelPath(sceneDir, shot.shotNumber);
  if (!existsSync(panelPath)) {
    console.warn(`  Panel not found: ${panelPath}, skipping shot ${shot.shotNumber}`);
    return [];
  }

  const videoPath = getShotVideoPath(sceneDir, shot.shotNumber);
  if (existsSync(videoPath)) {
    console.log(`  Shot ${String(shot.shotNumber).padStart(3, '0')}: video exists, skipping`);
    unit.renderedDurationSec = getVideoDuration(videoPath);
    unit.segments = [{
      shotNumber: shot.shotNumber,
      startOffsetSec: 0,
      durationSec: unit.renderedDurationSec,
      outputFile: `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`,
    }];
    return [videoPath];
  }

  const videoPrompt = buildVideoPrompt(shot, series, previousShot);
  unit.model = videoPrompt.model;

  if (videoPrompt.modelResolution) {
    const res = videoPrompt.modelResolution;
    console.log(`  Model: ${res.modelId}${res.upgraded ? ` (upgraded: ${res.reason})` : ''}`);
    if (res.autoUseElements) console.log('  Auto-enabled: elements (character identity anchoring)');
    if (res.autoUseReferenceImages) console.log('  Auto-enabled: reference images');
  }

  const anchorImagePath = chooseAnchorImagePath(unit, sceneDir, videoPath, previousRenderedShotPath);
  const endFramePath = chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  const { elements, referenceImagePaths } = resolveCharacterElements(series, shot, videoPrompt);
  const sceneImagePaths = shot.sceneImagePaths?.filter(p => existsSync(p));

  const savedPath = await renderVideoFile(client, {
    prompt: videoPrompt,
    anchorImagePath,
    outputPath: videoPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    sceneImagePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
  });

  const durationSec = getVideoDuration(savedPath);
  unit.renderedDurationSec = durationSec;
  unit.segments = [{
    shotNumber: shot.shotNumber,
    startOffsetSec: 0,
    durationSec,
    outputFile: `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`,
  }];

  await saveSingleShotMetadata(series, shot, savedPath, videoPrompt, {
    generationUnit: unit.unitId,
  });
  return [savedPath];
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

  const firstPanelPath = getShotPanelPath(sceneDir, shots[0].shotNumber);
  if (!existsSync(firstPanelPath)) {
    console.warn(`  Panel not found: ${firstPanelPath}, skipping unit ${unit.unitId}`);
    return [];
  }

  const unitOutputPath = join(sceneDir, unit.outputFile);
  const prompt = buildKlingMultiShotPrompt(shots, unit, series);
  const anchorImagePath = chooseAnchorImagePath(unit, sceneDir, unitOutputPath, previousRenderedShotPath);
  const endFramePath = chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  // Resolve elements and references for multi-shot — same identity anchoring as single shots
  const allCharNames = Array.from(new Set(shots.flatMap(s => s.characters)));
  const resolvedChars = allCharNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;

  const charDirFn2 = (name: string) => getCharacterDir(series, name);

  let elements: VideoElement[] | undefined;
  let referenceImagePaths: string[] | undefined;

  if (prompt.characterElements && prompt.characterElements.length > 0
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

  const savedUnitPath = await renderVideoFile(client, {
    prompt,
    anchorImagePath,
    outputPath: unitOutputPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
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

export async function generateEpisodeVideos(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  sceneDir: string,
  plan: GenerationPlan,
): Promise<GenerateEpisodeVideosResult> {
  const videoPaths: string[] = [];
  const shotsByNumber = new Map(shots.map(shot => [shot.shotNumber, shot]));
  let previousRenderedShotPath: string | undefined;
  let previousShot: ShotScript | undefined;

  for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
    const unit = plan.units[unitIndex];
    const unitShots = unit.shotNumbers
      .map(shotNumber => shotsByNumber.get(shotNumber))
      .filter((shot): shot is ShotScript => Boolean(shot));
    const nextUnit = plan.units[unitIndex + 1];
    const nextShotNumber = nextUnit?.shotNumbers[0];

    if (unitShots.length === 0) continue;

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
