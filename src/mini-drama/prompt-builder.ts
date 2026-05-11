import type {
  GenerationUnit,
  SeriesState,
  ShotScript,
  ShotEnvironment,
  MiniDramaCharacter,
  VideoElement,
} from '../series/types.js';
import {
  VIDEO_NO_MUSIC_SUFFIX,
  FEMALE_BASE_TRAITS,
  MALE_BASE_TRAITS,
  KLING_MULTISHOT_MODEL,
  KLING_R2V_MODEL,
  DAYTIME_ENVIRONMENTS,
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  MODELS_USING_IMAGE_TAGS,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
} from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import { parseShotDuration } from './generation-planner.js';
import { getMaxPositivePromptChars } from '../venice/models.js';

export interface MiniDramaImagePrompt {
  prompt: string;
  negativePrompt: string;
  seed?: number;
}

export interface CharacterElementSlot {
  characterName: string;
  elementIndex: number;
}

export interface MiniDramaVideoPrompt {
  prompt: string;
  model: string;
  duration: string;
  audio: boolean;
  imageUrl?: string;
  endImageUrl?: string;
  referenceImageUrls?: string[];
  /**
   * Character-to-element mapping. The video generator resolves these to
   * actual image paths and builds the `elements` API array.
   */
  characterElements?: CharacterElementSlot[];
  /** File paths for scene reference images (@Image1, @Image2). */
  sceneImagePaths?: string[];
  /** How the model was selected — logged for transparency. */
  modelResolution?: ModelResolution;
}

const NEGATIVE_PROMPT =
  'comic panels, multiple panels, panel layout, panel borders, panel grid, speech bubbles, text bubbles, ' +
  'manga panels, comic strip, storyboard grid, split screen, multiple frames, ' +
  'deformed, blurry, bad anatomy, bad hands, extra fingers, mutation, ' +
  'poorly drawn face, watermark, text, signature, low quality, ugly, ' +
  'umbrella, holding umbrella';

const NO_PEOPLE_NEGATIVE =
  NEGATIVE_PROMPT + ', people, person, human, figure, silhouette, crowd, pedestrian, bystander';

const CAMERA_TERMS: Record<string, string> = {
  'static': 'locked-off static shot',
  'slow dolly forward': 'slow dolly shot pushing forward',
  'slow dolly back': 'slow dolly shot pulling back',
  'pan left': 'slow pan left',
  'pan right': 'slow pan right',
  'tilt up': 'tilt up',
  'tilt down': 'tilt down',
  'tracking': 'tracking shot following the subject',
  'crane up': 'crane shot rising upward',
  'handheld': 'handheld shot with subtle movement',
  'zoom in': 'slow zoom in',
  'zoom out': 'slow zoom out',
};

function getCharacterPromptText(char: MiniDramaCharacter): string {
  const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
  return `${char.name} (${baseTraits}): ${char.fullDescription}`;
}

function buildAestheticString(aesthetic: AestheticProfile): string {
  return [aesthetic.style, aesthetic.palette, aesthetic.lighting, aesthetic.lensCharacteristics, `shot on ${aesthetic.filmStock}`]
    .filter(Boolean)
    .join(', ');
}

/**
 * Determines if a shot should use daytime aesthetics. Uses the explicit
 * `environment` field when set; falls back to panelDescription heuristics
 * for backwards compatibility with scripts that don't have it yet.
 */
function isDaytimeShot(shot: ShotScript): boolean {
  if (shot.environment) {
    return DAYTIME_ENVIRONMENTS.has(shot.environment);
  }
  const sceneText = (shot.panelDescription ?? shot.description).toUpperCase();
  return sceneText.includes('NO RAIN') || sceneText.includes('BRIGHT INDOOR') || sceneText.includes('DAYTIME');
}

/**
 * Strips rain, dark-sky, and wet-surface terms from the aesthetic string
 * so that daytime scenes aren't contaminated by the series' default
 * nighttime cyberpunk aesthetic.
 */
function stripDarkAesthetic(aestheticStr: string): string {
  return aestheticStr
    .replace(/,?\s*rain rendered as[^,]*(?:,|$)/gi, ', ')
    .replace(/,?\s*neon reflections on wet surfaces/gi, '')
    .replace(/,?\s*volumetric light rays through rain/gi, ', soft volumetric light')
    .replace(/,?\s*dark charcoal backgrounds\s*\([^)]*\)/gi, ', warm bright interior backgrounds')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim();
}

