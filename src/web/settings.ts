// ---------------------------------------------------------------------------
// Per-project model settings for the web UI.
//
// Read: assembles the option lists from the same registries the CLI wizard
// uses (TEXT_MODELS via choices.ts, VIDEO_MODELS, family defaults) plus the
// project's current selections from series.json.
//
// Write: the ONE place the web server mutates project state directly instead
// of spawning the CLI -- because the CLI itself has no `set-models` command;
// interactive projects change these by editing series.json. The write goes
// through loadSeries/saveSeries (which preserves the characters[] merge) and
// touches only whitelisted model fields.
// ---------------------------------------------------------------------------

import { loadSeries, saveSeries } from '../series/manager.js';
import {
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_MULTISHOT_MODEL,
  resolveVideoFamilyDefaults,
  SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL,
  type VideoFamilyPreference,
} from '../series/types.js';
import { VIDEO_MODELS } from '../venice/models.js';
import {
  DEFAULT_INTELLIGENCE_MODEL,
  resolveIntelligence,
  selectableTextModels,
} from '../venice/text-models.js';
import { INTELLIGENCE_CHOICES, VIDEO_FAMILY_CHOICES } from '../mini-drama/choices.js';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface ProjectModelSettings {
  current: {
    intelligenceModel: string;
    intelligenceVisionModel: string;
    videoFamilyPreference: string;
    actionModel: string;
    atmosphereModel: string;
    characterConsistencyModel: string;
    multiShotModel: string;
    imageGenerationModel: string;
    imageEditModel: string;
  };
  options: {
    intelligence: ModelOption[];
    videoFamily: ModelOption[];
    video: ModelOption[];
    image: ModelOption[];
  };
}

/** Video models the picker offers: online, grouped by their registry order. */
function videoModelOptions(): ModelOption[] {
  return VIDEO_MODELS
    .filter(model => !model.offline)
    .map(model => ({
      value: model.id,
      label: `${model.name} (${model.type})`,
      description: [
        model.durations.join('/'),
        model.resolutions[0],
        model.audio ? 'audio' : 'silent',
        model.privacy,
      ].filter(Boolean).join(' · '),
    }));
}

/** Image models: the compatibility map's keys are the harness's known set. */
function imageModelOptions(): ModelOption[] {
  return Object.keys(SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL).map(id => ({
    value: id,
    label: id,
    description: `Seedance compat: ${SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL[id]}`,
  }));
}

export async function getModelSettings(projectDir: string): Promise<ProjectModelSettings | null> {
  const series = await loadSeries(projectDir);
  if (!series) return null;
  const defaults = series.videoDefaults;
  const intelligence = series.intelligence ?? resolveIntelligence(DEFAULT_INTELLIGENCE_MODEL);

  return {
    current: {
      intelligenceModel: intelligence.model,
      intelligenceVisionModel: intelligence.visionModel,
      videoFamilyPreference: defaults?.videoFamilyPreference ?? 'auto',
      actionModel: defaults?.actionModel ?? DEFAULT_ACTION_MODEL,
      atmosphereModel: defaults?.atmosphereModel ?? DEFAULT_ATMOSPHERE_MODEL,
      characterConsistencyModel: defaults?.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL,
      multiShotModel: defaults?.multiShotModel ?? DEFAULT_MULTISHOT_MODEL,
      imageGenerationModel: defaults?.imageDefaults?.generationModel ?? DEFAULT_IMAGE_GENERATION_MODEL,
      imageEditModel: defaults?.imageDefaults?.editModel ?? DEFAULT_IMAGE_EDIT_MODEL,
    },
    options: {
      intelligence: INTELLIGENCE_CHOICES.map(choice => ({
        value: choice.value,
        label: choice.label,
        description: choice.description,
      })),
      videoFamily: VIDEO_FAMILY_CHOICES.map(choice => ({
        value: choice.value,
        label: choice.label,
        description: choice.description,
      })),
      video: videoModelOptions(),
      image: imageModelOptions(),
    },
  };
}

