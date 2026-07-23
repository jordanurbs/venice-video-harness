// ---------------------------------------------------------------------------
// Shot Recipe Sidecar
//
// A per-asset, append-only log of every AI-model call that produced or
// transformed the asset. Where the provenance sidecar answers "which model
// families touched this file?" (for the Seedance compatibility gate), the
// recipe sidecar answers "how do I reproduce or continue this asset with
// another AI call?".
//
// Design intent: a project started with the harness can be FINISHED by any
// AI-driven workflow (an agent, the MCP, a manual operator directing edit
// models). The recipe is the complete handoff contract — each entry is a
// replayable Venice API call: model, prompt, negative prompt, seed, cfg,
// and the reference images that were attached (by stable path, never by
// data: URI).
//
// Storage format
// --------------
// For `/path/to/shot-003.png` (or `.mp4`) we write
// `/path/to/shot-003.recipe.json`:
//
//   {
//     "asset": "shot-003.png",
//     "passes": [
//       { "pass": 1, "kind": "generate", "role": "content", "model": "seedream-v5-lite", ... },
//       { "pass": 2, "kind": "multi-edit", "role": "identity", "model": "seedream-v5-lite-edit", ... },
//       { "pass": 3, "kind": "multi-edit", "role": "look", ... }
//     ],
//     "createdAt": "...",
//     "updatedAt": "..."
//   }
//
// Roles let a finishing agent reason about what is safe to redo:
//   - "content"  — establishes what is in the frame (base generation, scene-ref injection)
//   - "identity" — anchors character identity (character-refine passes, R2V identity locks)
//   - "look"     — style/grade only (style-match passes, polish edits)
//   - "mechanical" — local non-AI ops that changed pixels (aspect-restore crop, format conversion)
//
// Finishing convention: any AI pass applied after the harness hands off MUST
// be appended here too (and, for face-bearing images edited by a non-seedream
// model, recorded via recordEditProvenance so the Seedance gate stays honest).
// Use `appendRecipePass()` for both — it writes recipe + provenance together.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { writeImageProvenance, recordEditProvenance } from './provenance.js';

// ---- Types ----------------------------------------------------------------

/** What a pass did to the asset. */
export type RecipePassKind =
  | 'generate'        // text(+refs)-to-image base generation
  | 'multi-edit'      // layered image edit (refine / style-match / scene-ref / polish)
  | 'upscale'
  | 'video-generate'  // video queue call (i2v / r2v / t2v)
  | 'tts'
  | 'mechanical';     // local pixel op — logged so finishers know it happened

/** Which layer of the shot the pass belongs to (see module comment). */
export type RecipePassRole = 'content' | 'identity' | 'look' | 'mechanical';

export interface RecipePass {
  /** 1-based position in the chain. Assigned automatically on append. */
  pass: number;
  kind: RecipePassKind;
  role: RecipePassRole;
  /** Venice model slug, or a tool name for mechanical passes (e.g. "ffmpeg"). */
  model: string;
  /** Free-form label, e.g. "base panel", "character refine", "style match", "finishing polish". */
  label?: string;
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  cfgScale?: number;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  /**
   * Stable on-disk paths of every reference image attached to the call
   * (character angles, style anchor, scene refs). Data URIs must be
   * resolved to their source path by the caller before logging.
   */
  referenceImagePaths?: string[];
  /** For video passes: the start-frame / keyframe image. */
  anchorImagePath?: string;
  /** For video passes: the end-frame target image. */
  endImagePath?: string;
  /** For lip-sync passes: the dialogue/audio file attached. */
  audioPath?: string;
  /** Where the pre-pass version of the asset was archived, if it was. */
  archivedPrevious?: string;
  /** Anything model- or pass-specific worth keeping (e.g. elements mapping, crop geometry). */
  extra?: Record<string, unknown>;
  at: string;
}

export interface ShotRecipe {
  asset: string;
  passes: RecipePass[];
  createdAt: string;
  updatedAt: string;
}

export interface AppendRecipeOptions {
  /**
   * Also update the provenance sidecar in the same call (images only).
   *   - 'generate': writeImageProvenance(model) — for kind 'generate'
   *   - 'edit':     recordEditProvenance(model) — for kind 'multi-edit' / 'upscale'
   *   - false / undefined: recipe only (video files, mechanical ops, or callers
   *     that manage provenance themselves)
   */
  provenance?: 'generate' | 'edit' | false;
  /** hasFace flag forwarded to the provenance write. */
  hasFace?: boolean;
}

// ---- Path helpers ---------------------------------------------------------

export function recipeSidecarPath(assetPath: string): string {
  return assetPath.replace(/\.(png|jpg|jpeg|webp|mp4|mov|mp3|wav)$/i, '.recipe.json');
}

// ---- Read / append --------------------------------------------------------

export async function readShotRecipe(assetPath: string): Promise<ShotRecipe | null> {
  const sidecar = recipeSidecarPath(assetPath);
  if (!existsSync(sidecar)) return null;
  try {
    const raw = await readFile(sidecar, 'utf-8');
    return JSON.parse(raw) as ShotRecipe;
  } catch {
    return null;
  }
}

/**
 * Append one pass to the asset's recipe sidecar (creating it if needed), and
 * optionally record provenance in the same step so the two sidecars can never
 * drift apart. This is the single write-path both the harness pipeline and
 * any finishing script should use.
 *
 * Never throws — recipe logging must not break a render that already
 * succeeded. Failures are reported on stderr.
 */
export async function appendRecipePass(
  assetPath: string,
  pass: Omit<RecipePass, 'pass' | 'at'>,
  options: AppendRecipeOptions = {},
): Promise<void> {
  try {
    const sidecar = recipeSidecarPath(assetPath);
    await mkdir(dirname(sidecar), { recursive: true });

    const existing = await readShotRecipe(assetPath);
    const now = new Date().toISOString();

    const entry: RecipePass = {
      ...pass,
      pass: (existing?.passes.length ?? 0) + 1,
      at: now,
    };

    const next: ShotRecipe = {
      asset: existing?.asset ?? basename(assetPath),
      passes: [...(existing?.passes ?? []), entry],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await writeFile(sidecar, JSON.stringify(next, null, 2), 'utf-8');

    if (options.provenance === 'generate') {
      await writeImageProvenance(assetPath, pass.model, [], { hasFace: options.hasFace });
    } else if (options.provenance === 'edit') {
      await recordEditProvenance(assetPath, pass.model, { hasFace: options.hasFace });
    }
  } catch (err) {
    console.warn(`  ⚠ recipe sidecar write failed for ${assetPath}: ${(err as Error).message}`);
  }
}
