// ---------------------------------------------------------------------------
// Prompt Builder -- converts a Shot + Scene + aesthetic profile into a
// structured image-generation prompt with character face references.
//
// The output is a PromptResult containing the final text prompt, collected
// reference images, a negative prompt, and an optional seed.
// ---------------------------------------------------------------------------

import type { Shot } from "./shot-planner.js";
import type { Scene } from "../parsers/scene-extractor.js";
import type { CharacterDescription } from "../characters/describer.js";
import type { CharacterLock } from "../characters/reference-manager.js";

// ---- Public types ---------------------------------------------------------

export interface AestheticProfile {
  /** Overall visual style, e.g. "Cinematic photography". */
  style: string;

  /** Color palette, e.g. "warm amber palette". */
  palette: string;

  /** Lighting approach, e.g. "natural lighting with film grain". */
  lighting: string;

  /** Lens rendering traits, e.g. "anamorphic lens characteristics". */
  lensCharacteristics: string;

  /** Emulated film stock, e.g. "35mm Kodak Vision3 500T". */
  filmStock: string;
}

export interface PromptResult {
  /** The assembled text prompt ready for the generation API. */
  prompt: string;

  /** Reference images to attach to the generation request. */
  referenceImages: { base64: string; role: string }[];

  /** Negative prompt describing what to exclude. */
  negativePrompt: string;

  /** Reproducibility seed (from the first character lock that has one). */
  seed?: number;

  /** Paired video generation prompt (populated by buildVideoPrompt). */
  videoPrompt?: VideoPromptResult;
}

/** Audio cue metadata for a video clip. */
export interface AudioNotes {
  dialogue?: string;
  sfx?: string;
  ambient?: string;
}

/** Video API-ready configuration block. */
export interface VideoConfig {
  model: string;
  prompt: string;
  duration: string;
  audio: boolean;
}

/** @deprecated Use VideoConfig instead. Kept for backward compatibility. */
export type VeoConfig = VideoConfig & {
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: string;
  generateAudio?: boolean;
  seed?: number;
};

/** Result of buildVideoPrompt() -- describes motion over time for a shot. */
export interface VideoPromptResult {
  /** The text prompt for a video generation model. */
  videoPrompt: string;

  /** Suggested clip duration in seconds. */
  duration: number;

  /** Specific camera motion instruction (e.g. "dolly-in, slow"). */
  cameraMovement: string;

  /** Description tying this clip to the image panel (first-frame reference). */
  startFrame: string;

  /** Audio cue metadata. */
  audioNotes: AudioNotes;

  /** Transition to the next clip. */
  transition: string;

  /** Video API-ready configuration block. */
  video: VideoConfig;

  /** @deprecated Use `video` instead. */
  veo?: VeoConfig;
}

// ---- Constants ------------------------------------------------------------

const DEFAULT_NEGATIVE_PROMPT =
  "deformed, blurry, bad anatomy, bad hands, extra fingers, mutation, " +
  "poorly drawn face, watermark, text, signature";

// ---- Time-of-day to lighting mapping --------------------------------------

const LIGHTING_BY_TIME: Record<string, string> = {
  day: "bright daylight, hard shadows",
  night: "moonlight and practical lighting, deep shadows",
  morning: "soft golden-hour light, long shadows",
  dawn: "cool pre-dawn blue light fading to warm horizon glow",
  dusk: "warm orange dusk light, long purple shadows",
  evening: "warm tungsten interior light, window glow",
  sunset: "rich golden-hour backlight, lens flare",
  noon: "harsh overhead sun, minimal shadows",
  afternoon: "warm angled sunlight, moderate shadows",
};

// ---- Interior/Exterior lighting hints -------------------------------------

const LIGHTING_BY_LOCATION_TYPE: Record<string, string> = {
  INT: "interior practical lighting, motivated sources",
  EXT: "natural ambient light",
  "INT/EXT": "mixed interior and exterior light, window spill",
  "EXT/INT": "exterior light filtering into interior",
};

// ---- Mood to lighting modifier --------------------------------------------

const LIGHTING_BY_MOOD: Record<string, string> = {
  tense: "high contrast, chiaroscuro shadows",
  romantic: "soft diffused light, warm tones, bokeh",
  chaotic: "harsh strobing light, mixed color temperatures",
  melancholy: "flat overcast light, desaturated",
  suspenseful: "underexposed, rim lighting, silhouettes",
  warm: "bright even lighting, warm color temperature",
  mysterious: "low-key lighting, fog diffusion",
  violent: "harsh directional light, deep red accents",
  quiet: "soft natural light, pastel tones",
  dark: "deep shadows, minimal fill, noir lighting",
  bright: "vivid saturated lighting, high key",
};

