import type { AestheticProfile } from '../storyboard/prompt-builder.js';

// ---------------------------------------------------------------------------
// Project / Series State
// ---------------------------------------------------------------------------

export interface SeriesState {
  name: string;
  slug: string;
  concept: string;
  genre: string;
  setting: string;
  aesthetic: AestheticProfile | null;
  aestheticSeed?: number;
  characters: Character[];
  episodes: EpisodeMeta[];
  videoDefaults: VideoModelDefaults;
  storyboardAspectRatio?: '16:9' | '9:16' | '1:1';
  outputDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoModelDefaults {
  actionModel: string;
  atmosphereModel: string;
  characterConsistencyModel?: string;
  /**
   * Paired image-generation defaults. When the video family is Seedance 2.0,
   * Venice blocks requests that include images produced by any other family,
   * so the image defaults must match the video family.
   */
  imageDefaults?: ImageModelDefaults;
  /**
   * Strategy when an incompatible (non-seedream) image is about to be sent
   * to a Seedance model. Defaults to `prompt` in interactive shells and
   * `fallback` in non-TTY environments.
   */
  seedanceCompatibility?: SeedanceCompatibilityMode;
}

export interface ImageModelDefaults {
  /** Image generation model (t2i) — e.g. `seedream-v5-lite`, `nano-banana-pro`. */
  generationModel: string;
  /** Multi-edit model — e.g. `seedream-v5-lite-edit`, `nano-banana-pro-edit`. */
  editModel: string;
}

export type SeedanceCompatibilityMode = 'prompt' | 'fallback' | 'launder';

// ---------------------------------------------------------------------------
// Character (general-purpose, not mini-drama specific)
// ---------------------------------------------------------------------------

export interface Character {
  name: string;
  gender: 'male' | 'female' | 'other';
  age: string;
  description: string;
  fullDescription: string;
  wardrobe: string;
  voiceDescription: string;
  voiceId?: string;
  voiceName?: string;
  baseTraits?: string;
  locked: boolean;
  seed: number;
}

/**
 * @deprecated Use Character instead. Kept for backward compatibility.
 */
export type MiniDramaCharacter = Character;

// ---------------------------------------------------------------------------
// Episode / Script
// ---------------------------------------------------------------------------

export interface EpisodeMeta {
  number: number;
  title: string;
  status: 'draft' | 'scripted' | 'storyboarded' | 'produced' | 'assembled';
}

export interface EpisodeScript {
  episode: number;
  title: string;
  seriesName: string;
  totalDuration: string;
  status?: 'draft' | 'approved';
  shots: ShotScript[];
}

// ---------------------------------------------------------------------------
// Shot Environment
// ---------------------------------------------------------------------------

export type ShotEnvironment =
  | 'DAY_INTERIOR'
  | 'DAY_EXTERIOR'
  | 'NIGHT_INTERIOR'
  | 'NIGHT_EXTERIOR';

export const DAYTIME_ENVIRONMENTS = new Set<ShotEnvironment>(['DAY_INTERIOR', 'DAY_EXTERIOR']);
export const INTERIOR_ENVIRONMENTS = new Set<ShotEnvironment>(['DAY_INTERIOR', 'NIGHT_INTERIOR']);

// ---------------------------------------------------------------------------
// Shot Script
// ---------------------------------------------------------------------------

export interface ShotScript {
  shotNumber: number;
  type: 'establishing' | 'dialogue' | 'action' | 'reaction' | 'insert' | 'close-up';
  duration: string;
  videoModel: 'action' | 'atmosphere';
  environment?: ShotEnvironment;
  description: string;
  panelDescription?: string;
  characters: string[];
  /**
   * Characters visible as silhouettes/distant figures but not requiring R2V
   * identity anchoring. Included in panel prompts but don't trigger R2V routing.
   * Example: a silhouetted figure in a doorway for an establishing shot.
   */
  silhouetteCharacters?: string[];
  dialogue: { character: string; line: string; delivery?: string } | null;
  sfx: string | null;
  cameraMovement: string;
  transition: string;
  trimStart?: number;
  trimEnd?: number;
  flip?: boolean;
  allowMultiShot?: boolean;
  mustStaySingle?: boolean;
  continuityPriority?: 'identity' | 'continuity' | 'balanced';
  titleOverlay?: {
    text: string;
    fadeInSec?: number;
    holdSec?: number;
  };
  episodeWardrobe?: Record<string, string>;
  skipRefine?: boolean;
  useElements?: boolean;
  useReferenceImages?: boolean;
  sceneImagePaths?: string[];
  /** Describes what the scene reference image should visually contribute (used in Pass 3 multi-edit). */
  sceneRefDescription?: string;
  /** Negative prompt appended during video generation for this shot. */
  negativePrompt?: string;
  /** Audio URL to use as background audio input for models that support it. */
  audioUrl?: string;
  /** Video URL to use as reference input for models that support it. */
  videoUrl?: string;
}

// ---------------------------------------------------------------------------
// Generation Planning
// ---------------------------------------------------------------------------

export type GenerationUnitType = 'single' | 'kling-multishot';
export type StartFrameStrategy = 'panel' | 'previous-last-frame';
export type EndFrameStrategy = 'natural' | 'next-panel-target';

export interface GenerationUnitSegment {
  shotNumber: number;
  startOffsetSec: number;
  durationSec: number;
  outputFile: string;
}

export interface GenerationUnit {
  unitId: string;
  unitType: GenerationUnitType;
  shotNumbers: number[];
  outputFile: string;
  model: string;
  duration: string;
  startFrameStrategy: StartFrameStrategy;
  endFrameStrategy: EndFrameStrategy;
  decisionReasons: string[];
  fallbackToSingles: boolean;
  renderedDurationSec?: number;
  segments?: GenerationUnitSegment[];
}

export interface GenerationPlan {
  episode: number;
  generatedAt: string;
  units: GenerationUnit[];
}

// ---------------------------------------------------------------------------
// Default Models
//
// These are sensible defaults. Override per-project via series.json videoDefaults.
// ---------------------------------------------------------------------------

export const DEFAULT_ACTION_MODEL = 'seedance-2-0-image-to-video';
export const DEFAULT_ATMOSPHERE_MODEL = 'seedance-2-0-image-to-video';
export const DEFAULT_CHARACTER_CONSISTENCY_MODEL = 'seedance-2-0-reference-to-video';
export const KLING_R2V_MODEL = 'kling-o3-standard-reference-to-video';
export const KLING_MULTISHOT_MODEL = 'kling-o3-pro-image-to-video';

/**
 * Paired image defaults for the Seedance family. Seedance 2.0 blocks any
 * request whose input images were not produced by `seedream-v5-lite` or
 * edited by `seedream-v5-lite-edit`, so these are the only compatible
 * defaults when the video target is a Seedance model.
 */
export const DEFAULT_IMAGE_GENERATION_MODEL = 'seedream-v5-lite';
export const DEFAULT_IMAGE_EDIT_MODEL = 'seedream-v5-lite-edit';

/**
 * Models whose outputs Seedance 2.0 accepts as input images.
 * Updated as Venice expands cross-family compatibility.
 */
export const SEEDANCE_COMPATIBLE_GENERATION_MODELS = new Set<string>([
  'seedream-v5-lite',
]);
export const SEEDANCE_COMPATIBLE_EDIT_MODELS = new Set<string>([
  'seedream-v5-lite-edit',
]);

/** True when the model id belongs to the Seedance 2.0 family. */
export function isSeedanceVideoModel(modelId: string): boolean {
  return modelId.startsWith('seedance-');
}

/**
 * Atmosphere/i2v fallback when the user is on a Seedance default but the
 * images in the request are not Seedance-compatible (or the user is in a
 * region where Seedance is unavailable).
 */
export const SEEDANCE_FALLBACK_ATMOSPHERE_MODEL = 'veo3.1-fast-image-to-video';
export const SEEDANCE_FALLBACK_R2V_MODEL = KLING_R2V_MODEL;

export const VIDEO_NO_MUSIC_SUFFIX = 'No background music. Only generate dialogue, ambient sound, and sound effects.';

// ---------------------------------------------------------------------------
// Model Capability Sets
//
// Derived from the model registry but kept here as fast lookup sets for
// the video generator and prompt builder.
// ---------------------------------------------------------------------------

export const MODELS_SUPPORTING_ELEMENTS = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
]);