export interface ModelResolution {
  modelId: string;
  upgraded: boolean;
  reason: string;
  autoUseElements: boolean;
  autoUseReferenceImages: boolean;
  /** Use @Image1/@Image2 tags instead of @Element1/@Element2 (Seedance, Grok Imagine R2V). */
  useImageTags: boolean;
}

/**
 * Selects the video model for a shot. The core principle is simple:
 *
 *   - **R2V by default** for all non-establishing shots (consistency first)
 *   - **Atmosphere model only** for truly empty establishing/mood shots
 *
 * R2V models accept `elements` and `reference_image_urls`, which are the
 * only reliable way to maintain character identity across shots. Since the
 * action model now defaults to R2V, almost all shots benefit from reference
 * anchoring. The atmosphere model is reserved for truly empty
 * establishing/insert shots with no characters on screen.
 *
 * When the resolved model supports elements or reference images, those
 * capabilities are auto-enabled.
 */
export function resolveVideoModel(
  shot: ShotScript,
  series: SeriesState,
  _previousShot?: ShotScript,
): ModelResolution {
  const baseModel = shot.videoModel === 'action'
    ? series.videoDefaults.actionModel
    : series.videoDefaults.atmosphereModel;

  const consistencyModel =
    series.videoDefaults.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL;

  const hasCharacters = shot.characters.length > 0;

  if (!hasCharacters) {
    return {
      modelId: baseModel,
      upgraded: false,
      reason: 'no characters — prompt-first model',
      autoUseElements: false,
      autoUseReferenceImages: false,
      useImageTags: false,
    };
  }

  // 3+ characters with a flat-ref R2V model (e.g. Seedance) — fall back to
  // Kling O3 R2V which supports structured elements for better per-character
  // identity separation when reference image budget is tight.
  const needsElementsFallback = shot.characters.length >= 3
    && MODELS_USING_IMAGE_TAGS.has(consistencyModel)
    && !MODELS_SUPPORTING_ELEMENTS.has(consistencyModel);

  if (needsElementsFallback) {
    return {
      modelId: KLING_R2V_MODEL,
      upgraded: true,
      reason: '3+ characters — falling back to Kling O3 R2V for structured elements',
      autoUseElements: true,
      autoUseReferenceImages: true,
      useImageTags: false,
    };
  }

  return {
    modelId: consistencyModel,
    upgraded: consistencyModel !== baseModel,
    reason: 'characters present — R2V for identity anchoring',
    autoUseElements: MODELS_SUPPORTING_ELEMENTS.has(consistencyModel),
    autoUseReferenceImages: MODELS_SUPPORTING_REFERENCE_IMAGES.has(consistencyModel),
    useImageTags: MODELS_USING_IMAGE_TAGS.has(consistencyModel),
  };
}

