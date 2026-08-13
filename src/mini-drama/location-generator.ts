// ---------------------------------------------------------------------------
// Location Reference Generation (anchor → derive, 2026-08-13)
//
// Locations are first-class environment entities (see Location in
// src/series/types.ts). Their reference images anchor the environment across
// storyboard panels, starting frames, and video generations — mirroring how
// character references anchor identity, and directly serving the
// lighting-consistency anti-pattern (AGENTS.md anti-pattern 7).
//
// THE ANGLES ARE ONE COHERENT SPACE. `wide.png` is the ONLY from-scratch
// text-to-image generation — the hero establishing plate. Every other angle
// (`angle-2`, `angle-3`, `angle-4`, and any custom coverage) is DERIVED by
// multi-editing `wide.png` with the edit model (nano-banana-2-edit by
// default), the same anchor→derive pattern character references use. This is
// the fix for the old wide/medium/detail ladder, where each angle was an
// INDEPENDENT t2i call (same seed, different prompt) that produced three
// visibly different rooms — the video model was then handed three "same
// place" references that disagreed, and the environment drifted. Deriving
// from one plate guarantees every angle is the same physical space; the edit
// model preserves the 16:9 frame (no 1:1 crop distortion).
//
// Generated FACELESS with provenance hasFace:false, so they pass the Seedance
// pre-flight gate without laundering. Shared by the `add-location` CLI command
// and workshop-episode's auto-extraction so both paths produce identical
// assets.
// ---------------------------------------------------------------------------

import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { VeniceClient } from '../venice/client.js';
import type { Location, SeriesState } from '../series/types.js';
import { getLocationDir } from '../series/manager.js';
import { generateImage } from '../venice/generate.js';
import { multiEditImage, loadImageAsDataUri } from '../venice/multi-edit.js';
import {
  ensureRealPng,
  restoreAspectRatio,
  aspectRatioToDimensions,
  getImageDimensions,
} from '../venice/edit-post.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
} from '../series/types.js';
import type { MultiEditModel } from '../venice/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';

/** The one from-scratch angle; every other angle is derived from it. */
export const WIDE_ANGLE = 'wide';

/** Derived alternate viewpoints of the SAME room, in generation order. */
export const DERIVED_ANGLES = ['angle-2', 'angle-3', 'angle-4'] as const;

/** The default set generated per location: wide + three derived angles. */
export const DEFAULT_LOCATION_ANGLES = [WIDE_ANGLE, ...DERIVED_ANGLES] as const;

/**
 * Legacy distance-ladder names from before 2026-08-13. Still recognized so an
 * old project can regenerate them, and still read by the reference-slot
 * allocator when present on disk — but no longer part of the default set.
 */
export const LEGACY_LOCATION_ANGLES = ['medium', 'detail'] as const;

/** @deprecated Back-compat alias — was `['wide','medium','detail']`. */
export const LOCATION_ANGLES = DEFAULT_LOCATION_ANGLES;
export type LocationAngle = (typeof DEFAULT_LOCATION_ANGLES)[number];

const WIDE_VIEW =
  'wide establishing shot of the location, full environment visible, cinematic widescreen framing';

/**
 * Default re-framings for the non-wide canonical angles. Room-agnostic and
 * grounded in the wide base image the editor sees. Each LEADS with the new
 * foreground: a ">90° turn away from X" instruction phrased as a negative
 * ("window behind camera") tends to revert the edit to the master framing —
 * describing the wall that should FILL the new frame holds far better.
 */
const KNOWN_ANGLE_VIEWS: Record<string, string> = {
  'angle-2':
    'Reverse angle of the SAME room: place the camera on the opposite side and look back toward where the establishing shot was taken, so the far wall of the establishing view now fills the background. Medium-wide framing.',
  'angle-3':
    'Turn the camera to face the LEFT-hand wall of the SAME room — the wall running along the left edge of the reference image now fills the frame, seen close to straight on. Medium framing.',
  'angle-4':
    'Turn the camera to face the RIGHT-hand wall of the SAME room — the wall running along the right edge of the reference image now fills the frame, seen close to straight on. Medium framing.',
  // Legacy ladder, kept so `--angles medium,detail` still works on old projects.
  'medium':
    'a tighter medium view of the SAME room from roughly the establishing position, mid-distance framing of its key features',
  'detail':
    'a close detail view within the SAME room of one distinctive feature — texture and material detail, identical lighting',
};

