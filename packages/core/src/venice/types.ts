// ---------------------------------------------------------------------------
// Venice AI API -- TypeScript type definitions
//
// Covers image/generate, image/multi-edit, image/edit, image/upscale,
// image/background-remove, video/queue, video/retrieve, video/quote,
// audio/speech, audio/queue, and character references.
// ---------------------------------------------------------------------------

// ---- Shared primitives ----------------------------------------------------

/** Supported init-image modes for img2img generation. */
export type InitImageMode = "IMAGE_STRENGTH" | "STEP_SCHEDULE";

// ---- POST /api/v1/image/generate -----------------------------------------

/** Request body for the image generation endpoint. */
export interface ImageGenerateRequest {
  model: string;
  prompt: string;
  negative_prompt?: string;
  resolution?: string;
  aspect_ratio?: string;
  /** @deprecated Use resolution + aspect_ratio instead. */
  width?: number;
  /** @deprecated Use resolution + aspect_ratio instead. */
  height?: number;
  steps?: number;
  cfg_scale?: number;
  seed?: number;
  safe_mode?: boolean;
  return_binary?: boolean;
  hide_watermark?: boolean;
  fidelity?: number;
  image?: string;
  init_image_mode?: InitImageMode;
  format?: 'jpeg' | 'png' | 'webp';
  variants?: number;
  style_preset?: string;
  lora_strength?: number;
  embed_exif_metadata?: boolean;
  enable_web_search?: boolean;
}

/** A single generated image entry returned by the API. */
export interface GeneratedImage {
  b64_json: string;
  seed?: number;
}

/** Response body from the image generation endpoint (JSON mode). */
export interface ImageGenerateResponse {
  id?: string;
  images: GeneratedImage[];
  timing?: {
    inferenceDuration: number;
    inferencePreprocessingTime: number;
    inferenceQueueTime: number;
    total: number;
  };
}

// ---- POST /api/v1/images/edit (DEPRECATED) --------------------------------

/**
 * @deprecated Inpainting via /images/edit was disabled May 19, 2025.
 * Use multi-edit (/image/multi-edit) instead.
 */
export interface ImageEditRequest {
  image: string;
  mask?: string;
  prompt: string;
  strength?: number;
  model?: string;
  steps?: number;
  cfg_scale?: number;
  seed?: number;
  safe_mode?: boolean;
}

/** @deprecated */
export interface ImageEditResponse {
  images: GeneratedImage[];
}

// ---- POST /api/v1/image/multi-edit ----------------------------------------

export type MultiEditModel =
  | 'qwen-edit'
  | 'qwen-image-2-edit'
  | 'qwen-image-2-pro-edit'
  | 'flux-2-max-edit'
  | 'gpt-image-1-5-edit'
  | 'gpt-image-2-edit'
  | 'grok-imagine-edit'
  | 'nano-banana-2-edit'
  | 'nano-banana-pro-edit'
  | 'seedream-v4-edit'
  | 'seedream-v5-lite-edit';

export interface MultiEditRequest {
  modelId: MultiEditModel;
  prompt: string;
  /**
   * 1-3 images: first is base image, rest are reference layers.
   * Each can be a raw base64 string, data URL, or HTTP URL.
   */
  images: string[];
}

// ---- POST /api/v1/image/upscale -------------------------------------------

export interface ImageUpscaleRequest {
  model?: string;
  image: string;
  scale?: number;
}

// ---- POST /api/v1/image/background-remove ---------------------------------

export interface BackgroundRemoveRequest {
  model?: string;
  image: string;
}

// ---- POST /api/v1/video/queue ---------------------------------------------

export interface VideoElement {
  frontal_image_url?: string;
  reference_image_urls?: string[];
  video_url?: string;
}

/**
 * One camera keyframe for `camera_trajectory` (MiniMax H3 Max Multi-Angle).
 *
 * The model orbits the subject in the start frame (`image_url`) along the path
 * described by 2–12 keyframes. This is Venice's real shape for the feature the
 * request framed as "horizontal/vertical angle degrees and camera distance for
 * the start and finish frame": the 2-keyframe case (`time: 0` and `time: 1`) is
 * exactly a start→finish move; `azimuth` is the horizontal angle and
 * `elevation` the vertical angle. Extra keyframes let the rotation speed-ramp
 * within a single shot (uneven angular velocity over even time).
 *
 * Confirmed against the live strict queue schema (2026-09-15):
 *   POST /video/queue with a bad field name → "Unrecognized key(s) in object";
 *   camera_trajectory with azimuth 99999 → "Camera azimuth travel must not
 *   exceed 32 full turns". Source: GET /api/v1/swagger.yaml camera_trajectory.
 */
export interface CameraKeyframe {
  /** Normalized position along the clip, 0–1. Strictly increasing across the array. */
  time: number;
  /** Horizontal orbit angle in degrees (signed). Total absolute travel ≤ 32 full turns (11520°). */
  azimuth: number;
  /** Vertical orbit angle in degrees, −90 to 90. */
  elevation: number;
  /** Camera distance relative to the start frame; must be > 0. 1 = unchanged, <1 dollies in, >1 out. */
  distance: number;
}