export function buildImagePrompt(
  shot: ShotScript,
  series: SeriesState,
): MiniDramaImagePrompt {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating images.');
  }

  const isDaytime = isDaytimeShot(shot);

  let aestheticStr = buildAestheticString(series.aesthetic);
  if (isDaytime) {
    aestheticStr = stripDarkAesthetic(aestheticStr);
  }

  const parts: string[] = [];

  parts.push(`STYLE: ${aestheticStr}.`);
  parts.push('Single cinematic frame, one continuous image, NOT a comic panel layout, NO panel borders, NO speech bubbles, NO text overlays.');

  const isEmptyScene = shot.characters.length === 0;

  parts.push('Characters are engaged in the scene, NOT looking at the camera.');

  if (!isEmptyScene && shot.characters.length === 1) {
    parts.push('This is NOT a portrait or headshot. The environment, props, and action are equally important as the character. Show the full scene composition with widescreen cinematic framing.');
  }

  parts.push(`Camera: ${shot.cameraMovement}.`);
  parts.push(shot.panelDescription ?? shot.description);

  // Silhouette characters appear in the panel but don't trigger R2V
  if (shot.silhouetteCharacters && shot.silhouetteCharacters.length > 0) {
    for (const charName of shot.silhouetteCharacters) {
      const char = series.characters.find(c => c.name.toUpperCase() === charName.toUpperCase());
      if (char) {
        parts.push(`A distant silhouetted figure (${char.name}) is visible — seen from behind or at a distance, no face detail needed, identifiable by wardrobe: ${char.wardrobe}.`);
      }
    }
  }

  if (isEmptyScene && (!shot.silhouetteCharacters || shot.silhouetteCharacters.length === 0)) {
    parts.push('Empty environment, no people present, no human figures, uninhabited scene.');
  } else if (isEmptyScene) {
    // Has silhouette characters but no main characters — don't add "no people" directive
  } else {
    for (const charName of shot.characters) {
      const char = series.characters.find(c => c.name.toUpperCase() === charName.toUpperCase());
      if (char) {
        const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
        const wardrobe = shot.episodeWardrobe?.[charName.toUpperCase()] ?? char.wardrobe;
        parts.push(`${char.name} (${baseTraits}): ${char.description}, wearing ${wardrobe}.`);
      }
    }
  }

  parts.push(`STYLE REMINDER: ${aestheticStr}.`);

  const seed = series.aestheticSeed ?? undefined;

  const hasSilhouettes = shot.silhouetteCharacters && shot.silhouetteCharacters.length > 0;
  let negativePrompt = (isEmptyScene && !hasSilhouettes) ? NO_PEOPLE_NEGATIVE : NEGATIVE_PROMPT;
  if (isDaytime) {
    negativePrompt += ', rain, rain streaks, wet surfaces, wet pavement, dark sky, storm, night sky, outdoor rain, neon reflections on wet ground';
  }

  return {
    prompt: parts.join(' ').trim(),
    negativePrompt,
    seed,
  };
}

function getCharacterVideoTag(char: MiniDramaCharacter): string {
  const key = char.gender === 'female'
    ? `${char.name}, ${char.age}, ${char.wardrobe}`
    : `${char.name}, ${char.age}, ${char.wardrobe}`;
  return key;
}

function buildCharacterAnchorText(characters: MiniDramaCharacter[]): string {
  if (characters.length === 0) return '';

  const anchors = characters.map(char => {
    const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
    return `${char.name}: ${baseTraits}, ${char.fullDescription}, wearing ${char.wardrobe}`;
  });

  return `Core subjects: ${anchors.join('; ')}.`;
}

function buildCompactAestheticString(aesthetic: AestheticProfile): string {
  return [
    aesthetic.style,
    aesthetic.palette,
    aesthetic.lighting,
  ]
    .filter(Boolean)
    .join(', ');
}

function summarizeCharacterForMultiShot(
  char: MiniDramaCharacter,
  wardrobeOverride?: string,
  elementSlot?: CharacterElementSlot,
): string {
  const wardrobe = wardrobeOverride ?? char.wardrobe;
  const shortWardrobe = wardrobe.split(',').slice(0, 2).join(',').trim();
  const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
  const label = elementSlot ? `@Element${elementSlot.elementIndex} (${char.name})` : char.name;
  return `[${label}: ${baseTraits}, ${char.age}, ${char.description.split(',').slice(0, 3).join(',').trim()}, wearing ${shortWardrobe}]`;
}

