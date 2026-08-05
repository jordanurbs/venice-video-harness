// ---------------------------------------------------------------------------
// The intelligence layer: the reasoning model behind the pipeline.
//
// Distinct from every other registry in this codebase. The models in
// `models.ts` MAKE the pictures and the sound; these models decide WHAT gets
// made -- they develop the workshop, write the shot script, and read the
// rendered panels back to QA them. One bad choice here costs a whole
// production; one bad choice there costs a shot.
//
// Two roles, because not every model can see:
//   - writer  -- text in, JSON out. Workshop and script.
//   - vision  -- images in, JSON out. Storyboard QA.
//
// A model without vision is paired with a companion, and `resolveIntelligence`
// will only ever pair WITHIN the same privacy tier. Silently sending a private
// project's panels to an anonymized model to work around a missing capability
// would break the promise the operator made when they picked "private".
//
// Verified against the live Venice catalog on 2026-08-05 (privacy, vision) and
// by direct calls (JSON reliability, real image comprehension).
// ---------------------------------------------------------------------------

/**
 * How Venice handles the request upstream.
 *
 * - `private`    -- served on Venice infrastructure; the prompt is not handed
 *                   to a third-party provider.
 * - `anonymized` -- routed to an external provider with identifying metadata
 *                   stripped. Stronger models live here; the prompt still
 *                   leaves Venice.
 */
export type ModelPrivacy = 'private' | 'anonymized';

export interface TextModelSpec {
  id: string;
  /** How the model is referred to in conversation and in the wizard. */
  label: string;
  privacy: ModelPrivacy;
  /** Genuinely reads images -- verified by asking one to name a colour. */
  vision: boolean;
  /** USD per million tokens, from the live catalog. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Shown in the wizard. Plain facts, no salesmanship. */
  note: string;
  /**
   * Set when the model needs more than one attempt to emit valid JSON often
   * enough to matter. Measured, not assumed.
   */
  jsonRetryProne?: boolean;
  /** Kept resolvable for existing projects, but not offered in the wizard. */
  legacy?: boolean;
}

export const TEXT_MODELS: ReadonlyArray<TextModelSpec> = [
  // ---- Private: the prompt stays on Venice infrastructure -----------------
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    privacy: 'private',
    vision: true,
    inputUsdPerMTok: 3.75,
    outputUsdPerMTok: 18.75,
    note: 'Reads panels as well as it writes, so one model covers the whole pipeline',
  },
  {
    id: 'zai-org-glm-5-2',
    label: 'GLM 5.2',
    privacy: 'private',
    vision: false,
    inputUsdPerMTok: 1.4,
    outputUsdPerMTok: 4.4,
    note: 'Cheapest of the reasoning models, and text only. Needs a second attempt at JSON about one time in three',
    jsonRetryProne: true,
  },
  {
    id: 'grok-4-5',
    label: 'Grok 4.5',
    privacy: 'private',
    vision: true,
    inputUsdPerMTok: 2.27,
    outputUsdPerMTok: 6.8,
    note: 'Reads panels, and the cheapest output of the private vision models',
  },

  // ---- Anonymized: routed off Venice with metadata stripped ---------------
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    privacy: 'anonymized',
    vision: true,
    inputUsdPerMTok: 12,
    outputUsdPerMTok: 60,
    note: 'Tuned for narrative. The most expensive option by a wide margin',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    privacy: 'anonymized',
    vision: true,
    inputUsdPerMTok: 6,
    outputUsdPerMTok: 30,
    note: 'Holds long structure across a full treatment',
  },
  {
    id: 'openai-gpt-56-sol',
    label: 'GPT 5.6 Sol',
    privacy: 'anonymized',
    vision: true,
    inputUsdPerMTok: 6.25,
    outputUsdPerMTok: 37.5,
    note: 'Follows an exact output schema closely',
  },
  {
    id: 'qwen-3-8-max',
    label: 'Qwen 3.8 Max',
    privacy: 'anonymized',
    vision: true,
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 7.5,
    note: 'Cheapest of the anonymized models, and reads panels',
  },

  // ---- Legacy -------------------------------------------------------------
  {
    id: 'llama-3.3-70b',
    label: 'Llama 3.3 70B',
    privacy: 'private',
    vision: false,
    inputUsdPerMTok: 0.7,
    outputUsdPerMTok: 2.8,
    note: 'The pre-2.9.0 default. Cheapest overall, but neither reasons nor sees',
    legacy: true,
  },
];

/**
 * Default for new projects: private, sees panels, reasons.
 *
 * Private is the default on principle -- a film in development is exactly the
 * kind of thing an operator would not want leaving Venice by accident, and
 * opting out should be a deliberate choice rather than something you inherit.
 */
export const DEFAULT_INTELLIGENCE_MODEL = 'kimi-k3';

export function getTextModel(id: string): TextModelSpec | undefined {
  return TEXT_MODELS.find(model => model.id === id);
}

/** Wizard-facing models, private tier first. */
export function selectableTextModels(): ReadonlyArray<TextModelSpec> {
  return TEXT_MODELS.filter(model => !model.legacy);
}

export interface IntelligenceModels {
  /** Writes the workshop and the shot script. */
  model: string;
  /** Reads storyboard panels for QA. Equals `model` when it has vision. */
  visionModel: string;
}

/**
 * Resolve the writer and the panel reader for a chosen model.
 *
 * When the choice cannot see, the companion is the cheapest vision-capable
 * model in the SAME privacy tier -- never a cheaper one from a weaker tier.
 */
export function resolveIntelligence(id: string = DEFAULT_INTELLIGENCE_MODEL): IntelligenceModels {
  const spec = getTextModel(id);
  if (!spec) {
    // An unregistered id is still honoured for the writer -- the catalog moves
    // faster than this file -- but QA needs something known to have vision.
    return { model: id, visionModel: DEFAULT_INTELLIGENCE_MODEL };
  }
  if (spec.vision) return { model: spec.id, visionModel: spec.id };

  const companion = TEXT_MODELS
    .filter(candidate => candidate.vision && !candidate.legacy && candidate.privacy === spec.privacy)
    .sort((a, b) => a.outputUsdPerMTok - b.outputUsdPerMTok)[0];
  return { model: spec.id, visionModel: companion?.id ?? DEFAULT_INTELLIGENCE_MODEL };
}

/** One-line summary for CLI output, e.g. `Kimi K3 (private, reads panels)`. */
export function describeIntelligence(id: string): string {
  const spec = getTextModel(id);
  if (!spec) return id;
  const resolved = resolveIntelligence(id);
  const vision = spec.vision
    ? 'reads panels'
    : `QA via ${getTextModel(resolved.visionModel)?.label ?? resolved.visionModel}`;
  return `${spec.label} (${spec.privacy}, ${vision})`;
}
