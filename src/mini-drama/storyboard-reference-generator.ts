// ---------------------------------------------------------------------------
// Storyboard reference (blocking plate) generation
//
// A StoryboardReference is a COMPOSED image of a scene beat: multiple
// characters positioned in a location in relation to each other (and to key
// props). It is consumed as a reference_image_urls entry on @Image-tag R2V
// models (Seedance 2.0 family, HappyHorse 1.1 R2V) — NEVER as a start frame —
// with a role clause restricting it to composition/blocking authority.
//
// Composition strategy mirrors panel generation: generateWithReferences with
// each character's front.png as a face ref plus the location wide.png as an
// environment anchor, so the plate itself stays consistent with the canonical
// assets it will sit alongside in the reference array.
// ---------------------------------------------------------------------------

import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { VeniceClient } from '../venice/client.js';
import type { SeriesState, StoryboardReference, EpisodeScript, ShotScript } from '../series/types.js';
import {
  getCharacterDir,
  getLocationDir,
  getLocation,
  getStoryboardDir,
  getStoryboardRefPath,
} from '../series/manager.js';
import { generateWithReferences, generateImage } from '../venice/generate.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import { DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';
import type { CharacterReference } from '../venice/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';

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

export interface GenerateStoryboardReferenceOptions {
  /** Override the image-generation model (default: series imageDefaults / nano-banana-2). */
  model?: string;
  /** cfg_scale (default 10). */
  cfgScale?: number;
  /** Regenerate even if the plate already exists on disk (archives prior). */
  force?: boolean;
}

/**
 * Generate (or reuse) the composed blocking plate for a storyboard reference.
 * Writes `storyboards/<slug>.png` plus a `.prompt.json` sidecar, provenance
 * (hasFace matches whether characters were composed), and a recipe pass.
 * Returns the on-disk path.
 */
