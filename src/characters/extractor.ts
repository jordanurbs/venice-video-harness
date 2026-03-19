// ---------------------------------------------------------------------------
// Character profile extraction from parsed screenplay scenes.
// Scans dialogue, action, and scene headers to build rich character profiles
// that drive downstream description synthesis and reference image generation.
// ---------------------------------------------------------------------------

import type { Scene } from "../parsers/scene-extractor.js";

// ---- Public types ---------------------------------------------------------

/** Aggregated profile for a single character across the entire screenplay. */
export interface CharacterProfile {
  /** Canonical uppercase character name (e.g. "MARCUS"). */
  name: string;

  /** Every line of action or dialogue text that mentions this character. */
  mentions: string[];

  /** Extracted physical-description fragments found in action lines. */
  physicalDescriptions: string[];

  /** 1-based scene numbers in which the character appears. */
  scenesPresent: number[];

  /** Total number of dialogue lines attributed to this character. */
  dialogueCount: number;
}

// ---- Internal constants ---------------------------------------------------

/**
 * Keywords that commonly appear in physical descriptions of characters.
 * Used to filter action lines for appearance-related text.
 */
const PHYSICAL_KEYWORDS: readonly string[] = [
  "hair",
  "eyes",
  "eye",
  "tall",
  "short",
  "wearing",
  "wears",
  "dressed",
  "dress",
  "outfit",
  "suit",
  "shirt",
  "coat",
  "jacket",
  "jeans",
  "pants",
  "skirt",
  "boots",
  "shoes",
  "hat",
  "glasses",
  "age",
  "aged",
  "old",
  "young",
  "elderly",
  "teenage",
  "middle-aged",
  "skin",
  "complexion",
  "build",
  "muscular",
  "slender",
  "stocky",
  "thin",
  "heavy",
  "heavyset",
  "lean",
  "athletic",
  "face",
  "facial",
  "beard",
  "mustache",
  "moustache",
  "clean-shaven",
  "scar",
  "scarred",
  "tattoo",
  "tattooed",
  "piercing",
  "freckles",
  "wrinkles",
  "handsome",
  "beautiful",
  "pretty",
  "rugged",
  "height",
  "weight",
  "blonde",
  "brunette",
  "redhead",
  "bald",
  "curly",
  "straight",
  "shoulder-length",
  "ponytail",
  "braids",
  "uniform",
  "armor",
  "cloak",
  "robe",
] as const;

