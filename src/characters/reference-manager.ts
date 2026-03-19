// ---------------------------------------------------------------------------
// Character reference image management.
// Generates, persists, and retrieves character reference images (front,
// 3/4, profile, full-body) used to maintain visual consistency across all
// storyboard frames.
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CharacterDescription } from "./describer.js";
import type {
  ImageGenerateRequest,
  ImageGenerateResponse,
} from "../venice/types.js";
import type { AestheticProfile } from "../storyboard/prompt-builder.js";
import type { VeniceClient } from "../venice/client.js";
import { generateImage } from "../venice/generate.js";

// ---- Public types ---------------------------------------------------------

/** Persistent lock for a character's visual identity. */
export interface CharacterLock {
  /** Canonical character name. */
  name: string;

  /** Full character description used to generate references. */
  description: CharacterDescription;

  /** Base64-encoded PNG reference images from four canonical angles. */
  referenceImages: {
    front: string;
    threeQuarter: string;
    profile: string;
    fullBody: string;
  };

  /** Whether this character's visual identity has been locked. */
  locked: boolean;

  /** Seed used for generation reproducibility. */
  seed: number;
}

// ---- Internal constants ---------------------------------------------------

/** Default model for reference image generation. */
const DEFAULT_MODEL = "nano-banana-2";

/** Default resolution and aspect ratio for character reference sheets. */
const REF_RESOLUTION = "1K";
const REF_ASPECT_RATIO = "1:1";

/** Reference angle definitions with prompt suffixes. */
const REFERENCE_ANGLES = [
  {
    key: "front" as const,
    filename: "front.png",
    promptSuffix:
      "front-facing portrait, looking directly at camera, centered, studio lighting, neutral background, character reference sheet",
  },
  {
    key: "threeQuarter" as const,
    filename: "three-quarter.png",
    promptSuffix:
      "three-quarter view portrait, 45 degree angle, studio lighting, neutral background, character reference sheet",
  },
  {
    key: "profile" as const,
    filename: "profile.png",
    promptSuffix:
      "side profile portrait, 90 degree angle, studio lighting, neutral background, character reference sheet",
  },
  {
    key: "fullBody" as const,
    filename: "full-body.png",
    promptSuffix:
      "full body shot, head to toe, standing pose, studio lighting, neutral background, character reference sheet",
  },
] as const;

/** Filename for the character metadata JSON. */
const METADATA_FILENAME = "character-lock.json";

// ---- Serialization helpers ------------------------------------------------

/**
 * JSON-safe representation of CharacterLock for disk persistence.
 * Maps are serialized as plain objects.
 */
interface SerializedCharacterLock {
  name: string;
  description: {
    name: string;
    shortDescription: string;
    fullDescription: string;
    wardrobe: string;
    wardrobeByScene: Record<string, string>;
  };
  locked: boolean;
  seed: number;
}

function serializeLock(lock: CharacterLock): SerializedCharacterLock {
  const wardrobeByScene: Record<string, string> = {};
  const wbs = lock.description.wardrobeByScene;
  if (wbs instanceof Map) {
    for (const [sceneNum, wardrobe] of wbs) {
      wardrobeByScene[String(sceneNum)] = wardrobe;
    }
  } else if (wbs && typeof wbs === "object") {
    // Handle plain object (e.g. from JSON deserialization)
    for (const [key, value] of Object.entries(wbs)) {
      wardrobeByScene[String(key)] = value as string;
    }
  }

  return {
    name: lock.name,
    description: {
      name: lock.description.name,
      shortDescription: lock.description.shortDescription,
      fullDescription: lock.description.fullDescription,
      wardrobe: lock.description.wardrobe,
      wardrobeByScene,
    },
    locked: lock.locked,
    seed: lock.seed,
  };
}

