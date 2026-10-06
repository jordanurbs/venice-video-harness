// ---------------------------------------------------------------------------
// Venice AI Model Registry
//
// Canonical source for all available Venice models, their capabilities,
// and constraints. Updated from the live /api/v1/models endpoint.
// Last synced: 2026-03-18
// ---------------------------------------------------------------------------

import type { CameraKeyframe } from './types.js';
export type { CameraKeyframe } from './types.js';

// ---- Video Models ---------------------------------------------------------

export type VideoModelType = 'image-to-video' | 'text-to-video';

export interface VideoModelSpec {
  id: string;
  name: string;
  type: VideoModelType;
  durations: string[];
  resolutions: string[];
  aspectRatios: string[];
  audio: boolean;
  audioConfigurable: boolean;
  audioInput: boolean;
  videoInput: boolean;
  /** Supports structured `elements` with @Element1/@Element2 prompt refs */
  supportsElements: boolean;
  /** Supports flat `reference_image_urls` array */
  supportsReferenceImages: boolean;
  /** Supports `scene_image_urls` for environment/style anchoring */
  supportsSceneImages: boolean;
  /** Supports `end_image_url` for targeted ending composition */
  supportsEndImage: boolean;
  /** Max duration in seconds */
  maxDurationSec: number;
  /**
   * Supports per-reference audio (Wan 2.7 R2V): each `elements[].audio_url`
   * can drive a different speaker's lip-sync inside a single render.
   */
  perReferenceAudio?: boolean;
  /**
   * Supports `reference_audio_urls` — voice-donor clips (up to 3, 2-15s each,
   * ≤15s aggregate, wav/mp3, ≤15MB per file) bound in-prompt as @Audio1,
   * @Audio2, … so a character's voice (timbre / accent / pacing) stays
   * consistent across shots. Must be paired with ≥1 reference image (Venice
   * rejects audio-only requests at validation). Distinct from `audioInput`
   * (lip-sync `audio_url`): these four R2V models accept reference audio but
   * do NOT set `audio_input: true` in GET /models. Confirmed live via
   * /video/quote (HTTP 200) 2026-07-23.
   */
  supportsReferenceAudio?: boolean;
  /**
   * Exact lip-sync is driven by a `reference_audio_urls` entry instead of
   * `audio_url`: the model animates the reference face to the supplied
   * recording. Wan 3.0 R2V rejects `audio_url` ("does not support audio
   * input") but accepts the dialogue MP3 here, while GET /models still
   * reports `audio_input: false`. Needs ≥1 reference image, like every
   * reference-audio request.
   */
  lipSyncViaReferenceAudio?: boolean;
  /**
   * Minimum allowed duration (seconds) for `audio_url` input.
   * Wan 2.7 rejects audio shorter than 3 seconds. Use the pre-flight
   * helper in `src/venice/audio-preflight.ts` to pad shorter clips.
   */
  minAudioInputSec?: number;
  /**
   * How much prompt the model wants.
   *
   * `'directorial'` (the default, and every family except MiniMax H3 Max) is
   * the house style: camera, blocking, location geography, aesthetic, and
   * reference role clauses all stated per shot, because these models render
   * what they are told and drift when they are not.
   *
   * `'simple'` models degrade with that treatment. They compose their own
   * coverage — framing, cutting, and beat rhythm — from one plain statement of
   * intent, and a wall of directorial clauses fights the shot the model would
   * have chosen. The prompt builder drops the heavy blocks for these (see
   * `buildVideoPrompt` / `buildMontagePrompt`) and keeps only what binds
   * identity and look.
   */
  promptStyle?: 'simple' | 'directorial';
  /**
   * The model runs WITHOUT the provider's face handling: Venice lists each
   * Seedance lane twice, the plain id (face-capable, 409 `needs_consent`
   * handshake, face screening) and a `-basic` twin that skips all of it and
   * refuses input images that show a person (422 `provider_content_policy`,
   * credits refunded). Text-only renders are fine on a faces-off id; any
   * request that sends an image of a person is not. Evidence: 31 of 32 takes
   * with a character reference failed on a `-basic` id in one project, 20 as
   * content-policy rejections; the face-capable twins were refused ~6%.
   *
   * Preflight (`assertFacesOffCompatible`) blocks the combination before the
   * paid call and names `faceCapableTwinId(id)` as the fix; routing
   * (`resolveVideoModel`) never picks a faces-off id for a shot with people.
   *
   * The flag is set on the `-basic` ids the registry enumerates (Seedance 2.0
   * today). Venice also lists `seedance-2-5-*-basic`, which the registry does
   * not carry; a consumer that reads only this field (or `capabilities.json`)
   * will not see those as faces-off. `isFacesOffModel(id)` is the source of
   * truth: it reads the flag and falls back to the id shape for unlisted ids.
   */
  facesOff?: boolean;
  /**
   * Accepts the `camera_trajectory` keyframe array — MiniMax H3 Max Multi-Angle
   * only. When true, callers may pass a 2–12 keyframe camera orbit path
   * (`buildOrbitTrajectory` / `buildStartEndTrajectory`); every other model
   * rejects the field as an unrecognized key.
   */
  supportsCameraTrajectory?: boolean;
  privacy: 'private' | 'anonymized';
  offline: boolean;
}

/**
 * True when a model wants a short, plain prompt rather than the full
 * directorial stack. Drives the lean branches in the mini-drama prompt
 * builder; unknown ids fall through to directorial (the safe default).
 */
export function modelWantsSimplePrompt(modelId: string): boolean {
  return getVideoModel(modelId)?.promptStyle === 'simple';
}

/**
 * MiniMax H3 (all variants) image-to-video renders die server-side when the
 * START frame (`image_url`) contains a recognizable human face: Venice accepts
 * and bills the queue, then `/video/retrieve` 500s forever, with no
 * needs_consent handshake like Seedance. Loop chaining (which feeds each shot's
 * last frame into the next shot's i2v) and any panel-anchored i2v off a
 * face-bearing panel hit this. See AGENTS.md anti-pattern 31 (PR #25).
 *
 * Callers use this to avoid feeding a face-bearing start frame to these models
 * (degrade to t2v, skip face-continuity prompting, etc.). It's a per-model
 * capability so a future Venice fix — or a new i2v family — is a one-line change.
 */
export function i2vRejectsFaceStartFrame(modelId: string): boolean {
  return modelId.startsWith('minimax-h3') && modelId.includes('image-to-video');
}

/**
 * True for a model that runs without the provider's face handling and refuses
 * input images of people (see `VideoModelSpec.facesOff`). Registry entries
 * carry the flag; the id-shape fallback covers the `seedance-2-5-*-basic`
 * spellings Venice lists live but the registry does not enumerate.
 */
export function isFacesOffModel(modelId: string): boolean {
  const spec = getVideoModel(modelId);
  if (spec) return spec.facesOff === true;
  return /^seedance-.+-basic$/i.test(modelId);
}

/**
 * The face-capable twin of a faces-off id (`seedance-2-0-reference-to-video-basic`
 * -> `seedance-2-0-reference-to-video`). Returns the id unchanged when it is
 * not a faces-off model.
 */
export function faceCapableTwinId(modelId: string): string {
  return isFacesOffModel(modelId) ? modelId.replace(/-basic$/i, '') : modelId;
}

// ---- Image generation prompt-length budgets () -----------------------

/**
 * Per-image-model positive-prompt length caps.
 *
 * Venice silently rejects requests with overly long positive prompts on
 * certain models (observed at ~1800-2200 chars on seedream-v5-lite; the
 * mini-drama character-reference builder used to emit 2400+ char prompts).
 *
 * Default cap is intentionally conservative (300 chars). Callers should
 * keep the most-important style cue + character anchor inline and move
 * everything else to negative_prompt.
 */
export const DEFAULT_MAX_POSITIVE_PROMPT_CHARS = 300;

export const MAX_POSITIVE_PROMPT_CHARS: Record<string, number> = {
  'seedream-v5-lite': 300,
  'seedream-v5-lite-edit': 300,
  'nano-banana-pro': 500,
  'nano-banana-pro-edit': 500,
  // nano-banana-2 accepts long prompts (promptCharacterLimit 1500+ per the
  // Venice API skill). It previously fell through to the 300-char default —
  // a seedream-specific silent-reject guard — which truncated character
  // reference prompts to a style fragment with NO character in it (the
  // venice-4m-users all-sheets-identical failure, 2026-08-11).
  'nano-banana-2': 1500,
  'nano-banana-2-edit': 1500,
  'gpt-image-2': 600,
  'gpt-image-2-edit': 600,
};

/**
 * Look up the positive-prompt cap for an image-generation model.
 * Falls back to DEFAULT_MAX_POSITIVE_PROMPT_CHARS when unspecified.
 */
