// ---------------------------------------------------------------------------
// Seedance 2.0 Compatibility Pre-flight
//
// Seedance 2.0 (both R2V and i2v variants) blocks any video request whose
// input images (`image_url`, `end_image_url`, `reference_image_urls`,
// `scene_image_urls`, elements[].frontal_image_url, etc.) were not produced
// by `seedream-v5-lite` or edited by `seedream-v5-lite-edit`.
//
// Running this check before every Seedance call lets us:
//   1. Detect incompatible images that would otherwise 4xx from Venice
//   2. Offer the user an interactive choice:
//      - fallback: route this shot to Kling O3 R2V / Veo atmosphere
//      - launder: pass each incompatible image through seedream-v5-lite-edit
//        with a neutral "preserve image" prompt so it becomes compatible
//   3. Honor a pre-configured `seedanceCompatibility` strategy for batch
//      / CI runs where no human is present.
//
// The launder step is intentionally conservative: it only fires on images
// that fail the provenance check, and it updates the provenance sidecar so
// subsequent calls pass the check without re-laundering.
// ---------------------------------------------------------------------------

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { VeniceClient } from './client.js';
import { multiEditImage } from './multi-edit.js';
import {
  checkImagesForSeedance,
  recordEditProvenance,
  type ImageProvenance,
} from './provenance.js';
import type { SeedanceCompatibilityMode } from '../series/types.js';
import {
  isSeedanceVideoModel,
  SEEDANCE_FALLBACK_ATMOSPHERE_MODEL,
  SEEDANCE_FALLBACK_R2V_MODEL,
} from '../series/types.js';

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
  /** The configured strategy. Defaults to `prompt` if interactive, otherwise `fallback`. */
  mode?: SeedanceCompatibilityMode;
  /** Hint to skip the interactive prompt (used in tests and CI). */
  nonInteractive?: boolean;
}

export type PreflightAction =
  | { type: 'proceed'; model: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'fallback'; newModel: string; reason: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'laundered'; model: string; imagePaths: SeedanceInputImagePaths; lauderedPaths: string[] };

// ---- Public entry point ---------------------------------------------------

/**
 * Run the Seedance pre-flight check against a pending video request.
 *
 * No-op if the target model is not a Seedance model. Otherwise:
 *   - Confirms every image path's provenance is Seedance-compatible
 *   - If any are not, resolves the strategy (prompt / fallback / launder)
 *     and returns a `PreflightAction` describing how to proceed.
 *
 * The caller applies the `PreflightAction`: for `fallback`, it re-resolves
 * the request against the fallback model; for `laundered`, it proceeds with
 * the original Seedance call (images now have compatible provenance).
 */
export async function ensureSeedanceCompatibility(
  client: VeniceClient,
  targetModel: string,
  images: SeedanceInputImagePaths,
  options: PreflightOptions = {},
): Promise<PreflightAction> {
  if (!isSeedanceVideoModel(targetModel)) {
    return { type: 'proceed', model: targetModel, imagePaths: images };
  }

  const imagePathList = collectPaths(images);
  const result = await checkImagesForSeedance(imagePathList);
  if (result.compatible) {
    return { type: 'proceed', model: targetModel, imagePaths: images };
  }

  const mode = resolveMode(options);
  reportIncompatibility(targetModel, result.incompatible);

  let chosen: SeedanceCompatibilityMode;
  if (mode === 'prompt') {
    chosen = await promptUser(options);
  } else {
    chosen = mode;
    console.warn(`  Seedance pre-flight: applying configured mode '${mode}'.`);
  }

  if (chosen === 'fallback') {
    const newModel = isReferenceToVideo(targetModel)
      ? SEEDANCE_FALLBACK_R2V_MODEL
      : SEEDANCE_FALLBACK_ATMOSPHERE_MODEL;
    return {
      type: 'fallback',
      newModel,
      reason: `Seedance provenance check failed on ${result.incompatible.length} image(s); rerouting to ${newModel}.`,
      imagePaths: images,
    };
  }

  // launder
  const lauderedPaths = await launderImages(
    client,
    result.incompatible.map(entry => entry.imagePath),
  );
  return {
    type: 'laundered',
    model: targetModel,
    imagePaths: images,
    lauderedPaths,
  };
}