// ---- Helpers --------------------------------------------------------------

/**
 * Extract the INT/EXT prefix from a scene heading.
 */
function extractIntExt(heading: string): string {
  const upper = heading.toUpperCase().trim();
  if (upper.startsWith("INT./EXT.") || upper.startsWith("INT/EXT")) return "INT/EXT";
  if (upper.startsWith("EXT./INT.") || upper.startsWith("EXT/INT")) return "EXT/INT";
  if (upper.startsWith("I/E.")) return "INT/EXT";
  if (upper.startsWith("INT.")) return "INT";
  if (upper.startsWith("EXT.")) return "EXT";
  return "INT"; // default assumption
}

/**
 * Infer a lighting description from the scene's time of day, location type,
 * and mood.
 */
function inferLighting(scene: Scene): string {
  const parts: string[] = [];

  // Time of day
  const timeLower = scene.timeOfDay.toLowerCase();
  for (const [key, value] of Object.entries(LIGHTING_BY_TIME)) {
    if (timeLower.includes(key)) {
      parts.push(value);
      break;
    }
  }

  // Interior / exterior
  const intExt = extractIntExt(scene.heading);
  const locationType = LIGHTING_BY_LOCATION_TYPE[intExt];
  if (locationType) {
    parts.push(locationType);
  }

  // Mood
  const moodLower = scene.mood.toLowerCase();
  for (const [key, value] of Object.entries(LIGHTING_BY_MOOD)) {
    if (moodLower.includes(key)) {
      parts.push(value);
      break;
    }
  }

  return parts.length > 0 ? parts.join(", ") : "natural lighting";
}

/**
 * Expand the shot setting with location context from the scene action.
 */
function expandLocationDescription(scene: Scene): string {
  // Use the first action line as a location description supplement.
  if (scene.action.length > 0) {
    const firstLine = scene.action[0].trim();
    if (firstLine.length > 10) {
      return `${scene.heading} -- ${firstLine}`;
    }
  }
  return scene.heading;
}

/**
 * Build the wardrobe string for a character in a specific scene.
 *
 * Checks for a per-scene override first, then falls back to the default
 * wardrobe from the CharacterDescription.
 */
function getWardrobe(
  characterName: string,
  sceneNumber: number,
  descriptions: Map<string, CharacterDescription>,
): string {
  const desc = descriptions.get(characterName.toUpperCase());
  if (!desc) return "contextually appropriate attire";

  const wbs = desc.wardrobeByScene;
  const sceneWardrobe = wbs instanceof Map
    ? wbs.get(sceneNumber)
    : (wbs && typeof wbs === "object" ? (wbs as Record<string, string>)[String(sceneNumber)] : undefined);
  if (sceneWardrobe) return sceneWardrobe;

  return desc.wardrobe !== "unspecified"
    ? desc.wardrobe
    : "contextually appropriate attire";
}

/**
 * Build a full character visual string from a CharacterDescription.
 *
 * Uses the pre-synthesized `fullDescription` from the describer module,
 * which already contains age, build, hair, eyes, and distinguishing
 * features in prompt-ready format.
 */
function getFullCharacterDescription(
  characterName: string,
  descriptions: Map<string, CharacterDescription>,
): string {
  const desc = descriptions.get(characterName.toUpperCase());
  if (!desc) return characterName;

  // The fullDescription is the exhaustive, prompt-ready paragraph.
  return desc.fullDescription || desc.shortDescription || characterName;
}

/**
 * Infer a facial expression from the shot's action and dialogue context.
 */
function inferExpression(shot: Shot): string {
  const context = (shot.action + " " + (shot.dialogue ?? "")).toLowerCase();

  if (/laugh|smile|grin|joy|happy|elat/.test(context)) return "smiling, joyful";
  if (/cry|tear|weep|sob|grief|mourn/.test(context)) return "tearful, grief-stricken";
  if (/anger|rage|fury|furious|yell|scream/.test(context)) return "angry, intense";
  if (/fear|terror|scared|frighten|horror/.test(context)) return "fearful, wide-eyed";
  if (/shock|stun|surprise|gasp/.test(context)) return "shocked, mouth slightly open";
  if (/think|ponder|consider|contempl/.test(context)) return "thoughtful, contemplative";
  if (/determin|resolv|focus|steely/.test(context)) return "determined, focused";
  if (/love|tender|affection|gentle|soft/.test(context)) return "tender, warm";
  if (/suspic|distrust|doubt|wary/.test(context)) return "suspicious, narrowed eyes";
  if (/confus|bewilder|perplex/.test(context)) return "confused, furrowed brow";

  return "neutral, composed";
}

