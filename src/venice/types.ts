// ---------------------------------------------------------------------------
// Venice AI API -- TypeScript type definitions
// Covers image/generate, images/edit, character references, and
// reference-augmented generation.
// ---------------------------------------------------------------------------

// ---- Shared primitives ----------------------------------------------------

/** Supported init-image modes for img2img generation. */
export type InitImageMode = "IMAGE_STRENGTH" | "STEP_SCHEDULE";

// ---- POST /api/v1/image/generate -----------------------------------------

/** Request body for the image generation endpoint. */
export interface ImageGenerateRequest {
  /** Model identifier (e.g. "nano-banana-2"). */
  model: string;

  /** Text prompt describing the desired image. */
  prompt: string;

  /** Text describing what should be excluded from the image. */
  negative_prompt?: string;

  /** Image resolution: "1K" or "2K". */
  resolution?: string;

  /** Aspect ratio: "1:1", "16:9", "9:16", "4:3", "3:4". */
  aspect_ratio?: string;

  /** Output width in pixels (deprecated -- use resolution + aspect_ratio). */
  width?: number;

  /** Output height in pixels (deprecated -- use resolution + aspect_ratio). */
  height?: number;

  /** Number of diffusion steps. Higher = better quality, slower. */
  steps?: number;

  /** Classifier-free guidance scale. Higher = stricter adherence to prompt. */
  cfg_scale?: number;

  /** Reproducibility seed. Omit for random. */
  seed?: number;

  /** When true the API applies its built-in safety filter. */
  safe_mode?: boolean;

  /** When true the response body is the raw image bytes instead of JSON. */
  return_binary?: boolean;

  /** When true the Venice watermark is suppressed. */
  hide_watermark?: boolean;

  /**
   * Fidelity to a reference / init image (0-1).
   * 0 = ignore the reference entirely, 1 = reproduce it almost exactly.
   */
  fidelity?: number;

  /** Base-64 encoded reference / init image. */
  image?: string;

  /** How `fidelity` is interpreted when a reference image is supplied. */
  init_image_mode?: InitImageMode;
}

/** A single generated image entry returned by the API. */
export interface GeneratedImage {
  /** Base-64 encoded PNG/JPEG data. */
  b64_json: string;

  /** Seed that was used for this particular image. */
  seed?: number;
}

/** Response body from the image generation endpoint (JSON mode). */
export interface ImageGenerateResponse {
  images: GeneratedImage[];
}

// ---- POST /api/v1/images/edit ---------------------------------------------

/** Request body for the image editing endpoint. */
export interface ImageEditRequest {
  /** Base-64 encoded source image to edit. */
  image: string;

  /**
   * Base-64 encoded mask image (white = edit region, black = preserve).
   * Omit for a full-image edit guided only by `prompt` and `strength`.
   */
  mask?: string;

  /** Text prompt describing the desired edit. */
  prompt: string;

  /**
   * Edit strength (0-1).
   * 0 = no change, 1 = completely regenerate the masked region.
   */
  strength?: number;

  /** Model identifier. Defaults to the same model used for generation. */
  model?: string;

  /** Number of diffusion steps. */
  steps?: number;

  /** Classifier-free guidance scale. */
  cfg_scale?: number;

  /** Reproducibility seed. */
  seed?: number;

  /** Apply built-in safety filter. */
  safe_mode?: boolean;
}

/** Response body from the image editing endpoint. */
export interface ImageEditResponse {
  images: GeneratedImage[];
}

// ---- Character reference helpers ------------------------------------------

/** A named character with an associated face reference image. */
export interface CharacterReference {
  /** Display name used in the prompt (e.g. "MARCUS"). */
  name: string;

  /** Short role description (e.g. "the detective"). */
  role: string;

  /** Base-64 encoded face reference image. */
  base64Image: string;
}

// ---- Reference-augmented generation ---------------------------------------

/**
 * Extended options for generating an image while injecting character face
 * references into the request.
 *
 * The Venice multi-reference protocol supports up to 14 reference images
 * per request. Slots 1-5 are conventionally reserved for face references;
 * slots 6-14 can carry style, environment, or additional references.
 */
export interface GenerateWithReferencesOptions {
  /** Text prompt describing the desired scene. */
  prompt: string;

  /** Negative prompt. */
  negative_prompt?: string;

  /** Image resolution: "1K" or "2K" (default "1K"). */
  resolution?: string;

  /** Aspect ratio: "1:1", "16:9", "9:16", "4:3", "3:4" (default "1:1"). */
  aspect_ratio?: string;

  /** Diffusion steps. */
  steps?: number;

  /** Guidance scale. */
  cfg_scale?: number;

  /** Reproducibility seed. */
  seed?: number;

  /** Apply built-in safety filter. */
  safe_mode?: boolean;

  /** Suppress Venice watermark. */
  hide_watermark?: boolean;

  /** Model override (default "nano-banana-2"). */
  model?: string;

  /**
   * Reference images to inject. The first `faceSlots` entries are treated
   * as face references and receive role-assignment text in the prompt.
   * Maximum 14 total entries.
   */
  referenceImages: CharacterReference[];

  /**
   * How many of the leading reference images are face references (default 5).
   * Must be between 0 and 5 inclusive.
   */
  faceSlots?: number;
}

/** Return value from a reference-augmented generation call. */
export interface GenerateWithReferencesResult {
  /** Base-64 encoded generated image. */
  base64: string;

  /** The seed used to produce this image. */
  seed: number | undefined;
}

// ---- POST /api/v1/image/multi-edit ----------------------------------------

export type MultiEditModel =
  | 'nano-banana-pro-edit'
  | 'nano-banana-2-edit'
  | 'gpt-image-1-5-edit'
  | 'grok-imagine-edit'
  | 'qwen-edit'
  | 'flux-2-max-edit'
  | 'seedream-v4-edit'
  | 'seedream-v5-lite-edit';

/** Request body for the multi-edit endpoint (JSON mode). */
export interface MultiEditRequest {
  /** Model ID for multi-edit. */
  modelId: MultiEditModel;

  /** Edit instruction describing what to change. */
  prompt: string;

  /**
   * 1-3 images: first is base image, rest are reference layers.
   * Each can be a raw base64 string, data URL, or HTTP URL.
   */
  images: string[];
}

// ---- Error envelope -------------------------------------------------------

/** Shape of an error body returned by the Venice API. */
export interface VeniceApiError {
  error: {
    message: string;
    type?: string;
    code?: string | number;
  };
}
