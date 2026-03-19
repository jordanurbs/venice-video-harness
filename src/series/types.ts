import type { AestheticProfile } from '../storyboard/prompt-builder.js';

export interface SeriesState {
  name: string;
  slug: string;
  concept: string;
  genre: string;
  setting: string;
  aesthetic: AestheticProfile | null;
  /** Fixed seed used for all storyboard panels to ensure consistent aesthetic rendering. */
  aestheticSeed?: number;
  characters: MiniDramaCharacter[];
  episodes: EpisodeMeta[];
  videoDefaults: VideoModelDefaults;
  outputDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoModelDefaults {
  actionModel: string;
  atmosphereModel: string;
  /**
   * Model used when character identity consistency is critical (close-ups,
   * reactions, new character entrances). Supports `elements` and
   * `reference_image_urls` for reference-first generation.
   * Falls back to `actionModel` when unset.
   */
  characterConsistencyModel?: string;
}

export interface MiniDramaCharacter {
  name: string;
  gender: 'male' | 'female' | 'other';
  age: string;
  description: string;
  fullDescription: string;
  wardrobe: string;
  voiceDescription: string;
  voiceId?: string;
  voiceName?: string;
  locked: boolean;
  seed: number;
}

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

/**
 * Scene environment tag. The prompt builder uses this to automatically
 * adapt the series aesthetic — stripping rain/dark terms for daytime
 * scenes, adding anti-rain negative prompts, etc.
 */
export type ShotEnvironment =
  | 'DAY_INTERIOR'
  | 'DAY_EXTERIOR'
  | 'NIGHT_INTERIOR'
  | 'NIGHT_EXTERIOR';

export const DAYTIME_ENVIRONMENTS = new Set<ShotEnvironment>(['DAY_INTERIOR', 'DAY_EXTERIOR']);
export const INTERIOR_ENVIRONMENTS = new Set<ShotEnvironment>(['DAY_INTERIOR', 'NIGHT_INTERIOR']);

export interface ShotScript {
  shotNumber: number;
  type: 'establishing' | 'dialogue' | 'action' | 'reaction' | 'insert' | 'close-up';
  duration: string;
  videoModel: 'action' | 'atmosphere';
  /**
   * Scene environment tag. Controls automatic aesthetic adaptation:
   * - DAY_INTERIOR / DAY_EXTERIOR: strips rain/dark terms, adds bright overrides
   * - NIGHT_INTERIOR / NIGHT_EXTERIOR: uses default series aesthetic
   * When omitted, defaults to the series' canonical environment (usually NIGHT_EXTERIOR).
   */
  environment?: ShotEnvironment;
  description: string;
  /**
   * Optional single-frame description used only for panel (image) generation.
   * When present, buildImagePrompt uses this instead of `description`.
   * The full `description` (which may contain sequential action) is still
   * used for video prompts. This prevents the image model from rendering
   * comic-panel layouts when the description contains "A happens, then B
   * happens, then C" language.
   */
  panelDescription?: string;
  characters: string[];
  dialogue: { character: string; line: string; delivery?: string } | null;
  sfx: string | null;
  cameraMovement: string;
  transition: string;
  /**
   * Seconds to trim from the start of the generated video during assembly.
   * Use when the first N seconds have continuity issues (e.g., character twist,
   * duplicate frames from chaining). Applied automatically by the assembler.
   */
  trimStart?: number;
  /**
   * Seconds to trim from the end of the generated video during assembly.
   * Use when the last N seconds have unwanted content.
   */
  trimEnd?: number;
  /**
   * If true, the video should be horizontally flipped during assembly.
   * Use when the shot angle needs mirroring for visual continuity.
   */
  flip?: boolean;
  /**
   * When false, the generation planner must not group this shot into a
   * Kling multi-shot unit.
   */
  allowMultiShot?: boolean;
  /**
   * Strong override that forces this shot to remain a standalone render.
   */
  mustStaySingle?: boolean;
  /**
   * Hint for continuity decisions. "identity" favors the current panel over
   * chaining, "continuity" favors chaining when safe, and "balanced" uses
   * planner heuristics.
   */
  continuityPriority?: 'identity' | 'continuity' | 'balanced';
  /**
   * Optional title treatment that should fade in over the ending of this shot
   * during final assembly, rather than as a separate standalone clip.
   */
  titleOverlay?: {
    text: string;
    fadeInSec?: number;
    holdSec?: number;
  };
  /**
   * Per-episode wardrobe overrides keyed by uppercase character name.
   * When present, prompt builders use these instead of the character's
   * default wardrobe from series.json.
   */
  episodeWardrobe?: Record<string, string>;
  /**
   * Skip multi-edit refinement for this shot during storyboard generation.
   * Useful for empty establishing shots that get contaminated by style passes.
   */
  skipRefine?: boolean;
  /**
   * Pass character reference images as structured `elements` with
   * @Element1/@Element2 prompt references. Requires a model in
   * MODELS_SUPPORTING_ELEMENTS.
   */
  useElements?: boolean;
  /**
   * Pass character reference images as flat `reference_image_urls` array
   * (up to 4). Requires a model in MODELS_SUPPORTING_REFERENCE_IMAGES.
   */
  useReferenceImages?: boolean;
  /**
   * Paths to scene reference images for style/environment consistency.
   * Referenced in prompt as @Image1, @Image2, etc. Requires a model in
   * MODELS_SUPPORTING_SCENE_IMAGES.
   */
  sceneImagePaths?: string[];
}

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

export const DEFAULT_ACTION_MODEL = 'kling-v3-pro-image-to-video';
export const DEFAULT_ATMOSPHERE_MODEL = 'veo3.1-fast-image-to-video';
export const DEFAULT_CHARACTER_CONSISTENCY_MODEL = 'kling-o3-standard-reference-to-video';
export const KLING_MULTISHOT_MODEL = 'kling-o3-pro-image-to-video';

export const VIDEO_NO_MUSIC_SUFFIX = 'No background music. Only generate dialogue, ambient sound, and sound effects.';

export const FEMALE_BASE_TRAITS = 'beautiful, elegant, hourglass figure, classy cleavage, skin showing, detailed features';
export const MALE_BASE_TRAITS = 'extremely handsome, strong jawline, styled appearance, detailed features';

export interface VideoElement {
  frontalImageUrl?: string;
  referenceImageUrls?: string[];
  videoUrl?: string;
}

/**
 * Models that support the `elements` parameter (structured character/object
 * definitions with frontal_image_url, reference_image_urls, video_url).
 * Prompt should reference them as @Element1, @Element2, etc.
 */
export const MODELS_SUPPORTING_ELEMENTS = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
]);

/**
 * Models that support the `reference_image_urls` parameter (flat array of
 * up to 4 reference images for character/style consistency).
 */
export const MODELS_SUPPORTING_REFERENCE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
  'vidu-q3-image-to-video',
]);

/**
 * Models that support the `image_urls` parameter (up to 4 scene/style
 * reference images). Reference as @Image1, @Image2 in prompt.
 * Note: Venice API uses `image_urls`, not `scene_image_urls`.
 */
export const MODELS_SUPPORTING_SCENE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
]);