/** Names that carry their own default view clause (no `--prompt` required). */
const KNOWN_ANGLE_NAMES = new Set<string>([
  WIDE_ANGLE,
  ...DERIVED_ANGLES,
  ...LEGACY_LOCATION_ANGLES,
]);

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
  /** Override the wide-plate (t2i) generation model (default nano-banana-2). */
  model?: string;
  /** Override the derived-angle edit model (default nano-banana-2-edit). */
  editModel?: string;
  /** cfg_scale for the wide plate (default 10). */
  cfgScale?: number;
  /** Regenerate angles that already exist on disk. */
  force?: boolean;
  /**
   * Only (re)generate this subset of angles. Default: the canonical set
   * (wide + angle-2/angle-3/angle-4). `wide` is generated from scratch; every
   * other angle is DERIVED by multi-editing wide.png. Names outside the known
   * set are CUSTOM angles — extra coverage of the same space
   * ("reverse-angle", "behind-the-desk", "night") — and require
   * `promptOverride` to describe the new view. Custom angles are saved as
   * `<name>.png` beside the canonical set and picked up automatically by the
   * reference-slot allocator as additional location slots. Deriving any angle
   * requires `wide.png`; it is generated first automatically when missing.
   */
  angles?: string[];
  /**
   * Inline positive-prompt override. On `wide` it REPLACES the whole t2i
   * prompt verbatim. On any derived angle it becomes the VIEW clause composed
   * into the same-room edit build (required for custom angles).
   */
  promptOverride?: string;
}

/** Filesystem-safe custom-angle name: kebab-case, no path tricks. */
export function sanitizeAngleName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Absolute path to the location's wide plate (png preferred, webp fallback). */
function resolveWidePath(dir: string): string | undefined {
  return ['wide.png', 'wide.webp'].map(f => join(dir, f)).find(p => existsSync(p));
}

