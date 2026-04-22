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
  status: 'PROCESSING';
  average_execution_time: number;
  execution_duration: number;
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
