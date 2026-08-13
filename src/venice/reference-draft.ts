// ---------------------------------------------------------------------------
// Reference-conditioned panel drafting via /image/multi-edit.
//
// WHY THIS EXISTS (2026-08-11): the Venice /image/generate endpoint has NO
// character-reference input — its only image conditioning is
// `style_references` (aesthetic-only, krea/luma models). The old
// `generateWithReferences` helper claimed to send reference images but never
// did: reference bytes were dropped and only a text line ("Image 1: face
// reference for X") reached the model. Every "reference-anchored" panel was
// actually drafted from prompt text alone — the root cause of character
// drift that storyboard QA then had to repair panel by panel.
//
// /image/multi-edit is the only image endpoint that accepts real reference
// bytes (1–3 images: base + up to 2 layers). This module drafts panels
// through it so the character's actual face is in the conditioning path
// FROM THE FIRST PIXEL, not repaired in afterward:
//
//   with location plate:  base = location angle, layers = character refs
//                         ("place the character from image 2 into image 1")
//   without location:     caller t2i-drafts the scene first, then this
//                         module composites identity in as an edit
//
// Output post-processing (WebP fix, 1:1→target aspect restore) is shared
// with the panel fixer via edit-post.ts.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { VeniceClient } from './client.js';
import type { MultiEditModel } from './types.js';
import { multiEditImage, loadImageAsDataUri } from './multi-edit.js';
import { ensureRealPng, restoreAspectRatio, aspectRatioToDimensions } from './edit-post.js';
import { appendRecipePass } from './recipe.js';

export interface ReferenceDraftCharacter {
  name: string;
  /** Short identity line: base traits + description + wardrobe. */
  identityLine: string;
  /** Absolute path to the character's reference image (front.png / anchor.png). */
  refPath: string;
}

export interface DraftPanelOptions {
  /** Edit model (multi-edit takes `modelId`). Defaults to the caller's edit default. */
  model?: MultiEditModel;
  /**
   * Base image path. When this is a location plate, characters are composed
   * INTO the location (geography inherited, not re-imagined). When it is a
   * t2i scene draft, characters are corrected in place.
   */
  basePath: string;
  /** How the base image should be treated in the prompt. */
  baseKind: 'location' | 'scene-draft';
  /** Up to 2 character references (multi-edit budget: base + 2 layers). */
  characters: ReferenceDraftCharacter[];
  /**
   * Scene text: action, framing, and blocking for the shot. The composition
   * instruction ("place X from image N…") is prepended automatically.
   */
  sceneDescription: string;
  /** Explicit spatial blocking sentence(s), injected verbatim when present. */
  blocking?: string;
  /** Aesthetic string appended as a style clause. */
  aesthetic?: string;
  /** Target aspect ratio, e.g. "16:9" — output is restored to this. */
  aspectRatio: string;
  /** Where to write the finished PNG. */
  outPath: string;
  /** Recipe label, e.g. "reference-drafted panel" / "blocking plate". */
  recipeLabel: string;
}

export interface DraftPanelResult {
  path: string;
  prompt: string;
  referenceImagePaths: string[];
  /** Character names whose identity came from real reference bytes. */
  anchoredCharacters: string[];
  /** Character names that fell back to text-only identity (missing/dropped refs). */
  textOnlyCharacters: string[];
}

/**
 * Build the composition prompt. Image numbering follows the multi-edit
 * array order: image 1 = base, images 2..N = character layers.
 */
