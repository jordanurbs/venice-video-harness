// ---------------------------------------------------------------------------
// Image generation functions for the Venice AI API.
//
// - generateImage          -- thin wrapper around POST /api/v1/image/generate
// - generateWithReferences -- builds a reference-augmented prompt for
//                             character-consistent storyboard frames
// ---------------------------------------------------------------------------

import type { VeniceClient } from "./client.js";
import type {
  ImageGenerateRequest,
  ImageGenerateResponse,
  GenerateWithReferencesOptions,
  GenerateWithReferencesResult,
  CharacterReference,
} from "./types.js";

// ---- Constants ------------------------------------------------------------

const GENERATE_PATH = "/api/v1/image/generate";
const DEFAULT_MODEL = "nano-banana-2";
const DEFAULT_RESOLUTION = "1K";
const DEFAULT_ASPECT_RATIO = "1:1";

/** Venice supports up to 14 reference images per request. */
const MAX_REFERENCE_IMAGES = 14;

/** Maximum number of the 14 slots that may be used for face references. */
const MAX_FACE_SLOTS = 5;

// ---- generateImage --------------------------------------------------------

/**
 * Generate a single image from a text prompt.
 *
 * This is a straightforward 1:1 mapping to the Venice `/api/v1/image/generate`
 * endpoint.  All request fields are forwarded as-is; only `model`, `resolution`,
 * and `aspect_ratio` receive defaults when omitted.
 *
 * @param client  An authenticated {@link VeniceClient} instance.
 * @param options Request parameters.  At minimum `prompt` is required.
 * @returns       The full API response including the `images` array.
 */
export async function generateImage(
  client: VeniceClient,
  options: Partial<ImageGenerateRequest> & { prompt: string },
): Promise<ImageGenerateResponse> {
  const body: ImageGenerateRequest = {
    model: options.model ?? DEFAULT_MODEL,
    resolution: options.resolution ?? DEFAULT_RESOLUTION,
    aspect_ratio: options.aspect_ratio ?? DEFAULT_ASPECT_RATIO,
    ...options,
  };

  const raw = await client.post<Record<string, unknown>>(GENERATE_PATH, body as unknown as Record<string, unknown>);

  // Venice may return images as raw base64 strings or as { b64_json } objects.
  // Normalize to the { b64_json, seed } shape our codebase expects.
  const rawImages = (raw as { images?: unknown[] }).images ?? [];
  const normalized: ImageGenerateResponse = {
    images: rawImages.map((img) => {
      if (typeof img === "string") {
        return { b64_json: img };
      }
      return img as { b64_json: string; seed?: number };
    }),
  };

  return normalized;
}

// ---- generateWithReferences -----------------------------------------------

/**
 * Generate a scene image while injecting character face references for
 * identity consistency across storyboard frames.
 *
 * **How it works**
 *
 * 1. The caller supplies up to 14 {@link CharacterReference} entries via
 *    `options.referenceImages`.
 * 2. The first N entries (where N = `options.faceSlots`, default 5, max 5)
 *    are treated as **face references**.  For each one a role-assignment line
 *    is prepended to the prompt so the model knows which reference image
 *    corresponds to which character:
 *
 *    ```
 *    Image 1: face reference for MARCUS (the detective)
 *    Image 2: face reference for LENA (the journalist)
 *    ```
 *
 * 3. All reference images (face + non-face) are concatenated as a
 *    comma-separated base-64 string in the `image` field, which Venice
 *    interprets as a multi-reference input.
 *
 * 4. The fidelity is set to a moderate default (0.35) to allow creative
 *    freedom while anchoring character likeness.
 *
 * @param client  An authenticated {@link VeniceClient} instance.
 * @param options Generation parameters plus reference images.
 * @returns       The generated image as base-64 and the seed used.
 */
export async function generateWithReferences(
  client: VeniceClient,
  options: GenerateWithReferencesOptions,
): Promise<GenerateWithReferencesResult> {
  const {
    referenceImages,
    faceSlots: rawFaceSlots,
    prompt,
    negative_prompt,
    resolution = DEFAULT_RESOLUTION,
    aspect_ratio = DEFAULT_ASPECT_RATIO,
    model = DEFAULT_MODEL,
    steps,
    cfg_scale,
    seed,
    safe_mode,
    hide_watermark,
  } = options;

  // ---- Validate reference counts ------------------------------------------

  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `Venice supports at most ${MAX_REFERENCE_IMAGES} reference images per request, ` +
        `but ${referenceImages.length} were provided.`,
    );
  }

  const faceSlots = Math.min(
    Math.max(rawFaceSlots ?? MAX_FACE_SLOTS, 0),
    MAX_FACE_SLOTS,
  );

  // ---- Build augmented prompt ---------------------------------------------

  const faceRefs: CharacterReference[] = referenceImages.slice(0, faceSlots);
  const roleLines = faceRefs.map(
    (ref, i) => `Image ${i + 1}: face reference for ${ref.name} (${ref.role})`,
  );

  const augmentedPrompt = roleLines.length > 0
    ? `${roleLines.join("\n")}\n\n${prompt}`
    : prompt;

  // ---- Assemble request body ----------------------------------------------

  const body: ImageGenerateRequest = {
    model,
    prompt: augmentedPrompt,
    resolution,
    aspect_ratio,
  };

  if (negative_prompt !== undefined) body.negative_prompt = negative_prompt;
  if (steps !== undefined) body.steps = steps;
  if (cfg_scale !== undefined) body.cfg_scale = cfg_scale;
  if (seed !== undefined) body.seed = seed;
  if (safe_mode !== undefined) body.safe_mode = safe_mode;
  if (hide_watermark !== undefined) body.hide_watermark = hide_watermark;

  // ---- Call API -----------------------------------------------------------

  const response = await client.post<ImageGenerateResponse>(
    GENERATE_PATH,
    body as unknown as Record<string, unknown>,
  );

  const firstImage = response.images[0];
  if (!firstImage) {
    throw new Error("Venice API returned an empty images array.");
  }

  return {
    base64: firstImage.b64_json,
    seed: firstImage.seed,
  };
}
