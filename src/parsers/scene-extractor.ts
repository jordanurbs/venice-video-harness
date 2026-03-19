import type { FountainResult, FountainToken } from "./fountain-parser.js";

// Re-export for convenience so callers can import from either module.
export type { FountainResult, FountainToken };

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DialogueLine {
  character: string;
  parenthetical?: string;
  text: string;
}

export interface Scene {
  number: number;
  heading: string;
  location: string;
  timeOfDay: string;
  characters: string[];
  action: string[];
  dialogue: DialogueLine[];
  transitions: string[];
  mood: string;
}

// ---------------------------------------------------------------------------
// Heading parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the location portion from a scene heading.
 *
 * Examples:
 *   "INT. JAZZ CLUB - NIGHT"          -> "JAZZ CLUB"
 *   "EXT. ROOFTOP - DOWNTOWN - DUSK"  -> "ROOFTOP - DOWNTOWN"
 *   "INT./EXT. CAR"                   -> "CAR"
 *   "I/E. APARTMENT"                  -> "APARTMENT"
 */
function extractLocation(heading: string): string {
  // Remove the INT./EXT./INT./EXT./I/E. prefix.
  const withoutPrefix = heading
    .replace(/^\s*(INT\.\s*\/\s*EXT\.|I\s*\/\s*E\.|INT\.|EXT\.)\s*/i, "")
    .trim();

  // Everything before the *last* " - " delimiter is location.
  // If there is no delimiter the entire remainder is the location.
  const lastDash = withoutPrefix.lastIndexOf(" - ");
  if (lastDash === -1) return withoutPrefix;
  return withoutPrefix.substring(0, lastDash).trim();
}

/**
 * Extract the time-of-day portion from a scene heading.
 *
 * Looks for the text after the last " - " separator.  If the result
 * matches a known time-of-day keyword it is returned; otherwise the
 * raw text after the last dash is returned (to preserve non-standard
 * time indicators like "LATER" or "MOMENTS LATER").
 */
const TIME_OF_DAY_KEYWORDS = new Set([
  "DAY",
  "NIGHT",
  "DAWN",
  "DUSK",
  "MORNING",
  "AFTERNOON",
  "EVENING",
  "SUNRISE",
  "SUNSET",
  "LATER",
  "CONTINUOUS",
  "MOMENTS LATER",
  "SAME",
  "SAME TIME",
]);

