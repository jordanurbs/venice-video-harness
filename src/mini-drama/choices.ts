import type { VideoFamilyPreference } from '../series/types.js';
import { resolveIntelligence, selectableTextModels } from '../venice/text-models.js';

export const VIDEO_FAMILY_CHOICES: ReadonlyArray<{
  label: string; value: VideoFamilyPreference; description?: string;
}> = [
  { label: 'Automatic', value: 'auto', description: 'Current reference-first Seedance Enhanced defaults' },
  { label: 'Seedance 2.0', value: 'seedance', description: 'Reference-first identity anchoring, native dialogue, 720p drafts, 4-15s' },
  { label: 'Wan 3.0', value: 'wan-3-0', description: 'Shots up to 30s, 480p drafts through 1080p, native audio always on' },
  { label: 'MiniMax H3', value: 'minimax-h3', description: 'Open-weight omni-modal, 2K native audio, 5-15s' },
  { label: 'HappyHorse 1.1', value: 'happyhorse', description: 'Native multilingual lip-sync, 720p/1080p, 3-15s' },
  { label: 'Grok Imagine', value: 'grok-imagine', description: 'Atmosphere-forward look; R2V durations stepped at 5s/8s/10s' },
  { label: 'Kling O3', value: 'kling-o3', description: 'Stylized and illustrated aesthetics; structured character elements' },
];

export const AUDIO_STRATEGY_CHOICES = [
  { label: 'Native dialogue', value: 'native', description: 'The selected video model speaks in-frame; Seedance and HappyHorse take a voice-donor clip so timbre and accent hold across shots' },
  { label: 'Exact lip-sync', value: 'lip-sync', description: 'Venice speech is rendered first and passed to the model as an audio file, and the mouth follows that recording. Seedance 2.x and MiniMax H3 do it in-family; other families route to Wan 2.7' },
  { label: 'Narrator voice-over', value: 'narrator-vo', description: 'Mute model narration and own the VO lane' },
] as const;

/**
 * The reasoning model behind the project, private tier first.
 *
 * Each line states the privacy tier, whether the model reads panels itself,
 * and its output price -- the three things that actually decide the choice.
 * A text-only model names the companion QA borrows, so the pairing is visible
 * before it happens rather than discovered in a log.
 */
export const INTELLIGENCE_CHOICES: ReadonlyArray<{
  label: string; value: string; description?: string;
}> = selectableTextModels()
  .slice()
  .sort((a, b) => (a.privacy === b.privacy ? 0 : a.privacy === 'private' ? -1 : 1))
  .map(spec => {
    const resolved = resolveIntelligence(spec.id);
    const companion = spec.vision
      ? ''
      : ` · QA uses ${selectableTextModels().find(m => m.id === resolved.visionModel)?.label ?? resolved.visionModel}`;
    return {
      label: `${spec.label} (${spec.privacy})`,
      value: spec.id,
      description: `${spec.note} · $${spec.outputUsdPerMTok}/M out${companion}`,
    };
  });
