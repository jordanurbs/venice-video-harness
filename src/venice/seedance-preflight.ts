// ---------------------------------------------------------------------------
// Seedance pre-flight
//
// Two generations of this module:
//
// 1. (2026-03 → 2026-07, NEUTRALIZED) Seedance 2.0 used to reject face-bearing
//    input images that weren't produced by `seedream-v5-lite` / `-edit`. The
//    provenance gate that rerouted or "laundered" those images is a no-op
//    since Venice dropped the cross-family restriction. `ensureSeedanceCompatibility`
//    is kept so the remaining one-off scripts compile.
//
// 2. (2026-10) Faces-off twins. Venice lists each Seedance lane twice: the
//    plain id (face-capable: 409 `needs_consent` handshake, face screening)
//    and a `-basic` twin that runs WITHOUT face handling and refuses any input
//    image that shows a person (422 `provider_content_policy`, credits
//    refunded). Routing a shot with characters to a `-basic` id fails nearly
//    every time -- 31 of 32 takes in one project -- and the error text blames
//    the prompt, so operators rewrite prompts that were never the problem.
//    `assertFacesOffCompatible` blocks that combination before the paid call
//    and names the face-capable twin as the fix.
//
// NOTE: the Seedance face *consent* attestation (HTTP 409 `needs_consent`) is a
// SEPARATE mechanism handled at queue time in `video-generator.ts`.
// ---------------------------------------------------------------------------

import type { VeniceClient } from './client.js';
import { faceCapableTwinId, getVideoModel, isFacesOffModel } from './models.js';
import { readImageProvenance } from './provenance.js';

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
  /** @deprecated The provenance gate is neutralized; this option is ignored. */
  mode?: import('../series/types.js').SeedanceCompatibilityMode;
  /** @deprecated The provenance gate is neutralized; this option is ignored. */
  nonInteractive?: boolean;
}

export type PreflightAction =
  | { type: 'proceed'; model: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'fallback'; newModel: string; reason: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'laundered'; model: string; imagePaths: SeedanceInputImagePaths; lauderedPaths: string[] };

// ---- Provenance gate (no-op) ----------------------------------------------

/**
 * No-op Seedance provenance pre-flight. Always returns `proceed` with the
 * original model and image paths. Retained only so existing callers keep
 * compiling -- Venice removed the seedream-only face restriction that this
 * gate used to enforce.
 */
export async function ensureSeedanceCompatibility(
  _client: VeniceClient,
  targetModel: string,
  images: SeedanceInputImagePaths,
  _options: PreflightOptions = {},
): Promise<PreflightAction> {
  return { type: 'proceed', model: targetModel, imagePaths: images };
}

// ---- Faces-off gate -------------------------------------------------------

export interface FacesOffCheckInput {
  /** The model the request would be sent to. */
  model: string;
  /**
   * Every on-disk image the request would send (start frame, end frame,
   * reference images, scene images, element frontals/refs). `data:`/`http`
   * URLs are skipped: nothing to read a sidecar from.
   */
  imagePaths: string[];
  /**
   * Character names the shot places on screen, if the caller knows them.
   * A shot with characters is treated as showing people even when no image
   * sidecar says so -- the panel and character sheets will.
   */
  characters?: string[];
}

export interface FacesOffViolation {
  model: string;
  /** The face-capable id to switch to. */
  faceCapableModel: string;
  /** Images whose provenance says (or does not deny) a face. */
  faceImages: string[];
  /** Characters the shot shows, when supplied. */
  characters: string[];
  message: string;
}

/**
 * Thrown by `assertFacesOffCompatible`. Carries the structured violation so a
 * CLI or UI can offer the one-click fix (switch to `faceCapableModel`).
 */
export class FacesOffModelError extends Error {
  public readonly violation: FacesOffViolation;

  constructor(violation: FacesOffViolation) {
    super(violation.message);
    this.name = 'FacesOffModelError';
    this.violation = violation;
  }
}

function isLocalPath(p: string): boolean {
  return Boolean(p) && !p.startsWith('data:') && !/^https?:\/\//i.test(p);
}

/**
 * Decide whether a request to `model` with these inputs would be refused for
 * showing a person on a faces-off id. Returns `undefined` when the request is
 * fine (not a faces-off model, no images, or every image is known faceless).
 *
 * An image counts as showing a face when its provenance sidecar says
 * `hasFace: true`, OR when the sidecar is missing / undecided
 * (`hasFace` absent) and the shot has characters. Only an explicit
 * `hasFace: false` clears an image. Location plates and other faceless
 * references are written with `hasFace:false` (rule 41), so a shot with no
 * people and only location refs passes.
 */
export async function checkFacesOffCompatible(
  input: FacesOffCheckInput,
): Promise<FacesOffViolation | undefined> {
  if (!isFacesOffModel(input.model)) return undefined;
  const localPaths = Array.from(new Set(input.imagePaths.filter(isLocalPath)));
  if (localPaths.length === 0) return undefined;

  const characters = input.characters ?? [];
  const hasCharacters = characters.length > 0;
  const faceImages: string[] = [];
  for (const path of localPaths) {
    const prov = await readImageProvenance(path);
    const hasFace = prov?.hasFace;
    if (hasFace === true) faceImages.push(path);
    else if (hasFace === undefined && hasCharacters) faceImages.push(path);
  }
  if (faceImages.length === 0) return undefined;

  const faceCapableModel = faceCapableTwinId(input.model);
  const twinKnown = Boolean(getVideoModel(faceCapableModel));
  const who = hasCharacters
    ? `shows ${characters.length === 1 ? characters[0] : `${characters.length} characters`}`
    : `sends ${faceImages.length === 1 ? 'an image' : `${faceImages.length} images`} with a face`;
  const message =
    `This shot ${who}, and ${input.model} runs without Seedance's face handling, `
    + `so Venice refuses images of people on it (422 provider_content_policy). `
    + `Use ${faceCapableModel}${twinKnown ? '' : ' (the same model with face handling)'} instead. `
    + `No request was submitted.`;

  return { model: input.model, faceCapableModel, faceImages, characters, message };
}

/** Throw `FacesOffModelError` when `checkFacesOffCompatible` finds a violation. */
export async function assertFacesOffCompatible(input: FacesOffCheckInput): Promise<void> {
  const violation = await checkFacesOffCompatible(input);
  if (violation) throw new FacesOffModelError(violation);
}