function extractTimeOfDay(heading: string): string {
  const lastDash = heading.lastIndexOf(" - ");
  if (lastDash === -1) return "";
  const candidate = heading.substring(lastDash + 3).trim().toUpperCase();
  if (TIME_OF_DAY_KEYWORDS.has(candidate)) return candidate;
  // Partial match: heading may say "NIGHT (FLASHBACK)" etc.
  for (const kw of TIME_OF_DAY_KEYWORDS) {
    if (candidate.startsWith(kw)) return kw;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Mood inference
// ---------------------------------------------------------------------------

const MOOD_KEYWORDS: Record<string, string[]> = {
  dark: [
    "dark",
    "shadow",
    "dim",
    "gloomy",
    "ominous",
    "sinister",
    "bleak",
    "eerie",
    "foreboding",
    "dread",
  ],
  tense: [
    "tense",
    "nervous",
    "anxious",
    "sweat",
    "grip",
    "clench",
    "trembl",
    "panic",
    "frantic",
    "urgent",
    "desperate",
    "suspense",
  ],
  violent: [
    "punch",
    "kick",
    "gun",
    "shot",
    "blood",
    "fight",
    "stab",
    "explo",
    "crash",
    "smash",
    "attack",
    "scream",
    "wound",
    "kill",
    "dead",
  ],
  romantic: [
    "kiss",
    "embrace",
    "love",
    "tender",
    "gentle",
    "caress",
    "intimate",
    "passion",
    "heart",
    "gaze",
  ],
  warm: [
    "warm",
    "cozy",
    "comfort",
    "smile",
    "laugh",
    "joy",
    "happy",
    "bright",
    "sun",
    "glow",
    "golden",
    "cheerful",
  ],
  bright: [
    "vivid",
    "colorful",
    "radiant",
    "sparkl",
    "gleam",
    "shine",
    "brilliant",
    "luminous",
  ],
  quiet: [
    "quiet",
    "silent",
    "still",
    "calm",
    "peace",
    "serene",
    "hushed",
    "soft",
    "whisper",
    "murmur",
  ],
  chaotic: [
    "chaos",
    "crowd",
    "rush",
    "noise",
    "loud",
    "frenzy",
    "mayhem",
    "hectic",
    "commotion",
    "scramble",
    "disorder",
  ],
  melancholy: [
    "sad",
    "tear",
    "cry",
    "weep",
    "sorrow",
    "grief",
    "mourn",
    "lonely",
    "desolat",
    "wistful",
    "melan",
    "somber",
  ],
  mysterious: [
    "mystery",
    "strange",
    "odd",
    "peculiar",
    "enigma",
    "unknown",
    "secret",
    "hidden",
    "fog",
    "mist",
    "vanish",
  ],
};

/**
 * Score the combined action text of a scene against mood keyword buckets
 * and return the mood with the highest hit count.  Falls back to "neutral"
 * when no keywords are matched.
 */
function inferMood(actionLines: string[]): string {
  const blob = actionLines.join(" ").toLowerCase();
  if (blob.length === 0) return "neutral";

  let bestMood = "neutral";
  let bestScore = 0;

  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      // Use indexOf for substring matching so partial stems work
      // (e.g. "trembl" matches "trembling").
      let idx = 0;
      while ((idx = blob.indexOf(kw, idx)) !== -1) {
        score++;
        idx += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMood = mood;
    }
  }

  return bestMood;
}

// ---------------------------------------------------------------------------
// Character name normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a character name by stripping parenthetical extensions
 * like "(V.O.)", "(O.S.)", "(CONT'D)" and trimming whitespace.
 */
function normaliseCharacterName(raw: string): string {
  return raw.replace(/\s*\(.*?\)\s*/g, "").trim();
}

// ---------------------------------------------------------------------------
// Scene extraction
// ---------------------------------------------------------------------------

/**
 * Walk through a flat token stream produced by either `parseFountain` or
 * `parsePdfToTokens` and group them into structured `Scene` objects.
 *
 * Tokens appearing before the first `scene_heading` token are discarded
 * (they typically represent title-page metadata that is already captured
 * in `FountainResult.title` etc.).
 *
 * @param parsed - The `FountainResult` from any parser.
 * @returns An ordered array of `Scene` objects, numbered from 1.
 */
export function extractScenes(parsed: FountainResult): Scene[] {
  const scenes: Scene[] = [];
  let current: Scene | null = null;
  let sceneNumber = 0;

  // Dialogue accumulation state.
  let currentCharacter: string | null = null;
  let currentParenthetical: string | undefined = undefined;

  /** Flush a completed dialogue line into the current scene. */
  function flushDialogue(text: string): void {
    if (current && currentCharacter) {
      const line: DialogueLine = {
        character: currentCharacter,
        text,
      };
      if (currentParenthetical) {
        line.parenthetical = currentParenthetical;
      }
      current.dialogue.push(line);
      // Add character to the scene's unique set.
      const normalised = normaliseCharacterName(currentCharacter);
      if (normalised && !current.characters.includes(normalised)) {
        current.characters.push(normalised);
      }
    }
    currentParenthetical = undefined;
  }

  for (const token of parsed.tokens) {
    switch (token.type) {
      case "scene_heading": {
        // Finalise previous scene mood before starting a new one.
        if (current) {
          current.mood = inferMood(current.action);
        }

        sceneNumber++;
        const heading = token.text ?? "";
        current = {
          number: sceneNumber,
          heading,
          location: extractLocation(heading),
          timeOfDay: extractTimeOfDay(heading),
          characters: [],
          action: [],
          dialogue: [],
          transitions: [],
          mood: "neutral",
        };
        scenes.push(current);
        currentCharacter = null;
        currentParenthetical = undefined;
        break;
      }

      case "character": {
        if (!current) break;
        currentCharacter = token.text ?? "";
        currentParenthetical = undefined;
        // Track the character even if they have no dialogue lines.
        const normalised = normaliseCharacterName(currentCharacter);
        if (normalised && !current.characters.includes(normalised)) {
          current.characters.push(normalised);
        }
        break;
      }

      case "parenthetical": {
        if (!current) break;
        currentParenthetical = token.text ?? "";
        break;
      }

      case "dialogue": {
        if (!current) break;
        flushDialogue(token.text ?? "");
        break;
      }

      case "action": {
        if (!current) break;
        currentCharacter = null;
        currentParenthetical = undefined;
        const text = token.text ?? "";
        if (text.length > 0) {
          current.action.push(text);
        }
        break;
      }

      case "transition": {
        if (!current) break;
        currentCharacter = null;
        currentParenthetical = undefined;
        const text = token.text ?? "";
        if (text.length > 0) {
          current.transitions.push(text);
        }
        break;
      }

      // Sections, synopses, notes, centered text, lyrics -- carry useful
      // context but are treated as action for mood/content purposes.
      case "section":
      case "synopsis":
      case "note":
      case "centered":
      case "lyrics": {
        if (!current) break;
        const text = token.text ?? "";
        if (text.length > 0) {
          current.action.push(text);
        }
        break;
      }

      default:
        // Unknown or structural token types are silently ignored.
        break;
    }
  }

  // Finalise mood for the last scene.
  if (current) {
    current.mood = inferMood(current.action);
  }

  return scenes;
}

// ---------------------------------------------------------------------------
// Character extraction
// ---------------------------------------------------------------------------

/**
 * Collect every unique character name that appears across all scenes.
 *
 * Names are normalised (parenthetical extensions removed) and de-duplicated.
 * The returned array preserves first-appearance order.
 *
 * @param scenes - Array of `Scene` objects produced by `extractScenes`.
 * @returns Ordered, de-duplicated array of character names.
 */
export function extractAllCharacters(scenes: Scene[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const scene of scenes) {
    for (const name of scene.characters) {
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}
