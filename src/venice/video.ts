// ---------------------------------------------------------------------------
// Venice Video API -- queue, retrieve, quote, complete
//
// Async workflow: queue a job, poll for completion, download the MP4.
// ---------------------------------------------------------------------------

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import type { VeniceClient } from './client.js';
import { VeniceRequestError } from './client.js';
import { clearPendingJob, findPendingJob, recordPendingJob, touchPendingJob } from './job-store.js';
import { abortableSleep, reportProgress, throwIfAborted } from './operation-context.js';
import type {
  VideoQueueRequest,
  VideoQueueResponse,
  VideoRetrieveStatus,
  VideoQuoteRequest,
  VideoQuoteResponse,
} from './types.js';
import { getVideoModel, buildModelParams, resolveBitrateMode, type BitrateMode } from './models.js';
import { MODELS_SUPPORTING_REFERENCE_AUDIO } from '../series/types.js';
import { assertNotSilentRejectVideo } from './rejection.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';
const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';
const VIDEO_COMPLETE_PATH = '/api/v1/video/complete';
const VIDEO_QUOTE_PATH = '/api/v1/video/quote';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 180;

/**
 * True when Venice no longer recognises a queue id -- the job finished and was
 * reaped, or it never existed. A resumed job that hits this is unrecoverable, so
 * the caller drops the stale record and queues fresh.
 */
function isQueueGoneError(error: unknown): boolean {
  return error instanceof VeniceRequestError
    && (error.status === 400 || error.status === 404 || error.status === 410);
}

// ---- Quote ----------------------------------------------------------------

/**
 * Get a price estimate for a video generation before committing.
 */
export async function quoteVideo(
  client: VeniceClient,
  request: VideoQuoteRequest,
): Promise<VideoQuoteResponse> {
  return client.post<VideoQuoteResponse>(VIDEO_QUOTE_PATH, request as unknown as Record<string, unknown>);
}

// ---- Queue ----------------------------------------------------------------

export interface QueueVideoOptions {
  model: string;
  prompt: string;
  duration: string;
  imageUrl?: string;
  endImageUrl?: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  audioUrl?: string;
  videoUrl?: string;
  referenceImageUrls?: string[];
  elements?: Array<{
    frontal_image_url?: string;
    reference_image_urls?: string[];
    video_url?: string;
  }>;
  sceneImageUrls?: string[];
  /**
   * Voice-donor reference clips (data URLs or HTTP URLs), bound in-prompt as
   * @Audio1, @Audio2, …. Only sent to reference-audio-capable models and only
   * when at least one reference image is present (Venice rejects audio-only).
   */
  referenceAudioUrls?: string[];
  /**
   * Output encoding bitrate mode. Only sent to models that accept it (Seedance
   * 2.x). When omitted, Seedance 2.5 defaults to `'high'` — a large fidelity
   * gain at no extra cost. Pass `'standard'` to opt back into smaller files.
   */
  bitrateMode?: BitrateMode;
}

/**
 * Queue a video generation job. Returns the queue_id for polling.
 *
 * Automatically applies model-specific parameter constraints:
 * - Skips resolution/aspect_ratio when not supported
 * - Skips end_image_url when not supported
 * - Validates duration against model capabilities
 */