export const MODELS_SUPPORTING_REFERENCE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
  'seedance-2-0-reference-to-video',
  'vidu-q3-image-to-video',
  'vidu-q3-text-to-video',
]);

export const MODELS_SUPPORTING_SCENE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
]);

export const MODELS_SUPPORTING_END_IMAGE = new Set([
  'kling-v3-pro-image-to-video',
  'kling-v3-standard-image-to-video',
  'kling-o3-pro-image-to-video',
  'kling-o3-standard-image-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-standard-reference-to-video',
  'kling-2.6-pro-image-to-video',
  'kling-2.5-turbo-pro-image-to-video',
  'pixverse-v5.6-transition',
]);

export const MODELS_USING_IMAGE_TAGS = new Set([
  'seedance-2-0-reference-to-video',
  'grok-imagine-reference-to-video',
]);

export const MODELS_SUPPORTING_AUDIO_INPUT = new Set([
  'wan-2.6-image-to-video',
  'wan-2.6-text-to-video',
  'wan-2.6-flash-image-to-video',
  'wan-2.5-preview-image-to-video',
  'wan-2.5-preview-text-to-video',
]);

// ---------------------------------------------------------------------------
// Video Element (for elements param)
// ---------------------------------------------------------------------------

export interface VideoElement {
  frontalImageUrl?: string;
  referenceImageUrls?: string[];
  videoUrl?: string;
}

// ---------------------------------------------------------------------------
// Character Appearance Defaults
//
// These are used by the prompt builder when constructing character descriptions
// for image and video generation. Override per-project or per-character as needed.
// ---------------------------------------------------------------------------

export const FEMALE_BASE_TRAITS = 'beautiful, elegant, detailed features';
export const MALE_BASE_TRAITS = 'handsome, strong features, detailed features';
