import { readFile, stat } from 'node:fs/promises';
import type { VeniceClient } from './client.js';
import type { MultiEditModel, MultiEditRequest } from './types.js';
import { assertNotSilentRejectImage } from './rejection.js';

// Intentional non-cache: every call to loadImageAsDataUri / multiEditImage
// re-reads its inputs from disk. Do NOT introduce an in-process cache of
// reference-image bytes here without also tracking each file's mtime as the
// cache key — character reference images can be regenerated under the same
// path while the harness process is alive (the Founder/Legislator
// regenerations during the PNW field-guide produced exactly this pattern),
// and a path-keyed cache would silently serve stale bytes.

const MULTI_EDIT_PATH = '/api/v1/image/multi-edit';
// Safe low-level fallback. Seedance 2.0 only gates face-bearing images, so
// callers editing non-face panels can safely override with any model. The
// default remains `seedream-v5-lite-edit` because the most common use of
// multi-edit is fixing character appearance — where the face rule applies.
const DEFAULT_EDIT_MODEL: MultiEditModel = 'seedream-v5-lite-edit';

export interface MultiEditOptions {
  model?: MultiEditModel;
  prompt: string;
  baseImage: string;
  referenceImages?: string[];
}

function toDataUri(base64: string, mime = 'image/png'): string {
  if (base64.startsWith('data:') || base64.startsWith('http')) return base64;
  return `data:${mime};base64,${base64}`;
}

export async function loadImageAsDataUri(filePath: string): Promise<string> {
  // Always re-read from disk; see top-of-file note about why a cache is unsafe.
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * Return the mtime (ms since epoch) for each reference image. Useful for
 * diagnostic logs — "character refs loaded: front.png mtime=… three-quarter.png
 * mtime=…" lets the operator confirm the latest regeneration was picked up.
 *
 * Missing files are silently dropped so callers can pass an optimistic list.
 */
export async function referenceFreshness(
  paths: string[],
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      out.push({ path: p, mtimeMs: s.mtimeMs });
    } catch {
      // skip missing
    }
  }
  return out;
}

/**
 * Edit a panel image using character references via Venice multi-edit.
 *
 * The base image (the generated panel) is image[0]. Character reference
 * images are image[1] and image[2] (up to 3 total). The prompt instructs
 * the model to align characters in the base image with the references.
 *
 * Returns raw PNG buffer.
 */
export async function multiEditImage(
  client: VeniceClient,
  options: MultiEditOptions,
): Promise<Buffer> {
  const {
    model = DEFAULT_EDIT_MODEL,
    prompt,
    baseImage,
    referenceImages = [],
  } = options;

  const images = [
    toDataUri(baseImage),
    ...referenceImages.slice(0, 2).map(img => toDataUri(img)),
  ];

  const body: MultiEditRequest = {
    modelId: model,
    prompt,
    images,
  };

  const result = await client.postBinary(MULTI_EDIT_PATH, body as unknown as Record<string, unknown>);
  // Multi-edit responses are returned as raw bytes (PNG/WebP). When Seedream
  // silently refuses a prompt (e.g. content-moderation hit) we get a tiny
  // refusal stub. Catch this here so callers don't try to use a 2 KB image
  // as a valid edit result.
  assertNotSilentRejectImage(result, { model, prompt });
  return result;
}

/**
 * Fix character appearance in a panel by referencing character images.
 * Constructs a targeted edit prompt from the character's description.
 */
export async function fixCharacterInPanel(
  client: VeniceClient,
  panelBase64: string,
  characterRef: string,
  editPrompt: string,
  model?: MultiEditModel,
): Promise<Buffer> {
  return multiEditImage(client, {
    model,
    prompt: editPrompt,
    baseImage: panelBase64,
    referenceImages: [characterRef],
  });
}

/**
 * Two-character fix: pass both character references as layers.
 */
export async function fixTwoCharactersInPanel(
  client: VeniceClient,
  panelBase64: string,
  char1Ref: string,
  char2Ref: string,
  editPrompt: string,
  model?: MultiEditModel,
): Promise<Buffer> {
  return multiEditImage(client, {
    model,
    prompt: editPrompt,
    baseImage: panelBase64,
    referenceImages: [char1Ref, char2Ref],
  });
}
