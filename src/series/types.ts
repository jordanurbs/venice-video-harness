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
  /**
   * Default lip-sync model for dialogue shots whose character is a
   * non-narrator with a visible face. Defaults to `wan-2-7-image-to-video`.
   * The planner only routes to this model when `shot.motion !== 'high'`;
   * high-motion dialogue stays on the R2V model for identity preservation.
   */
  lipSyncModel?: string;
  /**
   * Auto-keyframe Wan 2.7 i2v from a Seedance R2V render instead of the
   * panel image. Wan 2.7 has no `reference_image_urls` capability; its
   * only identity anchor is the single `image_url` keyframe. A panel-derived
   * keyframe drifts mid-clip because the panel was generated without strong
   * character anchoring. When this flag is true (the default), every shot
   * routed to the lip-sync model first renders a quick Seedance R2V pass
   * (no audio, all character refs), extracts frame 1, and uses that frame
   * as the Wan 2.7 keyframe — locking identity from frame 0 + adding
   * lip-sync from the dialogue MP3. Doubles per-shot cost (~$0.85 total).
   * Skip per-shot with `ShotScript.disableSeedanceKeyframe = true`.
   *
   * See CLAUDE.md rule 32 for the underlying motivation.
   */
  seedanceKeyframeForWan?: boolean;
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
  /**
   * Optional per-act music cues. When set, the assembler renders each cue
   * and ffmpeg-crossfades between adjacent cues at their fade points. The
   * single static music-bed path on the assembler options is kept for
   * back-compat — when both are present, cues win.
   */
  musicCues?: MusicCueSpec[];
  /**
   * Audio-mix defaults for this episode. Overrides the assembler's built-in
   * defaults. Optional — sensible -16 LUFS targeting is applied when omitted.
   */
  audioMix?: AudioMixDefaults;
}

/**
 * Per-act music cue. References shot ids by **string** so that suffixed
 * inserts like "3b" / "3c" can be addressed without coercion bugs. The
 * assembler converts shot-id → start/end seconds via the placementMap
 * built during segment iteration.
 */
export interface MusicCueSpec {
  /**
   * Shot id at which this cue starts. Numeric shot numbers (e.g. `6`) or
   * the suffixed string form (`"3b"`) are both accepted; the assembler
   * normalizes via the same path builder it uses for dialogue placement.
   */
  startShot: number | string;
  /** Shot id at which this cue ends (inclusive). */
  endShot: number | string;
  /** Prompt for the music generation model. */
  prompt: string;
  /** Music model id. Defaults to `elevenlabs-music`. */
  model?: string;
  /** Output gain in dB. Defaults to -22. */
  gain?: number;
  /** Fade-in in seconds. Defaults to 1.0. */
  fadeIn?: number;
  /** Fade-out in seconds. Defaults to 1.5. */
  fadeOut?: number;
  /**
   * How this music cue behaves over the underlying score:
   *   - 'sustain' — flat bed (default)
   *   - 'swell'   — ramp +4 dB across the cue
   *   - 'drop'    — duck to -inf for the cue's range
   *   - 'stinger' — 0.4s pulse +6 dB then return to bed
   * Per-shot `shot.musicHold` automation is layered on top of this.
   */
  musicHold?: 'sustain' | 'swell' | 'drop' | 'stinger';
  /**
   * Optional pre-rendered audio file. When set, the assembler skips the
   * generation step and uses this directly. Useful for music beds that
   * were rendered by other harnesses or hand-edited.
   */
  audioPath?: string;
}

/**
 * Episode-level audio-mix defaults.
 */
