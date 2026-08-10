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

/**
 * The production/render route, asked up front at project creation.
 *
 *   - montage  → videoDefaults.montageMode: true  (this branch's default).
 *                Each scene renders as ONE single-pass Seedance 2.5 generation
 *                and is auto-cut into per-shot clips in a media library for a
 *                human/editor to assemble. Strongest continuity (identity,
 *                lighting, geography hold across every cut inside one render).
 *   - standard → videoDefaults.montageMode: false (2.0-era planner).
 *                Per-shot + short multi-shot units that run end-to-end with
 *                less hands-on editing, but stitching separate renders is more
 *                prone to consistency drift across cuts.
 *
 * Montage is listed first so it stays the default (Enter / non-TTY).
 */
export type RenderRoute = 'montage' | 'standard';

export const RENDER_ROUTE_CHOICES: ReadonlyArray<{
  label: string; value: RenderRoute; description?: string;
}> = [
  {
    label: 'Montage (default — recommended)',
    value: 'montage',
    description: 'Each scene renders as ONE single-pass Seedance 2.5 generation (up to 30s), then auto-cuts into per-shot clips in a media library for you to edit. Strongest continuity — identity, lighting, and geography hold across every cut inside one render. Add --auto-edit (or videoDefaults.autoEdit) to chain straight into assembly.',
  },
  {
    label: 'Standard (special-purpose — per-shot)',
    value: 'standard',
    description: 'The per-shot / short multi-shot planner. Reach for it when the script cannot group into scenes (location-hopping, one-shot scenes, non-overlapping characters), when you need per-shot control over individual renders, or to render on a non-Seedance family. Stitching separately-rendered shots is more prone to consistency drift across cuts.',
  },
];

export const AUDIO_STRATEGY_CHOICES = [
  { label: 'Native dialogue (default — right for almost every project)', value: 'native', description: 'The selected video model speaks in-frame; Seedance and HappyHorse take a voice-donor clip (reference_audio_urls) so timbre and accent hold across shots. Voice consistency is already covered here — you do NOT need lip-sync for that.' },
  { label: 'Exact lip-sync (special-purpose — only when the mouth must follow a specific recording)', value: 'lip-sync', description: 'For music videos, pre-recorded VO, language swaps, or precise wording/timing: Venice speech is rendered first and passed as an audio file, and the mouth follows that exact recording. Seedance 2.x and MiniMax H3 do it in-family; other families route to Wan 2.7.' },
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