export interface ModelSettingsPatch {
  intelligenceModel?: string;
  videoFamilyPreference?: string;
  actionModel?: string;
  atmosphereModel?: string;
  characterConsistencyModel?: string;
  multiShotModel?: string;
  imageGenerationModel?: string;
  imageEditModel?: string;
}

const VALID_FAMILIES = new Set(VIDEO_FAMILY_CHOICES.map(choice => choice.value));

function isKnownVideoModel(id: string): boolean {
  return VIDEO_MODELS.some(model => model.id === id && !model.offline);
}

/**
 * Apply a validated patch to series.json. Returns the new settings or an
 * error string. Selecting a video family repoints the three routing models
 * to that family's defaults (mirroring new-series), which individual model
 * fields in the SAME patch can then override.
 */
export async function updateModelSettings(
  projectDir: string,
  patch: ModelSettingsPatch,
): Promise<ProjectModelSettings | { error: string }> {
  const series = await loadSeries(projectDir);
  if (!series) return { error: 'Project not found.' };

  if (patch.intelligenceModel !== undefined) {
    const known = selectableTextModels().some(model => model.id === patch.intelligenceModel);
    if (!known) return { error: `Unknown intelligence model: ${patch.intelligenceModel}` };
    series.intelligence = resolveIntelligence(patch.intelligenceModel);
  }

  series.videoDefaults = series.videoDefaults ?? {
    actionModel: DEFAULT_ACTION_MODEL,
    atmosphereModel: DEFAULT_ATMOSPHERE_MODEL,
  };

  if (patch.videoFamilyPreference !== undefined) {
    if (!VALID_FAMILIES.has(patch.videoFamilyPreference as VideoFamilyPreference)) {
      return { error: `Unknown video family: ${patch.videoFamilyPreference}` };
    }
    const family = patch.videoFamilyPreference as VideoFamilyPreference;
    series.videoDefaults.videoFamilyPreference = family;
    const familyDefaults = family === 'auto'
      ? {
          actionModel: DEFAULT_ACTION_MODEL,
          atmosphereModel: DEFAULT_ATMOSPHERE_MODEL,
          characterConsistencyModel: DEFAULT_CHARACTER_CONSISTENCY_MODEL,
        }
      : resolveVideoFamilyDefaults(family);
    series.videoDefaults.actionModel = familyDefaults.actionModel;
    series.videoDefaults.atmosphereModel = familyDefaults.atmosphereModel;
    series.videoDefaults.characterConsistencyModel = familyDefaults.characterConsistencyModel;
  }

  for (const key of ['actionModel', 'atmosphereModel', 'characterConsistencyModel', 'multiShotModel'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!isKnownVideoModel(value)) return { error: `Unknown video model: ${value}` };
    series.videoDefaults[key] = value;
  }

  if (patch.imageGenerationModel !== undefined || patch.imageEditModel !== undefined) {
    const imageDefaults = series.videoDefaults.imageDefaults ?? {
      generationModel: DEFAULT_IMAGE_GENERATION_MODEL,
      editModel: DEFAULT_IMAGE_EDIT_MODEL,
    };
    if (patch.imageGenerationModel !== undefined) {
      if (!(patch.imageGenerationModel in SEEDANCE_COMPATIBILITY_BY_IMAGE_MODEL)) {
        return { error: `Unknown image model: ${patch.imageGenerationModel}` };
      }
      imageDefaults.generationModel = patch.imageGenerationModel;
      // Keep the edit model in-family unless explicitly overridden — the
      // harness convention is `<generation-model>-edit` (nano-banana-2 →
      // nano-banana-2-edit); mismatched pairs cause style drift on fix-panel.
      if (patch.imageEditModel === undefined) {
        imageDefaults.editModel = `${patch.imageGenerationModel}-edit`;
      }
    }
    if (patch.imageEditModel !== undefined) {
      imageDefaults.editModel = patch.imageEditModel;
    }
    series.videoDefaults.imageDefaults = imageDefaults;
  }

  await saveSeries(series);
  const next = await getModelSettings(projectDir);
  return next ?? { error: 'Settings saved but could not be re-read.' };
}
