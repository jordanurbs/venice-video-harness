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
  projectType?: 'film' | 'series' | 'product-video' | 'music-video' | 'screenplay';
  aesthetic: AestheticProfile | null;
  aestheticSeed?: number;
  characters: Character[];
  /** First-class location entities with generated reference images. */
  locations?: Location[];
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
   * Exact lip-sync model for dialogue shots whose character is a non-narrator
   * with a visible face. Consulted only when `audioStrategy === 'lip-sync'`.
   * Native dialogue stays on the selected R2V family and uses voice-donor
   * references when supported. Defaults to `wan-2-7-image-to-video`.
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
   * See AGENTS.md rule 32 for the underlying motivation.
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
  /**
   * Auto-generate + attach a per-character voice-donor reference clip
   * (`reference_audio_urls`, bound in-prompt as @AudioN) on dialogue shots
   * that route to a reference-audio-capable model (Seedance 2.0 R2V family,
   * HappyHorse 1.1 R2V). The clip locks the character's voice — timbre,
   * accent, pacing — across shots so the native model dialogue doesn't drift
   * take to take. Defaults to `true`. Set `false` to disable series-wide;
   * `generate-videos --no-voice-reference` disables for one run. See
   * AGENTS.md rule 40.
   */
  voiceReferenceForDialogue?: boolean;
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
 *   - 'native'      — the video model speaks the dialogue in-frame. Seedance
 *                     and HappyHorse use character voice-donor references when
 *                     available to preserve timbre, accent, and pacing. Best when
 *                     characters speak only once or twice, the model's voice
 *                     range suffices, and you don't need precise control.
 *                     `assemble-episode` keeps `dialogueReplace: false`.
 *   - 'lip-sync'    — exact lip-sync mode: Venice TTS renders each dialogue
 *                     line, and Wan 2.7 i2v lip-syncs the character's mouth to the audio. Best when
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
 * family's i2v / R2V variants. `lipSyncModel` remains available for the
 * explicit exact-audio lip-sync strategy; it does not affect native dialogue.
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
 *   - 'minimax-h3'   — MiniMax H3, the open-weight omni-modal model. Renders
 *                      2K with native stereo audio for roughly a third of what
 *                      other families cost per second, and its R2V lane takes
 *                      the same 9-image reference stack as Seedance. Two hard
 *                      constraints: 2K is the only resolution (no draft tier,
 *                      so every take is a finish-quality spend) and the
 *                      duration ladder starts at 5s, so 3-4s beats have to be
 *                      re-scripted or routed elsewhere.
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
  | 'minimax-h3'
  | 'grok-imagine'
  | 'kling-o3';

/**
 * Returns the model-id triplet for a given preferred family. Used by
 * `createSeries` to populate `actionModel` / `atmosphereModel` /
 * `characterConsistencyModel` from the operator's questionnaire answer.
 *
 * `lipSyncModel` is intentionally NOT included. It is only consulted when
 * `audioStrategy === 'lip-sync'`; native dialogue remains on the selected
 * family and uses voice references when that family supports them.
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
    case 'minimax-h3':
      // MiniMax H3 (2026-07-31): reference-first like Seedance, but every
      // render is 2K with native stereo audio. i2v carries action/atmosphere;
      // R2V carries identity with up to 9 reference images.
      return {
        actionModel: 'minimax-h3-image-to-video',
        atmosphereModel: 'minimax-h3-image-to-video',
        characterConsistencyModel: 'minimax-h3-reference-to-video',
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
      // Enhanced R2V for all three lanes (2026-07-30): reference-first
      // generation. Every shot — action, atmosphere, character — renders on
      // the R2V lane with the full reference stack; no start image needed.
      return {
        actionModel: 'seedance-2-0-enhanced-reference-to-video',
        atmosphereModel: 'seedance-2-0-enhanced-reference-to-video',
        characterConsistencyModel: 'seedance-2-0-enhanced-reference-to-video',
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
  /**
   * Path (relative to the series output dir or absolute) to a short
   * voice-donor clip used as a `reference_audio_urls` entry (bound in-prompt
   * as @AudioN) so the character's voice — timbre, accent, pacing — stays
   * consistent across shots on reference-audio-capable video models
   * (Seedance 2.0 R2V family, HappyHorse 1.1 R2V). Generated via
   * `generate-voice-reference` (default source: seed-audio-1-0 from
   * `voiceDescription`) or supplied by the operator via
   * `lock-character --voice-reference`. Convention:
   * `characters/<slug>/voice-reference.mp3`. See AGENTS.md rule 40.
   */
  voiceReferencePath?: string;
  /** Model that produced the voice reference (e.g. `seed-audio-1-0`), or `user-supplied`. */
  voiceReferenceModel?: string;
  locked: boolean;
  seed: number;
}

