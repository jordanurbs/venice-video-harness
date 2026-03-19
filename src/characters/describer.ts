// ---------------------------------------------------------------------------
// Character description synthesis.
// Transforms raw CharacterProfile data into structured, prompt-ready
// descriptions suitable for injection into image generation requests.
// ---------------------------------------------------------------------------

import type { CharacterProfile } from "./extractor.js";

// ---- Public types ---------------------------------------------------------

/** Fully synthesized character description ready for prompt injection. */
export interface CharacterDescription {
  /** Canonical character name. */
  name: string;

  /** 1-2 sentence summary suitable for quick reference. */
  shortDescription: string;

  /**
   * Exhaustive paragraph covering all known physical attributes.
   * Formatted for direct injection into image generation prompts.
   */
  fullDescription: string;

  /** Default wardrobe description (most commonly described outfit). */
  wardrobe: string;

  /**
   * Per-scene wardrobe overrides.
   * Key is the 1-based scene number; value is the wardrobe description
   * specific to that scene. Only populated when distinct wardrobe changes
   * are detected in the screenplay text.
   */
  wardrobeByScene: Map<number, string>;
}

// ---- Internal types -------------------------------------------------------

/** Structured bucket for organizing extracted physical attributes. */
interface PhysicalAttributes {
  ageRange: string;
  ethnicity: string;
  hairColor: string;
  hairLength: string;
  hairStyle: string;
  eyeColor: string;
  eyeShape: string;
  faceFeatures: string[];
  build: string;
  height: string;
  distinguishingFeatures: string[];
}

// ---- Extraction patterns --------------------------------------------------

/**
 * Each entry maps a regex to one or more attribute fields.
 * Patterns are applied against physical-description lines to populate
 * the PhysicalAttributes struct.
 */
