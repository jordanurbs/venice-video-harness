// ---------------------------------------------------------------------------
// Venice AI Model Registry
//
// Canonical source for all available Venice models, their capabilities,
// and constraints. Updated from the live /api/v1/models endpoint.
// Last synced: 2026-03-18
// ---------------------------------------------------------------------------

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
   * Minimum allowed duration (seconds) for `audio_url` input.
   * Wan 2.7 rejects audio shorter than 3 seconds. Use the pre-flight
   * helper in `src/venice/audio-preflight.ts` to pad shorter clips.
   */
  minAudioInputSec?: number;
  privacy: 'private' | 'anonymized';
  offline: boolean;
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
  {
    id: 'ltx-2-19b-full-text-to-video', name: 'LTX Video 2.0 19B Full', type: 'text-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-19b-full-image-to-video', name: 'LTX Video 2.0 19B Full', type: 'image-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-19b-distilled-text-to-video', name: 'LTX Video 2.0 19B Distilled', type: 'text-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: false,
  },
  {
    id: 'ltx-2-19b-distilled-image-to-video', name: 'LTX Video 2.0 19B Distilled', type: 'image-to-video',
    durations: ['5s', '8s', '10s', '15s', '18s'], resolutions: ['720p'], aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 18, privacy: 'anonymized', offline: false,
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
  {
    id: 'kling-2.6-pro-text-to-video', name: 'Kling 2.6 Pro', type: 'text-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 10, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-2.6-pro-image-to-video', name: 'Kling 2.6 Pro', type: 'image-to-video',
    durations: ['5s', '10s'], resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
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
  {
    id: 'kling-o3-pro-text-to-video', name: 'Kling O3 Pro', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-pro-image-to-video', name: 'Kling O3 Pro', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-pro-reference-to-video', name: 'Kling O3 Pro R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: true, supportsReferenceImages: true, supportsSceneImages: true, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-text-to-video', name: 'Kling O3 Standard', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-image-to-video', name: 'Kling O3 Standard', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-o3-standard-reference-to-video', name: 'Kling O3 Standard R2V', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
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
  // -- Kling V3 --
  {
    id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-pro-image-to-video', name: 'Kling V3 Pro', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: true,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-standard-text-to-video', name: 'Kling V3 Standard', type: 'text-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'kling-v3-standard-image-to-video', name: 'Kling V3 Standard', type: 'image-to-video',
    durations: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],
    resolutions: [], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
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
  {
    id: 'veo3.1-fast-text-to-video', name: 'Veo 3.1 Fast', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-fast-image-to-video', name: 'Veo 3.1 Fast', type: 'image-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-full-text-to-video', name: 'Veo 3.1 Full', type: 'text-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'veo3.1-full-image-to-video', name: 'Veo 3.1 Full', type: 'image-to-video',
    durations: ['4s', '6s', '8s'], resolutions: ['720p', '1080p', '4k'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  // -- Seedance 2.0 --
  {
    id: 'seedance-2-0-image-to-video', name: 'Seedance 2.0', type: 'image-to-video',
    durations: ['4s', '5s', '8s', '10s', '12s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
  },
  {
    id: 'seedance-2-0-text-to-video', name: 'Seedance 2.0', type: 'text-to-video',
    durations: ['4s', '5s', '8s', '10s', '12s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
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
    durations: ['4s', '5s', '8s', '10s', '12s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
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
    durations: ['4s', '5s', '8s', '10s', '12s', '15s'],
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    // audioInput probe 2026-07-23: queue validator accepted audio_url (R2V family).
    audio: true, audioConfigurable: true, audioInput: true, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, supportsReferenceAudio: true, privacy: 'anonymized', offline: false,
  },
  // -- Sora 2 --
  {
    id: 'sora-2-image-to-video', name: 'Sora 2', type: 'image-to-video',
    durations: ['4s', '8s', '12s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: false,
  },
  {
    // Sora 2 Pro: durations expanded to 20s as of 2026-05; 'true_1080p' added.
    id: 'sora-2-pro-image-to-video', name: 'Sora 2 Pro', type: 'image-to-video',
    durations: ['4s', '8s', '12s', '16s', '20s'],
    resolutions: ['720p', '1080p', 'true_1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  {
    id: 'sora-2-text-to-video', name: 'Sora 2', type: 'text-to-video',
    durations: ['4s', '8s', '12s'], resolutions: ['720p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: false,
  },
  {
    id: 'sora-2-pro-text-to-video', name: 'Sora 2 Pro', type: 'text-to-video',
    durations: ['4s', '8s', '12s', '16s', '20s'],
    resolutions: ['720p', '1080p', 'true_1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 20, privacy: 'anonymized', offline: false,
  },
  // -- PixVerse v5.6 --
  {
    id: 'pixverse-v5.6-text-to-video', name: 'PixVerse v5.6', type: 'text-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-v5.6-image-to-video', name: 'PixVerse v5.6', type: 'image-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: [],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 8, privacy: 'anonymized', offline: false,
  },
  {
    id: 'pixverse-v5.6-transition', name: 'PixVerse v5.6 Transition', type: 'image-to-video',
    durations: ['5s', '8s'], resolutions: ['360p', '540p', '720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
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

/**
 * Build the model-specific parameters for a video queue request.
 * Handles resolution, aspect_ratio, and end_image_url based on model capabilities.
 */
export function buildModelParams(modelId: string, opts: {
  aspectRatio?: string;
  resolution?: string;
  endImageUrl?: string;
}): Record<string, unknown> {
  const model = getVideoModel(modelId);
  const params: Record<string, unknown> = {};

  if (!model) return params;

  if (opts.resolution && model.resolutions.length > 0) {
    const validRes = model.resolutions.includes(opts.resolution) ? opts.resolution : model.resolutions[0];
    params.resolution = validRes;
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

  return params;
}
