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
  /**
   * Operator's answer to "lip-sync mode or native model voices?" from the
   * upfront questionnaire. See AudioStrategy for semantics. When unset, the
   * harness uses the per-call defaults (effectively 'native'). Setting this
   * at series-creation time eliminates the double-narration / mouth-out-of-
   * sync class of bugs we hit during the PNW field-guide episode.
   */
  audioStrategy?: AudioStrategy;
  /**
   * Operator's answer to "which video model family?" from the upfront
   * questionnaire. See VideoFamilyPreference. `auto` (or unset) keeps the
   * harness's Seedance 2.0 defaults. Setting this swaps the action /
   * atmosphere / character-consistency model defaults to the chosen family.
   */
  videoFamilyPreference?: VideoFamilyPreference;
}

export interface ImageModelDefaults {
  /** Image generation model (t2i) — e.g. `seedream-v5-lite`, `nano-banana-pro`. */
  generationModel: string;
  /** Multi-edit model — e.g. `seedream-v5-lite-edit`, `nano-banana-pro-edit`. */
  editModel: string;
  /**
   * Strategy for the negative-prompt builder when constructing character
   * reference images and panels:
   *   - 'auto'     — (default) infer from the series aesthetic. Aesthetics
   *                  mentioning "photoreal", "photograph", "documentary",
   *                  "photo", "live action", "cinematic photography" suppress
   *                  the anti-photoreal guards; everything else keeps them.
   *   - 'stylized' — always inject anti-photoreal guards (photorealistic,
   *                  photograph, photo, 3D render, Pixar). Legacy behaviour.
   *   - 'photoreal'— never inject anti-photoreal guards; keep only structural
   *                  guards (deformed, watermark, text, etc.).
   *   - 'none'     — emit an empty negative prompt; trust positives only.
   *                  Useful for paths that have already hand-tuned a negative
   *                  via `negativePromptOverride`.
   */
  negativePromptStrategy?: 'auto' | 'stylized' | 'photoreal' | 'none';
}

export type SeedanceCompatibilityMode = 'prompt' | 'fallback' | 'launder';

// ---------------------------------------------------------------------------
// Upfront questionnaire answers (W3 / production-audit follow-up)
//
// These two fields belong on every new series. The MCP's pipeline skill asks
// the operator before calling `series.new`; the answers steer model selection
// and audio routing for the whole series, eliminating three classes of bugs
// we hit producing the PNW field-guide:
//   1. NARRATOR-driven episodes with `dialogueReplace: false` → double narration
//      when Seedance synthesizes its own competing English narrator.
//   2. Lip-sync-heavy scripts forced through Seedance R2V (no native lip-sync) →
//      mouths out of sync with the dialogue track.
//   3. Multi-character episodes accidentally routed to Grok Imagine (no R2V) →
//      identity drift across cuts.
// ---------------------------------------------------------------------------

/**
 * How dialogue reaches the final mix.
 *
 *   - 'native'      — the video model speaks the dialogue in-frame. Best when
 *                     characters speak only once or twice, the model's voice
 *                     range suffices, and you don't need precise control.
 *                     `assemble-episode` keeps `dialogueReplace: false`.
 *   - 'lip-sync'    — Venice TTS renders each dialogue line, Wan 2.7 i2v
 *                     lip-syncs the character's mouth to the audio. Best when
 *                     a character speaks many times (so a single voice picks
 *                     up across the episode), the user wants accent control,
 *                     or the dialogue needs deterministic delivery.
 *                     The planner routes face-visible low/medium-motion
 *                     dialogue shots to `videoDefaults.lipSyncModel`.
 *                     `assemble-episode` defaults `dialogueReplace: true`.
 *   - 'narrator-vo' — the speaker is a NARRATOR / voice-over only (no on-camera
 *                     speaking mouth). Every dialogue-bearing shot is queued
 *                     with `audio: false` so Seedance can't synthesize a
 *                     competing narrator; Venice TTS owns the dialogue lane.
 *                     `assemble-episode` defaults `dialogueReplace: true` and
 *                     `nativeVolume: 0`. Sets `audioMix.suppressModelNarration: true`.
 */
export type AudioStrategy = 'native' | 'lip-sync' | 'narrator-vo';