// ---- Helpers --------------------------------------------------------------

function collectPaths(images: SeedanceInputImagePaths): Array<string | undefined> {
  return [
    images.imageUrl,
    images.endImageUrl,
    ...(images.referenceImagePaths ?? []),
    ...(images.sceneImagePaths ?? []),
    ...(images.elementsFrontalPaths ?? []),
    ...(images.elementsReferencePaths ?? []),
  ];
}

function isReferenceToVideo(modelId: string): boolean {
  return modelId.includes('reference-to-video');
}

function resolveMode(options: PreflightOptions): SeedanceCompatibilityMode {
  if (options.mode) return options.mode;
  if (options.nonInteractive) return 'fallback';
  return stdout.isTTY ? 'prompt' : 'fallback';
}

function reportIncompatibility(
  targetModel: string,
  entries: Array<{
    imagePath: string;
    provenance: ImageProvenance | 'unknown';
    reason: string;
  }>,
): void {
  console.warn('');
  console.warn(`  ⚠ Seedance pre-flight: ${targetModel} will block this request.`);
  console.warn(`    Seedance 2.0 only accepts images from seedream-v5-lite / seedream-v5-lite-edit.`);
  console.warn(`    ${entries.length} incompatible image(s) detected:`);
  for (const entry of entries) {
    console.warn(`      • ${entry.imagePath}`);
    console.warn(`        ${entry.reason}`);
  }
  console.warn('');
}

async function promptUser(options: PreflightOptions): Promise<'fallback' | 'launder'> {
  if (options.nonInteractive || !stdin.isTTY) {
    console.warn('  Non-interactive environment — defaulting to fallback.');
    return 'fallback';
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (
        await rl.question(
          '  How should the harness proceed?\n' +
            '    [f] fallback — reroute this shot to Kling O3 R2V / Veo 3.1 atmosphere\n' +
            '    [l] launder  — re-render each incompatible image through seedream-v5-lite-edit and retry\n' +
            '  Choose [f/l]: ',
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'f' || answer === 'fallback') return 'fallback';
      if (answer === 'l' || answer === 'launder') return 'launder';
      console.warn("  Please answer 'f' or 'l'.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Re-render each incompatible image through `seedream-v5-lite-edit` with a
 * neutral "preserve the image" prompt so it acquires Seedance-compatible
 * provenance. The original file is archived next to it (`<name>-pre-launder.png`).
 */
async function launderImages(client: VeniceClient, paths: string[]): Promise<string[]> {
  const laundered: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      console.warn(`  Launder skipped (not on disk): ${path}`);
      continue;
    }

    console.log(`  Laundering through seedream-v5-lite-edit: ${path}`);
    try {
      const original = await readFile(path);
      const baseDataUri = `data:image/png;base64,${original.toString('base64')}`;
      const resultBuffer = await multiEditImage(client, {
        model: 'seedream-v5-lite-edit',
        prompt:
          'Preserve the image exactly as-is. Do not alter composition, characters, lighting, style, colors, or framing. This is a provenance conversion pass only.',
        baseImage: baseDataUri,
      });

      const archivePath = path.replace(/\.(png|jpg|jpeg|webp)$/i, '-pre-launder.png');
      await rename(path, archivePath);
      await writeFile(path, resultBuffer);
      await recordEditProvenance(path, 'seedream-v5-lite-edit');
      laundered.push(path);
      console.log(`    Laundered; archived original to ${archivePath}`);
    } catch (err) {
      console.warn(`  Launder failed for ${path}: ${err}`);
      throw err;
    }
  }
  return laundered;
}