// ---------------------------------------------------------------------------
// Location (first-class environment entity with generated reference images)
//
// Locations mirror characters: a named entity with a locked description,
// deterministic seed, and generated reference images (wide / medium / detail
// angles). They anchor the environment across storyboard panels, starting
// frames, and video generations the same way character refs anchor identity —
// serving the lighting-consistency anti-pattern (see AGENTS.md anti-pattern 7).
//
// Reference images are FACELESS by design (generated with nano-banana-pro,
// provenance hasFace:false) so they flow through the Seedance pre-flight gate
// without laundering. On Kling O3 R2V they populate `scene_image_urls`; on
// Seedance / HappyHorse (which lack scene_image_urls) the wide ref folds into
// `reference_image_urls` with a matching @ImageN environment tag.
// ---------------------------------------------------------------------------

export interface Location {
  /** Display name, e.g. "Sietch Workshop". */
  name: string;
  /** Filesystem-safe slug; also the directory name under locations/. */
  slug: string;
  /** Locked prose description of the environment (drives panel + ref prompts). */
  description: string;
  /**
   * Lighting notes carried into every panel prompt for this location so
   * consecutive shots in the same place stay lit consistently (anti-pattern 7).
   */
  lightingNotes?: string;
  /**
   * Optional time-of-day / weather variants keyed by label
   * (e.g. { "night": "…", "dawn": "…" }). Reserved for future per-shot
   * variant selection; the base `description` is used when unset.
   */
  timeVariants?: Record<string, string>;
  /** Deterministic seed so the reference angles stay reproducible. */
  seed: number;
  /** Image-generation model used for the reference angles (default nano-banana-pro). */
  referenceModel?: string;
}

// ---------------------------------------------------------------------------
// Storyboard reference (composed blocking plate)
//
// A storyboard reference is a COMPOSED image showing multiple characters
// positioned in a location, in relation to each other — e.g. "Bob and Alice
// fighting over the golden chalice inside the courtyard". It is NOT a start
// frame: it is sent as one of the reference_image_urls with an @ImageN role
// clause that tells the model "use this for composition, blocking, and
// spatial relationships; take each character's appearance from their own
// reference". Generated per scene BEAT (key moment) during storyboarding and
// reused by every shot in that beat, so consecutive shots agree about where
// everyone is standing across space and time even as camera angles change.
// ---------------------------------------------------------------------------

