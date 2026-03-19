import { readFile } from 'node:fs/promises';
import type { VeniceClient } from './client.js';
import type { MultiEditModel, MultiEditRequest } from './types.js';

const MULTI_EDIT_PATH = '/api/v1/image/multi-edit';
const DEFAULT_EDIT_MODEL: MultiEditModel = 'nano-banana-pro-edit';

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
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
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

  return client.postBinary(MULTI_EDIT_PATH, body as unknown as Record<string, unknown>);
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
