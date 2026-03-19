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
  DAYTIME_ENVIRONMENTS,
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
} from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import { parseShotDuration } from './generation-planner.js';

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
  const baseTraits = char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;
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
}

const IDENTITY_SENSITIVE_TYPES = new Set(['close-up', 'reaction']);

/**
 * Intelligently selects the video model for a shot based on its
 * characteristics. Upgrades from the default action/atmosphere model
 * to the character-consistency model (O3 R2V) when identity anchoring
 * is important — close-ups, reactions, new character entrances, or
 * explicit opt-in via shot flags.
 *
 * When the resolved model supports elements or reference images,
 * those capabilities are auto-enabled (the shot no longer needs
 * manual `useElements`/`useReferenceImages` flags).
 */
export function resolveVideoModel(
  shot: ShotScript,
  series: SeriesState,
  previousShot?: ShotScript,
): ModelResolution {
  const baseModel = shot.videoModel === 'action'
    ? series.videoDefaults.actionModel
    : series.videoDefaults.atmosphereModel;

  const consistencyModel =
    series.videoDefaults.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL;

  const hasCharacters = shot.characters.length > 0;

  if (shot.useElements || shot.useReferenceImages) {
    return {
      modelId: consistencyModel,
      upgraded: consistencyModel !== baseModel,
      reason: 'explicit useElements/useReferenceImages requested',
      autoUseElements: MODELS_SUPPORTING_ELEMENTS.has(consistencyModel),
      autoUseReferenceImages: MODELS_SUPPORTING_REFERENCE_IMAGES.has(consistencyModel),
    };
  }

  if (!hasCharacters) {
    return {
      modelId: baseModel,
      upgraded: false,
      reason: 'no characters — prompt-first model',
      autoUseElements: false,
      autoUseReferenceImages: false,
    };
  }

  if (IDENTITY_SENSITIVE_TYPES.has(shot.type)) {
    return {
      modelId: consistencyModel,
      upgraded: consistencyModel !== baseModel,
      reason: `identity-sensitive shot type (${shot.type})`,
      autoUseElements: MODELS_SUPPORTING_ELEMENTS.has(consistencyModel),
      autoUseReferenceImages: MODELS_SUPPORTING_REFERENCE_IMAGES.has(consistencyModel),
    };
  }

  if (shot.continuityPriority === 'identity') {
    return {
      modelId: consistencyModel,
      upgraded: consistencyModel !== baseModel,
      reason: 'continuityPriority set to identity',
      autoUseElements: MODELS_SUPPORTING_ELEMENTS.has(consistencyModel),
      autoUseReferenceImages: MODELS_SUPPORTING_REFERENCE_IMAGES.has(consistencyModel),
    };
  }

  if (previousShot) {
    const prevChars = new Set(previousShot.characters.map(n => n.toUpperCase()));
    const newCharsEntering = shot.characters.some(n => !prevChars.has(n.toUpperCase()));
    if (newCharsEntering) {
      return {
        modelId: consistencyModel,
        upgraded: consistencyModel !== baseModel,
        reason: 'new character entering scene — reference anchoring needed',
        autoUseElements: MODELS_SUPPORTING_ELEMENTS.has(consistencyModel),
        autoUseReferenceImages: MODELS_SUPPORTING_REFERENCE_IMAGES.has(consistencyModel),
      };
    }
  }

  return {
    modelId: baseModel,
    upgraded: false,
    reason: 'default prompt-first model',
    autoUseElements: false,
    autoUseReferenceImages: false,
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

  const portraitTypes = new Set(['close-up', 'reaction']);
  const isPortrait = portraitTypes.has(shot.type);
  const isEmptyScene = shot.characters.length === 0;
  const isSingleCharAction = !isPortrait && !isEmptyScene && shot.characters.length === 1
    && (shot.type === 'action' || shot.type === 'dialogue' || shot.type === 'establishing');

  if (!isPortrait) {
    parts.push('Characters are engaged in the scene, NOT looking at the camera.');
  }

  if (isSingleCharAction) {
    parts.push('This is NOT a portrait or headshot. The environment, props, and action are equally important as the character. Show the full scene composition.');
  }

  parts.push(`Camera: ${shot.cameraMovement}.`);
  parts.push(shot.panelDescription ?? shot.description);

  if (isEmptyScene) {
    parts.push('Empty environment, no people present, no human figures, uninhabited scene.');
  } else {
    for (const charName of shot.characters) {
      const char = series.characters.find(c => c.name.toUpperCase() === charName.toUpperCase());
      if (char) {
        const baseTraits = char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;
        const wardrobe = shot.episodeWardrobe?.[charName.toUpperCase()] ?? char.wardrobe;
        parts.push(`${char.name} (${baseTraits}): ${char.description}, wearing ${wardrobe}.`);
      }
    }
  }

  parts.push(`STYLE REMINDER: ${aestheticStr}.`);

  const seed = series.aestheticSeed ?? undefined;

  let negativePrompt = isEmptyScene ? NO_PEOPLE_NEGATIVE : NEGATIVE_PROMPT;
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
    const baseTraits = char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;
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
): string {
  const wardrobe = wardrobeOverride ?? char.wardrobe;
  const shortWardrobe = wardrobe.split(',').slice(0, 2).join(',').trim();
  return `${char.name}: ${char.age}, ${char.description.split(',').slice(0, 3).join(',').trim()}, wearing ${shortWardrobe}`;
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

  const resolvedCharacters = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is MiniDramaCharacter => Boolean(c));

  let characterElements: CharacterElementSlot[] | undefined;

  if (useElements && resolvedCharacters.length > 0) {
    characterElements = resolvedCharacters.slice(0, 4).map((char, index) => ({
      characterName: char.name,
      elementIndex: index + 1,
    }));
  }

  const parts: string[] = [];

  const cameraTerm = CAMERA_TERMS[shot.cameraMovement.toLowerCase()] ?? shot.cameraMovement;
  parts.push(`${cameraTerm}.`);

  if (useElements && characterElements) {
    let desc = shot.description;
    for (const slot of characterElements) {
      const re = new RegExp(`\\b${slot.characterName}\\b`, 'gi');
      desc = desc.replace(re, `@Element${slot.elementIndex}`);
    }
    parts.push(desc);
  } else {
    parts.push(shot.description);
  }

  if (shot.dialogue) {
    const speakingChar = series.characters.find(
      c => c.name.toUpperCase() === shot.dialogue!.character.toUpperCase(),
    );
    const voiceDesc = speakingChar?.voiceDescription
      ? ` (voice: ${speakingChar.voiceDescription})`
      : '';
    const delivery = shot.dialogue.delivery || 'in character';
    const charRef = useElements && characterElements
      ? (characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())
        ? `@Element${characterElements.find(s => s.characterName.toUpperCase() === shot.dialogue!.character.toUpperCase())!.elementIndex}`
        : shot.dialogue.character)
      : shot.dialogue.character;

    parts.push(`${charRef}${voiceDesc} says ${delivery}: "${shot.dialogue.line}"`);
  }

  if (shot.sfx) {
    parts.push(`Sound of ${shot.sfx}.`);
  }

  if (shot.sceneImagePaths && shot.sceneImagePaths.length > 0 && MODELS_SUPPORTING_SCENE_IMAGES.has(modelId)) {
    const refs = shot.sceneImagePaths.slice(0, 4).map((_, i) => `@Image${i + 1}`);
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

  const wardrobeByChar = new Map<string, string>();
  for (const shot of shots) {
    if (!shot.episodeWardrobe) continue;
    for (const [charName, wardrobe] of Object.entries(shot.episodeWardrobe)) {
      if (!wardrobeByChar.has(charName.toUpperCase())) {
        wardrobeByChar.set(charName.toUpperCase(), wardrobe);
      }
    }
  }

  const parts: string[] = [];
  if (uniqueCharacters.length > 0) {
    parts.push(`Subjects: ${uniqueCharacters.map(char =>
      summarizeCharacterForMultiShot(char, wardrobeByChar.get(char.name.toUpperCase())),
    ).join('; ')}.`);
  }

  parts.push('One continuous multi-shot sequence. Keep faces, wardrobe, and visual continuity stable.');

  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
    const cameraTerm = CAMERA_TERMS[shot.cameraMovement.toLowerCase()] ?? shot.cameraMovement;
    const shotParts: string[] = [];

    shotParts.push(`Shot ${index + 1} (${parseShotDuration(shot.duration)} seconds): ${cameraTerm}.`);
    shotParts.push(shot.description);

    if (shot.dialogue) {
      const delivery = shot.dialogue.delivery || 'in character';
      const speakingChar = series.characters.find(
        c => c.name.toUpperCase() === shot.dialogue!.character.toUpperCase(),
      );
      const voiceDesc = speakingChar?.voiceDescription
        ? ` (voice: ${speakingChar.voiceDescription})`
        : '';
      shotParts.push(`${shot.dialogue.character}${voiceDesc} says ${delivery}: "${shot.dialogue.line}"`);
    }

    if (shot.sfx) {
      shotParts.push(`Ambient and effects: ${shot.sfx}.`);
    }

    parts.push(shotParts.join(' '));
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
  };
}

export function buildCharacterReferencePrompt(
  char: MiniDramaCharacter,
  aesthetic: AestheticProfile,
  angle: 'front' | 'three-quarter' | 'profile' | 'full-body',
): string {
  const baseTraits = char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;

  const anglePrompts: Record<string, string> = {
    'front': 'front-facing portrait, looking directly at camera, centered, studio lighting, neutral background',
    'three-quarter': 'three-quarter view portrait, 45 degree angle, studio lighting, neutral background',
    'profile': 'side profile portrait, 90 degree angle, studio lighting, neutral background',
    'full-body': 'full body shot, head to toe, standing pose, studio lighting, neutral background',
  };

  const noLayout = 'single portrait only, no text, no labels, no annotations, no inset panels, no detail callouts, no multi-view layout';
  const aestheticStr = buildAestheticString(aesthetic);
  return `${char.fullDescription}. ${baseTraits}. ${anglePrompts[angle]}. ${noLayout}. ${aestheticStr}. ${char.wardrobe}.`;
}