export function getMaxPositivePromptChars(modelId: string): number {
  return MAX_POSITIVE_PROMPT_CHARS[modelId] ?? DEFAULT_MAX_POSITIVE_PROMPT_CHARS;
}

export const VIDEO_MODELS: VideoModelSpec[] = [
  // -- Wan 2.6 --
  {
    id: 'wan-2.6-image-to-video', name: 'Wan 2.6', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2.6-flash-image-to-video', name: 'Wan 2.6 Flash', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2.6-text-to-video', name: 'Wan 2.6', type: 'text-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- Wan 2.7 (lip-sync via audio_url / per-reference audio) --
  // Live API probed 2026-05-10. Notes:
  //   - audio_url minimum duration is 3 seconds (returns HTTP 400 below).
  //   - i2v inherits aspect ratio from the input image; passing aspect_ratio
  //     yields "This model does not support aspect_ratio" — empty array.
  //   - t2v supports aspect_ratio.
  //   - R2V uses `per_reference_audio` via elements[].audio_url, not audio_url.
  //   - end_image_url is NOT supported: live 2026-07-06 the i2v (incl. Spicy)
  //     queue returned HTTP 400 "This model does not support end_image_url".
  //   - Cost reference: ~$0.55 per 5s clip at 720p.
  {
    id: 'wan-2-7-image-to-video', name: 'Wan 2.7', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, minAudioInputSec: 3,
    privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2-7-text-to-video', name: 'Wan 2.7', type: 'text-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, minAudioInputSec: 3,
    privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2-7-reference-to-video', name: 'Wan 2.7 R2V', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, perReferenceAudio: true, minAudioInputSec: 3,
    privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2-7-video-to-video', name: 'Wan 2.7 V2V', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: true, videoInput: true,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, minAudioInputSec: 3,
    privacy: 'anonymized', offline: false,
  },
  // -- Wan 3.0 (live catalog 2026-08-05) --
  // The successor to 2.7, and the first family on Venice with a duration
  // ladder past 15s: 5/10/15/20/25/30s at 480p/720p/1080p, native audio on
  // by default and not configurable. Notes:
  //   - `audio_input` and `per_reference_audio` are false across the whole
  //     family in GET /models, and `audio_url` is rejected. But
  //     `wan-3-0-reference-to-video` DOES lip-sync the reference face to a
  //     dialogue MP3 sent as `reference_audio_urls` (paid render, 2026-09-01,
  //     one reference image + a 4.9s clip). That is its exact lip-sync lane
  //     (`lipSyncViaReferenceAudio`), capped at 15s of reference audio per
  //     render (LIP_SYNC_REFERENCE_AUDIO_MAX_SEC). The prime / enhanced / pro
  //     R2V lanes have not been probed for it and are left out until they are.
  //   - i2v and R2V accept `adaptive` aspect (inherit from the input image)
  //     plus the five concrete ratios. Only the concrete ratios are listed
  //     here so the aspect pre-flight has real values to compare against.
  //   - Reference images need a short side ≥ 240px.
  //   - `wan-3-0-enhanced-*` are flagged beta by Venice.
  //   - Cost reference: ~$0.55 per 5s clip at 720p (quote, 2026-08-05).
  {
    id: 'wan-3-0-text-to-video', name: 'Wan 3.0', type: 'text-to-video',
    durations: ['5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-image-to-video', name: 'Wan 3.0', type: 'image-to-video',
    durations: ['5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-reference-to-video', name: 'Wan 3.0 R2V', type: 'image-to-video',
    durations: ['5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    lipSyncViaReferenceAudio: true,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-enhanced-text-to-video', name: 'Wan 3.0 Enhanced', type: 'text-to-video',
    durations: ['5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-enhanced-reference-to-video', name: 'Wan 3.0 R2V Enhanced', type: 'image-to-video',
    durations: ['5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  // Post-production 2x/4x upscaler. Requires `upscale_factor`, the real
  // input duration as a string, and chunking for large payloads. It strips
  // audio; src/venice/upscale.ts remuxes the original audio after processing.
  {
    id: 'topaz-video-upscale', name: 'Topaz Video Upscale', type: 'image-to-video',
    durations: [], resolutions: [], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: true,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 300, privacy: 'anonymized', offline: false,
  },
  // -- Wan 2.5 Preview --
  {
    id: 'wan-2.5-preview-image-to-video', name: 'Wan 2.5 Preview', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: ['1080p', '720p', '480p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2.5-preview-text-to-video', name: 'Wan 2.5 Preview', type: 'text-to-video',
    durations: ['5s', '10s'], resolutions: ['1080p', '720p', '480p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- Wan 2.2 / 2.1 (legacy) --
  {
    id: 'wan-2.2-a14b-text-to-video', name: 'Wan 2.2 A14B', type: 'text-to-video',
    durations: ['5s'], resolutions: ['720p', '580p', '480p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 5, privacy: 'private', offline: false,
  },
  {
    id: 'wan-2.1-pro-image-to-video', name: 'Wan 2.1 Pro', type: 'image-to-video',
    durations: ['6s'], resolutions: [], aspectRatios: ['16:9'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 6, privacy: 'private', offline: false,
  },
  // -- Grok Imagine --
  {
    id: 'grok-imagine-text-to-video', name: 'Grok Imagine', type: 'text-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['480p', '720p'], aspectRatios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'grok-imagine-image-to-video', name: 'Grok Imagine', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['480p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- LTX Video 2.0 --
  {
    id: 'ltx-2-fast-image-to-video', name: 'LTX Video 2.0 Fast', type: 'image-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-fast-text-to-video', name: 'LTX Video 2.0 Fast', type: 'text-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-full-image-to-video', name: 'LTX Video 2.0 Full', type: 'image-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-full-text-to-video', name: 'LTX Video 2.0 Full', type: 'text-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- LTX Video 2.0 v2.3 --
  {
    id: 'ltx-2-v2-3-fast-image-to-video', name: 'LTX Video 2.0 v2.3 Fast', type: 'image-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-v2-3-fast-text-to-video', name: 'LTX Video 2.0 v2.3 Fast', type: 'text-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-v2-3-full-image-to-video', name: 'LTX Video 2.0 v2.3 Full', type: 'image-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-v2-3-full-text-to-video', name: 'LTX Video 2.0 v2.3 Full', type: 'text-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- LTX Video 2.0 19B --
  // Offline 2026-10-06: no longer in GET /models (with or without a key), and
  // /video/quote now validates these ids against a different ladder (6-20s at 1080p-2160p, the v2.3 one)
  // that rejects the durations recorded here, so Venice appears to route the id
  // to another model. Kept for old projects; not offered for new work.
  {
    id: 'ltx-2-19b-full-text-to-video', name: 'LTX Video 2.0 19B Full', type: 'text-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: true,
  },
  {
    id: 'ltx-2-19b-full-image-to-video', name: 'LTX Video 2.0 19B Full', type: 'image-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: true,
  },
  {
    id: 'ltx-2-19b-distilled-text-to-video', name: 'LTX Video 2.0 19B Distilled', type: 'text-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: true,
  },
  {
    id: 'ltx-2-19b-distilled-image-to-video', name: 'LTX Video 2.0 19B Distilled', type: 'image-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: true,
  },
  // -- OVI --
  {
    id: 'ovi-image-to-video', name: 'OVI', type: 'image-to-video',
    durations: ['5s'], resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 5, privacy: 'anonymized', offline: false,
  },
  // -- Kling 2.6 --
  // audioConfigurable corrected 2026-10-06 (pro lanes): live /models reports audio_configurable
  // true and /video/quote prices `audio: false` lower, so the toggle is real.
  // (Lanes that reject the field, HappyHorse 1.1 and H3 Max, quote the same
  // price either way and report false.) With the flag false the harness dropped
  // `audio: false` and paid for audio it had asked to omit.
  {
    id: 'kling-2.6-pro-text-to-video', name: 'Kling 2.6 Pro', type: 'text-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-2.6-pro-image-to-video', name: 'Kling 2.6 Pro', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- Kling 2.5 Turbo Pro --
  {
    id: 'kling-2.5-turbo-pro-text-to-video', name: 'Kling 2.5 Turbo Pro', type: 'text-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-2.5-turbo-pro-image-to-video', name: 'Kling 2.5 Turbo Pro', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- Kling O3 --
  // audioConfigurable corrected 2026-10-06 (pro + standard lanes): live /models reports audio_configurable
  // true and /video/quote prices `audio: false` lower, so the toggle is real.
  // (Lanes that reject the field, HappyHorse 1.1 and H3 Max, quote the same
  // price either way and report false.) With the flag false the harness dropped
  // `audio: false` and paid for audio it had asked to omit.
  {
    id: 'kling-o3-pro-text-to-video', name: 'Kling O3 Pro', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-pro-image-to-video', name: 'Kling O3 Pro', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-pro-reference-to-video', name: 'Kling O3 Pro R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: true, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-text-to-video', name: 'Kling O3 Standard', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-image-to-video', name: 'Kling O3 Standard', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-reference-to-video', name: 'Kling O3 Standard R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: true, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- Kling O3 4K (not in registry sync 2026-03-18 — added by hand) --
  {
    id: 'kling-o3-4k-text-to-video', name: 'Kling O3 4K', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['4K', '1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-4k-image-to-video', name: 'Kling O3 4K', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['4K', '1080p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-4k-reference-to-video', name: 'Kling O3 4K R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['4K', '1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: true, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- HappyHorse 1.0 (not in registry sync 2026-03-18 — added by hand) --
  {
    id: 'happyhorse-1-0-text-to-video', name: 'HappyHorse 1.0', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'happyhorse-1-0-image-to-video', name: 'HappyHorse 1.0', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'happyhorse-1-0-reference-to-video', name: 'HappyHorse 1.0 R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- HappyHorse 1.1 (live registry sync 2026-07-06) --
  // Alibaba's 15B model, #1 on the Artificial Analysis Video Arena (T2V + I2V)
  // by blind human preference. Joint single-pass video+audio with phoneme-level
  // lip-sync across 7 languages (EN, Mandarin, Cantonese, JA, KO, DE, FR).
  // 1.1 adds reference-to-video with up to 9 reference images and widens the
  // aspect-ratio menu to nine ratios. Draft on 720p, finalize keepers on 1080p.
  {
    id: 'happyhorse-1-1-text-to-video', name: 'HappyHorse 1.1', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'happyhorse-1-1-image-to-video', name: 'HappyHorse 1.1', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'happyhorse-1-1-reference-to-video', name: 'HappyHorse 1.1 R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['1080p', '720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5'],
    // Top-level audio_url is rejected ("This model does not support audio input",
    // probe 2026-07-23), but per-reference audio via
    // image_references[{image_url, audio_url}] IS accepted (paid job queued same
    // probe). Requires the object-form builder; audioInput stays false.
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, perReferenceAudio: true, supportsReferenceAudio: true,
    privacy: 'anonymized', offline: false,
  },
  // -- MiniMax H3 (live registry sync 2026-07-31) --
  // Open-weight omni-modal generator: one model covers T2V, I2V, and
  // multimodal reference, with native stereo audio baked into the render.
  // Two traits make it different from every other family in this registry:
  //
  //   1. 2K is the ONLY resolution. Sending `resolution: '720p'` is a hard
  //      HTTP 400 ("Invalid enum value. Expected '2K'") — probed 2026-07-31.
  //      There is no draft tier, so every H3 shot is a finish-quality render.
  //   2. The duration ladder STARTS AT 5s. 3s and 4s both 400 — so shots
  //      scripted at Seedance/HappyHorse's short end fail preflight rather
  //      than silently rounding up.
  //
  // Pricing at the time of sync: $0.81 for 5s, $2.44 for 15s (~$0.16/s at 2K),
  // which is why it is the cheap-2K option in the family questionnaire.
  // Prompt limit is 2500 characters on all three variants.
  {
    id: 'minimax-h3-text-to-video', name: 'MiniMax H3', type: 'text-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['2K'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'minimax-h3-image-to-video', name: 'MiniMax H3', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    // Aspect is inherited from the start image; the live constraints report an
    // empty aspect_ratios list, so don't send the field on this variant.
    resolutions: ['2K'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'minimax-h3-reference-to-video', name: 'MiniMax H3 R2V', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['2K'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    // audio_input:true here (and false on t2v/i2v) per the live constraints —
    // the R2V lane is the one that accepts a top-level `audio_url`.
    //
    // PURE REFERENCE ONLY: `image_url`/`end_image_url` alongside
    // `reference_image_urls` is a hard 400 ("cannot be combined with reference
    // media for this model"), which is why this id is in
    // MODELS_USING_IMAGE_TAGS — that set is what drops the start frame.
    // supportsEndImage stays false for the same reason.
    audio: true, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- MiniMax H3 Max / H3 Max Turbo (live probe 2026-09-03) ------------------
  // A different product shape from MiniMax H3 above, despite the shared name.
  // Four things separate them, and all four are load-bearing:
  //
  //   1. RESOLUTION IS INVERTED. H3 renders 2K; H3 Max tops out at 768P and
  //      REJECTS 2K ("Invalid enum value. Expected '480P' | '768P'"). 480P is
  //      the draft tier. This is why the resolution pin in video-generator.ts
  //      matches `minimax-h3-max` BEFORE `minimax-h3` — a substring fall-through
  //      would pin these to 2K and 400 every render.
  //   2. THEY WANT PLAIN PROMPTS (`promptStyle: 'simple'`). The model composes
  //      its own coverage and cutting from a stated intent; the full directorial
  //      stack fights it. Best used for montages and for beats where the model
  //      telling its own story IS the shot. The API cap is 10000 chars, but the
  //      useful prompt is a couple of sentences.
  //   3. PRIVATE, and uncensored. H3 is `anonymized`.
  //   4. PRICE. At 768P: H3 Max $0.024/s ($0.36 for 15s), Turbo $0.012/s
  //      ($0.18 for 15s) — against $0.10/s for base H3. Turbo is the cheapest
  //      lane in this registry, which makes 15s takes disposable enough to
  //      generate several and pick.
  //
  // Shared with H3: the duration ladder starts at 5s (4s is a hard 400) and
  // tops out at 15s, native audio is on and NOT toggleable (the `audio` field
  // is omitted for these — see renderVideoFile).
  //
  // There is NO Turbo R2V lane: `minimax-h3-max-turbo-reference-to-video` is
  // "Specified model not found". Identity work has to route to the non-turbo
  // `minimax-h3-max-reference-to-video`.
  {
    id: 'minimax-h3-max-text-to-video', name: 'MiniMax H3 Max', type: 'text-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    // Highest first: `resolutions[0]` is the default tier (what
    // validateVideoRequest suggests and the Creator app's reconcile() falls
    // back to), and 768P is the finish tier. Venice's live
    // /models reports this pair as ["480P", "768P"]; the app reorders live to
    // follow this array (preferredResolutionOrder) precisely so that incidental
    // ordering doesn't quietly default every shot to the draft tier.
    resolutions: ['768P', '480P'], aspectRatios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', privacy: 'private', offline: false,
  },
  {
    id: 'minimax-h3-max-image-to-video', name: 'MiniMax H3 Max', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    // Aspect is inherited from the start image — the live constraints report an
    // empty aspect_ratios list, so don't send the field on this variant.
    resolutions: ['768P', '480P'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', privacy: 'private', offline: false,
  },
  {
    id: 'minimax-h3-max-reference-to-video', name: 'MiniMax H3 Max R2V', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['768P', '480P'], aspectRatios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16'],
    // audio_input:true on the R2V lane only, same split as H3 — this is the
    // lane that takes a top-level `audio_url`, so it's the family's lip-sync
    // model. Reference images: min short side 256px, aspect 0.4-2.5.
    audio: true, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', privacy: 'private', offline: false,
  },
  {
    id: 'minimax-h3-max-turbo-text-to-video', name: 'MiniMax H3 Max Turbo', type: 'text-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['768P', '480P'], aspectRatios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', privacy: 'private', offline: false,
  },
  {
    id: 'minimax-h3-max-turbo-image-to-video', name: 'MiniMax H3 Max Turbo', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['768P', '480P'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', privacy: 'private', offline: false,
  },
  // -- MiniMax H3 Max Multi-Angle (live catalog + OpenAPI probe 2026-09-15) ----
  // An i2v lane in the H3 Max family with ONE thing no other Venice model has:
  // a `camera_trajectory` param. You give it the start frame (`image_url`) and
  // a 2–12 keyframe camera path — normalized time (0–1), azimuth° (horizontal),
  // elevation° (vertical, −90..90), and distance (1 = unchanged) — and it orbits
  // the subject along that path. See buildOrbitTrajectory / buildStartEndTrajectory
  // and MODELS_SUPPORTING_CAMERA_TRAJECTORY. Four things separate it from the
  // rest of the H3 Max family, all load-bearing:
  //
  //   1. RESOLUTION goes to 1080P. Base H3 Max / Turbo cap at 768P and 400 on
  //      2K; multi-angle's live constraints report ["480P","768P","1080P"], so
  //      it is the ONE H3 Max lane with a true-HD finish tier. Highest-first so
  //      resolutions[0] is the finish (1080P); the video-generator still pins a
  //      cost-sane 768P auto-default and only sends 1080P on explicit override.
  //   2. `camera_trajectory` is the payload. `prompt` is OPTIONAL for this model
  //      (the camera path carries the shot); still `promptStyle: 'simple'`.
  //   3. PRIVATE + uncensored, like the rest of H3 Max.
  //   4. i2v only — no t2v/R2V multi-angle lane. aspect follows the start image
  //      (empty aspect_ratios), audio is on and NOT configurable (field omitted).
  //
  // Pricing (live /video/quote 2026-09-15): 480P $0.06/s, 768P ~$0.096/s,
  // 1080P ~$0.19/s ($1.54 for 8s at 1080P). Ladder 5–15s like the rest of H3 Max.
  {
    id: 'minimax-h3-max-multi-angle', name: 'MiniMax H3 Max Multi-Angle', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    // Highest first (finish tier is 1080P). Unlike base H3 Max, 1080P is valid.
    resolutions: ['1080P', '768P', '480P'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, promptStyle: 'simple', supportsCameraTrajectory: true,
    privacy: 'private', offline: false,
  },
  // -- Kling V3 --
  // audioConfigurable corrected 2026-10-06 (pro + standard lanes): live /models reports audio_configurable
  // true and /video/quote prices `audio: false` lower, so the toggle is real.
  // (Lanes that reject the field, HappyHorse 1.1 and H3 Max, quote the same
  // price either way and report false.) With the flag false the harness dropped
  // `audio: false` and paid for audio it had asked to omit.
  {
    id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-pro-image-to-video', name: 'Kling V3 Pro', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-standard-text-to-video', name: 'Kling V3 Standard', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-standard-image-to-video', name: 'Kling V3 Standard', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- Longcat --
  {
    id: 'longcat-distilled-image-to-video', name: 'Longcat Distilled', type: 'image-to-video',
    durations: ['5s', '10s', '15s', '20s', '30s'], resolutions: ['720p'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'longcat-distilled-text-to-video', name: 'Longcat Distilled', type: 'text-to-video',
    durations: ['5s', '10s', '15s', '20s', '30s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'longcat-image-to-video', name: 'Longcat', type: 'image-to-video',
    durations: ['5s', '10s', '15s', '20s', '30s'], resolutions: ['720p'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'longcat-text-to-video', name: 'Longcat', type: 'text-to-video',
    durations: ['5s', '10s', '15s', '20s', '30s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  // -- Veo 3 --
  {
    id: 'veo3-fast-text-to-video', name: 'Veo 3 Fast', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3-fast-image-to-video', name: 'Veo 3 Fast', type: 'image-to-video',
    durations: ['8s'], resolutions: [], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3-full-text-to-video', name: 'Veo 3 Full', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3-full-image-to-video', name: 'Veo 3 Full', type: 'image-to-video',
    durations: ['8s'], resolutions: [], aspectRatios: ['16:9'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  // -- Veo 3.1 --
  // audioConfigurable corrected 2026-10-06: live /models reports audio_configurable
  // true and /video/quote prices `audio: false` lower, so the toggle is real.
  // (Lanes that reject the field, HappyHorse 1.1 and H3 Max, quote the same
  // price either way and report false.) With the flag false the harness dropped
  // `audio: false` and paid for audio it had asked to omit.
  {
    id: 'veo3.1-fast-text-to-video', name: 'Veo 3.1 Fast', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-fast-image-to-video', name: 'Veo 3.1 Fast', type: 'image-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-full-text-to-video', name: 'Veo 3.1 Full', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-full-image-to-video', name: 'Veo 3.1 Full', type: 'image-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  // -- Seedance 2.0 --
  // Duration ladder widened 2026-10-06: /video/quote accepts every whole second
  // from 4s to 15s on these four lanes, so a 6s or 7s shot renders at its scripted
  // length instead of snapping to 5s or 8s.
  // Resolution ladder corrected against live /video/quote (2026-09-07): the
  // i2v/t2v/r2v lanes accept up to 4k (quote 200: 4k=$4.86, 1080p=$2.34 for
  // a 5s clip). The harness previously capped these at 720p. Fast/mini stay
  // 480p/720p. Kept ascending so the resolutions[0] default tier is the cheap
  // draft, not 4k; renderVideoFile still pins 720p as the auto
  // default and only sends a higher value when the user/engine picks one.
  {
    id: 'seedance-2-0-image-to-video', name: 'Seedance 2.0', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-text-to-video', name: 'Seedance 2.0', type: 'text-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // Seedance R2V variants accept audio_url despite /models reporting
  // audio_input: false — live probe 2026-07-23 (queue accepted audio_url on all
  // four R2V variants, real job completed on Fast R2V; i2v/t2v rejected with
  // "This model does not support audio input"). reference_audio_urls (≤3) also
  // validates on R2V only.
  {
    id: 'seedance-2-0-reference-to-video', name: 'Seedance 2.0 R2V', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, supportsReferenceAudio: true, privacy: 'anonymized', offline: false,
  },
  // Delisted from GET /models (2026-07 sync) but still live on the queue/quote
  // endpoints — probed 2026-07-15 (quote OK at 5/8/10/15s, 720p + 1080p).
  // Higher-fidelity "enhanced" render path of Seedance 2.0 R2V; same duration
  // ladder, roughly ~1.5x the standard R2V price per clip.
  {
    id: 'seedance-2-0-enhanced-reference-to-video', name: 'Seedance 2.0 R2V Enhanced', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    // audioInput probe 2026-07-23: queue validator accepted audio_url (R2V family).
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, supportsReferenceAudio: true, privacy: 'anonymized', offline: false,
  },
  // -- Seedance 2.5 --
  // Not listed on GET /models but live on quote/queue — probed 2026-08-07.
  //   - Duration ladder: EVERY integer 4s-30s (quote enum). 30s single pass
  //     is the montage lane: one generation covering a whole scene of beats.
  //   - Resolutions: 480p / 720p / 1080p (re-probed live 2026-09-07: 1080p
  //     quotes 200 at $2.56/5s on all three lanes — i2v, t2v, r2v. 2K/4K
  //     still 400. The earlier "720p only" note was stale; harness had been
  //     capping 2.5 a full tier below what the API accepts).
  //   - Aspect ratios: 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 (native scope!).
  //   - Quote accepted audio_url + reference_audio_urls + reference_video_urls
  //     together on the R2V variant. Reference ceilings per the Seedance 2.5
  //     release notes: up to 30 image / 10 video / 10 audio refs (50 total);
  //     the quote endpoint does not police the count (31 imgs quoted OK), so
  //     the documented budget is enforced harness-side.
  //   - Price scales linearly: ~$0.29/s at 720p ($8.67 for 30s), 480p ~$3.86
  //     for 30s. No 30s premium — same per-second rate as short clips.
  //   - Prompt cap: quote accepted 12k chars; montage builder still guards at
  //     5000 to keep beats directed rather than decorated.
  {
    id: 'seedance-2-5-text-to-video', name: 'Seedance 2.5', type: 'text-to-video',
    durations: Array.from({ length: 27 }, (_, i) => `${i + 4}s`),
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-5-image-to-video', name: 'Seedance 2.5', type: 'image-to-video',
    durations: Array.from({ length: 27 }, (_, i) => `${i + 4}s`),
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-5-reference-to-video', name: 'Seedance 2.5 R2V', type: 'image-to-video',
    durations: Array.from({ length: 27 }, (_, i) => `${i + 4}s`),
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: true,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, supportsReferenceAudio: true, privacy: 'anonymized', offline: false,
  },
  // -- Sora 2 --
  // Offline 2026-10-06: no longer in GET /models (with or without a key), and
  // /video/quote now validates these ids against a different ladder (5-15s at 480P/768P/1080P)
  // that rejects the durations recorded here, so Venice appears to route the id
  // to another model. Kept for old projects; not offered for new work.
  {
    id: 'sora-2-image-to-video', name: 'Sora 2', type: 'image-to-video',
    durations: ['4s', '8s', '12s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: true,
  },
  {
    // Sora 2 Pro: durations expanded to 20s as of 2026-05; 'true_1080p' added.
    id: 'sora-2-pro-image-to-video', name: 'Sora 2 Pro', type: 'image-to-video',
    durations: ['4s', '8s', '12s', '16s', '20s'],
    resolutions: ['720p', '1080p', 'true_1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: true,
  },
  {
    id: 'sora-2-text-to-video', name: 'Sora 2', type: 'text-to-video',
    durations: ['4s', '8s', '12s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: true,
  },
  {
    id: 'sora-2-pro-text-to-video', name: 'Sora 2 Pro', type: 'text-to-video',
    durations: ['4s', '8s', '12s', '16s', '20s'],
    resolutions: ['720p', '1080p', 'true_1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: true,
  },
  // -- PixVerse v5.6 --
  // audioConfigurable corrected 2026-10-06: live /models reports audio_configurable
  // true and /video/quote prices `audio: false` lower, so the toggle is real.
  // (Lanes that reject the field, HappyHorse 1.1 and H3 Max, quote the same
  // price either way and report false.) With the flag false the harness dropped
  // `audio: false` and paid for audio it had asked to omit.
  {
    id: 'pixverse-v5.6-text-to-video', name: 'PixVerse v5.6', type: 'text-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-v5.6-image-to-video', name: 'PixVerse v5.6', type: 'image-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-v5.6-transition', name: 'PixVerse v5.6 Transition', type: 'image-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  // -- Vidu Q3 --
  {
    id: 'vidu-q3-text-to-video', name: 'Vidu Q3', type: 'text-to-video',
    durations: ['3s', '5s', '8s', '10s', '12s', '14s', '16s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 16, privacy: 'anonymized', offline: false,
  },
  {
    id: 'vidu-q3-image-to-video', name: 'Vidu Q3', type: 'image-to-video',
    durations: ['3s', '5s', '8s', '10s', '12s', '14s', '16s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 16, privacy: 'anonymized', offline: false,
  },
  // -- Runway Gen-4.5 (added 2026-05 sync) --
  // Runway's family on Venice: all variants top out at 10s, silent (audio:false,
  // not configurable), no end_image_url, no R2V identity refs. Pick when the
  // user wants Runway's signature motion physics, not when they need
  // character identity locks.
  {
    id: 'runway-gen4-5', name: 'Runway Gen-4.5', type: 'image-to-video',
    durations: ['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'runway-gen4-5-text', name: 'Runway Gen-4.5', type: 'text-to-video',
    durations: ['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'runway-gen4-turbo', name: 'Runway Gen-4 Turbo', type: 'image-to-video',
    durations: ['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'runway-gen4-aleph', name: 'Runway Gen-4 Aleph', type: 'image-to-video',
    durations: ['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- Seedance 2.0 Fast (added 2026-05 sync) --
  // Cheaper / quicker Seedance 2.0 variants. Same i2v / t2v / R2V split as
  // the regular Seedance 2.0 line, same 4-15s ladder, same image provenance
  // gate. Pick when iterating or when the per-second cost of Seedance regular
  // is prohibitive.
  {
    id: 'seedance-2-0-fast-image-to-video', name: 'Seedance 2.0 Fast', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-fast-text-to-video', name: 'Seedance 2.0 Fast', type: 'text-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-fast-reference-to-video', name: 'Seedance 2.0 Fast R2V', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    // audioInput probe 2026-07-23: real audio_url job queued + completed.
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, supportsReferenceAudio: true, privacy: 'anonymized', offline: false,
  },
  // -- PixVerse C1 (added 2026-05 sync) --
  // PixVerse's c1 line. Replaces the v5.6 family for new projects: same four
  // resolutions but 15s native durations (vs v5.6's 8s ceiling) AND a new R2V
  // variant with `reference_image_urls`. Transition variant also gained
  // the 15s ladder.
  {
    id: 'pixverse-c1-text-to-video', name: 'PixVerse C1', type: 'text-to-video',
    durations: ['3s', '5s', '8s', '10s', '15s'],
    resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-c1-image-to-video', name: 'PixVerse C1', type: 'image-to-video',
    durations: ['3s', '5s', '8s', '10s', '15s'],
    resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-c1-reference-to-video', name: 'PixVerse C1 R2V', type: 'image-to-video',
    durations: ['3s', '5s', '8s', '10s', '15s'],
    resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-c1-transition', name: 'PixVerse C1 Transition', type: 'image-to-video',
    durations: ['3s', '5s', '8s', '10s', '15s'],
    resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- DaVinci MagiHuman: REMOVED 2026-07-06 --
  // Venice pulled `davinci-magihuman-image-to-video` from the live catalog
  // (`/models?type=all` no longer lists it). Entry removed here and the matching
  // magihuman branches dropped from the app's VideoModelCapabilities in the same
  // change (per harness↔app capability-sync rule). Restore both if Venice re-adds it.
  // -- Wan 2.7 Spicy + Wan 2.6 R2V (added 2026-05 sync) --
  // wan-2-7-spicy-image-to-video is an uncensored Wan 2.7 i2v variant; same
  // 5/10/15s ladder. wan-2.6-reference-to-video is the new R2V variant of
  // the Wan 2.6 family.
  {
    id: 'wan-2-7-spicy-image-to-video', name: 'Wan 2.7 Spicy', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['1080p', '720p'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, minAudioInputSec: 3,
    privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-2.6-reference-to-video', name: 'Wan 2.6 R2V', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: ['1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // -- Kling V3 4K (added 2026-05 sync) --
  // 4K-resolution variants of Kling V3 R2V and t2v.
  {
    id: 'kling-v3-4k-text-to-video', name: 'Kling V3 4K', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['4K', '1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-4k-reference-to-video', name: 'Kling V3 4K R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['4K', '1080p', '720p'], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: true, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- Grok Imagine R2V + V2V (added 2026-05 sync) --
  // Grok Imagine gained R2V (with reference_image_urls) and V2V (video input)
  // variants. R2V durations are stepped: 5s/8s/10s only.
  {
    id: 'grok-imagine-reference-to-video', name: 'Grok Imagine R2V', type: 'image-to-video',
    durations: ['5s', '8s', '10s'], resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'grok-imagine-video-to-video', name: 'Grok Imagine V2V', type: 'image-to-video',
    durations: ['5s', '10s', '15s'], resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: true,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // -- Live catalog sync 2026-09-07 --------------------------------------------
  // Added from GET /models?type=video + confirmed on /video/quote. These are
  // the high-resolution lanes the harness was missing entirely — the reason the
  // resolution picker could not offer 4K / 1440p / 2K on anything but a hand-
  // added Kling entry. Concrete aspect ratios only (the live 'auto'/'adaptive'
  // sentinels are dropped so the aspect pre-flight compares against real values).

  // LTX Video 2.5 — the true-4K fast lane. Fast: 720p→2160p, even-second
  // ladder 6-20s (15s is NOT valid — snaps to 14s/16s). Pro: 720p/1080p, 6-10s.
  {
    id: 'ltx-2-5-fast-text-to-video', name: 'LTX Video 2.5 Fast', type: 'text-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'],
    resolutions: ['720p', '1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-5-fast-image-to-video', name: 'LTX Video 2.5 Fast', type: 'image-to-video',
    durations: ['6s', '8s', '10s', '12s', '14s', '16s', '18s', '20s'],
    resolutions: ['720p', '1080p', '1440p', '2160p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-5-pro-text-to-video', name: 'LTX Video 2.5 Pro', type: 'text-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-5-pro-image-to-video', name: 'LTX Video 2.5 Pro', type: 'image-to-video',
    durations: ['6s', '8s', '10s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  // MiniMax Hailuo 03 — 2K only (like base H3), 5-15s, NO audio (audio:false,
  // not configurable — omit the audio field, same as HappyHorse/H3).
  {
    id: 'minimax-hailuo-03-text-to-video', name: 'MiniMax Hailuo 03', type: 'text-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['2K'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'minimax-hailuo-03-image-to-video', name: 'MiniMax Hailuo 03', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['2K'], aspectRatios: [],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'minimax-hailuo-03-reference-to-video', name: 'MiniMax Hailuo 03 R2V', type: 'image-to-video',
    durations: ['5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['2K'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: false, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  // Wan 3.0 Prime — the premium Wan 3.0 lane, 480p→1080p, 2-30s ladder, audio.
  {
    id: 'wan-3-0-prime-text-to-video', name: 'Wan 3.0 Prime', type: 'text-to-video',
    durations: ['2s', '5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-prime-image-to-video', name: 'Wan 3.0 Prime', type: 'image-to-video',
    durations: ['2s', '5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  {
    id: 'wan-3-0-prime-reference-to-video', name: 'Wan 3.0 Prime R2V', type: 'image-to-video',
    durations: ['2s', '5s', '10s', '15s', '20s', '25s', '30s'],
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 30, privacy: 'anonymized', offline: false,
  },
  // Seedance 2.0 "basic" — the live-listed IDs (the non-suffixed ones the
  // harness sends are unlisted but still valid). Same 4K ceiling, 4-15s ladder.
  // `facesOff`: these twins run WITHOUT Seedance's face handling and refuse
  // input images of people (422 provider_content_policy, refunded). Fine for
  // text-only and faceless-image renders; never for a shot with characters.
  // See `VideoModelSpec.facesOff`.
  {
    id: 'seedance-2-0-text-to-video-basic', name: 'Seedance 2.0 (basic)', type: 'text-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, facesOff: true, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-image-to-video-basic', name: 'Seedance 2.0 (basic)', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: [],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, facesOff: true, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-reference-to-video-basic', name: 'Seedance 2.0 R2V (basic)', type: 'image-to-video',
    durations: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: ['480p', '720p', '1080p', '4k'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, supportsReferenceAudio: true, facesOff: true, privacy: 'anonymized', offline: false,
  },
];

// ---- Image Models ---------------------------------------------------------

export interface ImageModelSpec {
  id: string;
  name: string;
  type: 'generation' | 'edit' | 'upscale' | 'background-remove';
  offline: boolean;
}

export const IMAGE_GENERATION_MODELS: ImageModelSpec[] = [
  // Registry refreshed 2026-05-20 against live /models?type=image (28 models).
  // `qwen-image` was sunset in favour of `qwen-image-2`; new entries below are
  // marked in trailing comments.
  { id: 'venice-sd35', name: 'Venice SD 3.5', type: 'generation', offline: false },
  { id: 'hidream', name: 'HiDream', type: 'generation', offline: false },
  { id: 'flux-2-pro', name: 'Flux 2 Pro', type: 'generation', offline: false },
  { id: 'flux-2-max', name: 'Flux 2 Max', type: 'generation', offline: false },
  { id: 'gpt-image-1-5', name: 'GPT Image 1.5', type: 'generation', offline: false },
  { id: 'gpt-image-2', name: 'GPT Image 2', type: 'generation', offline: false },
  // Grok Imagine image-gen split into two endpoints (2026-05+):
  { id: 'grok-imagine-image', name: 'Grok Imagine', type: 'generation', offline: false },
  { id: 'grok-imagine-image-quality', name: 'Grok Imagine Quality', type: 'generation', offline: false },
  { id: 'hunyuan-image-v3', name: 'Hunyuan Image V3', type: 'generation', offline: false },
  { id: 'imagineart-1.5-pro', name: 'ImagineArt 1.5 Pro', type: 'generation', offline: false },
  { id: 'nano-banana-2', name: 'Nano Banana 2', type: 'generation', offline: false },
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', type: 'generation', offline: false },
  { id: 'recraft-v4', name: 'Recraft V4', type: 'generation', offline: false },
  { id: 'recraft-v4-pro', name: 'Recraft V4 Pro', type: 'generation', offline: false },
  { id: 'seedream-v4', name: 'SeedReam V4', type: 'generation', offline: false },
  { id: 'seedream-v5-lite', name: 'SeedReam V5 Lite', type: 'generation', offline: false },
  { id: 'qwen-image-2', name: 'Qwen Image 2', type: 'generation', offline: false },
  { id: 'qwen-image-2-pro', name: 'Qwen Image 2 Pro', type: 'generation', offline: false },
  { id: 'lustify-sdxl', name: 'Lustify SDXL', type: 'generation', offline: false },
  { id: 'lustify-v7', name: 'Lustify V7', type: 'generation', offline: false },
  { id: 'lustify-v8', name: 'Lustify V8', type: 'generation', offline: false },
  { id: 'wai-Illustrious', name: 'WAI Illustrious', type: 'generation', offline: false },
  { id: 'z-image-turbo', name: 'Z Image Turbo', type: 'generation', offline: false },
  { id: 'chroma', name: 'Chroma', type: 'generation', offline: false },
  // Ernie joins the Venice image catalog (2026-05+):
  { id: 'ernie-image', name: 'Ernie Image', type: 'generation', offline: false },
  { id: 'ernie-image-turbo', name: 'Ernie Image Turbo', type: 'generation', offline: false },
  // Wan 2.7 also offers text-to-image (separate from the video-gen pipeline):
  { id: 'wan-2-7-text-to-image', name: 'Wan 2.7 Text-to-Image', type: 'generation', offline: false },
  { id: 'wan-2-7-pro-text-to-image', name: 'Wan 2.7 Pro Text-to-Image', type: 'generation', offline: false },
  { id: 'bria-bg-remover', name: 'Bria Background Remover', type: 'background-remove', offline: false },
];

export const MULTI_EDIT_MODELS = [
  'qwen-edit',
  'qwen-image-2-edit',
  'qwen-image-2-pro-edit',
  'flux-2-max-edit',
  'gpt-image-1-5-edit',
  'gpt-image-2-edit',
  'grok-imagine-edit',
  'nano-banana-2-edit',
  'nano-banana-pro-edit',
  'seedream-v4-edit',
  'seedream-v5-lite-edit',
] as const;

export type MultiEditModelId = typeof MULTI_EDIT_MODELS[number];

// ---- Music / Audio Models -------------------------------------------------

export interface MusicModelSpec {
  id: string;
  name: string;
  type: 'music' | 'sound-effects' | 'tts';
  offline: boolean;
  // ---- Optional capability metadata (mirrors GET /models?type=music) -------
  // Populated for models whose queue-time params matter to callers so the
  // harness can validate voice/speed/prompt/format before enqueuing (and
  // avoid a paid 400). Left undefined for models where the generic queued-audio
  // path already does the right thing with no extra params.
  /** Selectable voices (voice-enabled models). `default_voice` first if known. */
  voices?: string[];
  /** Default voice id. For seed-audio this is the sentinel "Describe in prompt". */
  defaultVoice?: string;
  /** `speed` param support + bounds. */
  supportsSpeed?: boolean;
  minSpeed?: number;
  maxSpeed?: number;
  defaultSpeed?: number;
  /** Lyrics / instrumental behaviour. */
  supportsLyrics?: boolean;
  lyricsRequired?: boolean;
  supportsForceInstrumental?: boolean;
  supportsLanguageCode?: boolean;
  /** Output containers the model can emit (`response_format` on retrieve). */
  supportedFormats?: string[];
  defaultFormat?: string;
  /** Prompt length bounds, in characters. */
  promptCharacterLimit?: number;
  minPromptLength?: number;
  /** Default generation length in seconds. */
  defaultDurationSec?: number;
  /** Per-second price in USD (for budgeting without a `/audio/quote` round-trip). */
  pricingPerSecondUsd?: number;
  /** One-line human summary. */
  description?: string;
}

export const MUSIC_MODELS: MusicModelSpec[] = [
  { id: 'ace-step-15', name: 'ACE Step 1.5', type: 'music', offline: false },
  { id: 'elevenlabs-music', name: 'ElevenLabs Music', type: 'music', offline: false },
  { id: 'minimax-music-v2', name: 'MiniMax Music V2', type: 'music', offline: false },
  { id: 'minimax-music-v25', name: 'MiniMax Music V2.5', type: 'music', offline: false },
  { id: 'minimax-music-v26', name: 'MiniMax Music V2.6', type: 'music', offline: false },
  { id: 'lyria-3-pro', name: 'Lyria 3 Pro', type: 'music', offline: false },
  { id: 'stable-audio-25', name: 'Stable Audio 2.5', type: 'music', offline: false },
  // Seed Audio 1.0 (BytePlus) — expressive speech + audio from a text prompt.
  // A `music`-type (async queue) model, not a synchronous /audio/speech TTS:
  // it carries named voices, speed control, and a 2048-char prompt, so treat
  // it as premium prompt-driven narration/VO delivered through the audio queue.
  {
    id: 'seed-audio-1-0',
    name: 'Seed Audio 1.0',
    type: 'music',
    offline: false,
    voices: [
      'Describe in prompt', 'Tim', 'Stokie', 'Dacey', 'Vivi', 'Mindy', 'Kian',
      'Jess', 'Vienna', 'Cedric', 'Magnus', 'Quentin', 'Wukong', 'Gigi',
      'Celeste', 'Esther', 'Tracy', 'Sven', 'Felipe', 'Usseau', 'Enzo',
      'Minimi', 'Jihoon', 'Martins', 'Han',
    ],
    defaultVoice: 'Describe in prompt',
    supportsSpeed: true,
    minSpeed: 0.5,
    maxSpeed: 2,
    defaultSpeed: 1,
    supportsLyrics: false,
    lyricsRequired: false,
    supportsForceInstrumental: false,
    supportsLanguageCode: false,
    supportedFormats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    promptCharacterLimit: 2048,
    minPromptLength: 1,
    defaultDurationSec: 120,
    pricingPerSecondUsd: 0.0028750000000000004,
    description: 'Generate expressive speech and audio from a text prompt with BytePlus Seed Audio 1.0.',
  },
  { id: 'elevenlabs-sound-effects-v2', name: 'ElevenLabs Sound Effects V2', type: 'sound-effects', offline: false },
  { id: 'mmaudio-v2-text-to-audio', name: 'MMAudio V2', type: 'sound-effects', offline: false },
  { id: 'elevenlabs-tts-v3', name: 'ElevenLabs TTS V3', type: 'tts', offline: false },
  { id: 'elevenlabs-tts-multilingual-v2', name: 'ElevenLabs TTS Multilingual V2', type: 'tts', offline: false },
];

export const TTS_MODELS = ['tts-kokoro', 'tts-qwen3-0-6b', 'tts-qwen3-1-7b'] as const;
export type TTSModelId = typeof TTS_MODELS[number];

// ---- Lookup helpers -------------------------------------------------------

const _videoIndex = new Map(VIDEO_MODELS.map(m => [m.id, m]));

export function getVideoModel(id: string): VideoModelSpec | undefined {
  return _videoIndex.get(id);
}

const _musicIndex = new Map(MUSIC_MODELS.map(m => [m.id, m]));

export function getMusicModel(id: string): MusicModelSpec | undefined {
  return _musicIndex.get(id);
}

export function listMusicModels(filter?: { type?: MusicModelSpec['type'] }): MusicModelSpec[] {
  let models = MUSIC_MODELS.filter(m => !m.offline);
  if (filter?.type) models = models.filter(m => m.type === filter.type);
  return models;
}

export function listVideoModels(filter?: {
  type?: VideoModelType;
  audio?: boolean;
  minDurationSec?: number;
  supportsElements?: boolean;
  supportsReferenceImages?: boolean;
  supportsEndImage?: boolean;
  imageToVideo?: boolean;
}): VideoModelSpec[] {
  let models = VIDEO_MODELS.filter(m => !m.offline);

  if (filter?.type) models = models.filter(m => m.type === filter.type);
  if (filter?.audio !== undefined) models = models.filter(m => m.audio === filter.audio);
  if (filter?.minDurationSec) models = models.filter(m => m.maxDurationSec >= filter.minDurationSec!);
  if (filter?.supportsElements) models = models.filter(m => m.supportsElements);
  if (filter?.supportsReferenceImages) models = models.filter(m => m.supportsReferenceImages);
  if (filter?.supportsEndImage) models = models.filter(m => m.supportsEndImage);
  if (filter?.imageToVideo) models = models.filter(m => m.type === 'image-to-video');

  return models;
}

/**
 * Check if a model supports a given duration string (e.g. "8s").
 * Falls back to checking max duration if the duration is within range.
 */
export function modelSupportsDuration(modelId: string, duration: string): boolean {
  const model = getVideoModel(modelId);
  if (!model) return false;
  if (model.durations.includes(duration)) return true;

  const sec = parseInt(duration, 10);
  return !isNaN(sec) && sec <= model.maxDurationSec;
}

/**
 * For a given model, return the closest valid duration to the requested one.
 */
export function closestValidDuration(modelId: string, requestedSec: number): string | undefined {
  const model = getVideoModel(modelId);
  if (!model || model.durations.length === 0) return undefined;

  const parsed = model.durations.map(d => ({ label: d, sec: parseInt(d, 10) }));
  parsed.sort((a, b) => Math.abs(a.sec - requestedSec) - Math.abs(b.sec - requestedSec));
  return parsed[0]?.label;
}

// ---- Request validation (before the paid call) ----------------------------

export interface VideoRequestIssue {
  field: 'duration' | 'resolution';
  requested: string;
  valid: string[];
  /** A concrete alternative, e.g. the closest valid duration. */
  suggestion?: string;
  message: string;
}

/**
 * Check `duration` and `resolution` against a model's registry entry and
 * return every mismatch, with the valid list and a concrete suggestion.
 *
 * Returns `[]` for an unknown model (the registry cannot vouch either way) and
 * for models that expose no ladder for a field.
 *
 * Both values are matched VERBATIM against the ladder, including case:
 * Venice's enums are case-sensitive and differ by family (`'720p'` on
 * Seedance, `'768P'` on MiniMax; 2K on H3 Max 400s with
 * `Expected '480P' | '768P'`), so a caller that normalises resolution to one
 * case would pass here and fail at the paid call. Pass the string exactly as
 * the model's `resolutions` ladder (or the live `/models` constraints) spell
 * it; when the only mismatch is case, the issue's `suggestion` is that
 * spelling.
 *
 * This replaces two silent corrections: `queueVideo` used to snap an invalid
 * duration to the nearest valid one, and `buildModelParams` used to swap an
 * invalid resolution for `resolutions[0]`. Both changed the price and the
 * output without the caller asking, and only a `console.warn` said so. A
 * caller that *wants* snapping can pass `{ snap: true }` to `queueVideo`.
 */
export function validateVideoRequest(
  modelId: string,
  opts: { duration?: string; resolution?: string },
): VideoRequestIssue[] {
  const model = getVideoModel(modelId);
  if (!model) return [];
  const issues: VideoRequestIssue[] = [];

  if (opts.duration && model.durations.length > 0 && !model.durations.includes(opts.duration)) {
    const requestedSec = parseInt(opts.duration, 10);
    const suggestion = Number.isFinite(requestedSec)
      ? closestValidDuration(modelId, requestedSec)
      : model.durations[0];
    issues.push({
      field: 'duration',
      requested: opts.duration,
      valid: [...model.durations],
      suggestion,
      message: `Duration ${opts.duration} is not supported by ${modelId} (valid: ${model.durations.join(', ')})`
        + (suggestion ? `; try ${suggestion}` : ''),
    });
  }

  if (opts.resolution && model.resolutions.length > 0 && !model.resolutions.includes(opts.resolution)) {
    // Prefer a case-insensitive match ('720P' vs '720p') as the suggestion;
    // otherwise the model's first (default) tier.
    const ci = model.resolutions.find(r => r.toLowerCase() === opts.resolution!.toLowerCase());
    const suggestion = ci ?? model.resolutions[0];
    issues.push({
      field: 'resolution',
      requested: opts.resolution,
      valid: [...model.resolutions],
      suggestion,
      message: `Resolution ${opts.resolution} is not supported by ${modelId} (valid: ${model.resolutions.join(', ')})`
        + (suggestion ? `; try ${suggestion}` : ''),
    });
  }

  return issues;
}

// ---- Bitrate mode (Seedance 2.x) ------------------------------------------

/**
 * Venice's `bitrate_mode` for the Seedance family: `'high'` encodes at ~5-6x
 * the bitrate for sharper output and far fewer compression artifacts (larger
 * files), `'standard'` is the API default. It does NOT affect token price.
 */
export type BitrateMode = 'standard' | 'high';

/**
 * Default `bitrate_mode` applied to every Seedance 2.5 render. Seedance 2.5's
 * standard encode is visibly soft/blocky on detailed footage; `'high'` is the
 * dramatic-quality default and costs nothing extra.
 */
export const DEFAULT_SEEDANCE_25_BITRATE_MODE: BitrateMode = 'high';

/**
 * True for any Seedance 2.5 video model id — the registry ids
 * (`seedance-2-5-text-to-video`, `-image-to-video`, `-reference-to-video`) as
 * well as the `-basic` / `-i2v` id spellings some launch scripts use.
 */
export function isSeedance25VideoModel(modelId: string): boolean {
  return modelId.startsWith('seedance-2-5');
}

/**
 * Resolve the `bitrate_mode` to attach to a `/video/queue` body for a model.
 * An explicit override always wins; otherwise Seedance 2.5 defaults to `'high'`
 * and every other model returns `undefined` (the field is Seedance-only, so
 * callers should skip it rather than send it to models that reject it).
 */
export function resolveBitrateMode(
  modelId: string,
  override?: BitrateMode,
): BitrateMode | undefined {
  if (override) return override;
  if (isSeedance25VideoModel(modelId)) return DEFAULT_SEEDANCE_25_BITRATE_MODE;
  return undefined;
}

// ---- Camera trajectory (MiniMax H3 Max Multi-Angle) -----------------------

/** Min / max keyframes the `camera_trajectory` array accepts (server-enforced). */
export const CAMERA_TRAJECTORY_MIN_KEYFRAMES = 2;
export const CAMERA_TRAJECTORY_MAX_KEYFRAMES = 12;
/** Elevation bounds in degrees (server: elevation −90..90). */
export const CAMERA_ELEVATION_MIN_DEG = -90;
export const CAMERA_ELEVATION_MAX_DEG = 90;
/** Total absolute azimuth travel ceiling: 32 full turns (server: "must not exceed 32 full turns"). */
export const CAMERA_MAX_AZIMUTH_TURNS = 32;
export const CAMERA_MAX_AZIMUTH_TRAVEL_DEG = CAMERA_MAX_AZIMUTH_TURNS * 360; // 11520

/** True when the model accepts `camera_trajectory` (MiniMax H3 Max Multi-Angle). */
export function supportsCameraTrajectory(modelId: string): boolean {
  return getVideoModel(modelId)?.supportsCameraTrajectory === true;
}

/**
 * Validate a `camera_trajectory` against the live server rules BEFORE queueing,
 * so a malformed path fails fast client-side with a specific message instead of
 * bouncing off the strict queue schema. Mirrors the OpenAPI item schema:
 *   2–12 keyframes; each { time 0–1, azimuth°, elevation° −90..90, distance>0 };
 *   time strictly increasing; total absolute azimuth travel ≤ 32 turns (11520°).
 */
export function validateCameraTrajectory(kfs: CameraKeyframe[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(kfs)) return { ok: false, errors: ['camera_trajectory must be an array'] };
  if (kfs.length < CAMERA_TRAJECTORY_MIN_KEYFRAMES || kfs.length > CAMERA_TRAJECTORY_MAX_KEYFRAMES) {
    errors.push(`camera_trajectory must have ${CAMERA_TRAJECTORY_MIN_KEYFRAMES}–${CAMERA_TRAJECTORY_MAX_KEYFRAMES} keyframes (got ${kfs.length})`);
  }
  let prevTime = -Infinity;
  let travel = 0;
  kfs.forEach((k, i) => {
    if (!Number.isFinite(k.time) || k.time < 0 || k.time > 1) errors.push(`keyframe ${i}: time must be 0–1 (got ${k.time})`);
    if (k.time <= prevTime) errors.push(`keyframe ${i}: time must strictly increase (${k.time} ≤ ${prevTime})`);
    prevTime = k.time;
    if (!Number.isFinite(k.azimuth)) errors.push(`keyframe ${i}: azimuth must be a number`);
    if (!Number.isFinite(k.elevation) || k.elevation < CAMERA_ELEVATION_MIN_DEG || k.elevation > CAMERA_ELEVATION_MAX_DEG) {
      errors.push(`keyframe ${i}: elevation must be ${CAMERA_ELEVATION_MIN_DEG}..${CAMERA_ELEVATION_MAX_DEG} (got ${k.elevation})`);
    }
    if (!Number.isFinite(k.distance) || k.distance <= 0) errors.push(`keyframe ${i}: distance must be > 0 (got ${k.distance})`);
    if (i > 0 && Number.isFinite(k.azimuth) && Number.isFinite(kfs[i - 1].azimuth)) {
      travel += Math.abs(k.azimuth - kfs[i - 1].azimuth);
    }
  });
  if (travel > CAMERA_MAX_AZIMUTH_TRAVEL_DEG) {
    errors.push(`total azimuth travel ${travel}° exceeds ${CAMERA_MAX_AZIMUTH_TRAVEL_DEG}° (${CAMERA_MAX_AZIMUTH_TURNS} turns)`);
  }
  return { ok: errors.length === 0, errors };
}

const _clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const _lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rotation-speed profile for an orbit, applied by easing azimuth over even time. */
export type CameraRamp = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
function _ease(profile: CameraRamp, t: number): number {
  switch (profile) {
    case 'ease-in': return t * t;                                   // slow start → fast finish
    case 'ease-out': return 1 - (1 - t) * (1 - t);                  // fast start → slow settle
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'linear': default: return t;
  }
}

/**
 * The minimal, literal form of the request's ask: horizontal/vertical angle and
 * camera distance for the START frame and the FINISH frame → a 2-keyframe
 * `camera_trajectory` (time 0 and 1). `azimuth` is the horizontal angle,
 * `elevation` the vertical.
 */
export function buildStartEndTrajectory(
  start: { azimuth: number; elevation: number; distance: number },
  finish: { azimuth: number; elevation: number; distance: number },
): CameraKeyframe[] {
  return [
    { time: 0, azimuth: start.azimuth, elevation: start.elevation, distance: start.distance },
    { time: 1, azimuth: finish.azimuth, elevation: finish.elevation, distance: finish.distance },
  ];
}

export interface OrbitTrajectoryOptions {
  /** Total signed horizontal rotation over the clip, degrees. 360 = one full turn (default). Negative reverses. */
  azimuthTravel?: number;
  /** Starting horizontal angle, degrees. Default 0. */
  startAzimuth?: number;
  /** Elevation (vertical angle) at start / end, degrees. Defaults: flat 0° orbit. */
  startElevation?: number;
  endElevation?: number;
  /** Distance at start / end (1 = unchanged). Set both to dolly across the orbit. Default 1 → 1. */
  startDistance?: number;
  endDistance?: number;
  /**
   * Rotation speed profile. Implemented by easing azimuth (and the elevation /
   * distance moves) across EVENLY spaced time, so the camera covers the same arc
   * at a ramping angular velocity — real in-shot speed ramping. Default 'linear'.
   */
  ramp?: CameraRamp;
  /** Keyframe count (2–12). Linear defaults to 2; eased ramps default to 6 so the ramp is visible. */
  keyframes?: number;
}

/**
 * Build an orbit `camera_trajectory` around the start-frame subject. Covers the
 * common "full 360° turn with an optional crane/dolly and a speed ramp" case
 * used by the multi-angle demo reel. For a plain start→finish move use
 * `buildStartEndTrajectory`.
 */
export function buildOrbitTrajectory(opts: OrbitTrajectoryOptions = {}): CameraKeyframe[] {
  const {
    azimuthTravel = 360,
    startAzimuth = 0,
    startElevation = 0,
    endElevation = startElevation,
    startDistance = 1,
    endDistance = startDistance,
    ramp = 'linear',
  } = opts;
  const n = _clamp(
    Math.round(opts.keyframes ?? (ramp === 'linear' ? 2 : 6)),
    CAMERA_TRAJECTORY_MIN_KEYFRAMES,
    CAMERA_TRAJECTORY_MAX_KEYFRAMES,
  );
  const kfs: CameraKeyframe[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);           // even time → strictly increasing
    const p = _ease(ramp, t);        // eased progress drives the whole move
    kfs.push({
      time: Number(t.toFixed(4)),
      azimuth: Number((startAzimuth + azimuthTravel * p).toFixed(3)),
      elevation: Number(_clamp(_lerp(startElevation, endElevation, p), CAMERA_ELEVATION_MIN_DEG, CAMERA_ELEVATION_MAX_DEG).toFixed(3)),
      distance: Number(Math.max(1e-3, _lerp(startDistance, endDistance, p)).toFixed(4)),
    });
  }
  return kfs;
}

/**
 * Build the model-specific parameters for a video queue request.
 * Handles resolution, aspect_ratio, end_image_url, and camera_trajectory based
 * on model capabilities.
 */
export function buildModelParams(modelId: string, opts: {
  aspectRatio?: string;
  resolution?: string;
  endImageUrl?: string;
  cameraTrajectory?: CameraKeyframe[];
}): Record<string, unknown> {
  const model = getVideoModel(modelId);
  const params: Record<string, unknown> = {};

  if (!model) return params;

  // Only pass a resolution the model lists. An invalid one used to be swapped
  // for `resolutions[0]` here, silently changing price and output; callers
  // now validate up front (`validateVideoRequest`) and this stays a pure
  // pass-through so a bad value can never reach the body unannounced.
  if (opts.resolution && model.resolutions.length > 0 && model.resolutions.includes(opts.resolution)) {
    params.resolution = opts.resolution;
  }

  if (opts.aspectRatio && model.aspectRatios.length > 0) {
    if (model.aspectRatios.includes(opts.aspectRatio)) {
      params.aspect_ratio = opts.aspectRatio;
    }
  } else if (model.type === 'image-to-video' && model.id.includes('reference-to-video') && model.aspectRatios.length > 0) {
    params.aspect_ratio = opts.aspectRatio ?? '16:9';
  }

  if (opts.endImageUrl && model.supportsEndImage) {
    params.end_image_url = opts.endImageUrl;
  }

  // camera_trajectory: only for models that accept it, validated up front so a
  // malformed path fails here rather than as a paid queue round-trip.
  if (opts.cameraTrajectory && opts.cameraTrajectory.length > 0) {
    if (model.supportsCameraTrajectory) {
      const { ok, errors } = validateCameraTrajectory(opts.cameraTrajectory);
      if (!ok) throw new Error(`Invalid camera_trajectory for ${modelId}: ${errors.join('; ')}`);
      params.camera_trajectory = opts.cameraTrajectory;
    } else {
      console.warn(`  ⚠ Model ${modelId} does not support camera_trajectory; dropping it.`);
    }
  }

  return params;
}