/**
 * Convert a kebab-case shot type into a human-readable label.
 */
function formatShotType(type: string): string {
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Convert a kebab-case movement into a human-readable description.
 */
function formatMovement(movement: string): string {
  const descriptions: Record<string, string> = {
    static: "static camera",
    "pan-left": "panning left",
    "pan-right": "panning right",
    "tilt-up": "tilting up",
    "tilt-down": "tilting down",
    "dolly-in": "dolly pushing in",
    "dolly-out": "dolly pulling out",
    tracking: "tracking shot",
    crane: "crane movement",
    handheld: "handheld camera",
    "rack-focus": "rack focus",
  };
  return descriptions[movement] ?? movement;
}

// ---- Main builder ---------------------------------------------------------

/**
 * Build a structured image-generation prompt from a shot, its parent scene,
 * an aesthetic profile, and character data.
 *
 * The prompt follows a structured template with tagged sections so the
 * image model can attend to each aspect independently:
 *
 * ```
 * [AESTHETIC] ...
 * [SHOT] ...
 * [SETTING] ...
 * [CHARACTERS] ...
 * [ACTION] ...
 * [MOOD] ...
 * [LIGHTING] ...
 * ```
 *
 * Reference images are collected from character locks (front-facing angles)
 * and returned alongside the prompt for multi-reference generation.
 */
export function buildPrompt(
  shot: Shot,
  scene: Scene,
  aesthetic: AestheticProfile,
  characterDescriptions: Map<string, CharacterDescription>,
  characterLocks: Map<string, CharacterLock>,
): PromptResult {
  const lines: string[] = [];

  // ---- [AESTHETIC] --------------------------------------------------------
  lines.push(
    `[AESTHETIC] ${aesthetic.style}, ${aesthetic.palette}, ` +
      `${aesthetic.lighting}, ${aesthetic.lensCharacteristics}, ` +
      `shot on ${aesthetic.filmStock}`,
  );
  lines.push("");

  // ---- [SHOT] -------------------------------------------------------------
  lines.push(
    `[SHOT] ${formatShotType(shot.type)} shot, ${shot.angle}, ` +
      `${shot.lens}, ${formatMovement(shot.movement)}`,
  );
  lines.push("");

  // ---- [SETTING] ----------------------------------------------------------
  lines.push(`[SETTING] ${expandLocationDescription(scene)}`);
  lines.push("");

  // ---- [CHARACTERS] -------------------------------------------------------
  const referenceImages: { base64: string; role: string }[] = [];
  let seed: number | undefined;

  if (shot.characters.length > 0) {
    lines.push("[CHARACTERS]");

    for (let i = 0; i < shot.characters.length; i++) {
      const charName = shot.characters[i];
      const fullDesc = getFullCharacterDescription(charName, characterDescriptions);
      const wardrobe = getWardrobe(charName, scene.number, characterDescriptions);
      const expression = inferExpression(shot);
      const isFocus = charName === shot.focusCharacter;

      const position = isFocus ? "center frame" : i === 0 ? "frame left" : "frame right";
      const facing = isFocus ? "facing camera" : "three-quarter angle";

      lines.push(
        `- ${charName} (${position}, ${facing}): ${fullDesc}, ` +
          `wearing ${wardrobe}, expression: ${expression}`,
      );

      // Collect reference image from character lock.
      // CharacterLock stores base64 strings directly in referenceImages.front,
      // .threeQuarter, .profile, and .fullBody.
      const lock = characterLocks.get(charName.toUpperCase());
      if (lock) {
        // Prefer front face; fall back to three-quarter for variety
        const faceRef = lock.referenceImages.front || lock.referenceImages.threeQuarter;

        if (faceRef) {
          referenceImages.push({
            base64: faceRef,
            role: `face reference for ${charName} - preserve exact facial identity`,
          });
        }

        // Capture seed from the first lock that has one
        if (seed === undefined && lock.seed !== undefined) {
          seed = lock.seed;
        }
      }
    }

    lines.push("");
  }

  // ---- [ACTION] -----------------------------------------------------------
  lines.push(`[ACTION] ${shot.action}`);
  if (shot.dialogue) {
    lines.push(`[DIALOGUE] "${shot.dialogue}"`);
  }
  lines.push("");

  // ---- [MOOD] -------------------------------------------------------------
  lines.push(`[MOOD] ${scene.mood || "neutral"}`);
  lines.push("");

  // ---- [LIGHTING] ---------------------------------------------------------
  lines.push(`[LIGHTING] ${inferLighting(scene)}`);
  lines.push("");

  // ---- Reference image annotations ---------------------------------------
  if (referenceImages.length > 0) {
    for (let i = 0; i < referenceImages.length; i++) {
      lines.push(`Image ${i + 1}: ${referenceImages[i].role}`);
    }
  }

  const prompt = lines.join("\n").trim();

  return {
    prompt,
    referenceImages,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    seed,
  };
}

// ---- Video prompt helpers -------------------------------------------------

/**
 * Map shot movement + type + angle into a natural-language camera motion
 * instruction suitable for video generation models.
 */
function describeVideoMovement(shot: Shot): string {
  const speed = inferMovementSpeed(shot);
  const descriptions: Record<string, string> = {
    static: "Camera holds static",
    "pan-left": `Camera pans ${speed} to the left`,
    "pan-right": `Camera pans ${speed} to the right`,
    "tilt-up": `Camera tilts ${speed} upward`,
    "tilt-down": `Camera tilts ${speed} downward`,
    "dolly-in": `Camera ${speed} pushes forward`,
    "dolly-out": `Camera ${speed} pulls back`,
    tracking: `Camera tracks ${speed} alongside the subject`,
    crane: `Camera cranes ${speed} upward, revealing the scene`,
    handheld: `Handheld camera with ${speed === "slow" ? "subtle" : "energetic"} movement`,
    "rack-focus": "Focus racks between foreground and background",
  };

  const base = descriptions[shot.movement] ?? `Camera moves ${shot.movement}`;

  // Add framing context from shot type
  const framingMap: Record<string, string> = {
    "extreme-wide": "in an extreme wide shot",
    wide: "in a wide shot",
    "medium-wide": "framing a medium-wide shot",
    medium: "in a medium shot",
    "medium-close-up": "framing a medium close-up",
    "close-up": "into a close-up",
    "extreme-close-up": "into an extreme close-up",
    insert: "on a detail insert",
  };

  const framing = framingMap[shot.type] ?? "";
  return `${base} ${framing}`.trim();
}

/**
 * Infer movement speed from context -- action shots are faster, dialogue slower.
 */
function inferMovementSpeed(shot: Shot): string {
  const actionLower = shot.action.toLowerCase();
  if (
    /run|chase|fight|punch|kick|crash|explod|sprint|charge|slam/.test(
      actionLower,
    )
  ) {
    return "quickly";
  }
  if (/walk|step|enter|exit|sit|stand|lean|turn/.test(actionLower)) {
    return "steadily";
  }
  return "slowly";
}

/**
 * Convert shot action text into present-tense motion verbs for video prompts.
 */
function toMotionAction(shot: Shot): string {
  let text = shot.action;

  // Convert common past/imperative forms to present continuous
  text = text
    .replace(/\bruns\b/gi, "is running")
    .replace(/\bwalks\b/gi, "is walking")
    .replace(/\blooks\b/gi, "is looking")
    .replace(/\bturns\b/gi, "is turning")
    .replace(/\bsits\b/gi, "is sitting")
    .replace(/\bstands\b/gi, "is standing")
    .replace(/\bspeaks\b/gi, "is speaking")
    .replace(/\bstares\b/gi, "is staring");

  return text;
}

/**
 * Estimate clip duration based on shot characteristics, snapped to
 * Veo 3.1 allowed values: 4, 6, or 8 seconds.
 */
function estimateDuration(shot: Shot): 4 | 6 | 8 {
  let raw: number;

  // Insert and reaction shots are short
  if (shot.type === "insert" || shot.notes?.toLowerCase().includes("reaction")) {
    raw = 4;
  } else if (shot.dialogue) {
    // Dialogue-driven shots scale with line length
    const words = shot.dialogue.split(/\s+/).length;
    // ~2.5 words/second for natural speech + 1s padding
    raw = Math.ceil(words / 2.5) + 1;
  } else if (
    shot.type === "extreme-wide" ||
    shot.type === "wide" ||
    shot.action.toLowerCase().includes("establishing")
  ) {
    // Establishing shots are longer
    raw = shot.movement === "crane" ? 8 : 6;
  } else if (
    /run|chase|fight|punch|kick|crash|explod|sprint/.test(shot.action.toLowerCase())
  ) {
    // Action beats
    raw = 4;
  } else {
    raw = 6;
  }

  // Snap to Veo-allowed values: 4, 6, or 8
  if (raw <= 5) return 4;
  if (raw <= 7) return 6;
  return 8;
}

/**
 * Extract audio cues from scene action lines and shot data.
 */
function extractAudioNotes(shot: Shot, scene: Scene): AudioNotes {
  const notes: AudioNotes = {};

  // Dialogue
  if (shot.dialogue) {
    const speaker = shot.focusCharacter || shot.characters[0] || "CHARACTER";
    notes.dialogue = `${speaker}: "${shot.dialogue}"`;
  }

  // SFX -- scan shot action for sound-producing words
  const sfxPatterns =
    /\b(door|slam|crash|bang|click|beep|chirp|ring|buzz|hum|static|footstep|boot|step|knock|creak|shatter|break|explosion|gunshot|engine|alarm|siren|thunder|rain|wind|drip|splash|thud|clatter|scrape|whistle|hiss)\b/gi;
  const actionText = shot.action + " " + scene.action.join(" ");
  const sfxMatches = [...new Set(actionText.match(sfxPatterns) || [])];
  if (sfxMatches.length > 0) {
    notes.sfx = sfxMatches.map((s) => s.toLowerCase()).join(", ");
  }

  // Ambient -- infer from location and time of day
  const ambientParts: string[] = [];
  const heading = scene.heading.toUpperCase();
  if (heading.includes("EXT.")) {
    if (scene.timeOfDay.toLowerCase().includes("night")) {
      ambientParts.push("night crickets", "distant traffic");
    } else {
      ambientParts.push("outdoor ambience", "wind");
    }
  } else {
    ambientParts.push("room tone");
    if (/office|lab|station|building/i.test(scene.location)) {
      ambientParts.push("fluorescent hum");
    }
    if (/bar|club|restaurant|cafe/i.test(scene.location)) {
      ambientParts.push("background chatter");
    }
  }
  if (ambientParts.length > 0) {
    notes.ambient = ambientParts.join(", ");
  }

  return notes;
}

// ---- Video constants -------------------------------------------------------

const DEFAULT_VIDEO_MODEL = "kling-o3-pro-image-to-video";

// ---- Veo camera term mapping ----------------------------------------------

/** Map internal movement names to Veo-friendly camera terms. */
const VEO_CAMERA_TERMS: Record<string, string> = {
  static: "locked-off static shot",
  "pan-left": "slow pan left",
  "pan-right": "slow pan right",
  "tilt-up": "tilt up",
  "tilt-down": "tilt down",
  "dolly-in": "dolly shot pushing forward",
  "dolly-out": "dolly shot pulling back",
  tracking: "tracking shot",
  crane: "crane shot rising upward",
  handheld: "handheld shot",
  "rack-focus": "rack focus",
};

// ---- Aesthetic register extraction ----------------------------------------

/**
 * Extract the relevant aesthetic register for a given scene number.
 *
 * The multi-register aesthetic is structured as:
 * - PRIMARY (scenes 1-7, 10-28): Clean Dystopia
 * - HISTORICAL FLASHBACK (scenes 8-9): Baroque Oil Painting
 * - FINAL DAWN (scenes 29-32): Warm Analog Photography
 * - END CARDS (scenes 33-34): white text on black
 *
 * Each aesthetic field may contain all registers separated by labels like
 * "CLEAN DYSTOPIA:", "BAROQUE:", "WARM ANALOG:". This function extracts
 * only the portion relevant to the current scene.
 */
function extractRegister(fullText: string, sceneNumber: number): string {
  // Determine which register label to look for
  let registerLabel: string;
  if (sceneNumber >= 8 && sceneNumber <= 9) {
    registerLabel = "BAROQUE";
  } else if (sceneNumber >= 29 && sceneNumber <= 32) {
    registerLabel = "WARM ANALOG";
  } else {
    registerLabel = "CLEAN DYSTOPIA";
  }

  // Try to extract just this register's content
  // Pattern: "LABEL: content" up to the next "LABEL:" or end
  const registerPattern = new RegExp(
    `${registerLabel}:\\s*(.+?)(?=(?:CLEAN DYSTOPIA|BAROQUE|WARM ANALOG|HISTORICAL|FINAL DAWN|Scenes? \\d):|$)`,
    "is",
  );
  const match = fullText.match(registerPattern);
  if (match?.[1]) {
    return match[1].trim().replace(/\.\s*$/, "");
  }

  // If no register labels found, the aesthetic is single-register -- use as-is
  if (!fullText.includes("CLEAN DYSTOPIA") && !fullText.includes("BAROQUE") && !fullText.includes("WARM ANALOG")) {
    return fullText.trim();
  }

  // Fallback: return the full text but truncated
  return fullText.slice(0, 200).trim();
}

// ---- Main video prompt builder --------------------------------------------

/**
 * Build a video-generation prompt from a shot, its parent scene, and
 * aesthetic data.
 *
 * The prompt is plain descriptive prose kept under ~150 words: camera
 * movement, subject + action, setting, style, and audio cues. Only the
 * aesthetic register relevant to the current scene is included.
 *
 * The returned `video` block is API-ready for any supported video model.
 * The model field is a default -- the generation script chooses the actual
 * model at runtime.
 */
export function buildVideoPrompt(
  shot: Shot,
  scene: Scene,
  aesthetic: AestheticProfile,
): VideoPromptResult {
  const duration = estimateDuration(shot);
  const audioNotes = extractAudioNotes(shot, scene);
  const transition = shot.transitionOut || "CUT";

  // Build the start-frame description (ties video to the image panel)
  const startFrame =
    `${formatShotType(shot.type)} shot, ${shot.angle}, ` +
    `${expandLocationDescription(scene)}` +
    (shot.characters.length > 0
      ? ` with ${shot.characters.join(", ")}`
      : "");

  // ---- Extract only the relevant aesthetic register -----------------------

  const regStyle = extractRegister(aesthetic.style, scene.number);
  const regPalette = extractRegister(aesthetic.palette, scene.number);
  const regLighting = extractRegister(aesthetic.lighting, scene.number);
  const regLens = extractRegister(aesthetic.lensCharacteristics, scene.number);
  const regFilm = extractRegister(aesthetic.filmStock, scene.number);

  // ---- Build prompt in plain prose (target <150 words) --------------------

  const sentences: string[] = [];

  // 1. Camera movement + framing
  const cameraTerm = VEO_CAMERA_TERMS[shot.movement] ?? shot.movement;
  const shotTypeProse = formatShotType(shot.type).toLowerCase();
  const speed = inferMovementSpeed(shot);
  sentences.push(
    `A ${speed} ${cameraTerm} frames a ${shotTypeProse} at ${shot.angle.replace(/-/g, " ")} angle.`,
  );

  // 2. Subject + action
  const cleanAction = toMotionAction(shot).replace(/\.\s*$/, "");
  if (shot.characters.length > 0) {
    const charList = shot.characters.join(" and ");
    sentences.push(`${charList} ${cleanAction}.`);
  } else {
    sentences.push(cleanAction.charAt(0).toUpperCase() + cleanAction.slice(1) + ".");
  }

  // 3. Setting
  const intExt = extractIntExt(scene.heading);
  const locationDesc = scene.location || "an interior space";
  sentences.push(
    `${intExt.startsWith("EXT") ? "Outdoors" : "Inside"} ${locationDesc}. ${regLighting}.`,
  );

  // 4. Style (register-specific, concise)
  sentences.push(`${regStyle}. ${regFilm}.`);

  // 5. Audio cues
  if (audioNotes.sfx) {
    sentences.push(`Sound of ${audioNotes.sfx}.`);
  }
  if (audioNotes.ambient) {
    sentences.push(`Ambient sound of ${audioNotes.ambient}.`);
  }

  // Assemble and enforce word limit
  let videoPrompt = sentences.join(" ");
  const words = videoPrompt.split(/\s+/);
  if (words.length > 150) {
    videoPrompt = words.slice(0, 145).join(" ") + ".";
  }

  // ---- Build video config block -------------------------------------------

  const video: VideoConfig = {
    model: DEFAULT_VIDEO_MODEL,
    prompt: videoPrompt,
    duration: `${duration}s`,
    audio: true,
  };

  return {
    videoPrompt,
    duration,
    cameraMovement: `${shot.movement}, ${speed}`,
    startFrame,
    audioNotes,
    transition,
    video,
  };
}
