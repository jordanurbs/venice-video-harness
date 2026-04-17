// ---------------------------------------------------------------------------
// Venice Image Editing, Upscaling, and Background Removal
//
// - editImage:           DEPRECATED -- /api/v1/images/edit was disabled May 2025
// - upscaleImage:        POST /api/v1/image/upscale
// - removeBackground:    POST /api/v1/image/background-remove
//
// For layered multi-image editing, use multi-edit.ts instead.
// ---------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VeniceClient } from "./client.js";
import type {
  ImageEditRequest,
  ImageEditResponse,
} from "./types.js";

// ---- Constants ------------------------------------------------------------

const EDIT_PATH = "/api/v1/images/edit";
const UPSCALE_PATH = "/api/v1/image/upscale";
const BACKGROUND_REMOVE_PATH = "/api/v1/image/background-remove";
// The /images/edit endpoint is deprecated; kept for backwards compat only.
// Anything that goes downstream into Seedance should use the new
// `seedream-v5-lite` family, so align the default here too.
const DEFAULT_MODEL = "seedream-v5-lite";

// ---- Edit (DEPRECATED) ----------------------------------------------------

export interface EditImageOptions {
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

export interface EditImageResult {
  base64: string;
  seed: number | undefined;
}

/**
 * @deprecated The /images/edit inpainting endpoint was disabled May 19, 2025.
 * Use multiEditImage from multi-edit.ts instead.
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

  const raw = await client.post<Record<string, unknown>>(
    EDIT_PATH,
    body as unknown as Record<string, unknown>,
  );

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

// ---- Upscale --------------------------------------------------------------

export interface UpscaleImageOptions {
  /** Base64-encoded image or data URL */
  image: string;
  /** Upscale factor (e.g. 2, 4). Model-dependent. */
  scale?: number;
  /** Model override. Default determined by Venice. */
  model?: string;
}

export interface UpscaleImageResult {
  /** Base64-encoded upscaled image */
  base64: string;
}

/**
 * Upscale an image using Venice's AI upscaling endpoint.
 * Returns the upscaled image as base64.
 */
export async function upscaleImage(
  client: VeniceClient,
  options: UpscaleImageOptions,
): Promise<UpscaleImageResult> {
  const body: Record<string, unknown> = {
    image: options.image,
  };

  if (options.scale !== undefined) body.scale = options.scale;
  if (options.model) body.model = options.model;

  const buffer = await client.postBinary(UPSCALE_PATH, body);
  return { base64: buffer.toString('base64') };
}

/**
 * Upscale an image and save the result to disk.
 */
export async function upscaleImageToFile(
  client: VeniceClient,
  options: UpscaleImageOptions,
  outputPath: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    image: options.image,
  };

  if (options.scale !== undefined) body.scale = options.scale;
  if (options.model) body.model = options.model;

  const buffer = await client.postBinary(UPSCALE_PATH, body);
  await mkdir(dirname(outputPath), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputPath, buffer);
  return outputPath;
}

// ---- Background Remove ----------------------------------------------------

export interface RemoveBackgroundOptions {
  /** Base64-encoded image or data URL */
  image: string;
  /** Model override. Default: bria-bg-remover */
  model?: string;
}

export interface RemoveBackgroundResult {
  base64: string;
}

/**
 * Remove the background from an image.
 * Returns the image with transparent background as base64 PNG.
 */
export async function removeBackground(
  client: VeniceClient,
  options: RemoveBackgroundOptions,
): Promise<RemoveBackgroundResult> {
  const body: Record<string, unknown> = {
    image: options.image,
  };

  if (options.model) body.model = options.model;

  const buffer = await client.postBinary(BACKGROUND_REMOVE_PATH, body);
  return { base64: buffer.toString('base64') };
}