function deserializeLock(
  data: SerializedCharacterLock,
  referenceImages: CharacterLock["referenceImages"],
): CharacterLock {
  const wardrobeByScene = new Map<number, string>();
  if (data.description.wardrobeByScene) {
    for (const [key, value] of Object.entries(
      data.description.wardrobeByScene,
    )) {
      wardrobeByScene.set(Number(key), value);
    }
  }

  return {
    name: data.name,
    description: {
      name: data.description.name,
      shortDescription: data.description.shortDescription,
      fullDescription: data.description.fullDescription,
      wardrobe: data.description.wardrobe,
      wardrobeByScene,
    },
    referenceImages,
    locked: data.locked,
    seed: data.seed,
  };
}

// ---- Helpers --------------------------------------------------------------

/**
 * Sanitize a character name for use as a filesystem directory name.
 * Converts to lowercase, replaces spaces and special characters with
 * hyphens, and removes leading/trailing hyphens.
 */
function sanitizeDirectoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate a deterministic seed from a character name.
 * Provides a reproducible starting point when no seed is specified.
 */
function seedFromName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer.
  }
  return Math.abs(hash) % 999_999_999;
}

// ---- ReferenceManager class -----------------------------------------------

/**
 * Manages generation, persistence, and retrieval of character reference
 * images. Each character gets a dedicated directory under the output
 * path containing four reference angle PNGs and a metadata JSON file.
 */
export class ReferenceManager {
  private readonly outputDir: string;

  /**
   * @param outputDir - Base directory for storing all character references.
   *   Character-specific subdirectories are created under
   *   `outputDir/characters/CHARACTER_NAME/`.
   */
  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * Resolve the directory path for a specific character.
   */
  private characterDir(name: string): string {
    return join(this.outputDir, "characters", sanitizeDirectoryName(name));
  }

  /**
   * Generate all four reference images for a character and return a
   * locked character reference. Images are also saved to disk.
   *
   * The front face is generated first, then used as a reference image
   * for the remaining angles to maintain visual consistency.
   *
   * @param client - Venice API client instance.
   * @param description - Full character description to use as prompt basis.
   * @param aesthetic - Optional aesthetic profile to style-match references.
   * @returns A `CharacterLock` containing all reference images and metadata.
   */
  async generateReferences(
    client: VeniceClient,
    description: CharacterDescription,
    aesthetic?: AestheticProfile | null,
  ): Promise<CharacterLock> {
    const seed = seedFromName(description.name);

    const referenceImages: CharacterLock["referenceImages"] = {
      front: "",
      threeQuarter: "",
      profile: "",
      fullBody: "",
    };

    // Build aesthetic suffix to inject into every prompt.
    const aestheticSuffix = aesthetic
      ? ` ${aesthetic.style}. ${aesthetic.palette}. ${aesthetic.lighting}. ${aesthetic.filmStock}.`
      : "";

    // Generate front face FIRST -- it becomes the reference for other angles.
    const frontAngle = REFERENCE_ANGLES[0]; // front
    const frontPrompt = `${description.fullDescription} ${frontAngle.promptSuffix}${aestheticSuffix}`;

    const frontRequest: ImageGenerateRequest = {
      model: DEFAULT_MODEL,
      prompt: frontPrompt,
      negative_prompt:
        "blurry, low quality, distorted, deformed, multiple people, text, watermark, signature",
      resolution: REF_RESOLUTION,
      aspect_ratio: REF_ASPECT_RATIO,
      steps: 30,
      cfg_scale: 7,
      seed,
      safe_mode: false,
      hide_watermark: true,
    };

    const frontResponse = await generateImage(client, frontRequest);
    if (!frontResponse.images || frontResponse.images.length === 0) {
      throw new Error(
        `Venice API returned no images for ${description.name} (front view)`,
      );
    }
    referenceImages.front = frontResponse.images[0].b64_json;

    // Generate remaining angles with the same seed + high cfg_scale to
    // anchor to the same character identity established in the front view.
    const remainingAngles = REFERENCE_ANGLES.slice(1); // 3/4, profile, fullBody
    for (const angle of remainingAngles) {
      const prompt = `${description.fullDescription} ${angle.promptSuffix}${aestheticSuffix} Same person as previous image, consistent appearance.`;

      const request: ImageGenerateRequest = {
        model: DEFAULT_MODEL,
        prompt,
        negative_prompt:
          "blurry, low quality, distorted, deformed, multiple people, text, watermark, signature, different person, inconsistent appearance",
        resolution: REF_RESOLUTION,
        aspect_ratio: REF_ASPECT_RATIO,
        steps: 30,
        cfg_scale: 9,
        seed,
        safe_mode: false,
        hide_watermark: true,
      };

      const response = await generateImage(client, request);

      if (!response.images || response.images.length === 0) {
        throw new Error(
          `Venice API returned no images for ${description.name} (${angle.key} view)`,
        );
      }

      referenceImages[angle.key] = response.images[0].b64_json;
    }

    const lock: CharacterLock = {
      name: description.name,
      description,
      referenceImages,
      locked: true,
      seed,
    };

    // Persist to disk.
    await this.saveReferences(lock);

    return lock;
  }