export interface AudioMixDefaults {
  /** Cap any SFX clip to this many seconds. Defaults to 2.0. */
  sfxMaxDurationSec?: number;
  /** Fade-out applied after the SFX trim. Defaults to 0.3. */
  sfxFadeOutSec?: number;
  /** Dialogue track gain in dB. Defaults to 0. */
  dialogueGainDb?: number;
  /** Music bed gain in dB. Defaults to -22. */
  musicGainDb?: number;
  /** SFX track gain in dB. Defaults to -16. */
  sfxGainDb?: number;
  /** Final-pass integrated loudness target. Defaults to -16 LUFS. */
  lufsTarget?: number;
  /** Final-pass true peak target. Defaults to -1 dBTP. */
  truePeakDb?: number;
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
  /**
   * Per-shot motion intensity. Drives planner routing between:
   *   - Wan 2.7 i2v (lip-sync) for low/medium-motion dialogue shots, and
   *   - Seedance R2V (identity preservation, no lip-sync) for high motion.
   *
   * Defaults to `'medium'` when unset. Camera prompt suggestions:
   *   - 'low'    -> slow push-in, subtle parallax, still hold
   *   - 'medium' -> gentle tracking, lateral pan
   *   - 'high'   -> tracking action, dynamic camera, whip pan
   */
  motion?: 'low' | 'medium' | 'high';
  /**
   * Whether the character's face is visible in the shot. Used by the
   * planner to decide if lip-sync makes sense. When false, dialogue-bearing
   * shots can stay on Seedance because there's no mouth to animate.
   */
  faceVisible?: boolean;
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
  /**
   * When true, skip the automatic Seedance R2V → Wan 2.7 keyframe pipeline
   * for this shot even if it routes to the lip-sync model. Use when you
   * have a specific reason to prefer the panel as the Wan 2.7 keyframe
   * (e.g. you've manually retouched the panel for this shot). Default
   * undefined → the series-level `videoDefaults.seedanceKeyframeForWan`
   * (default `true`) decides.
   */
  disableSeedanceKeyframe?: boolean;
  /**
   * Per-shot music-cue automation. Layered on top of the containing
   * `MusicCueSpec.musicHold`. Set when a story beat (reveal, lightbulb
   * moment, drop) needs audio emphasis at this shot.
   */
  musicHold?: 'sustain' | 'swell' | 'drop' | 'stinger';
  /**
   * Optional suffix letter for inserted shots. When set, the canonical
   * shot id becomes `shotNumber + shotIdSuffix` — for example, shotNumber 3
   * with shotIdSuffix "b" → "3b" → key "003b". Inserted shots use this so
   * the order of the original shotNumbers is preserved.
   */
  shotIdSuffix?: string;
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
  /**
   * When true, render the keyframe via Seedance R2V first and use it as the
   * Wan 2.7 `image_url`. Set by the planner when the unit routes to the
   * lip-sync model on a single-character dialogue shot. See CLAUDE.md
   * rule 32.
   */
  useSeedanceKeyframe?: boolean;
  /** Model used for the Seedance keyframe stage when `useSeedanceKeyframe`. */
  keyframeModel?: string;
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
 * Default lip-sync model. Used by the planner for dialogue shots whose
 * character is a non-narrator with a visible face and motion !== 'high'.
 * Wan 2.7 i2v inherits the aspect ratio from the input image and
 * synthesizes lip-sync from `audio_url`. R2V dialogue (high motion or
 * multi-speaker) stays on Seedance for identity preservation.
 */
export const DEFAULT_LIP_SYNC_MODEL = 'wan-2-7-image-to-video';

/**
 * Default image models used when no face is present in the image.
 *
 * Seedance 2.0 only blocks FACE-BEARING images from non-seedream families,
 * so faceless images (atmosphere, establishing, scene refs, object inserts)
 * can be generated / edited with any model. The harness pairs these with
 * nano-banana-pro for better non-face quality.
 */
export const DEFAULT_IMAGE_GENERATION_MODEL = 'nano-banana-pro';
export const DEFAULT_IMAGE_EDIT_MODEL = 'nano-banana-pro-edit';

/**
 * Required image models when the image contains a human face AND the video
 * target is Seedance. Seedance 2.0 will reject face-bearing images produced
 * by any other family.
 */
export const SEEDANCE_FACE_GENERATION_MODEL = 'seedream-v5-lite';
export const SEEDANCE_FACE_EDIT_MODEL = 'seedream-v5-lite-edit';

/**
 * Models whose outputs Seedance 2.0 accepts as face-bearing input images.
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
  'kling-o3-4k-reference-to-video',
]);

export const MODELS_SUPPORTING_REFERENCE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-4k-reference-to-video',
  'seedance-2-0-reference-to-video',
  'happyhorse-1-0-reference-to-video',
  'vidu-q3-image-to-video',
  'vidu-q3-text-to-video',
]);

export const MODELS_SUPPORTING_SCENE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-4k-reference-to-video',
]);

export const MODELS_SUPPORTING_END_IMAGE = new Set([
  'kling-v3-pro-image-to-video',
  'kling-v3-standard-image-to-video',
  'kling-o3-pro-image-to-video',
  'kling-o3-standard-image-to-video',
  'kling-o3-4k-image-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-standard-reference-to-video',
  'kling-o3-4k-reference-to-video',
  'kling-2.6-pro-image-to-video',
  'kling-2.5-turbo-pro-image-to-video',
  'pixverse-v5.6-transition',
  // Wan 2.7 i2v supports `end_image_url` for keyframe bookending — helps
  // anchor identity drift across low-motion lip-sync clips.
  'wan-2-7-image-to-video',
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
  // Wan 2.7 lip-sync family
  'wan-2-7-image-to-video',
  'wan-2-7-text-to-video',
  'wan-2-7-video-to-video',
]);

/**
 * Models that accept per-reference `audio_url` inside `elements[]`.
 *
 * Wan 2.7 R2V is the only one today. Each `elements[].audio_url` drives a
 * different speaker's lip-sync inside a single render — useful for
 * multi-character speaking scenes. NOT interchangeable with the global
 * `audio_url` field used by the i2v / t2v variants.
 */
export const MODELS_SUPPORTING_PER_REFERENCE_AUDIO = new Set([
  'wan-2-7-reference-to-video',
]);

// ---------------------------------------------------------------------------
// Video Element (for elements param)
// ---------------------------------------------------------------------------

export interface VideoElement {
  frontalImageUrl?: string;
  referenceImageUrls?: string[];
  videoUrl?: string;
  /**
   * Per-reference audio for Wan 2.7 R2V (`per_reference_audio: true`).
   * When set, this element's character lip-syncs to the supplied audio
   * while other characters in the same render stay silent. NOT used by
   * models that lack `MODELS_SUPPORTING_PER_REFERENCE_AUDIO`.
   *
   * Pass as a data URL or a local file path — `audioPath` is preferred so
   * the audio pre-flight pad can run.
   */
  audioUrl?: string;
  audioPath?: string;
}

// ---------------------------------------------------------------------------
// Character Appearance Defaults
//
// These are used by the prompt builder when constructing character descriptions
// for image and video generation. Override per-project or per-character as needed.
// ---------------------------------------------------------------------------

export const FEMALE_BASE_TRAITS = 'beautiful, elegant, detailed features';
export const MALE_BASE_TRAITS = 'handsome, strong features, detailed features';
