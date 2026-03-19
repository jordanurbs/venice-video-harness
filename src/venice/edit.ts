// ---------------------------------------------------------------------------
// Image editing via the Venice AI API.
//
// Used primarily for face-correction passes when a character's identity
// drifts across storyboard frames.  The caller supplies the source image,
// an optional mask isolating the face region, and a corrective prompt.
// ---------------------------------------------------------------------------

import type { VeniceClient } from "./client.js";
import type {
  ImageEditRequest,
  ImageEditResponse,
} from "./types.js";

// ---- Constants ------------------------------------------------------------

const EDIT_PATH = "/api/v1/images/edit";
const DEFAULT_MODEL = "nano-banana-2";

// ---- Public options type --------------------------------------------------

/** Options accepted by {@link editImage}. */
export interface EditImageOptions {
  /** Base-64 encoded source image to edit. */
  image: string;

  /**
   * Base-64 encoded mask image.
   * White pixels mark the region to regenerate; black pixels are preserved.
   * When omitted, the entire image is eligible for editing (controlled by
   * `strength`).
   */
  mask?: string;

  /** Text prompt describing the desired correction. */
  prompt: string;

  /**
   * Edit strength (0-1, default 0.65).
   * Lower values make subtler corrections; higher values regenerate more
   * aggressively within the masked region.
   */
  strength?: number;

  /** Model override. Defaults to "nano-banana-2". */
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

/** Return value from {@link editImage}. */
export interface EditImageResult {
  /** Base-64 encoded edited image. */
  base64: string;

  /** Seed used for this edit. */
  seed: number | undefined;
}

// ---- editImage ------------------------------------------------------------

/**
 * Edit an existing image using the Venice inpainting / img2img endpoint.
 *
 * Typical use-case in the storyboard pipeline: a generated frame has the
 * right composition but a character's face has drifted from the established
 * reference.  The caller creates a mask around the face, supplies a prompt
 * like *"face of MARCUS, male, mid-40s, strong jawline"*, and this function
 * returns a corrected frame.
 *
 * @param client  An authenticated {@link VeniceClient} instance.
 * @param options Edit parameters.  `image` and `prompt` are required.
 * @returns       The edited image as base-64 and the seed used.
 */
export async function editImage(
  client: VeniceClient,
  options: EditImageOptions,
): Promise<EditImageResult> {
  const {
    image,
    mask,
    prompt,
    strength = 0.65,
    model = DEFAULT_MODEL,
    steps,
    cfg_scale,
    seed,
    safe_mode,
  } = options;

  // ---- Assemble request body ----------------------------------------------

  const body: ImageEditRequest = {
    image,
    prompt,
    strength,
    model,
  };

  if (mask !== undefined) body.mask = mask;
  if (steps !== undefined) body.steps = steps;
  if (cfg_scale !== undefined) body.cfg_scale = cfg_scale;
  if (seed !== undefined) body.seed = seed;
  if (safe_mode !== undefined) body.safe_mode = safe_mode;

  // ---- Call API -----------------------------------------------------------

  const raw = await client.post<Record<string, unknown>>(
    EDIT_PATH,
    body as unknown as Record<string, unknown>,
  );

  // Venice may return images as raw base64 strings or as { b64_json } objects.
  const rawImages = (raw as { images?: unknown[] }).images ?? [];
  if (rawImages.length === 0) {
    throw new Error("Venice API returned an empty images array from the edit endpoint.");
  }

  const first = rawImages[0];
  const b64 = typeof first === "string" ? first : (first as { b64_json: string }).b64_json;
  const imgSeed = typeof first === "object" && first !== null ? (first as { seed?: number }).seed : undefined;

  return {
    base64: b64,
    seed: imgSeed,
  };
}
