import type { VideoFamilyPreference } from '../series/types.js';

export const VIDEO_FAMILY_CHOICES: ReadonlyArray<{
  label: string; value: VideoFamilyPreference; description?: string;
}> = [
  { label: 'Automatic', value: 'auto', description: 'Current reference-first Seedance Enhanced defaults' },
  { label: 'Seedance 2.0', value: 'seedance', description: 'Reference-first identity anchoring, native dialogue, 720p drafts, 4-15s' },
  { label: 'MiniMax H3', value: 'minimax-h3', description: 'Open-weight omni-modal, 2K native audio, 5-15s' },
  { label: 'HappyHorse 1.1', value: 'happyhorse', description: 'Native multilingual lip-sync, 720p/1080p, 3-15s' },
  { label: 'Grok Imagine', value: 'grok-imagine', description: 'Atmosphere-forward look; R2V durations stepped at 5s/8s/10s' },
  { label: 'Kling O3', value: 'kling-o3', description: 'Stylized and illustrated aesthetics; structured character elements' },
];

export const AUDIO_STRATEGY_CHOICES = [
  { label: 'Native dialogue', value: 'native', description: 'The selected video model speaks in-frame; Seedance uses character voice references' },
  { label: 'Exact lip-sync', value: 'lip-sync', description: 'Venice speech drives Wan 2.7 mouth movement' },
  { label: 'Narrator voice-over', value: 'narrator-vo', description: 'Mute model narration and own the VO lane' },
] as const;