/**
 * Operator's preferred video model family for action / atmosphere shots.
 * `auto` keeps the current defaults (Seedance 2.0). Picking a family swaps
 * `actionModel`, `atmosphereModel`, and `characterConsistencyModel` to that
 * family's i2v / R2V variants. `lipSyncModel` stays on Wan 2.7 regardless —
 * it's the only Venice model with proper lip-sync today.
 *
 * Family quick reference:
 *   - 'seedance'     — Seedance 2.0 (default). Strong R2V identity anchoring,
 *                      4-15s native durations, mature `audio: true` support,
 *                      strict provenance requirements (seedream face refs only).
 *   - 'happyhorse'   — HappyHorse 1.1 (Alibaba, #1 blind-preference T2V + I2V).
 *                      Joint single-pass video+audio, phoneme-level lip-sync in
 *                      7 languages, and R2V with up to 9 reference images. 3-15s
 *                      natives, 720p/1080p. Best for talking characters and
 *                      multilingual localization; SFW/commercial-leaning (for
 *                      mature work prefer Seedance 2.0 or Wan 2.7). The 1.0 IDs
 *                      remain in the registry for back-compat.
 *   - 'grok-imagine' — Grok Imagine i2v + R2V (R2V durations stepped at
 *                      5s/8s/10s only). Pick for atmosphere-rich shots or
 *                      when the user wants Grok's signature look.
 *   - 'kling-o3'     — Kling O3 Standard / Pro / 4K. Best for stylized /
 *                      illustrated aesthetics. Accepts non-seedream images.
 */
export type VideoFamilyPreference =
  | 'auto'
  | 'seedance'
  | 'happyhorse'
  | 'grok-imagine'
  | 'kling-o3';

/**
 * Returns the model-id triplet for a given preferred family. Used by
 * `createSeries` to populate `actionModel` / `atmosphereModel` /
 * `characterConsistencyModel` from the operator's questionnaire answer.
 *
 * `lipSyncModel` is intentionally NOT included — Wan 2.7 i2v is the only
 * Venice lip-sync option today; callers should keep it at the default
 * regardless of family.
 */
export function resolveVideoFamilyDefaults(
  family: VideoFamilyPreference,
): { actionModel: string; atmosphereModel: string; characterConsistencyModel: string } {
  switch (family) {
    case 'happyhorse':
      // HappyHorse 1.1 (2026-07): #1 blind-preference T2V + I2V, and its new
      // R2V lane accepts up to 9 reference images for stronger identity locks
      // than 1.0. The 1.0 IDs remain in the registry for back-compat.
      return {
        actionModel: 'happyhorse-1-1-image-to-video',
        atmosphereModel: 'happyhorse-1-1-image-to-video',
        characterConsistencyModel: 'happyhorse-1-1-reference-to-video',
      };
    case 'grok-imagine':
      // Grok Imagine now ships its own R2V variant (2026-05+). Stays in-family.
      // Note: Grok R2V durations are stepped at 5s / 8s / 10s only — the
      // duration preflight in W1.6 will catch any shot scripted outside that
      // ladder.
      return {
        actionModel: 'grok-imagine-image-to-video',
        atmosphereModel: 'grok-imagine-image-to-video',
        characterConsistencyModel: 'grok-imagine-reference-to-video',
      };
    case 'kling-o3':
      return {
        actionModel: 'kling-o3-standard-image-to-video',
        atmosphereModel: 'kling-o3-standard-image-to-video',
        characterConsistencyModel: 'kling-o3-standard-reference-to-video',
      };
    case 'seedance':
    case 'auto':
    default:
      return {
        actionModel: 'seedance-2-0-image-to-video',
        atmosphereModel: 'seedance-2-0-image-to-video',
        characterConsistencyModel: 'seedance-2-0-reference-to-video',
      };
  }
}

/**
 * Recommended `seedanceCompatibility` mode given an image-generation model.
 * Used by `saveSeries` to auto-fill the field when the operator hasn't
 * explicitly set it. The table is intentionally conservative: models known
 * to produce face-bearing images Seedance will accept get `prompt` (run a
 * fast preflight, but expect success); known-bad pairings get `fallback`
 * (auto-switch to a Kling fallback); unknowns get `launder` (rewrite the
 * image through Seedream before sending to Seedance).
 */
export const SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL: Record<string, SeedanceCompatibilityMode> = {
  // Native Seedream outputs are accepted by Seedance directly.
  'seedream-v4': 'prompt',
  'seedream-v5-lite': 'prompt',
  // Other faceless-friendly families: Seedance won't reject these for
  // atmosphere shots but face-bearing images need laundering.
  'nano-banana-2': 'launder',
  'nano-banana-pro': 'launder',
  'gpt-image-1-5': 'launder',
  'gpt-image-2': 'launder',
  // Stylized models: fall back to a Kling R2V/i2v path entirely.
  'flux-2-pro': 'fallback',
  'flux-2-max': 'fallback',
  'hidream': 'fallback',
  'recraft-v4': 'fallback',
  'recraft-v4-pro': 'fallback',
  'imagineart-1.5-pro': 'fallback',
  'qwen-image': 'fallback',
  'qwen-image-2': 'fallback',
  'qwen-image-2-pro': 'fallback',
  'grok-imagine': 'fallback',
  'hunyuan-image-v3': 'fallback',
  'venice-sd35': 'fallback',
  'chroma': 'fallback',
  'z-image-turbo': 'fallback',
  'wai-Illustrious': 'fallback',
  'lustify-sdxl': 'fallback',
  'lustify-v7': 'fallback',
};