/** Pre-compiled regex for matching any physical keyword in a line. */
const PHYSICAL_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${PHYSICAL_KEYWORDS.join("|")})\\b`,
  "i",
);

// ---- Helpers --------------------------------------------------------------

/**
 * Normalise a character name to a canonical uppercase form.
 * Strips parenthetical extensions like "(V.O.)" or "(CONT'D)".
 */
function canonicalizeName(raw: string): string {
  return raw
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim()
    .toUpperCase();
}

/**
 * Test whether an action line contains the character name as a whole word.
 * Uses a word-boundary regex so "MARK" does not match inside "MARKET".
 */
function lineContainsName(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(line);
}

/**
 * Determine whether an action line that mentions a character also contains
 * physical-description content worth extracting.
 */
function hasPhysicalDescription(line: string): boolean {
  return PHYSICAL_KEYWORD_PATTERN.test(line);
}

// ---- Core extraction ------------------------------------------------------

/**
 * Extract character profiles from an array of parsed scenes.
 *
 * The function iterates every scene and inspects both dialogue attributions
 * and action/description text to build a comprehensive profile for each
 * unique character. Profiles are sorted by `dialogueCount` descending so
 * that principal characters appear first.
 *
 * @param scenes - Array of `Scene` objects produced by the scene parser.
 * @returns Deduplicated, sorted array of `CharacterProfile` entries.
 */
export function extractCharacterProfiles(scenes: Scene[]): CharacterProfile[] {
  const profileMap = new Map<string, CharacterProfile>();

  /** Retrieve or create a fresh profile entry for the given name. */
  function getOrCreate(name: string): CharacterProfile {
    const canonical = canonicalizeName(name);
    let profile = profileMap.get(canonical);
    if (!profile) {
      profile = {
        name: canonical,
        mentions: [],
        physicalDescriptions: [],
        scenesPresent: [],
        dialogueCount: 0,
      };
      profileMap.set(canonical, profile);
    }
    return profile;
  }

  for (const scene of scenes) {
    const sceneNum = scene.number;

    // --- Dialogue pass ---
    // Each dialogue entry attributes a line to a named character.
    if (scene.dialogue) {
      for (const entry of scene.dialogue) {
        const profile = getOrCreate(entry.character);

        // Track scene presence (deduplicated later).
        if (!profile.scenesPresent.includes(sceneNum)) {
          profile.scenesPresent.push(sceneNum);
        }

        // Each DialogueLine represents one dialogue line.
        profile.dialogueCount += 1;

        // Dialogue lines themselves can sometimes contain self-referential
        // physical description ("I cut my hair"), but we focus on action
        // lines for more reliable extraction.
      }
    }

    // --- Action / description pass ---
    // Scan action lines for character name mentions and physical descriptors.
    const actionLines: string[] = scene.action ?? [];

    // Collect all known character names so far (including those just discovered
    // in dialogue above) to search action text against.
    const knownNames = Array.from(profileMap.keys());

    for (const line of actionLines) {
      for (const name of knownNames) {
        if (!lineContainsName(line, name)) {
          continue;
        }

        const profile = getOrCreate(name);

        // Record the mention.
        profile.mentions.push(line);

        // Track scene presence.
        if (!profile.scenesPresent.includes(sceneNum)) {
          profile.scenesPresent.push(sceneNum);
        }

        // Check for physical description content.
        if (hasPhysicalDescription(line)) {
          profile.physicalDescriptions.push(line);
        }
      }
    }

    // --- Second discovery pass ---
    // Some characters appear only in action text (e.g. background characters
    // whose names are introduced in ALL CAPS inline). Screenplay convention
    // introduces a character name in uppercase the first time they appear in
    // action. We detect standalone uppercase words (2+ letters, not scene
    // slugline terms) that could be character introductions.
    for (const line of actionLines) {
      // Match words that are fully uppercase and at least 2 characters,
      // filtering out common screenplay terms and slugline fragments.
      const uppercaseWords = line.match(/\b[A-Z][A-Z'-]{1,}\b/g);
      if (!uppercaseWords) continue;

      const sluglineNoise = new Set([
        "INT",
        "EXT",
        "DAY",
        "NIGHT",
        "MORNING",
        "EVENING",
        "DAWN",
        "DUSK",
        "LATER",
        "CONTINUOUS",
        "CONT",
        "CUT",
        "FADE",
        "DISSOLVE",
        "SMASH",
        "MATCH",
        "ANGLE",
        "CLOSE",
        "WIDE",
        "POV",
        "INSERT",
        "FLASHBACK",
        "INTERCUT",
        "SUPER",
        "TITLE",
        "THE",
        "AND",
        "WITH",
        "FROM",
        "BACK",
        "END",
        "OVER",
        "ON",
        "TO",
        "IN",
        "AT",
        "OF",
        "OS",
        "VO",
      ]);

      for (const word of uppercaseWords) {
        if (sluglineNoise.has(word)) continue;
        if (profileMap.has(word)) {
          // Already known -- just make sure this action line is recorded.
          const profile = profileMap.get(word)!;
          if (!profile.mentions.includes(line)) {
            profile.mentions.push(line);
          }
          if (
            !profile.scenesPresent.includes(sceneNum)
          ) {
            profile.scenesPresent.push(sceneNum);
          }
          if (hasPhysicalDescription(line)) {
            if (!profile.physicalDescriptions.includes(line)) {
              profile.physicalDescriptions.push(line);
            }
          }
        }
        // We intentionally do NOT create new profiles for every uppercase word
        // found here -- that would produce excessive false positives ("FBI",
        // "CIA", location names, etc.). New character creation is limited to
        // dialogue attributions, which are the most reliable signal.
      }
    }
  }

  // Sort by dialogue count descending (main characters first), with a
  // secondary alphabetical sort for stability.
  const profiles = Array.from(profileMap.values());
  profiles.sort((a, b) => {
    if (b.dialogueCount !== a.dialogueCount) {
      return b.dialogueCount - a.dialogueCount;
    }
    return a.name.localeCompare(b.name);
  });

  return profiles;
}