export interface StoryboardReference {
  /** Filesystem-safe slug; also the file stem under storyboards/<episode>/. */
  slug: string;
  /** Prose description of the moment: who is where, doing what, with what. */
  description: string;
  /** Character names composed into the plate (drives face refs at gen time). */
  characters: string[];
  /** Location slug the moment takes place in (drives the env ref at gen time). */
  location?: string;
  /** Episode this beat belongs to. */
  episode: number;
  /** Shot numbers (or suffixed ids like "3b") this plate anchors. */
  shotIds: Array<number | string>;
  /** Deterministic seed for reproducible regeneration. */
  seed: number;
  /** Image model used to compose the plate. */
  referenceModel?: string;
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
   * First-class locations introduced by this episode's script (from
   * workshop-episode). Merged into SeriesState.locations on save so their
   * reference images can be generated once and reused across shots/episodes.
   */
  locations?: Location[];
  /**
   * Composed storyboard blocking plates for this episode's key beats
   * (see StoryboardReference). Planned during workshop/storyboard, generated
   * per beat, and referenced by shots via ShotScript.storyboardRef.
   */
  storyboardRefs?: StoryboardReference[];
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
  /**
   * Slug of the Location this shot takes place in (see SeriesState.locations).
   * When set and the location has generated reference images, the storyboard
   * folds the location's wide/medium ref into the panel generation and the
   * video generator folds it into scene_image_urls (Kling O3 R2V) or
   * reference_image_urls + an @ImageN env tag (Seedance / HappyHorse).
   */
  location?: string;
  /**
   * Slug of the StoryboardReference (composed blocking plate) for this shot's
   * scene beat. When set and the plate exists on disk, the video generator
   * appends it to reference_image_urls with an @ImageN blocking role clause —
   * PROTECTED in the budget allocator (dropped last, after extra character
   * angles and extra location angles). Set by the beat planner during
   * storyboarding or by hand.
   */
  storyboardRef?: string;
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
   * lip-sync model on a single-character dialogue shot. See AGENTS.md
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

// Seedance 2.0 R2V Enhanced is the default for ALL THREE lanes (2026-07-30).
// Reference-first generation: consistency comes from the full reference stack
// (character sheets, location angles, storyboard blocking plates) rather than
// a start image. Enhanced R2V is delisted from GET /models but live on
// queue/quote (probed 2026-07-15); 1080p-capable, ~1.5x standard R2V price.
export const DEFAULT_ACTION_MODEL = 'seedance-2-0-enhanced-reference-to-video';
export const DEFAULT_ATMOSPHERE_MODEL = 'seedance-2-0-enhanced-reference-to-video';
export const DEFAULT_CHARACTER_CONSISTENCY_MODEL = 'seedance-2-0-enhanced-reference-to-video';
export const KLING_R2V_MODEL = 'kling-o3-standard-reference-to-video';
export const KLING_MULTISHOT_MODEL = 'kling-o3-pro-image-to-video';

/**
 * Default exact lip-sync model. Used only when `audioStrategy === 'lip-sync'`
 * for visible, low/medium-motion single-speaker dialogue. Wan 2.7 i2v inherits
 * aspect ratio from the input image and follows the exact supplied `audio_url`.
 * Native dialogue remains on Seedance/HappyHorse with voice references.
 */
export const DEFAULT_LIP_SYNC_MODEL = 'wan-2-7-image-to-video';

/**
 * Default image models for ALL panels — character-bearing and faceless alike.
 *
 * Historical note: Seedance 2.0 used to reject face-bearing input images that
 * weren't produced by `seedream-v5-lite`, so the harness forced seedream on any
 * panel with a character. **Venice removed that cross-family restriction (2026-07)**
 * — Seedance now accepts face-bearing images from any image family — so a single
 * high-quality default is used everywhere. `nano-banana-2` is the global default.
 */
export const DEFAULT_IMAGE_GENERATION_MODEL = 'nano-banana-2';
export const DEFAULT_IMAGE_EDIT_MODEL = 'nano-banana-2-edit';

/**
 * @deprecated Venice removed the Seedance seedream-only face restriction (2026-07).
 * These constants are retained only for backward-compatible imports; the harness
 * no longer forces seedream on face-bearing panels. Use
 * `DEFAULT_IMAGE_GENERATION_MODEL` / `DEFAULT_IMAGE_EDIT_MODEL` instead.
 */
export const SEEDANCE_FACE_GENERATION_MODEL = 'seedream-v5-lite';
export const SEEDANCE_FACE_EDIT_MODEL = 'seedream-v5-lite-edit';