/**
 * Generate the reference angles for a location. `wide.png` is generated from
 * scratch (t2i); `angle-2/3/4` (and any custom angles) are DERIVED by
 * multi-editing wide.png so every angle is the same physical space. Writes
 * `locations/<slug>/<angle>.png` plus per-angle `.prompt.json` sidecars,
 * provenance (hasFace:false), and recipe passes. Returns the paths that were
 * (re)generated.
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

  const genModel = options.model ?? location.referenceModel ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const editModel = (options.editModel
    ?? series.videoDefaults?.imageDefaults?.editModel
    ?? DEFAULT_IMAGE_EDIT_MODEL) as MultiEditModel;
  const cfgScale = options.cfgScale ?? 10;
  const aspect = series.storyboardAspectRatio ?? '16:9';
  const aestheticStr = buildAestheticString(series.aesthetic);
  const seed = location.seed;

  const generated: string[] = [];
  const skipped: string[] = [];

  // Resolve the requested angle list: canonical names pass through; anything
  // else becomes a sanitized custom angle (needs a --prompt to describe it).
  let anglesToRun: string[] = options.angles?.length
    ? options.angles.map(angle =>
        KNOWN_ANGLE_NAMES.has(angle) ? angle : sanitizeAngleName(angle),
      ).filter(Boolean)
    : [...DEFAULT_LOCATION_ANGLES];

  const customWithoutPrompt = anglesToRun.filter(
    angle => !KNOWN_ANGLE_NAMES.has(angle) && !options.promptOverride,
  );
  if (customWithoutPrompt.length > 0) {
    throw new Error(
      `Custom angle(s) ${customWithoutPrompt.join(', ')} need --prompt to describe the new view — ` +
      'the default build only knows wide/angle-2/angle-3/angle-4.',
    );
  }

  // Deriving any non-wide angle needs the wide plate on disk. Ensure it is
  // generated first (prepended, deduped, and always processed before the
  // derived angles below).
  const needsWide = anglesToRun.some(a => a !== WIDE_ANGLE);
  const wideExists = Boolean(resolveWidePath(dir));
  if (needsWide && !wideExists && !anglesToRun.includes(WIDE_ANGLE)) {
    console.log('  wide plate missing — generating it first so angles can derive from it.');
    anglesToRun = [WIDE_ANGLE, ...anglesToRun];
  }
  // Always process wide before its derivations.
  anglesToRun = Array.from(new Set(anglesToRun)).sort((a, b) =>
    a === WIDE_ANGLE ? -1 : b === WIDE_ANGLE ? 1 : 0,
  );

  // Object cast members (recurring hero props) must NOT be baked into location
  // plates — a plate that paints its own THE LEDGER becomes a duplicate
  // look-alike when the real reference is composited per shot. Locations are
  // empty stages; hero props enter per shot via their own references.
  const objectCastNouns = (series.characters ?? [])
    .filter(c => /^\s*inanimate object/i.test(c.baseTraits ?? ''))
    .map(c => c.name.replace(/^THE\s+/i, '').toLowerCase().trim())
    .filter(Boolean);
  const cleanPlateClause = objectCastNouns.length > 0
    ? `Clean plate: the hero props (${objectCastNouns.join(', ')}) are NOT present — surfaces are clear of them; they are photographed separately.`
    : '';

  for (const angle of anglesToRun) {
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

    try {
      if (angle === WIDE_ANGLE) {
        await generateWidePlate(client, {
          dir, imgPath, location, genModel, cfgScale, aspect, seed,
          aestheticStr, objectCastNouns, cleanPlateClause,
          promptOverride: options.promptOverride,
        });
      } else {
        const widePath = resolveWidePath(dir);
        if (!widePath) {
          console.warn(`  ${angle}: wide plate not found — cannot derive this angle. Generate wide first.`);
          continue;
        }
        await deriveAngleFromWide(client, {
          dir, imgPath, angle, widePath, editModel, aspect,
          location, aestheticStr, cleanPlateClause,
          viewClause: KNOWN_ANGLE_NAMES.has(angle)
            ? (KNOWN_ANGLE_VIEWS[angle] ?? options.promptOverride!)
            : options.promptOverride!,
        });
      }
      generated.push(imgPath);
    } catch (err) {
      console.warn(`  ${angle}: failed - ${(err as Error).message}`);
    }
  }

  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// Wide plate (from-scratch t2i)
// ---------------------------------------------------------------------------

async function generateWidePlate(
  client: VeniceClient,
  args: {
    dir: string; imgPath: string; location: Location; genModel: string;
    cfgScale: number; aspect: string; seed: number; aestheticStr: string;
    objectCastNouns: string[]; cleanPlateClause: string; promptOverride?: string;
  },
): Promise<void> {
  const {
    dir, imgPath, location, genModel, cfgScale, aspect, seed,
    aestheticStr, objectCastNouns, cleanPlateClause, promptOverride,
  } = args;

  // Front-load STYLE (rule 11) so the environment holds the series look.
  const promptParts = [
    `STYLE: ${aestheticStr}.`,
    `${WIDE_VIEW}.`,
    `${location.description}.`,
    location.lightingNotes ? `Lighting: ${location.lightingNotes}.` : '',
    // Locked geography (rule 49): bake the named landmarks and their fixed
    // relative positions into the wide plate so the derived angles inherit
    // one coherent space.
    location.spatialAnchors ? `Layout: ${location.spatialAnchors}.` : '',
    'Empty environment, no people present, no human figures, uninhabited scene.',
    cleanPlateClause,
    `STYLE REMINDER: ${aestheticStr}.`,
  ].filter(Boolean);
  const prompt = promptOverride ? promptOverride : promptParts.join(' ');

  const negativePrompt = [
    'people', 'person', 'human', 'figure', 'silhouette', 'crowd',
    'deformed', 'blurry', 'low quality', 'watermark', 'text', 'signature',
    'comic panels', 'panel borders', 'multiple frames',
    ...objectCastNouns,
  ].join(', ');

  const response = await generateImage(client, {
    model: genModel,
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
    throw new Error('no image returned');
  }
  const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
  const finalPath = await writeImageBytesSmart(imgBuffer, imgPath);
  console.log(`  wide: saved -> ${basename(finalPath)} (hero plate)`);

  const returnedSeed = (response.images[0] as { seed?: number }).seed;
  await writeFile(join(dir, 'wide.prompt.json'), JSON.stringify({
    location: location.name,
    slug: location.slug,
    angle: 'wide',
    kind: 'generate',
    model: genModel,
    prompt,
    negative_prompt: negativePrompt,
    cfg_scale: cfgScale,
    aspect_ratio: aspect,
    resolution: '1K',
    seed,
    returnedSeed,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  await appendRecipePass(finalPath, {
    kind: 'generate',
    role: 'content',
    model: genModel,
    label: `location reference (${location.name}, wide hero plate)`,
    prompt,
    negativePrompt,
    seed,
    cfgScale,
    aspectRatio: aspect,
    resolution: '1K',
  }, { provenance: 'generate', hasFace: false });
}

// ---------------------------------------------------------------------------
// Derived angle (multi-edit of the wide plate — same room, new viewpoint)
// ---------------------------------------------------------------------------

async function deriveAngleFromWide(
  client: VeniceClient,
  args: {
    dir: string; imgPath: string; angle: string; widePath: string;
    editModel: MultiEditModel; aspect: string; location: Location;
    aestheticStr: string; cleanPlateClause: string; viewClause: string;
  },
): Promise<void> {
  const {
    dir, imgPath, angle, widePath, editModel, aspect, location,
    aestheticStr, cleanPlateClause, viewClause,
  } = args;

  const prompt = [
    `STYLE: ${aestheticStr}.`,
    `${viewClause}.`,
    // Same-room contract: keep everything but the camera fixed. This is what
    // makes the angle set ONE coherent space instead of a fresh imagining.
    'This is the SAME room shown in the reference image — keep every surface, ' +
    'material, colour, architectural feature, and the exact lighting identical; ' +
    'only the camera position changes. Do not add, remove, or rearrange ' +
    'furniture; do not redecorate; do not change the architecture.',
    location.spatialAnchors ? `Known layout (do not rearrange): ${location.spatialAnchors}.` : '',
    cleanPlateClause,
    'Empty environment, no people, no human figures.',
    'Render as a single continuous cinematic frame — no panels, no split ' +
    'screen, no inset views, no text, no labels.',
    `STYLE REMINDER: ${aestheticStr}.`,
  ].filter(Boolean).join(' ');

  const baseUri = await loadImageAsDataUri(widePath);
  const resultBuffer = await multiEditImage(client, {
    model: editModel,
    prompt,
    baseImage: baseUri,
    // NO reference layers — a pure single-image re-angle of the wide plate.
  });

  await writeFile(imgPath, resultBuffer);
  await ensureRealPng(imgPath);
  // Match the derived angle to the wide plate's EXACT dimensions (not the
  // theoretical ratio) so a same-size edit is a true no-op. nano-banana-2-edit
  // preserves the input frame; seedream-*-edit returns 1:1 and gets crop-fit
  // to the wide's shape here. Fall back to the series ratio if the wide's dims
  // can't be read.
  const targetDims = getImageDimensions(widePath) ?? aspectRatioToDimensions(aspect);
  if (targetDims) await restoreAspectRatio(imgPath, targetDims[0], targetDims[1]);

  console.log(`  ${angle}: saved -> ${basename(imgPath)} (derived from wide via ${editModel})`);

  await writeFile(join(dir, `${angle}.prompt.json`), JSON.stringify({
    location: location.name,
    slug: location.slug,
    angle,
    kind: 'multi-edit',
    model: editModel,
    base: basename(widePath),
    prompt,
    aspect_ratio: aspect,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  await appendRecipePass(imgPath, {
    kind: 'multi-edit',
    role: 'content',
    model: editModel,
    label: `location reference (${location.name}, ${angle}) derived from wide`,
    prompt,
    referenceImagePaths: [widePath],
    aspectRatio: aspect,
  }, { provenance: 'edit', hasFace: false });
}