export async function queueVideo(
  client: VeniceClient,
  options: QueueVideoOptions,
): Promise<VideoQueueResponse> {
  const modelSpec = getVideoModel(options.model);

  let duration = options.duration;
  if (modelSpec && modelSpec.durations.length > 0 && !modelSpec.durations.includes(duration)) {
    const requested = parseInt(duration, 10);
    const valid = modelSpec.durations.map(d => parseInt(d, 10)).sort((a, b) => a - b);
    const closest = valid.reduce((prev, curr) =>
      Math.abs(curr - requested) < Math.abs(prev - requested) ? curr : prev,
    );
    console.warn(`  Duration ${duration} not supported by ${options.model} (valid: ${modelSpec.durations.join(', ')}). Snapping to ${closest}s.`);
    duration = `${closest}s`;
  }

  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    duration,
    audio: options.audio ?? true,
  };

  if (options.imageUrl) body.image_url = options.imageUrl;
  if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
  if (options.audioUrl) body.audio_url = options.audioUrl;
  if (options.videoUrl) body.video_url = options.videoUrl;

  // R2V models require aspect_ratio — warn if not explicitly set
  if (modelSpec?.id.includes('reference-to-video') && !options.aspectRatio) {
    console.warn(`  ⚠ No aspect_ratio provided for R2V model ${options.model} — defaulting to 16:9. Set explicitly to avoid wrong orientation.`);
  }

  const modelParams = buildModelParams(options.model, {
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    endImageUrl: options.endImageUrl,
  });
  Object.assign(body, modelParams);

  // bitrate_mode: Seedance 2.5 defaults to 'high' (sharper encode, no price
  // change); other models don't accept the field, so it's omitted for them.
  const bitrateMode = resolveBitrateMode(options.model, options.bitrateMode);
  if (bitrateMode) body.bitrate_mode = bitrateMode;

  if (options.elements && options.elements.length > 0) {
    if (!modelSpec || modelSpec.supportsElements) {
      body.elements = options.elements;
    }
  }

  if (options.referenceImageUrls && options.referenceImageUrls.length > 0) {
    if (!modelSpec || modelSpec.supportsReferenceImages) {
      body.reference_image_urls = options.referenceImageUrls;
    }
  }

  if (options.sceneImageUrls && options.sceneImageUrls.length > 0) {
    if (!modelSpec || modelSpec.supportsSceneImages) {
      body.scene_image_urls = options.sceneImageUrls;
    }
  }

  // Voice-donor reference audio (@Audio1, @Audio2, …). Gated on model support
  // AND on the presence of at least one reference image — Venice rejects
  // audio-only reference_audio_urls at validation.
  if (options.referenceAudioUrls && options.referenceAudioUrls.length > 0) {
    const supportsRefAudio = modelSpec
      ? modelSpec.supportsReferenceAudio === true
      : MODELS_SUPPORTING_REFERENCE_AUDIO.has(options.model);
    const hasReferenceImage = Array.isArray(body.reference_image_urls)
      && (body.reference_image_urls as string[]).length > 0;
    if (supportsRefAudio && hasReferenceImage) {
      // Enforce the aggregate ≤3-clip budget defensively.
      body.reference_audio_urls = options.referenceAudioUrls.slice(0, 3);
    } else if (supportsRefAudio && !hasReferenceImage) {
      console.warn(`  ⚠ Dropping reference_audio_urls for ${options.model}: no reference image present (Venice rejects audio-only reference audio).`);
    } else {
      console.warn(`  ⚠ Model ${options.model} does not support reference_audio_urls; dropping.`);
    }
  }

  return client.post<VideoQueueResponse>(VIDEO_QUEUE_PATH, body);
}

// ---- Retrieve / Poll ------------------------------------------------------

export interface PollVideoOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onProgress?: (status: VideoRetrieveStatus) => void;
  /** Prompt text passed to VeniceRejectionError for context. */
  prompt?: string;
  /** Override the default silent-reject byte threshold for this poll. */
  silentRejectThreshold?: number;
  /** Skip the silent-reject check (e.g. for low-resolution or short clips). */
  skipSilentRejectCheck?: boolean;
  /**
   * Output path this poll is feeding. Supplying it keeps the pending-job
   * heartbeat fresh so `venice-video queue` can distinguish a live poll from an
   * abandoned one.
   */
  heartbeatPath?: string;
}

/**
 * Poll for a video generation result until the MP4 is ready.
 * Returns the raw video buffer.
 */