/**
 * @deprecated Venice removed the Seedance face-image family restriction (2026-07).
 * Seedance now accepts face-bearing images from any image family; these sets are
 * kept only so older imports keep compiling.
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
  'seedance-2-0-enhanced-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  'happyhorse-1-0-reference-to-video',
  // HappyHorse 1.1 R2V accepts up to 9 reference images (flat reference_image_urls).
  'happyhorse-1-1-reference-to-video',
  // MiniMax H3 R2V takes a flat reference_image_urls array (9-image budget).
  'minimax-h3-reference-to-video',
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
  'seedance-2-0-enhanced-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  'grok-imagine-reference-to-video',
  // MiniMax H3 R2V REQUIRES pure reference mode: sending `image_url` alongside
  // `reference_image_urls` is a hard 400 ("image_url and end_image_url cannot
  // be combined with reference media for this model", probed 2026-07-31), so
  // it has to be in this set or every H3 character shot fails at queue time.
  // It honors @ImageN tags — same probe, a paid 5s render placed both tagged
  // characters exactly per their @Image1/@Image2 assignments.
  'minimax-h3-reference-to-video',
  // HappyHorse 1.1 R2V honors @ImageN prompt mentions — probed 2026-07-30
  // (quote accepted @ImageN prompt + 9 refs + reference_audio_urls with no
  // image_url; paid 3s render placed both tagged characters correctly per
  // the prompt's @Image1/@Image2 assignments). NOTE: quote did NOT reject a
  // 10th ref, but we keep the documented 9-image budget.
  'happyhorse-1-1-reference-to-video',
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
  // Seedance 2.0 R2V family — GET /models reports audio_input:false, but a live
  // queue probe (2026-07-23) accepted top-level `audio_url` on all three R2V
  // variants (real job completed on Fast R2V); i2v/t2v still reject it. Kept in
  // sync with the audioInput:true specs in models.ts (registry-coverage test).
  'seedance-2-0-reference-to-video',
  'seedance-2-0-enhanced-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  // MiniMax H3 R2V — GET /models reports audio_input:true on the R2V variant
  // only; the t2v/i2v lanes report false and are deliberately left out.
  'minimax-h3-reference-to-video',
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

/**
 * Models that accept `reference_audio_urls` — voice-donor clips bound
 * in-prompt as @Audio1, @Audio2, … to keep a character's voice (timbre,
 * accent, pacing) consistent across shots. Up to 3 clips, 2-15s each,
 * ≤15s aggregate, wav/mp3, ≤15MB per file, and Venice REQUIRES at least
 * one reference image alongside them (audio-only is rejected at
 * validation). Mirror of `MODELS_SUPPORTING_AUDIO_INPUT` — kept here as a
 * fast lookup set for the video generator. Confirmed live via /video/quote
 * (HTTP 200) 2026-07-23 on all four; these do NOT set `audio_input: true`
 * in GET /models, so reference audio is a separate capability from the
 * lip-sync `audio_url` lane.
 */
export const MODELS_SUPPORTING_REFERENCE_AUDIO = new Set([
  'seedance-2-0-reference-to-video',
  'seedance-2-0-enhanced-reference-to-video',
  'seedance-2-0-fast-reference-to-video',
  'happyhorse-1-1-reference-to-video',
]);

/**
 * Per-model reference_image_urls budget. The Venice API cap is 9 (per the
 * venice-video SKILL.md params table); models not listed here fall back to
 * the legacy conservative cap of 4. The old universal `.slice(0, 4)` was a
 * harness convention, NOT the API limit — Seedance 2.0 R2V and HappyHorse
 * 1.1 R2V both accept up to 9 flat reference images, which is what makes the
 * full reference stack (character sheets + multi-angle locations + storyboard
 * blocking plates) possible.
 */
export const MAX_REFERENCE_IMAGES_BY_MODEL: Record<string, number> = {
  'seedance-2-0-reference-to-video': 9,
  'seedance-2-0-enhanced-reference-to-video': 9,
  'seedance-2-0-fast-reference-to-video': 9,
  'happyhorse-1-1-reference-to-video': 9,
  'minimax-h3-reference-to-video': 9,
};

export const DEFAULT_MAX_REFERENCE_IMAGES = 4;

export function getMaxReferenceImages(modelId: string): number {
  return MAX_REFERENCE_IMAGES_BY_MODEL[modelId] ?? DEFAULT_MAX_REFERENCE_IMAGES;
}

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