export function buildVideoPrompt(
  shot: ShotScript,
  series: SeriesState,
  previousShot?: ShotScript,
): MiniDramaVideoPrompt {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating videos.');
  }

  const resolution = resolveVideoModel(shot, series, previousShot);
  const modelId = resolution.modelId;

  const useElements = resolution.autoUseElements
    || (shot.useElements && MODELS_SUPPORTING_ELEMENTS.has(modelId));
  const useRefs = resolution.autoUseReferenceImages
    || (shot.useReferenceImages && MODELS_SUPPORTING_REFERENCE_IMAGES.has(modelId));
  const useImageTags = resolution.useImageTags;

  const resolvedCharacters = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is MiniDramaCharacter => Boolean(c));

  let characterElements: CharacterElementSlot[] | undefined;

  if ((useElements || useImageTags) && resolvedCharacters.length > 0) {
    characterElements = resolvedCharacters.slice(0, useImageTags ? 4 : 2).map((char, index) => ({
      characterName: char.name,
      elementIndex: index + 1,
    }));
  }

  const tagPrefix = useImageTags ? '@Image' : '@Element';

  const parts: string[] = [];

  const cameraTerm = CAMERA_TERMS[shot.cameraMovement.toLowerCase()] ?? shot.cameraMovement;
  parts.push(`${cameraTerm}.`);

  if ((useElements || useImageTags) && characterElements) {
    let desc = shot.description;
    for (const slot of characterElements) {
      const re = new RegExp(`\\b${slot.characterName}\\b`, 'gi');
      desc = desc.replace(re, `${tagPrefix}${slot.elementIndex}`);
    }
    parts.push(desc);
  } else {
    parts.push(shot.description);
  }

  if (shot.dialogue) {
    const speakingChar = series.characters.find(
      c => c.name.toUpperCase() === shot.dialogue!.character.toUpperCase(),
    );
    const voiceDesc = speakingChar?.voiceDescription ?? '';
    const delivery = shot.dialogue.delivery || '';
    const charRef = (useElements || useImageTags) && characterElements
      ? (characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())
        ? `${tagPrefix}${characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())!.elementIndex}`
        : shot.dialogue.character)
      : shot.dialogue.character;

    const voiceParts = [voiceDesc, delivery].filter(Boolean).join(', ');
    parts.push(`[${charRef}, ${voiceParts}]: "${shot.dialogue.line}"`);
  }

  if (shot.sfx) {
    parts.push(`Sound of ${shot.sfx}.`);
  }

  // Scene image refs use @Image tags — offset indices when image tags are
  // already used for character refs so tags don't collide.
  if (shot.sceneImagePaths && shot.sceneImagePaths.length > 0 && MODELS_SUPPORTING_SCENE_IMAGES.has(modelId)) {
    const sceneOffset = useImageTags ? (characterElements?.length ?? 0) : 0;
    const refs = shot.sceneImagePaths.slice(0, 4).map((_, i) => `@Image${sceneOffset + i + 1}`);
    parts.push(`Scene style references: ${refs.join(', ')}.`);
  }

  let aestheticStr = buildAestheticString(series.aesthetic);
  if (isDaytimeShot(shot)) {
    aestheticStr = stripDarkAesthetic(aestheticStr);
    parts.push('Bright daytime scene, natural light, no rain.');
  }
  parts.push(aestheticStr + '.');
  parts.push(VIDEO_NO_MUSIC_SUFFIX);

  const videoPrompt = parts.join(' ');

  return {
    prompt: videoPrompt,
    model: modelId,
    duration: shot.duration,
    audio: true,
    characterElements,
    sceneImagePaths: shot.sceneImagePaths,
    referenceImageUrls: useRefs ? [] : undefined,
    modelResolution: resolution,
  };
}

