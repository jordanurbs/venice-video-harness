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
  privacy: 'private' | 'anonymized';
  offline: boolean;
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
  {
    id: 'seedance-2-0-reference-to-video', name: 'Seedance 2.0 R2V', type: 'image-to-video',
    durations: ['4s', '5s', '8s', '10s', '12s', '15s'],
    resolutions: ['480p', '720p'], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    audio: true, audioConfigurable: true, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: true, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 15, privacy: 'anonymized', offline: false,
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
    id: 'sora-2-pro-image-to-video', name: 'Sora 2 Pro', type: 'image-to-video',
    durations: ['4s', '8s', '12s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: false,
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
    durations: ['4s', '8s', '12s'], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    audio: true, audioConfigurable: false, audioInput: false, videoInput: false,
    supportsElements: false, supportsReferenceImages: false, supportsSceneImages: false, supportsEndImage: false,
    maxDurationSec: 12, privacy: 'anonymized', offline: false,
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
];

// ---- Image Models ---------------------------------------------------------

export interface ImageModelSpec {
  id: string;
  name: string;
  type: 'generation' | 'edit' | 'upscale' | 'background-remove';
  offline: boolean;
}

export const IMAGE_GENERATION_MODELS: ImageModelSpec[] = [
  { id: 'venice-sd35', name: 'Venice SD 3.5', type: 'generation', offline: false },
  { id: 'hidream', name: 'HiDream', type: 'generation', offline: false },
  { id: 'flux-2-pro', name: 'Flux 2 Pro', type: 'generation', offline: false },
  { id: 'flux-2-max', name: 'Flux 2 Max', type: 'generation', offline: false },
  { id: 'gpt-image-1-5', name: 'GPT Image 1.5', type: 'generation', offline: false },
  { id: 'gpt-image-2', name: 'GPT Image 2', type: 'generation', offline: false },
  { id: 'grok-imagine', name: 'Grok Imagine', type: 'generation', offline: false },
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
  { id: 'qwen-image', name: 'Qwen Image', type: 'generation', offline: false },
  { id: 'lustify-sdxl', name: 'Lustify SDXL', type: 'generation', offline: false },
  { id: 'lustify-v7', name: 'Lustify V7', type: 'generation', offline: false },
  { id: 'wai-Illustrious', name: 'WAI Illustrious', type: 'generation', offline: false },
  { id: 'z-image-turbo', name: 'Z Image Turbo', type: 'generation', offline: false },
  { id: 'chroma', name: 'Chroma', type: 'generation', offline: false },
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
}

export const MUSIC_MODELS: MusicModelSpec[] = [
  { id: 'ace-step-15', name: 'ACE Step 1.5', type: 'music', offline: false },
  { id: 'elevenlabs-music', name: 'ElevenLabs Music', type: 'music', offline: false },
  { id: 'minimax-music-v2', name: 'MiniMax Music V2', type: 'music', offline: false },
  { id: 'stable-audio-25', name: 'Stable Audio 2.5', type: 'music', offline: false },
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