const ATTRIBUTE_EXTRACTORS: {
  pattern: RegExp;
  field: keyof PhysicalAttributes;
  transform?: (match: RegExpMatchArray) => string;
}[] = [
  // Age
  {
    pattern: /\b(\d{1,2})s?\s*(?:years?\s*old|year[- ]old)\b/i,
    field: "ageRange",
    transform: (m) => `${m[1]}s`,
  },
  {
    pattern: /\b(early|mid|late)\s*(\d{1,2})s\b/i,
    field: "ageRange",
    transform: (m) => `${m[1]} ${m[2]}s`,
  },
  {
    pattern: /\b(teenage|elderly|middle[- ]aged|young|older|youthful)\b/i,
    field: "ageRange",
    transform: (m) => m[1].toLowerCase(),
  },

  // Hair color
  {
    pattern:
      /\b(blonde|blond|brunette|brown|black|red|auburn|grey|gray|silver|white|dark|light|sandy|strawberry[- ]blonde|platinum|golden|chestnut|raven)\s*hair\b/i,
    field: "hairColor",
    transform: (m) => m[1].toLowerCase(),
  },
  {
    pattern: /\bhair\b.*?\b(blonde|blond|brunette|brown|black|red|auburn|grey|gray|silver|white|dark|light|sandy|platinum|golden|chestnut|raven)\b/i,
    field: "hairColor",
    transform: (m) => m[1].toLowerCase(),
  },

  // Hair length
  {
    pattern:
      /\b(short|long|shoulder[- ]length|cropped|close[- ]cropped|medium[- ]length|waist[- ]length)\s*hair\b/i,
    field: "hairLength",
    transform: (m) => m[1].toLowerCase(),
  },

  // Hair style
  {
    pattern:
      /\b(curly|straight|wavy|braided|braids|ponytail|bun|dreadlocks|dreads|mohawk|buzz[- ]cut|slicked[- ]back|tousled|messy|neat|pulled[- ]back|afro)\b/i,
    field: "hairStyle",
    transform: (m) => m[1].toLowerCase(),
  },
  {
    pattern: /\bbald\b/i,
    field: "hairStyle",
    transform: () => "bald",
  },

  // Eye color
  {
    pattern:
      /\b(blue|green|brown|hazel|grey|gray|dark|light|amber|violet|black|ice[- ]blue)\s*eyes?\b/i,
    field: "eyeColor",
    transform: (m) => m[1].toLowerCase(),
  },
  {
    pattern: /\beyes?\b.*?\b(blue|green|brown|hazel|grey|gray|dark|light|amber|violet|black)\b/i,
    field: "eyeColor",
    transform: (m) => m[1].toLowerCase(),
  },

  // Eye shape
  {
    pattern:
      /\b(narrow|wide|almond[- ]shaped|deep[- ]set|round|hooded|piercing|bright|sharp|tired|sunken)\s*eyes?\b/i,
    field: "eyeShape",
    transform: (m) => m[1].toLowerCase(),
  },

  // Build
  {
    pattern:
      /\b(muscular|slender|stocky|thin|heavy|heavyset|lean|athletic|wiry|burly|petite|portly|stout|gaunt|lanky|broad[- ]shouldered|slight)\b/i,
    field: "build",
    transform: (m) => m[1].toLowerCase(),
  },

  // Height
  {
    pattern: /\b(tall|short|average[- ]height|towering|diminutive|petite)\b/i,
    field: "height",
    transform: (m) => m[1].toLowerCase(),
  },
  {
    pattern: /\b(\d['']?\s*\d{1,2}"?)\b/,
    field: "height",
    transform: (m) => m[1],
  },

  // Ethnicity / appearance
  {
    pattern:
      /\b(African[- ]American|Black|Caucasian|White|Asian|Latino|Latina|Hispanic|Native\s*American|Indigenous|Middle\s*Eastern|South\s*Asian|East\s*Asian|Pacific\s*Islander|mixed[- ]race|biracial)\b/i,
    field: "ethnicity",
    transform: (m) => m[1],
  },

  // Face features (collected as array)
  {
    pattern:
      /\b(beard|bearded|mustache|moustache|goatee|stubble|clean[- ]shaven|scar|scarred|freckles|freckled|wrinkles|wrinkled|dimples|dimpled|angular|chiseled|round[- ]faced|square[- ]jawed|high\s*cheekbones)\b/i,
    field: "faceFeatures",
    transform: (m) => m[1].toLowerCase(),
  },

  // Distinguishing features (collected as array)
  {
    pattern:
      /\b(tattoo|tattooed|piercing|pierced|birthmark|mole|limp|eye[- ]patch|prosthetic|glasses|spectacles|monocle|hearing\s*aid|cane|wheelchair)\b/i,
    field: "distinguishingFeatures",
    transform: (m) => m[1].toLowerCase(),
  },
];

// ---- Wardrobe extraction --------------------------------------------------

const WARDROBE_PATTERN =
  /\b(?:wearing|wears|dressed\s+in|clad\s+in|in\s+a|outfit|suit|uniform|shirt|blouse|coat|jacket|jeans|pants|trousers|skirt|dress|boots|shoes|sneakers|heels|sandals|hat|cap|helmet|gloves|scarf|tie|vest|sweater|hoodie|tank\s*top|t-shirt|tuxedo|gown|armor|cloak|robe|overalls|apron)\b/i;

/**
 * Extract wardrobe-related fragments from a line of text.
 * Returns the full sentence/clause containing the wardrobe keyword.
 */
function extractWardrobeFragment(line: string): string | null {
  if (!WARDROBE_PATTERN.test(line)) return null;

  // Try to extract just the clause that mentions clothing.
  // Split on common clause delimiters and find the relevant part.
  const clauses = line.split(/[,.;]/).map((c) => c.trim());
  for (const clause of clauses) {
    if (WARDROBE_PATTERN.test(clause) && clause.length > 5) {
      return clause;
    }
  }
  return line.trim();
}

// ---- Attribute extraction -------------------------------------------------

function createEmptyAttributes(): PhysicalAttributes {
  return {
    ageRange: "unspecified",
    ethnicity: "unspecified",
    hairColor: "unspecified",
    hairLength: "unspecified",
    hairStyle: "unspecified",
    eyeColor: "unspecified",
    eyeShape: "unspecified",
    faceFeatures: [],
    build: "unspecified",
    height: "unspecified",
    distinguishingFeatures: [],
  };
}

/**
 * Run all attribute extractors against the provided description lines.
 * First match wins for scalar fields; array fields accumulate.
 */
function extractAttributes(lines: string[]): PhysicalAttributes {
  const attrs = createEmptyAttributes();

  for (const line of lines) {
    for (const extractor of ATTRIBUTE_EXTRACTORS) {
      const match = line.match(extractor.pattern);
      if (!match) continue;

      const value = extractor.transform
        ? extractor.transform(match)
        : match[1].toLowerCase();

      const field = extractor.field;

      if (field === "faceFeatures" || field === "distinguishingFeatures") {
        // Array fields -- accumulate unique entries.
        const arr = attrs[field] as string[];
        if (!arr.includes(value)) {
          arr.push(value);
        }
      } else {
        // Scalar fields -- first match wins (don't overwrite).
        if (attrs[field as keyof PhysicalAttributes] === "unspecified") {
          (attrs as any)[field] = value;
        }
      }
    }
  }

  return attrs;
}

// ---- Description builders -------------------------------------------------

/**
 * Build a short 1-2 sentence description from extracted attributes.
 */
function buildShortDescription(
  name: string,
  attrs: PhysicalAttributes,
): string {
  const parts: string[] = [];

  // Age + build/height
  const agePart =
    attrs.ageRange !== "unspecified" ? attrs.ageRange : null;
  const buildPart =
    attrs.build !== "unspecified" ? attrs.build : null;
  const heightPart =
    attrs.height !== "unspecified" ? attrs.height : null;

  if (agePart || buildPart || heightPart) {
    const descriptors = [agePart, heightPart, buildPart].filter(Boolean);
    parts.push(descriptors.join(", "));
  }

  // Hair
  if (attrs.hairColor !== "unspecified" || attrs.hairStyle !== "unspecified") {
    const hairParts = [attrs.hairColor, attrs.hairLength, attrs.hairStyle]
      .filter((v) => v !== "unspecified");
    if (hairParts.length > 0) {
      parts.push(`${hairParts.join(" ")} hair`);
    }
  }

  // Eyes
  if (attrs.eyeColor !== "unspecified") {
    parts.push(`${attrs.eyeColor} eyes`);
  }

  if (parts.length === 0) {
    return `${name}, a character whose physical appearance is not described in the screenplay.`;
  }

  return `${name}: ${parts.join(", ")}.`;
}

/**
 * Build an exhaustive paragraph covering all known attributes.
 * Formatted for direct injection into image generation prompts.
 * Unspecified fields are explicitly noted to prevent hallucination
 * by the image model.
 */
function buildFullDescription(
  name: string,
  attrs: PhysicalAttributes,
): string {
  const sections: string[] = [];

  // Identity line
  sections.push(`Character: ${name}.`);

  // Age
  sections.push(
    attrs.ageRange !== "unspecified"
      ? `Age range: ${attrs.ageRange}.`
      : "Age: unspecified.",
  );

  // Ethnicity / general appearance
  sections.push(
    attrs.ethnicity !== "unspecified"
      ? `Ethnicity/appearance: ${attrs.ethnicity}.`
      : "Ethnicity/appearance: unspecified.",
  );

  // Hair
  const hairDescriptors = [attrs.hairColor, attrs.hairLength, attrs.hairStyle]
    .filter((v) => v !== "unspecified");
  if (hairDescriptors.length > 0) {
    sections.push(`Hair: ${hairDescriptors.join(", ")}.`);
  } else {
    sections.push("Hair: unspecified.");
  }

  // Eyes
  const eyeDescriptors = [attrs.eyeColor, attrs.eyeShape].filter(
    (v) => v !== "unspecified",
  );
  if (eyeDescriptors.length > 0) {
    sections.push(`Eyes: ${eyeDescriptors.join(", ")}.`);
  } else {
    sections.push("Eyes: unspecified.");
  }

  // Face
  if (attrs.faceFeatures.length > 0) {
    sections.push(`Face features: ${attrs.faceFeatures.join(", ")}.`);
  } else {
    sections.push("Face features: unspecified.");
  }

  // Build / Height
  const bodyDescriptors = [
    attrs.build !== "unspecified" ? `build: ${attrs.build}` : null,
    attrs.height !== "unspecified" ? `height: ${attrs.height}` : null,
  ].filter(Boolean);
  if (bodyDescriptors.length > 0) {
    sections.push(`Body: ${bodyDescriptors.join(", ")}.`);
  } else {
    sections.push("Build/height: unspecified.");
  }

  // Distinguishing features
  if (attrs.distinguishingFeatures.length > 0) {
    sections.push(
      `Distinguishing features: ${attrs.distinguishingFeatures.join(", ")}.`,
    );
  }

  return sections.join(" ");
}

// ---- Main export ----------------------------------------------------------

/**
 * Transform an array of `CharacterProfile` objects into structured
 * `CharacterDescription` entries. Each description synthesizes scattered
 * physical-description fragments into a coherent, prompt-ready format.
 *
 * @param profiles - Array of profiles from `extractCharacterProfiles`.
 * @returns Array of `CharacterDescription` in the same order as input.
 */
export function buildCharacterDescriptions(
  profiles: CharacterProfile[],
): CharacterDescription[] {
  return profiles.map((profile) => {
    // Extract structured attributes from physical description lines.
    const attrs = extractAttributes(profile.physicalDescriptions);

    // Build the short and full descriptions.
    const shortDescription = buildShortDescription(profile.name, attrs);
    const fullDescription = buildFullDescription(profile.name, attrs);

    // Extract wardrobe -- default and per-scene.
    const wardrobeByScene = new Map<number, string>();
    const allWardrobeFragments: string[] = [];

    // physicalDescriptions and mentions may overlap; deduplicate.
    const allLines = [...profile.physicalDescriptions, ...profile.mentions];
    const uniqueLines = Array.from(new Set(allLines));

    for (const line of uniqueLines) {
      const fragment = extractWardrobeFragment(line);
      if (fragment) {
        allWardrobeFragments.push(fragment);
      }
    }

    // Deduplicate wardrobe fragments.
    const uniqueWardrobe = Array.from(new Set(allWardrobeFragments));
    const wardrobe =
      uniqueWardrobe.length > 0
        ? uniqueWardrobe.join("; ")
        : "unspecified";

    return {
      name: profile.name,
      shortDescription,
      fullDescription,
      wardrobe,
      wardrobeByScene,
    } satisfies CharacterDescription;
  });
}