export interface VideoQueueRequest {
  model: string;
  prompt: string;
  duration: string;
  image_url?: string;
  end_image_url?: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  resolution?: string;
  audio?: boolean;
  audio_url?: string;
  video_url?: string;
  reference_image_urls?: string[];
  elements?: VideoElement[];
  scene_image_urls?: string[];
  /**
   * Voice-donor reference clips (up to 3, 2-15s each, ≤15s aggregate,
   * wav/mp3, ≤15MB per file) bound in-prompt as @Audio1, @Audio2, … so a
   * character's voice stays consistent across shots. Only accepted by the
   * Seedance 2.0 R2V family and HappyHorse 1.1 R2V, and only alongside at
   * least one reference image (audio-only is rejected at validation).
   */
  reference_audio_urls?: string[];
  /**
   * Camera-orbit keyframes for MiniMax H3 Max Multi-Angle
   * (`minimax-h3-max-multi-angle`). 2–12 keyframes with strictly increasing
   * normalized `time` (0–1). Requires `image_url`; aspect ratio follows that
   * image. Omit to leave the camera path to the model. Rejected by every other
   * model ("Unrecognized key(s) in object: 'camera_trajectory'").
   */
  camera_trajectory?: CameraKeyframe[];
  /**
   * Output encoding bitrate mode (Seedance 2.x). `'high'` encodes at ~5-6x the
   * bitrate for sharper output and far fewer compression artifacts (larger
   * files); `'standard'` is the Venice default. Does not affect token price.
   * The harness attaches `'high'` to Seedance 2.5 renders by default.
   */
  bitrate_mode?: 'standard' | 'high';
}

export interface VideoQueueResponse {
  model: string;
  queue_id: string;
}

// ---- POST /api/v1/video/retrieve ------------------------------------------

export interface VideoRetrieveRequest {
  model: string;
  queue_id: string;
  delete_media_on_completion?: boolean;
}

export interface VideoRetrieveStatus {
  /**
   * `PROCESSING` while the job runs. The published spec lists only
   * `PROCESSING` and `COMPLETED` for the JSON body (a finished job normally
   * comes back as `video/mp4` bytes instead), but `FAILED` is observed in
   * practice when generation dies server-side. Treat anything that is not
   * `PROCESSING` as terminal -- see `classifyVideoRetrieveStatus`.
   */
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | (string & {});
  average_execution_time: number;
  execution_duration: number;
  /** Present on some failure bodies. */
  error?: string | { message?: string; code?: string };
  message?: string;
}

// ---- POST /api/v1/video/quote ---------------------------------------------

export interface VideoQuoteRequest {
  model: string;
  duration: string;
  aspect_ratio?: string | null;
  resolution?: string;
  audio?: boolean | null;
}

export interface VideoQuoteResponse {
  quote: number;
}

// ---- POST /api/v1/video/complete ------------------------------------------

export interface VideoCompleteRequest {
  model: string;
  queue_id: string;
}

// ---- POST /api/v1/audio/speech --------------------------------------------

export interface SpeechRequest {
  input: string;
  model?: string;
  voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  streaming?: boolean;
  /** Qwen3 TTS only: style prompt for emotion/delivery control. */
  prompt?: string;
  /** Qwen3 TTS only: language selection. */
  language?: string;
  /** Qwen3 TTS only: sampling temperature (0-2). */
  temperature?: number;
  /** Qwen3 TTS only: nucleus sampling (0-1). */
  top_p?: number;
}

// ---- POST /api/v1/audio/queue ---------------------------------------------

export interface AudioQueueRequest {
  model: string;
  prompt: string;
  lyrics_prompt?: string;
  duration_seconds?: number | string;
  force_instrumental?: boolean;
  voice?: string;
  language_code?: string;
  speed?: number;
}

export interface AudioQueueResponse {
  model: string;
  queue_id: string;
  status: 'QUEUED';
}

// ---- POST /api/v1/audio/retrieve ------------------------------------------

export interface AudioRetrieveRequest {
  model: string;
  queue_id: string;
  delete_media_on_completion?: boolean;
}

export interface AudioRetrieveStatus {
  status: 'PROCESSING';
  average_execution_time: number;
  execution_duration: number;
}

// ---- Character reference helpers ------------------------------------------

export interface CharacterReference {
  name: string;
  role: string;
  base64Image: string;
}

// ---- Reference-augmented generation ---------------------------------------

export interface GenerateWithReferencesOptions {
  prompt: string;
  negative_prompt?: string;
  resolution?: string;
  aspect_ratio?: string;
  steps?: number;
  cfg_scale?: number;
  seed?: number;
  safe_mode?: boolean;
  hide_watermark?: boolean;
  model?: string;
  referenceImages: CharacterReference[];
  faceSlots?: number;
}

export interface GenerateWithReferencesResult {
  base64: string;
  seed: number | undefined;
}

// ---- Error envelope -------------------------------------------------------

export interface VeniceApiError {
  error: {
    message: string;
    type?: string;
    code?: string | number;
  };
}