export function buildKlingMultiShotPrompt(
  shots: ShotScript[],
  unit: GenerationUnit,
  series: SeriesState,
): MiniDramaVideoPrompt {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating videos.');
  }

  const uniqueCharNames = Array.from(
    new Set(shots.flatMap(shot => shot.characters.map(name => name.toUpperCase()))),
  );
  const uniqueCharacters = uniqueCharNames
    .map(name => series.characters.find(char => char.name.toUpperCase() === name))
    .filter((char): char is MiniDramaCharacter => Boolean(char));

  // Build element slots for identity anchoring (Kling O3 Pro supports elements)
  const useElements = MODELS_SUPPORTING_ELEMENTS.has(KLING_MULTISHOT_MODEL);
  let characterElements: CharacterElementSlot[] | undefined;
  if (useElements && uniqueCharacters.length > 0) {
    characterElements = uniqueCharacters.slice(0, 2).map((char, index) => ({
      characterName: char.name,
      elementIndex: index + 1,
    }));
  }

  const useRefs = MODELS_SUPPORTING_REFERENCE_IMAGES.has(KLING_MULTISHOT_MODEL);

  const wardrobeByChar = new Map<string, string>();
  for (const shot of shots) {
    if (!shot.episodeWardrobe) continue;
    for (const [charName, wardrobe] of Object.entries(shot.episodeWardrobe)) {
      if (!wardrobeByChar.has(charName.toUpperCase())) {
        wardrobeByChar.set(charName.toUpperCase(), wardrobe);
      }
    }
  }

  // --- Kling 3.0 native multi-shot prompt structure ---
  // Per https://blog.fal.ai/kling-3-0-prompting-guide/:
  // 1. Define core subjects up front with @Element refs and traits
  // 2. State shot count and continuity instruction
  // 3. Label each shot as "Shot N (Xs):" with cinematic direction
  // 4. Use [Character, voice description]: "dialogue" format
  // 5. Use "Immediately," between shots for temporal control
  // 6. Append compact aesthetic and audio instructions

  const parts: string[] = [];

  // Subject definition block — Kling 3.0 locks these across all shots
  if (uniqueCharacters.length > 0) {
    for (const char of uniqueCharacters) {
      const slot = characterElements?.find(s => s.characterName.toUpperCase() === char.name.toUpperCase());
      const wardrobe = wardrobeByChar.get(char.name.toUpperCase()) ?? char.wardrobe;
      const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
      const label = slot ? `@Element${slot.elementIndex}` : char.name;
      parts.push(`${label} is ${char.name}: ${char.age}, ${baseTraits}, ${char.description}. Wearing ${wardrobe}.`);
    }
  }

  parts.push(`\n${shots.length}-shot continuous sequence. Lock face, wardrobe, and environment across all shots.\n`);

  // Per-shot blocks with Kling 3.0 dialogue format
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
    const cameraTerm = CAMERA_TERMS[shot.cameraMovement.toLowerCase()] ?? shot.cameraMovement;
    const shotParts: string[] = [];

    shotParts.push(`Shot ${index + 1} (${parseShotDuration(shot.duration)}s): ${cameraTerm}.`);

    let desc = shot.description;
    if (useElements && characterElements) {
      for (const slot of characterElements) {
        const re = new RegExp(`\\b${slot.characterName}\\b`, 'gi');
        desc = desc.replace(re, `@Element${slot.elementIndex}`);
      }
    }
    shotParts.push(desc);

    // Kling 3.0 dialogue format: [Character, voice description]: "line"
    if (shot.dialogue) {
      const speakingChar = series.characters.find(
        c => c.name.toUpperCase() === shot.dialogue!.character.toUpperCase(),
      );
      const voiceDesc = speakingChar?.voiceDescription ?? '';
      const delivery = shot.dialogue.delivery || '';
      const charRef = useElements && characterElements
        ? (characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())
          ? `@Element${characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())!.elementIndex}`
          : shot.dialogue.character)
        : shot.dialogue.character;

      const voiceParts = [voiceDesc, delivery].filter(Boolean).join(', ');
      shotParts.push(`[${charRef}, ${voiceParts}]: "${shot.dialogue.line}"`);
    }

    if (shot.sfx) {
      shotParts.push(`Sound: ${shot.sfx}.`);
    }

    parts.push(shotParts.join('\n'));

    // Temporal separator between shots
    if (index < shots.length - 1) {
      parts.push('\nImmediately, cut to:\n');
    }
  }

  const anyDaytime = shots.some(s => isDaytimeShot(s));
  let compactAesthetic = buildCompactAestheticString(series.aesthetic);
  if (anyDaytime) {
    compactAesthetic = stripDarkAesthetic(compactAesthetic);
    parts.push('Bright daytime scene, natural light, no rain.');
  }
  parts.push(`Visual style: ${compactAesthetic}.`);
  parts.push(VIDEO_NO_MUSIC_SUFFIX);

  let prompt = parts.join(' ').trim();

  const VENICE_PROMPT_LIMIT = 2500;
  if (prompt.length > VENICE_PROMPT_LIMIT) {
    console.warn(`  Multi-shot prompt is ${prompt.length} chars (limit: ${VENICE_PROMPT_LIMIT}). Truncating aesthetic to fit.`);
    const overBy = prompt.length - VENICE_PROMPT_LIMIT + 20;
    const aestheticPart = buildCompactAestheticString(series.aesthetic);
    const truncatedAesthetic = aestheticPart.slice(0, Math.max(40, aestheticPart.length - overBy));
    parts[parts.length - 2] = `Visual style: ${truncatedAesthetic}.`;
    prompt = parts.join(' ').trim();

    if (prompt.length > VENICE_PROMPT_LIMIT) {
      prompt = prompt.slice(0, VENICE_PROMPT_LIMIT);
      console.warn(`  Prompt still over limit after truncation. Hard-cut to ${VENICE_PROMPT_LIMIT} chars.`);
    }
  }

  return {
    prompt,
    model: KLING_MULTISHOT_MODEL,
    duration: unit.duration,
    audio: true,
    characterElements,
    referenceImageUrls: useRefs ? [] : undefined,
  };
}