export function recommendedSeedanceCompatibility(
  generationModel: string | undefined,
): SeedanceCompatibilityMode | undefined {
  if (!generationModel) return undefined;
  return SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL[generationModel];
}

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
  /**
   * Optional time-varying gain stops for a single cue. Each stop says "by the
   * time we reach shot `atShot`, ramp gain to `gainDb`." Stops are ramped with
   * a smooth volume crossfade `rampSec` seconds long (default 2.0). Stops
   * outside the cue's [startShot, endShot] window are ignored. When supplied,
   * this layers on top of the base `gain`.
   *
   * Example: "drop -20% by the time of the florida porch shot"
   *   { startShot: 1, endShot: 10, gain: -22,
   *     gainStops: [{ atShot: 7, gainDb: -24, rampSec: 3 }] }
   */
  gainStops?: Array<{ atShot: number | string; gainDb: number; rampSec?: number }>;
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
  /**
   * When true, every shot that has dialogue is queued at Seedance / Wan with
   * `audio: false` so the model doesn't synthesize its own narrator on top of
   * the Venice TTS that will be mixed in by the assembler. Strongly recommended
   * whenever the script's primary speaker is `NARRATOR` — Seedance i2v with
   * `audio: true` will eagerly generate a competing English narration track
   * when the prompt contains "narrator" / "documentary" / "naturalist". When
   * unset, the buildVideoPrompt heuristic forces `audio: false` for NARRATOR
   * shots anyway (since there's nothing on-camera to lip-sync to).
   */
  suppressModelNarration?: boolean;
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
   * How the assembler should treat the video model's native (Seedance / Wan)
   * audio track during dialogue replacement:
   *   - 'mute' — multiply native by 0 (silenced; only Venice TTS audible)
   *   - 'duck' — multiply native by 0.2 (legacy default; keeps ambient bed)
   *   - 'keep' — multiply native by 1.0 (no ducking; competes with TTS)
   * Per-shot value wins over the CLI's `--native-volume`. Use when one shot
   * has genuine ambient (paper rustle, room tone) you want to preserve while
   * the rest of the episode mutes a competing AI narrator.
   */
  nativeAudio?: 'mute' | 'duck' | 'keep';
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
  'kling-v3-4k-reference-to-video',
  'seedance-2-0-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  'happyhorse-1-0-reference-to-video',
  // HappyHorse 1.1 R2V accepts up to 9 reference images (flat reference_image_urls).
  'happyhorse-1-1-reference-to-video',
  'pixverse-c1-reference-to-video',
  'grok-imagine-reference-to-video',
  // Wan 2.7 R2V uses per_reference_audio (elements[].audio_url) for lip-sync;
  // it still exposes reference_image_urls at the API level.
  'wan-2-7-reference-to-video',
  'wan-2.6-reference-to-video',
  'vidu-q3-image-to-video',
  'vidu-q3-text-to-video',
]);

export const MODELS_SUPPORTING_SCENE_IMAGES = new Set([
  'kling-o3-standard-reference-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-4k-reference-to-video',
  'kling-v3-4k-reference-to-video',
]);

export const MODELS_SUPPORTING_END_IMAGE = new Set([
  'kling-v3-pro-image-to-video',
  'kling-v3-standard-image-to-video',
  'kling-v3-4k-reference-to-video',
  'kling-o3-pro-image-to-video',
  'kling-o3-standard-image-to-video',
  'kling-o3-4k-image-to-video',
  'kling-o3-pro-reference-to-video',
  'kling-o3-standard-reference-to-video',
  'kling-o3-4k-reference-to-video',
  'kling-2.6-pro-image-to-video',
  'kling-2.5-turbo-pro-image-to-video',
  'pixverse-v5.6-transition',
  'pixverse-c1-transition',
  // Wan 2.7 i2v supports `end_image_url` for keyframe bookending — helps
  // anchor identity drift across low-motion lip-sync clips.
  'wan-2-7-image-to-video',
  'wan-2-7-spicy-image-to-video',
]);

export const MODELS_USING_IMAGE_TAGS = new Set([
  'seedance-2-0-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  'grok-imagine-reference-to-video',
]);

export const MODELS_SUPPORTING_AUDIO_INPUT = new Set([
  'wan-2.6-image-to-video',
  'wan-2.6-text-to-video',
  'wan-2.6-flash-image-to-video',
  'wan-2.6-reference-to-video',
  'wan-2.5-preview-image-to-video',
  'wan-2.5-preview-text-to-video',
  // Wan 2.7 lip-sync family
  'wan-2-7-image-to-video',
  'wan-2-7-spicy-image-to-video',
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
