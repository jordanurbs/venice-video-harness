// ---------------------------------------------------------------------------
// Capability manifest — the machine-readable export of the probe-verified
// registry, consumed by downstream clients (the Venice Video Creator macOS
// app fetches it at launch to keep its VideoModelCapabilities allowlists in
// sync without an app release).
//
// The manifest is DATA ONLY: model specs, capability sets, budgets, prompt
// caps, and routing defaults. Behavior (prompt builders, planners) still
// ships with each client. Schema changes bump `schemaVersion`; clients must
// ignore unknown fields and reject manifests with a schemaVersion greater
// than what they understand (falling back to their bundled snapshot).
//
// Emit with:  venice-video capabilities --json   (or `capabilities > file`)
// A snapshot is written to capabilities.json at the repo root by
// `npm run manifest` and published with every release, so clients can fetch
// https://raw.githubusercontent.com/jordanurbs/venice-video-harness/main/capabilities.json
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  VIDEO_MODELS,
  IMAGE_GENERATION_MODELS,
  MULTI_EDIT_MODELS,
  MUSIC_MODELS,
  TTS_MODELS,
  MAX_POSITIVE_PROMPT_CHARS,
  DEFAULT_MAX_POSITIVE_PROMPT_CHARS,
} from './models.js';
import {
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  DEFAULT_MULTISHOT_MODEL,
  DEFAULT_LIP_SYNC_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  MODELS_SUPPORTING_END_IMAGE,
  MODELS_USING_IMAGE_TAGS,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_SUPPORTING_PER_REFERENCE_AUDIO,
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  MAX_REFERENCE_IMAGES_BY_MODEL,
  DEFAULT_MAX_REFERENCE_IMAGES,
} from '../series/types.js';

/** Bump when the manifest SHAPE changes (not when registry data changes). */
export const CAPABILITIES_SCHEMA_VERSION = 1;

export interface CapabilitiesManifest {
  schemaVersion: number;
  /** Harness package version the manifest was generated from. */
  harnessVersion: string;
  generatedAt: string;
  /** Full probe-verified video model specs (verbatim VIDEO_MODELS). */
  videoModels: typeof VIDEO_MODELS;
  /** Exact-id capability sets (authoritative; supersede family substrings). */
  capabilitySets: {
    elements: string[];
    referenceImages: string[];
    sceneImages: string[];
    endImage: string[];
    /** Pure-reference models that honor @ImageN prompt tags and reject image_url. */
    imageTags: string[];
    audioInput: string[];
    perReferenceAudio: string[];
    referenceAudio: string[];
  };
  budgets: {
    maxReferenceImagesByModel: Record<string, number>;
    defaultMaxReferenceImages: number;
    maxPositivePromptCharsByImageModel: Record<string, number>;
    defaultMaxPositivePromptChars: number;
    /** Venice video prompt cap (Seedance family, multi-shot prompts). */
    videoPromptCharLimit: number;
  };
  defaults: {
    actionModel: string;
    atmosphereModel: string;
    characterConsistencyModel: string;
    multiShotModel: string;
    lipSyncModel: string;
    imageGenerationModel: string;
    imageEditModel: string;
  };
  imageGenerationModels: typeof IMAGE_GENERATION_MODELS;
  multiEditModels: string[];
  musicModels: typeof MUSIC_MODELS;
  ttsModels: string[];
}

function harnessVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the manifest from the live registry constants.
 * Pass `generatedAt` to pin the timestamp (the snapshot script does, so the
 * committed capabilities.json only changes when the DATA changes).
 */
export function buildCapabilitiesManifest(generatedAt?: string): CapabilitiesManifest {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    harnessVersion: harnessVersion(),
    generatedAt: generatedAt ?? new Date().toISOString(),
    videoModels: VIDEO_MODELS,
    capabilitySets: {
      elements: [...MODELS_SUPPORTING_ELEMENTS].sort(),
      referenceImages: [...MODELS_SUPPORTING_REFERENCE_IMAGES].sort(),
      sceneImages: [...MODELS_SUPPORTING_SCENE_IMAGES].sort(),
      endImage: [...MODELS_SUPPORTING_END_IMAGE].sort(),
      imageTags: [...MODELS_USING_IMAGE_TAGS].sort(),
      audioInput: [...MODELS_SUPPORTING_AUDIO_INPUT].sort(),
      perReferenceAudio: [...MODELS_SUPPORTING_PER_REFERENCE_AUDIO].sort(),
      referenceAudio: [...MODELS_SUPPORTING_REFERENCE_AUDIO].sort(),
    },
    budgets: {
      maxReferenceImagesByModel: { ...MAX_REFERENCE_IMAGES_BY_MODEL },
      defaultMaxReferenceImages: DEFAULT_MAX_REFERENCE_IMAGES,
      maxPositivePromptCharsByImageModel: { ...MAX_POSITIVE_PROMPT_CHARS },
      defaultMaxPositivePromptChars: DEFAULT_MAX_POSITIVE_PROMPT_CHARS,
      videoPromptCharLimit: 2500,
    },
    defaults: {
      actionModel: DEFAULT_ACTION_MODEL,
      atmosphereModel: DEFAULT_ATMOSPHERE_MODEL,
      characterConsistencyModel: DEFAULT_CHARACTER_CONSISTENCY_MODEL,
      multiShotModel: DEFAULT_MULTISHOT_MODEL,
      lipSyncModel: DEFAULT_LIP_SYNC_MODEL,
      imageGenerationModel: DEFAULT_IMAGE_GENERATION_MODEL,
      imageEditModel: DEFAULT_IMAGE_EDIT_MODEL,
    },
    imageGenerationModels: IMAGE_GENERATION_MODELS,
    multiEditModels: [...MULTI_EDIT_MODELS],
    musicModels: MUSIC_MODELS,
    ttsModels: [...TTS_MODELS],
  };
}

/** Deterministic JSON (stable for diffing snapshot commits). */
export function renderCapabilitiesManifest(generatedAt?: string): string {
  return JSON.stringify(buildCapabilitiesManifest(generatedAt), null, 2) + '\n';
}
