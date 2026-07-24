// ---------------------------------------------------------------------------
// Seedance 2.0 Compatibility Pre-flight — NEUTRALIZED (2026-07)
//
// Historical behavior: Seedance 2.0 used to reject face-bearing input images
// that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`. This
// module ran a provenance check before every Seedance call and, on a face-
// bearing non-seedream image, either rerouted the shot to a Kling/Veo fallback
// or "laundered" the image through a seedream edit pass.
//
// **Venice removed that cross-family restriction.** Seedance now accepts face-
// bearing input images from ANY image family, so the gate has nothing to do.
// `ensureSeedanceCompatibility` is kept as a no-op that always proceeds, so the
// remaining callers (a couple of one-off scripts) keep compiling; it can be
// deleted entirely once nothing imports it.
//
// NOTE: the Seedance face *consent* attestation (HTTP 409 `needs_consent`) is a
// SEPARATE mechanism handled at queue time in `video.ts` / `video-generator.ts`
// — it was never part of this provenance gate and is unaffected.
// ---------------------------------------------------------------------------

import type { VeniceClient } from './client.js';

// ---- Types ----------------------------------------------------------------

/** All image-path fields on the request body that Seedance inspects. */
export interface SeedanceInputImagePaths {
  imageUrl?: string;
  endImageUrl?: string;
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  elementsFrontalPaths?: string[];
  elementsReferencePaths?: string[];
}

export interface PreflightOptions {
  /** @deprecated The gate is neutralized; this option is ignored. */
  mode?: import('../series/types.js').SeedanceCompatibilityMode;
  /** @deprecated The gate is neutralized; this option is ignored. */
  nonInteractive?: boolean;
}

export type PreflightAction =
  | { type: 'proceed'; model: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'fallback'; newModel: string; reason: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'laundered'; model: string; imagePaths: SeedanceInputImagePaths; lauderedPaths: string[] };

// ---- Public entry point (no-op) -------------------------------------------

/**
 * No-op Seedance pre-flight. Always returns `proceed` with the original model
 * and image paths. Retained only so existing callers keep compiling — Venice
 * removed the seedream-only face restriction that this gate used to enforce.
 */
export async function ensureSeedanceCompatibility(
  _client: VeniceClient,
  targetModel: string,
  images: SeedanceInputImagePaths,
  _options: PreflightOptions = {},
): Promise<PreflightAction> {
  return { type: 'proceed', model: targetModel, imagePaths: images };
}
