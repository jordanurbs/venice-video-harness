// ---------------------------------------------------------------------------
// Location Reference Generation
//
// Locations are first-class environment entities (see Location in
// src/series/types.ts). Their reference images anchor the environment across
// storyboard panels, starting frames, and video generations — mirroring how
// character references anchor identity, and directly serving the
// lighting-consistency anti-pattern (AGENTS.md anti-pattern 7).
//
// Reference angles: wide (establishing), medium (mid-distance), detail
// (distinctive feature). Generated FACELESS with nano-banana-pro (default) and
// provenance hasFace:false, so they pass the Seedance pre-flight gate without
// laundering. Shared by the `add-location` CLI command and workshop-episode's
// auto-extraction so both paths produce identical assets.
// ---------------------------------------------------------------------------

import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { VeniceClient } from '../venice/client.js';
import type { Location, SeriesState } from '../series/types.js';
import { getLocationDir } from '../series/manager.js';
import { generateImage } from '../venice/generate.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import { DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';

export const LOCATION_ANGLES = ['wide', 'medium', 'detail'] as const;
export type LocationAngle = (typeof LOCATION_ANGLES)[number];

const ANGLE_PROMPTS: Record<LocationAngle, string> = {
  wide: 'wide establishing shot of the location, full environment visible, cinematic widescreen framing',
  medium: 'medium shot of the location, mid-distance framing showing the key features and spatial layout',
  detail: 'close detail shot of a distinctive feature of the location, texture and material detail',
};

function buildAestheticString(aesthetic: AestheticProfile): string {
  return [
    aesthetic.style,
    aesthetic.palette,
    aesthetic.lighting,
    aesthetic.lensCharacteristics,
    aesthetic.filmStock ? `shot on ${aesthetic.filmStock}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export interface GenerateLocationReferencesOptions {
  /** Override the image-generation model (default nano-banana-pro). */
  model?: string;
  /** cfg_scale (default 10). */
  cfgScale?: number;
  /** Regenerate angles that already exist on disk. */
  force?: boolean;
}

/**
 * Generate the three reference angles for a location. Writes
 * `locations/<slug>/{wide,medium,detail}.png` plus per-angle `.prompt.json`
 * sidecars, provenance (hasFace:false), and recipe passes. Returns the paths
 * that were (re)generated.
 */
export async function generateLocationReferences(
  client: VeniceClient,
  series: SeriesState,
  location: Location,
  options: GenerateLocationReferencesOptions = {},
): Promise<{ generated: string[]; skipped: string[] }> {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating location references.');
  }

  const dir = getLocationDir(series, location.slug);
  await mkdir(dir, { recursive: true });

  const model = options.model ?? location.referenceModel ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const cfgScale = options.cfgScale ?? 10;
  const aspect = series.storyboardAspectRatio ?? '16:9';
  const aestheticStr = buildAestheticString(series.aesthetic);
  const seed = location.seed;

  const generated: string[] = [];
  const skipped: string[] = [];

  for (const angle of LOCATION_ANGLES) {
    const imgPath = join(dir, `${angle}.png`);
    if (existsSync(imgPath) && !options.force) {
      skipped.push(imgPath);
      continue;
    }
    // Archive existing when forcing (asset-safety: never destructive).
    if (existsSync(imgPath) && options.force) {
      const archive = imgPath.replace(/\.png$/, `-force-archive-${Date.now()}.png`);
      await rename(imgPath, archive);
    }

    // Front-load STYLE (rule 11) so the environment holds the series look.
    const promptParts = [
      `STYLE: ${aestheticStr}.`,
      `${ANGLE_PROMPTS[angle]}.`,
      `${location.description}.`,
      location.lightingNotes ? `Lighting: ${location.lightingNotes}.` : '',
      // Locked geography (rule 49): bake the named landmarks and their fixed
      // relative positions into every reference angle so the three angles
      // depict ONE coherent space the video model can navigate.
      location.spatialAnchors ? `Layout: ${location.spatialAnchors}.` : '',
      'Empty environment, no people present, no human figures, uninhabited scene.',
      `STYLE REMINDER: ${aestheticStr}.`,
    ].filter(Boolean);
    const prompt = promptParts.join(' ');

    const negativePrompt = [
      'people', 'person', 'human', 'figure', 'silhouette', 'crowd',
      'deformed', 'blurry', 'low quality', 'watermark', 'text', 'signature',
      'comic panels', 'panel borders', 'multiple frames',
    ].join(', ');

    try {
      const response = await generateImage(client, {
        model,
        prompt,
        negative_prompt: negativePrompt,
        resolution: '1K',
        aspect_ratio: aspect,
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
      console.log(`  ${angle}: saved -> ${basename(finalPath)}`);

      const returnedSeed = (response.images[0] as { seed?: number }).seed;
      await writeFile(join(dir, `${angle}.prompt.json`), JSON.stringify({
        location: location.name,
        slug: location.slug,
        angle,
        model,
        prompt,
        negative_prompt: negativePrompt,
        cfg_scale: cfgScale,
        aspect_ratio: aspect,
        resolution: '1K',
        seed,
        returnedSeed,
        generatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');

      // Faceless by design → provenance hasFace:false so the Seedance
      // pre-flight gate (which checks sceneImagePaths + referenceImagePaths)
      // passes without laundering.
      await appendRecipePass(finalPath, {
        kind: 'generate',
        role: 'content',
        model,
        label: `location reference (${location.name}, ${angle})`,
        prompt,
        negativePrompt,
        seed,
        cfgScale,
        aspectRatio: aspect,
        resolution: '1K',
      }, { provenance: 'generate', hasFace: false });

      generated.push(finalPath);
    } catch (err) {
      console.warn(`  ${angle}: failed - ${err}`);
    }
  }

  return { generated, skipped };
}
