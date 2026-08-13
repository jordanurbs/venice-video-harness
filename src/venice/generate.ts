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
import { assertNotSilentRejectImage, thresholdForResolution } from "./rejection.js";

// ---- Constants ------------------------------------------------------------

const GENERATE_PATH = "/api/v1/image/generate";
// Safe low-level fallback when no caller supplies a model. `seedream-v5-lite`
// is accepted by Seedance 2.0 regardless of whether the output contains a
// face. High-level callers (mini-drama CLI, storyboard assembler) should
// pick a model based on face presence — nano-banana-pro for faceless work,
// seedream-v5-lite for face-bearing work.
const DEFAULT_MODEL = "seedream-v5-lite";
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

  const threshold = thresholdForResolution(body.resolution);
  for (const img of normalized.images) {
    const decoded = Buffer.from(img.b64_json, "base64");
    assertNotSilentRejectImage(decoded, {
      model: body.model,
      prompt: body.prompt,
      threshold,
    });
  }

  return normalized;
}

// ---- generateWithReferences -----------------------------------------------

/**
 * @deprecated **This function CANNOT deliver image-conditioned generation and
 * never could.** The Venice `/image/generate` endpoint has no reference-image
 * input (its only image conditioning is `style_references`, aesthetic-only,
 * on krea/luma models). The `referenceImages` bytes passed here are DROPPED —
 * only a text line ("Image 1: face reference for X") reaches the model, which
 * then draws the character from prompt text alone. This was the root cause of
 * storyboard character drift (verified 2026-08-11): the original doc comment
 * claimed the refs were sent in an `image` field, but no such field was ever
 * assigned and no such multi-reference field exists in the API contract.
 *
 * For real reference-conditioned drafting use `draftPanelWithReferences`
 * (src/venice/reference-draft.ts), which routes through `/image/multi-edit` —
 * the only image endpoint that accepts reference bytes (base + 2 layers).
 *
 * Retained only for the legacy `storyboard/assembler.ts` lane. Emits a
 * runtime warning on every call.
 *
 * @param client  An authenticated {@link VeniceClient} instance.
 * @param options Generation parameters plus reference images (NOT SENT).
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

  if (referenceImages.length > 0) {
    console.warn(
      `  ⚠ generateWithReferences: ${referenceImages.length} reference image(s) supplied but /image/generate ` +
      'has NO reference input — the bytes are NOT sent; identity is prompt-text only. ' +
      'Use draftPanelWithReferences (multi-edit) for real reference conditioning.',
    );
  }

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

  const raw = await client.post<Record<string, unknown>>(
    GENERATE_PATH,
    body as unknown as Record<string, unknown>,
  );

  // Venice may return images as raw base64 strings or as { b64_json } objects.
  const rawImages = (raw as { images?: unknown[] }).images ?? [];
  const firstImage = rawImages[0];
  if (!firstImage) {
    throw new Error("Venice API returned an empty images array.");
  }

  const b64 = typeof firstImage === "string"
    ? firstImage
    : (firstImage as { b64_json: string; seed?: number }).b64_json;
  const resultSeed = typeof firstImage === "object"
    ? (firstImage as { seed?: number }).seed
    : undefined;

  const decoded = Buffer.from(b64, "base64");
  assertNotSilentRejectImage(decoded, {
    model,
    prompt: augmentedPrompt,
    threshold: thresholdForResolution(resolution),
  });

  return { base64: b64, seed: resultSeed };
}