  /**
   * Load a previously saved character lock from disk.
   *
   * @param name - Character name to look up.
   * @returns The `CharacterLock` if found, or `null` if no saved data exists.
   */
  async loadReferences(name: string): Promise<CharacterLock | null> {
    const dir = this.characterDir(name);

    try {
      // Read metadata.
      const metadataPath = join(dir, METADATA_FILENAME);
      const metadataRaw = await readFile(metadataPath, "utf-8");
      const metadata: SerializedCharacterLock = JSON.parse(metadataRaw);

      // Read each reference image from its PNG file.
      const referenceImages: CharacterLock["referenceImages"] = {
        front: "",
        threeQuarter: "",
        profile: "",
        fullBody: "",
      };

      for (const angle of REFERENCE_ANGLES) {
        const imagePath = join(dir, angle.filename);
        const imageBuffer = await readFile(imagePath);
        referenceImages[angle.key] = imageBuffer.toString("base64");
      }

      return deserializeLock(metadata, referenceImages);
    } catch (err: unknown) {
      // If any file is missing, treat as not found.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Save a character lock to disk. Reference images are written as PNG
   * files and metadata is written as JSON.
   *
   * @param lock - The `CharacterLock` to persist.
   */
  async saveReferences(lock: CharacterLock): Promise<void> {
    const dir = this.characterDir(lock.name);
    await mkdir(dir, { recursive: true });

    // Write reference images as PNG files.
    for (const angle of REFERENCE_ANGLES) {
      const imagePath = join(dir, angle.filename);
      const imageBuffer = Buffer.from(
        lock.referenceImages[angle.key],
        "base64",
      );
      await writeFile(imagePath, imageBuffer);
    }

    // Write metadata (without base64 image data to avoid duplication).
    const metadataPath = join(dir, METADATA_FILENAME);
    const serialized = serializeLock(lock);
    await writeFile(metadataPath, JSON.stringify(serialized, null, 2), "utf-8");
  }

  /**
   * Return the front-facing reference image as a base64 string.
   * This is the primary image used for face-reference injection into
   * scene generation prompts.
   *
   * @param lock - A loaded or generated `CharacterLock`.
   * @returns Base64-encoded PNG of the front face reference.
   */
  getBase64Face(lock: CharacterLock): string {
    return lock.referenceImages.front;
  }

  /**
   * List the names of all characters that have been locked (saved to disk).
   * Reads the characters directory and returns names derived from each
   * subdirectory that contains a valid metadata file.
   *
   * @returns Array of character names that have persisted locks.
   */
  async listLocked(): Promise<string[]> {
    const charactersDir = join(this.outputDir, "characters");
    const names: string[] = [];

    try {
      const entries = await readdir(charactersDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Check if this directory has a valid metadata file.
        try {
          const metadataPath = join(
            charactersDir,
            entry.name,
            METADATA_FILENAME,
          );
          const raw = await readFile(metadataPath, "utf-8");
          const metadata: SerializedCharacterLock = JSON.parse(raw);
          if (metadata.locked && metadata.name) {
            names.push(metadata.name);
          }
        } catch {
          // Skip directories without valid metadata.
        }
      }
    } catch (err: unknown) {
      // Characters directory does not exist yet -- return empty.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }

    return names;
  }
}
