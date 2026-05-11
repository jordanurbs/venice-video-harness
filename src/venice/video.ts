// ---------------------------------------------------------------------------
// Venice Video API -- queue, retrieve, quote, complete
//
// Async workflow: queue a job, poll for completion, download the MP4.
// ---------------------------------------------------------------------------

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VeniceClient } from './client.js';
import type {
  VideoQueueRequest,
  VideoQueueResponse,
  VideoRetrieveStatus,
  VideoQuoteRequest,
  VideoQuoteResponse,
} from './types.js';
import { getVideoModel, buildModelParams } from './models.js';
import { assertNotSilentRejectVideo } from './rejection.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';
const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';
const VIDEO_COMPLETE_PATH = '/api/v1/video/complete';
const VIDEO_QUOTE_PATH = '/api/v1/video/quote';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 180;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
  } = options;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (attempt > 0) await sleep(pollIntervalMs);

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
    if (status.status === 'PROCESSING' && onProgress) {
      onProgress(status);
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
}

/**
 * Queue, poll, download, and save a video in one call.
 * Returns the saved file path and the raw buffer size.
 */
export async function generateVideo(
  client: VeniceClient,
  options: GenerateVideoOptions,
): Promise<{ path: string; sizeBytes: number; queueId: string }> {
  const { outputPath, pollIntervalMs, maxPollAttempts, onProgress, ...queueOpts } = options;

  await mkdir(dirname(outputPath), { recursive: true });

  const { queue_id, model } = await queueVideo(client, queueOpts);

  const videoBuffer = await pollVideoResult(client, model, queue_id, {
    pollIntervalMs,
    maxPollAttempts,
    onProgress,
    prompt: options.prompt,
  });

  await writeFile(outputPath, videoBuffer);
  await completeVideo(client, model, queue_id);

  return { path: outputPath, sizeBytes: videoBuffer.length, queueId: queue_id };
}