export function buildReferenceDraftPrompt(options: DraftPanelOptions): string {
  const { baseKind, characters, sceneDescription, blocking, aesthetic } = options;
  const parts: string[] = [];

  if (baseKind === 'location') {
    parts.push(
      'Image 1 is the scene location — keep its architecture, layout, landmarks, and lighting exactly as shown; do not rearrange or mirror it.',
    );
  } else {
    parts.push(
      'Image 1 is the scene draft — keep its composition, framing, and environment.',
    );
  }

  characters.forEach((char, i) => {
    const imgNum = i + 2;
    if (baseKind === 'location') {
      parts.push(
        `Place the person from image ${imgNum} (${char.name}: ${char.identityLine}) into the scene — reproduce their exact face, hair, and body from image ${imgNum}, not from this text.`,
      );
    } else {
      parts.push(
        `Make the character ${char.name} in the scene match the person in image ${imgNum} exactly — face, hair, and body from image ${imgNum}, not from text. (${char.identityLine}.)`,
      );
    }
  });

  parts.push(sceneDescription);
  if (blocking) parts.push(`BLOCKING: ${blocking}`);

  parts.push(
    'Render as a single continuous cinematic frame. Do NOT copy the reference images\u2019 poses, backgrounds, or layout — only the identities. ' +
    'No text, no labels, no inset panels, no multi-view composition, no speech bubbles.',
  );
  if (aesthetic) parts.push(`STYLE: ${aesthetic}.`);

  return parts.join(' ');
}

/**
 * Draft a panel (or blocking plate) with REAL reference bytes via multi-edit.
 * Writes the result to `outPath`, restores the target aspect ratio, and
 * appends a recipe pass. Returns the final path + the prompt used.
 */
export async function draftPanelWithReferences(
  client: VeniceClient,
  options: DraftPanelOptions,
): Promise<DraftPanelResult> {
  const { basePath, characters, aspectRatio, outPath, model, recipeLabel } = options;

  if (!existsSync(basePath)) {
    throw new Error(`Reference draft: base image not found: ${basePath}`);
  }
  const usable = characters.filter(c => existsSync(c.refPath));
  const missingChars = characters.filter(c => !existsSync(c.refPath));
  for (const missing of missingChars) {
    console.warn(`  Reference draft: no reference image for ${missing.name} (${missing.refPath}) — identity will be text-only for this character.`);
  }
  if (usable.length > 2) {
    console.warn(`  Reference draft: multi-edit takes at most 2 reference layers — dropping ${usable.slice(2).map(c => c.name).join(', ')}.`);
  }
  const layerChars = usable.slice(0, 2);
  const droppedChars = usable.slice(2);
  const textOnlyCharacters = [...missingChars, ...droppedChars].map(c => c.name);

  const prompt = buildReferenceDraftPrompt({ ...options, characters: layerChars });

  const baseDataUri = await loadImageAsDataUri(basePath);
  const layerDataUris: string[] = [];
  for (const c of layerChars) {
    layerDataUris.push(await loadImageAsDataUri(c.refPath));
  }

  const resultBuffer = await multiEditImage(client, {
    model,
    prompt,
    baseImage: baseDataUri,
    referenceImages: layerDataUris,
  });

  await writeFile(outPath, resultBuffer);
  await ensureRealPng(outPath);

  // Multi-edit returns 1:1 — restore the storyboard aspect ratio.
  const dims = aspectRatioToDimensions(aspectRatio);
  if (dims) {
    await restoreAspectRatio(outPath, dims[0], dims[1]);
  }

  const referenceImagePaths = [basePath, ...layerChars.map(c => c.refPath)];
  const anchoredCharacters = layerChars.map(c => c.name);
  await appendRecipePass(outPath, {
    kind: 'multi-edit',
    role: 'identity',
    model: model ?? 'seedream-v5-lite-edit',
    label: recipeLabel,
    prompt,
    referenceImagePaths,
    extra: {
      ...(dims ? { aspectRestore: `1024x1024 -> ${dims[0]}x${dims[1]} center crop + scale` } : {}),
      // Reference-usage summary: which identities are anchored to real bytes
      // vs prompt text. Surfaced by the web UI as a per-shot badge so a
      // degraded draft is visible at a glance instead of buried in the log.
      referenceUsage: {
        base: options.baseKind,
        anchored: anchoredCharacters,
        textOnly: textOnlyCharacters,
      },
    },
  }, { provenance: 'edit', hasFace: layerChars.length > 0 });

  return { path: outPath, prompt, referenceImagePaths, anchoredCharacters, textOnlyCharacters };
}