export async function generateStoryboardReference(
  client: VeniceClient,
  series: SeriesState,
  ref: StoryboardReference,
  options: GenerateStoryboardReferenceOptions = {},
): Promise<{ path: string; skipped: boolean }> {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating storyboard references.');
  }

  const dir = getStoryboardDir(series);
  await mkdir(dir, { recursive: true });
  const imgPath = getStoryboardRefPath(series, ref.slug);

  if (existsSync(imgPath) && !options.force) {
    return { path: imgPath, skipped: true };
  }
  if (existsSync(imgPath) && options.force) {
    const archive = imgPath.replace(/\.png$/, `-force-archive-${Date.now()}.png`);
    await rename(imgPath, archive);
  }

  const model = options.model
    ?? ref.referenceModel
    ?? series.videoDefaults.imageDefaults?.generationModel
    ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const cfgScale = options.cfgScale ?? 10;
  const aspect = series.storyboardAspectRatio ?? '16:9';
  const aestheticStr = buildAestheticString(series.aesthetic);

  // Gather character face refs (front.png per character).
  const refPaths: string[] = [];
  const charRefs: CharacterReference[] = [];
  for (const name of ref.characters) {
    const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    if (!char) {
      console.warn(`  Storyboard ref "${ref.slug}": character "${name}" not found in series — skipping their face ref.`);
      continue;
    }
    const frontPath = join(getCharacterDir(series, char.name), 'front.png');
    if (!existsSync(frontPath)) {
      console.warn(`  Storyboard ref "${ref.slug}": no front.png for ${char.name} — generate character references first.`);
      continue;
    }
    refPaths.push(frontPath);
    charRefs.push({
      name: char.name,
      role: char.description.slice(0, 80),
      base64Image: readFileSync(frontPath).toString('base64'),
    });
  }

  // Location environment ref (wide angle), appended after face refs.
  let locationSuffix = '';
  let locationSpatialAnchors = '';
  if (ref.location) {
    const loc = getLocation(series, ref.location);
    if (loc) {
      if (loc.spatialAnchors) {
        locationSpatialAnchors = ` Fixed location layout (never rearrange): ${loc.spatialAnchors}.`;
      }
      const locDir = getLocationDir(series, loc.slug);
      const wide = ['wide.png', 'medium.png', 'detail.png']
        .map(f => join(locDir, f))
        .find(p => existsSync(p));
      if (wide) {
        refPaths.push(wide);
        charRefs.push({
          name: 'LOCATION',
          role: 'environment reference — setting, architecture, lighting',
          base64Image: readFileSync(wide).toString('base64'),
        } as CharacterReference);
        locationSuffix = ' The final reference image is the location environment — match its setting, architecture, and lighting; it is not a character.';
      }
    }
  }

  // Blocking plates prioritize spatial clarity over cinematic drama: a clean
  // medium-wide view where every character, their positions, and the key
  // props are unambiguous. The video model reads geometry from this image.
  const promptParts = [
    `STYLE: ${aestheticStr}.`,
    'Single cinematic frame, one continuous image, NOT a comic panel layout, NO panel borders, NO speech bubbles, NO text overlays.',
    'Medium-wide blocking shot: every character fully visible, positions and spatial relationships unambiguous, clear staging.',
    'Place each character exactly where the description says — screen side, distance from camera, facing direction, and position relative to named landmarks all legible in one look.',
    `${ref.description}.`,
    ...(locationSpatialAnchors ? [locationSpatialAnchors.trim()] : []),
    `STYLE REMINDER: ${aestheticStr}.`,
  ];
  const prompt = promptParts.join(' ') + locationSuffix;

  const negativePrompt = [
    'comic panels', 'multiple panels', 'panel layout', 'panel borders', 'panel grid',
    'speech bubbles', 'text bubbles', 'split screen', 'multiple frames',
    'deformed', 'blurry', 'bad anatomy', 'watermark', 'text', 'signature', 'low quality',
  ].join(', ');

  let imgBuffer: Buffer;
  if (charRefs.length > 0) {
    const result = await generateWithReferences(client, {
      model,
      prompt,
      negative_prompt: negativePrompt,
      resolution: '1K',
      aspect_ratio: aspect,
      steps: 30,
      cfg_scale: cfgScale,
      seed: ref.seed,
      safe_mode: false,
      hide_watermark: true,
      referenceImages: charRefs,
      faceSlots: Math.min(ref.characters.length, 5),
    });
    imgBuffer = Buffer.from(result.base64, 'base64');
  } else {
    const response = await generateImage(client, {
      model,
      prompt,
      negative_prompt: negativePrompt,
      resolution: '1K',
      aspect_ratio: aspect,
      steps: 30,
      cfg_scale: cfgScale,
      seed: ref.seed,
      safe_mode: false,
      hide_watermark: true,
    });
    if (!response.images?.[0]) {
      throw new Error(`Storyboard reference "${ref.slug}": no image returned.`);
    }
    imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
  }

  const finalPath = await writeImageBytesSmart(imgBuffer, imgPath);
  console.log(`  Storyboard ref: saved -> ${basename(finalPath)}`);

  await writeFile(imgPath.replace(/\.png$/, '.prompt.json'), JSON.stringify({
    slug: ref.slug,
    episode: ref.episode,
    description: ref.description,
    characters: ref.characters,
    location: ref.location ?? null,
    shotIds: ref.shotIds,
    model,
    prompt,
    negative_prompt: negativePrompt,
    cfg_scale: cfgScale,
    aspect_ratio: aspect,
    resolution: '1K',
    seed: ref.seed,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  await appendRecipePass(finalPath, {
    kind: 'generate',
    role: 'identity',
    model,
    label: `storyboard blocking plate (${ref.slug})`,
    prompt,
    negativePrompt,
    seed: ref.seed,
    cfgScale,
    aspectRatio: aspect,
    resolution: '1K',
    referenceImagePaths: refPaths.length > 0 ? refPaths : undefined,
  }, { provenance: 'generate', hasFace: ref.characters.length > 0 });

  return { path: finalPath, skipped: false };
}

// ---------------------------------------------------------------------------
// Beat planning
// ---------------------------------------------------------------------------

function shotIdOf(shot: ShotScript): number | string {
  return shot.shotIdSuffix ? `${shot.shotNumber}${shot.shotIdSuffix}` : shot.shotNumber;
}

function seedFromString(s: string): number {
  return Math.abs([...s].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999;
}

/**
 * Plan storyboard blocking plates per scene BEAT (user decision 2026-07-30:
 * per-beat granularity, auto-planned, reused across the beat's shots).
 *
 * A beat is a maximal run of consecutive shots that:
 *   - involve 2+ characters (single-character shots don't need blocking), and
 *   - share the same location, and
 *   - keep an overlapping character set (a full cast change starts a new beat).
 *
 * Each beat gets one StoryboardReference whose description is synthesized
 * from the beat's first multi-character shot; shots in the beat get
 * `storyboardRef` set to the plate's slug. Pre-existing per-shot
 * `storyboardRef` values are always respected and never overwritten.
 */
export function planStoryboardBeats(script: EpisodeScript): StoryboardReference[] {
  const refs: StoryboardReference[] = [];
  const shots = script.shots;
  let i = 0;
  while (i < shots.length) {
    const shot = shots[i];
    const chars = shot.characters.map(c => c.toUpperCase());
    if (chars.length < 2) { i += 1; continue; }

    // Extend the beat window.
    let j = i + 1;
    while (j < shots.length) {
      const next = shots[j];
      const nextChars = next.characters.map(c => c.toUpperCase());
      if (nextChars.length < 2) break;
      if ((next.location ?? '') !== (shot.location ?? '')) break;
      if (!nextChars.some(c => chars.includes(c))) break;
      j += 1;
    }

    const beatShots = shots.slice(i, j);
    const allChars = Array.from(new Set(beatShots.flatMap(s => s.characters)));
    const slug = [
      `e${String(script.episode).padStart(2, '0')}`,
      `beat-${String(shotIdOf(beatShots[0]))}`,
      ...(shot.location ? [shot.location] : []),
    ].join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    // The plate's description is the beat's first shot plus its authored
    // spatial blocking (when present) — the blocking sentence is exactly the
    // geometry the plate exists to encode.
    const baseDescription = shot.panelDescription ?? shot.description;
    const plateDescription = shot.blocking
      ? `${baseDescription} ${shot.blocking}`
      : baseDescription;

    refs.push({
      slug,
      description: plateDescription,
      characters: allChars,
      ...(shot.location ? { location: shot.location } : {}),
      episode: script.episode,
      shotIds: beatShots.map(shotIdOf),
      seed: seedFromString(slug),
    });

    for (const s of beatShots) {
      if (!s.storyboardRef) s.storyboardRef = slug;
    }

    i = j;
  }
  return refs;
}

/**
 * Plan beats for an episode (idempotent — respects existing storyboardRefs
 * and previously planned plates), merge them into script.storyboardRefs, and
 * generate any plates missing on disk. Called from workshop-episode after
 * location generation, and best-effort from generate-videos so hand-edited
 * scripts pick up plates too.
 */
export async function ensureEpisodeStoryboardReferences(
  client: VeniceClient,
  series: SeriesState,
  script: EpisodeScript,
  options: GenerateStoryboardReferenceOptions = {},
): Promise<{ generated: string[]; skipped: string[] }> {
  const planned = planStoryboardBeats(script);
  const existing = script.storyboardRefs ?? [];
  const bySlug = new Map(existing.map(r => [r.slug, r]));
  for (const ref of planned) {
    if (!bySlug.has(ref.slug)) bySlug.set(ref.slug, ref);
  }
  script.storyboardRefs = Array.from(bySlug.values());

  const generated: string[] = [];
  const skipped: string[] = [];
  if (!series.aesthetic) {
    if (script.storyboardRefs.length > 0) {
      console.warn('  ⚠ Storyboard beats planned but series aesthetic is not set — skipping plate generation.');
    }
    return { generated, skipped };
  }

  for (const ref of script.storyboardRefs) {
    try {
      const result = await generateStoryboardReference(client, series, ref, options);
      (result.skipped ? skipped : generated).push(result.path);
    } catch (err) {
      console.warn(`  ⚠ Storyboard plate generation failed for "${ref.slug}": ${(err as Error).message}`);
    }
  }
  return { generated, skipped };
}