export async function pollVideoResult(
  client: VeniceClient,
  model: string,
  queueId: string,
  options: PollVideoOptions = {},
): Promise<Buffer> {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    onProgress,
    prompt,
    silentRejectThreshold,
    skipSilentRejectCheck,
    heartbeatPath,
  } = options;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    throwIfAborted();
    if (attempt > 0) await abortableSleep(pollIntervalMs);

    const response = await client.postBinaryOrJson<VideoRetrieveStatus>(
      VIDEO_RETRIEVE_PATH,
      { model, queue_id: queueId },
    );

    if (Buffer.isBuffer(response.value)) {
      if (!skipSilentRejectCheck) {
        assertNotSilentRejectVideo(response.value, {
          model,
          prompt,
          threshold: silentRejectThreshold,
        });
      }
      return response.value;
    }

    const status = response.value as VideoRetrieveStatus;
    if (heartbeatPath) await touchPendingJob(heartbeatPath);
    if (status.status === 'PROCESSING') {
      reportProgress({
        phase: 'poll',
        detail: `${status.status} ${Math.round((attempt * pollIntervalMs) / 1000)}s`,
      });
      onProgress?.(status);
    }
  }

  throw new Error(`Timed out waiting for video generation: ${model} (${queueId})`);
}

// ---- Complete -------------------------------------------------------------

/**
 * Signal completion after downloading. Cleans up server-side storage.
 */
export async function completeVideo(
  client: VeniceClient,
  model: string,
  queueId: string,
): Promise<void> {
  try {
    await client.post(VIDEO_COMPLETE_PATH, { model, queue_id: queueId });
  } catch {
    // Cleanup is optional -- don't fail the pipeline
  }
}

// ---- High-level: generate and save ----------------------------------------

export interface GenerateVideoOptions extends QueueVideoOptions {
  outputPath: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onProgress?: (status: VideoRetrieveStatus) => void;
  /** Project directory, recorded on the pending job for `venice-video queue`. */
  project?: string;
  episode?: number;
  /** Ignore any recorded in-flight job and queue a fresh generation. */
  forceRequeue?: boolean;
}

/**
 * Queue, poll, download, and save a video in one call.
 * Returns the saved file path and the raw buffer size.
 *
 * The queue id is persisted before the first poll, so a generation interrupted
 * mid-flight is re-attached on the next run rather than paid for twice.
 */
export async function generateVideo(
  client: VeniceClient,
  options: GenerateVideoOptions,
): Promise<{ path: string; sizeBytes: number; queueId: string; resumed: boolean }> {
  const {
    outputPath,
    pollIntervalMs,
    maxPollAttempts,
    onProgress,
    project,
    episode,
    forceRequeue,
    ...queueOpts
  } = options;

  await mkdir(dirname(outputPath), { recursive: true });
  const jobKey = resolvePath(outputPath);

  const existing = forceRequeue ? undefined : await findPendingJob(jobKey);
  let queueId: string;
  let model: string;
  let resumed = false;

  if (existing && existing.kind === 'video') {
    console.log(`  Re-attaching to in-flight job ${existing.queueId} (${existing.model}) — not re-queueing.`);
    queueId = existing.queueId;
    model = existing.model;
    resumed = true;
  } else {
    ({ queue_id: queueId, model } = await queueVideo(client, queueOpts));
    await recordPendingJob({
      kind: 'video',
      model,
      queueId,
      outputPath: jobKey,
      project,
      episode,
      prompt: options.prompt,
    });
  }

  let videoBuffer: Buffer;
  try {
    videoBuffer = await pollVideoResult(client, model, queueId, {
      pollIntervalMs,
      maxPollAttempts,
      onProgress,
      prompt: options.prompt,
      heartbeatPath: jobKey,
    });
  } catch (err) {
    // A resumed id Venice has already reaped is a dead end; drop the stale
    // record and generate fresh rather than failing the whole episode.
    if (resumed && isQueueGoneError(err)) {
      console.warn(`  ⚠ Recorded job ${queueId} is gone on Venice's side; queueing a fresh generation.`);
      await clearPendingJob(jobKey);
      return generateVideo(client, { ...options, forceRequeue: true });
    }
    throw err;
  }

  await writeFile(outputPath, videoBuffer);
  await clearPendingJob(jobKey);
  await completeVideo(client, model, queueId);

  return { path: outputPath, sizeBytes: videoBuffer.length, queueId, resumed };
}
