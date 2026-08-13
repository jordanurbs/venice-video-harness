// ---------------------------------------------------------------------------
// Character reference-sheet generation, extracted for reuse.
//
// Historically the four-angle sheet loop lived only inside the add-character
// command, so a workshop-approved cast had data in series.json but no art
// until the operator re-ran add-character per character. This module lets
// `workshop --approve` (and anything else) generate sheets for characters
// that already exist in series state.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCharacterDir } from '../series/manager.js';
import type { Character, SeriesState } from '../series/types.js';
import { DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';
import type { VeniceClient } from '../venice/client.js';
import { generateImage } from '../venice/generate.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import { buildCharacterReferencePromptParts } from './prompt-builder.js';

export const CHARACTER_ANGLES = ['front', 'three-quarter', 'profile', 'full-body'] as const;
export type CharacterAngle = (typeof CHARACTER_ANGLES)[number];

export interface GenerateCharacterReferencesOptions {
  /** Only (re)generate this subset. Default: all four angles. */
  angles?: CharacterAngle[];
  /** Skip angles whose file already exists (used by ensure-style callers). */
  skipExisting?: boolean;
  /** Inline positive-prompt override applied verbatim to every angle. */
  promptOverride?: string;
  model?: string;
  cfgScale?: number;
  aspectRatio?: string;
  resolution?: string;
}

/**
 * Generate the four-angle reference sheet for one character already present
 * in series state. Existing angles are archived (never overwritten) unless
 * `skipExisting` short-circuits them. Writes the same prompt/recipe sidecars
 * as add-character.
 */
export async function generateCharacterReferences(
  client: VeniceClient,
  series: SeriesState,
  character: Character,
  options: GenerateCharacterReferencesOptions = {},
): Promise<{ generated: string[]; skipped: string[] }> {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating character references.');
  }

  const charDir = getCharacterDir(series, character.name);
  await mkdir(charDir, { recursive: true });

  const model = options.model ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const cfgScale = options.cfgScale ?? 10;
  const aspectRatio = options.aspectRatio ?? '1:1';
  const resolution = options.resolution ?? '1K';
  const seed = character.seed;
  const angles = options.angles?.length ? options.angles : [...CHARACTER_ANGLES];

  const generated: string[] = [];
  const skipped: string[] = [];

  for (const angle of angles) {
    const imgPath = join(charDir, `${angle}.png`);
    if (existsSync(imgPath) && options.skipExisting) {
      skipped.push(imgPath);
      continue;
    }
    if (existsSync(imgPath)) {
      const archive = imgPath.replace(/\.png$/, `-force-archive-${Date.now()}.png`);
      await copyFile(imgPath, archive);
    }

    const { positive: defaultPositive, negativeAdditions } =
      buildCharacterReferencePromptParts(character, series.aesthetic, angle, {
        model,
        negativePromptStrategy: series.videoDefaults.imageDefaults?.negativePromptStrategy ?? 'auto',
      });
    const prompt = options.promptOverride ?? defaultPositive;
    const negativePrompt = [
      'deformed', 'blurry', 'bad anatomy', 'low quality',
      'multiple people', 'watermark',
      'character reference sheet', 'comic panels', 'panel borders',
      ...negativeAdditions,
    ].join(', ');

    try {
      const response = await generateImage(client, {
        model,
        prompt,
        negative_prompt: negativePrompt,
        resolution,
        aspect_ratio: aspectRatio,
        steps: 30,
        cfg_scale: cfgScale,
        seed,
        safe_mode: false,
        hide_watermark: true,
      });
      if (!response.images?.[0]) {
        console.warn(`  ${angle}: no image returned`);
        continue;
      }
      const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
      const finalPath = await writeImageBytesSmart(imgBuffer, imgPath);
      console.log(`  ${angle}: saved -> ${finalPath.split('/').pop()}`);

      const returnedSeed = (response.images[0] as { seed?: number }).seed;
      await writeFile(join(charDir, `${angle}.prompt.json`), JSON.stringify({
        character: character.name,
        angle,
        model,
        prompt,
        negative_prompt: negativePrompt,
        cfg_scale: cfgScale,
        aspect_ratio: aspectRatio,
        resolution,
        seed,
        returnedSeed,
        overrideSource: null,
        generatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');

      await appendRecipePass(finalPath, {
        kind: 'generate',
        role: 'identity',
        model,
        label: `character reference (${character.name}, ${angle})`,
        prompt,
        negativePrompt,
        seed,
        cfgScale,
        aspectRatio,
        resolution,
        extra: returnedSeed !== undefined ? { returnedSeed } : undefined,
      }, { provenance: 'generate', hasFace: true });

      generated.push(finalPath);
    } catch (err) {
      console.warn(`  ${angle}: failed - ${err}`);
    }
  }

  // Persist character.json beside the art, matching add-character.
  await writeFile(
    join(charDir, 'character.json'),
    JSON.stringify(character, null, 2),
    'utf-8',
  );

  return { generated, skipped };
}