/**
 * EXT-3: Build a character reference prompt within a per-model length cap.
 *
 * Returns just the positive prompt (string) for backwards compatibility.
 * For the structured form that includes the recommended negative-prompt
 * additions, use `buildCharacterReferencePromptParts`.
 */
export function buildCharacterReferencePrompt(
  char: MiniDramaCharacter,
  aesthetic: AestheticProfile,
  angle: 'front' | 'three-quarter' | 'profile' | 'full-body',
  options?: { model?: string; maxChars?: number },
): string {
  return buildCharacterReferencePromptParts(char, aesthetic, angle, options).positive;
}

/**
 * EXT-3: Structured character-reference prompt that splits style and
 * "no realism" cues into the negative prompt, keeping the positive prompt
 * under the per-model cap.
 *
 * Discovered: above ~1800-2200 chars on seedream-v5-lite Venice silently
 * rejects the request (panel returns < 30KB; see EXT-2). Moving STYLE
 * REMINDER content to negative_prompt drops 60-80 chars and stops the
 * silent rejections in production (Glass panel re-generation, v3 -> v4).
 *
 * The positive prompt keeps the most-important style cue + character
 * anchor inline; everything else moves to negative_prompt.
 */
export function buildCharacterReferencePromptParts(
  char: MiniDramaCharacter,
  aesthetic: AestheticProfile,
  angle: 'front' | 'three-quarter' | 'profile' | 'full-body',
  options?: { model?: string; maxChars?: number },
): { positive: string; negativeAdditions: string[] } {
  const baseTraits = char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
  const cap = options?.maxChars
    ?? getMaxPositivePromptChars(options?.model ?? 'seedream-v5-lite');

  const anglePrompts: Record<string, string> = {
    'front': 'front portrait, looking at camera, centered, studio lighting, neutral background',
    'three-quarter': 'three-quarter view, 45 degree angle, studio lighting, neutral background',
    'profile': 'side profile, 90 degree angle, studio lighting, neutral background',
    'full-body': 'full body, head to toe, standing pose, studio lighting, neutral background',
  };

  // Style is a single front-loaded cue; the rest (palette, lensCharacteristics,
  // film stock) move to negativeAdditions as anti-realism guards.
  const styleCue = aesthetic.style;

  // Build prompt parts in priority order. We greedily append until the cap
  // is hit; the tail is dropped and the consumer can choose to push the
  // dropped pieces into the negative prompt.
  const parts = [
    `STYLE: ${styleCue}.`,
    `${anglePrompts[angle]}.`,
    `${char.fullDescription}.`,
    `${baseTraits}.`,
    `${char.wardrobe}.`,
  ];
  let positive = '';
  for (const p of parts) {
    const candidate = positive ? `${positive} ${p}` : p;
    if (candidate.length > cap) break;
    positive = candidate;
  }
  // If the very first part already exceeds the cap, hard-truncate.
  if (!positive) {
    positive = parts[0].slice(0, cap);
  }

  // Style-reminder content + photorealism guards belong on the negative side.
  // They steer the model away from the wrong rendering family without eating
  // positive-prompt budget.
  const negativeAdditions = [
    aesthetic.filmStock ? `not ${aesthetic.filmStock}` : null,
    aesthetic.palette ? `not ${aesthetic.palette}` : null,
    'photorealistic',
    'photograph',
    'photo',
    '3D render',
    'Pixar',
    'no text',
    'no labels',
    'no annotations',
    'no inset panels',
    'no detail callouts',
    'no multi-view layout',
  ].filter((s): s is string => Boolean(s));

  return { positive, negativeAdditions };
}
