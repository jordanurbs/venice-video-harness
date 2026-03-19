// ---------------------------------------------------------------------------
// Storyboard Assembler -- orchestrates image generation for each shot and
// compiles the results into a structured Storyboard object.
//
// Handles Venice API calls, image persistence, and final JSON export.
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Shot } from "./shot-planner.js";
import type { AestheticProfile, PromptResult, VideoPromptResult, AudioNotes, VeoConfig } from "./prompt-builder.js";
import type { Scene } from "../parsers/scene-extractor.js";
import type { CharacterLock } from "../characters/reference-manager.js";
import type { VeniceClient } from "../venice/client.js";
// Venice types not needed -- we parse raw responses directly.

// ---- Public types ---------------------------------------------------------

/** A single storyboard panel representing one shot. */
export interface StoryboardPanel {
  /** Unique panel identifier (e.g. "S3-P2" for scene 3, panel 2). */
  id: string;

  /** 1-based scene number this panel belongs to. */
  sceneNumber: number;

  /** 1-based panel/shot number within the scene. */
  panelNumber: number;

  /** Total number of panels in this scene (for "X of Y" display). */
  totalPanelsInScene: number;

  /** The image prompt that was sent to the generation API. */
  prompt: string;

  /** Base-64 encoded generated image (PNG). */
  imageBase64: string;

  /** MIME type of the image data (default "image/png"). */
  imageMimeType: string;

  /** Shot type classification. */
  shotType: string;

  /** Camera angle. */
  cameraAngle: string;

  /** Camera movement during this shot. */
  cameraMovement: string;

  /** Transition to the next panel (undefined for the last panel in a scene). */
  transition?: string;

  /** Character names visible in this panel. */
  characters: string[];

  /** Dialogue delivered during this shot, if any. */
  dialogue?: {
    character: string;
    line: string;
  };

  /** Director/artist notes for this panel. */
  notes?: string;

  /** Seed used for image generation (for reproducibility). */
  seed?: number;

  /** Path to the saved image file on disk. */
  imagePath?: string;

  /** Video generation prompt text. */
  videoPrompt?: string;

  /** Suggested video clip duration in seconds. */
  videoDuration?: number;

  /** Camera movement instruction for video generation. */
  videoCameraMovement?: string;

  /** Audio cue notes for the video clip. */
  videoAudioNotes?: AudioNotes;

  /** Transition instruction for the video clip. */
  videoTransition?: string;

  /** Start-frame description tying this clip to the image panel. */
  videoStartFrame?: string;

  /** Veo 3.1 API-ready configuration block. */
  veoConfig?: VeoConfig;

  /** The underlying Shot data. */
  shot?: Shot;

  /** Parent scene data. */
  scene?: Scene;
}

/** A scene's worth of storyboard panels plus its source metadata. */
export interface StoryboardScene {
  /** The parsed scene this group was generated from. */
  scene: Scene;

  /** Ordered panels for this scene. */
  panels: StoryboardPanel[];
}

export interface Storyboard {
  title: string;
  scenes: StoryboardScene[];
  characters: CharacterLock[];
  aesthetic: AestheticProfile;
  generatedAt: string;
}

// ---- Constants ------------------------------------------------------------

/** Default image resolution and aspect ratio for Venice API. */
const DEFAULT_RESOLUTION = "1K";
const DEFAULT_ASPECT_RATIO = "16:9";

/** Model used for generation. */
const DEFAULT_MODEL = "nano-banana-2";

/** Diffusion steps -- higher = better quality, slower. */
const DEFAULT_STEPS = 30;

/** Classifier-free guidance scale. */
const DEFAULT_CFG_SCALE = 7.5;

// ---- Assembler class ------------------------------------------------------

export class StoryboardAssembler {
  private readonly outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  // ---- Scene generation ---------------------------------------------------

  /**
   * Generate images for every shot in a scene and return an array of
   * StoryboardPanel objects.
   *
   * For each shot the method:
   * 1. Calls the Venice API (with reference images when available).
   * 2. Saves the generated image to disk.
   * 3. Saves a video prompt JSON file alongside the image.
   * 4. Records metadata in a StoryboardPanel.
   *
   * @param sceneNumber      - 1-based scene index.
   * @param scene            - The parent Scene data.
   * @param shots            - Ordered array of shots planned for this scene.
   * @param promptResults    - Parallel array of PromptResult objects (one per shot).
   * @param client           - An authenticated VeniceClient instance.
   * @param videoPrompts     - Parallel array of VideoPromptResult objects (one per shot).
   * @returns Array of StoryboardPanel objects in shot order.
   */
  async generateScene(
    sceneNumber: number,
    scene: Scene,
    shots: Shot[],
    promptResults: PromptResult[],
    client: VeniceClient,
    videoPrompts?: VideoPromptResult[],
  ): Promise<StoryboardPanel[]> {
    // Ensure the scene output directory exists.
    const sceneDir = join(
      this.outputDir,
      `scene-${String(sceneNumber).padStart(3, "0")}`,
    );
    await mkdir(sceneDir, { recursive: true });

    const panels: StoryboardPanel[] = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const pr = promptResults[i];

      let imageBase64: string;
      let usedSeed: number;

      if (pr.referenceImages.length > 0) {
        // Use reference-augmented generation
        const result = await this.generateWithReferences(client, pr);
        imageBase64 = result.base64;
        usedSeed = result.seed ?? 0;
      } else {
        // Standard generation (no character references)
        const result = await this.generateStandard(client, pr);
        imageBase64 = result.base64;
        usedSeed = result.seed ?? 0;
      }

      // Save image to disk
      const shotId = String(shot.shotNumber).padStart(3, "0");
      const fileName = `shot-${shotId}.png`;
      const imagePath = join(sceneDir, fileName);
      const imageBuffer = Buffer.from(imageBase64, "base64");
      await writeFile(imagePath, imageBuffer);

      // Save video prompt JSON alongside the image
      const vp = videoPrompts?.[i];
      if (vp) {
        const panelId = `S${sceneNumber}-P${shot.shotNumber}`;
        // Use new `video` block; fall back to legacy `veo` for old data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const videoBlock = (vp.video ?? vp.veo) as any;
        const videoJson = {
          panelId,
          sceneNumber,
          shotNumber: shot.shotNumber,
          video: {
            model: videoBlock.model,
            prompt: videoBlock.prompt,
            duration: videoBlock.duration ?? `${videoBlock.durationSeconds ?? "8"}s`,
            audio: videoBlock.audio ?? videoBlock.generateAudio ?? true,
          },
          metadata: {
            imagePrompt: pr.prompt,
            characters: shot.characters,
            dialogue: shot.dialogue
              ? { character: shot.focusCharacter || shot.characters[0] || "UNKNOWN", line: shot.dialogue }
              : undefined,
            sfx: vp.audioNotes.sfx || undefined,
            ambient: vp.audioNotes.ambient || undefined,
            transition: vp.transition,
            cameraMovement: vp.cameraMovement,
            aesthetic: `${pr.prompt.match(/\[AESTHETIC\] (.+)/)?.[1] || ""}`.trim() || undefined,
          },
        };
        const videoJsonPath = join(sceneDir, `shot-${shotId}.video.json`);
        await writeFile(videoJsonPath, JSON.stringify(videoJson, null, 2), "utf-8");
      }

      // Determine transition (if not last shot in scene)
      const transition = i < shots.length - 1 ? (shot.transitionOut || "CUT") : undefined;

      panels.push({
        id: `S${sceneNumber}-P${shot.shotNumber}`,
        sceneNumber,
        panelNumber: shot.shotNumber,
        totalPanelsInScene: shots.length,
        prompt: pr.prompt,
        imageBase64,
        imageMimeType: "image/png",
        shotType: shot.type,
        cameraAngle: shot.angle,
        cameraMovement: shot.movement,
        transition,
        characters: shot.characters,
        dialogue: shot.dialogue ? {
          character: shot.focusCharacter || shot.characters[0] || "UNKNOWN",
          line: shot.dialogue,
        } : undefined,
        notes: shot.notes,
        seed: usedSeed,
        imagePath,
        shot,
        scene,
        videoPrompt: vp?.videoPrompt,
        videoDuration: vp?.duration,
        videoCameraMovement: vp?.cameraMovement,
        videoAudioNotes: vp?.audioNotes,
        videoTransition: vp?.transition,
        videoStartFrame: vp?.startFrame,
        veoConfig: vp?.video ?? vp?.veo,
      });
    }

    return panels;
  }

  // ---- Storyboard compilation ---------------------------------------------

  /**
   * Assemble all generated panels into a final Storyboard structure.
   *
   * @param title       - Screenplay title.
   * @param scenePanels - Map of scene number to its generated panels.
   * @param scenes      - All Scene objects in order.
   * @param characters  - All locked character references.
   * @param aesthetic   - The aesthetic profile used for generation.
   * @returns A complete Storyboard object.
   */
  async compileStoryboard(
    title: string,
    scenePanels: Map<number, StoryboardPanel[]>,
    scenes: Scene[],
    characters: CharacterLock[],
    aesthetic: AestheticProfile,
  ): Promise<Storyboard> {
    const storyboardScenes: Storyboard["scenes"] = [];

    for (const scene of scenes) {
      const panels = scenePanels.get(scene.number) ?? [];
      storyboardScenes.push({ scene, panels });
    }

    return {
      title,
      scenes: storyboardScenes,
      characters,
      aesthetic,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---- Persistence --------------------------------------------------------

  /**
   * Save the complete storyboard as a JSON file and ensure all images are
   * written to the output directory.
   *
   * The JSON manifest omits the raw base64 image data from panels to keep
   * the file manageable. Full base64 data is available on the in-memory
   * Storyboard object for downstream consumers that need it.
   *
   * @param storyboard - The complete Storyboard to persist.
   * @returns The absolute path to the saved JSON file.
   */
  async saveStoryboard(storyboard: Storyboard): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    // Build a JSON-safe manifest that strips large base64 blobs.
    const manifest = {
      title: storyboard.title,
      generatedAt: storyboard.generatedAt,
      aesthetic: storyboard.aesthetic,
      characters: storyboard.characters.map((c) => ({
        name: c.name,
        locked: c.locked,
        seed: c.seed,
        shortDescription: c.description.shortDescription,
      })),
      scenes: storyboard.scenes.map((s) => ({
        scene: {
          number: s.scene.number,
          heading: s.scene.heading,
          location: s.scene.location,
          timeOfDay: s.scene.timeOfDay,
          characters: s.scene.characters,
          mood: s.scene.mood,
        },
        panels: s.panels.map((p) => ({
          id: p.id,
          sceneNumber: p.sceneNumber,
          panelNumber: p.panelNumber,
          totalPanelsInScene: p.totalPanelsInScene,
          imagePath: p.imagePath,
          prompt: p.prompt,
          seed: p.seed,
          shotType: p.shotType,
          cameraAngle: p.cameraAngle,
          cameraMovement: p.cameraMovement,
          characters: p.characters,
          dialogue: p.dialogue,
          notes: p.notes,
          transition: p.transition,
          videoPrompt: p.videoPrompt,
          videoDuration: p.videoDuration,
          videoCameraMovement: p.videoCameraMovement,
          videoAudioNotes: p.videoAudioNotes,
          videoTransition: p.videoTransition,
          shot: p.shot ? {
            shotNumber: p.shot.shotNumber,
            type: p.shot.type,
            angle: p.shot.angle,
            movement: p.shot.movement,
            lens: p.shot.lens,
            characters: p.shot.characters,
            focusCharacter: p.shot.focusCharacter,
            action: p.shot.action,
            dialogue: p.shot.dialogue,
            transitionIn: p.shot.transitionIn,
            transitionOut: p.shot.transitionOut,
            notes: p.shot.notes,
          } : undefined,
        })),
      })),
    };

    const jsonPath = join(this.outputDir, "storyboard.json");
    await writeFile(jsonPath, JSON.stringify(manifest, null, 2), "utf-8");

    return jsonPath;
  }

  // ---- Private: Venice API wrappers ---------------------------------------

  /**
   * Generate an image using the standard (no-reference) endpoint.
   */
  private async generateStandard(
    client: VeniceClient,
    pr: PromptResult,
  ): Promise<{ base64: string; seed: number | undefined }> {
    const raw = await client.post<Record<string, unknown>>(
      "/api/v1/image/generate",
      {
        model: DEFAULT_MODEL,
        prompt: pr.prompt,
        negative_prompt: pr.negativePrompt,
        resolution: DEFAULT_RESOLUTION,
        aspect_ratio: DEFAULT_ASPECT_RATIO,
        steps: DEFAULT_STEPS,
        cfg_scale: DEFAULT_CFG_SCALE,
        seed: pr.seed,
        hide_watermark: true,
        safe_mode: false,
      },
    );

    // Venice returns { images: ["base64string"] } or { images: [{ b64_json }] }.
    const rawImages = (raw as { images?: unknown[] }).images ?? [];
    if (rawImages.length === 0) {
      throw new Error("Venice API returned no images.");
    }
    const first = rawImages[0];
    const b64 = typeof first === "string" ? first : (first as { b64_json: string }).b64_json;

    return { base64: b64, seed: undefined };
  }

  /**
   * Generate an image using the reference-augmented endpoint.
   *
   * Constructs a multi-reference prompt following the Venice protocol:
   * the main prompt text is augmented with `Image N:` annotations, and
   * reference images are sent as separate base64 payloads keyed by slot.
   */
  private async generateWithReferences(
    client: VeniceClient,
    pr: PromptResult,
  ): Promise<{ base64: string; seed: number | undefined }> {
    // nano-banana-pro does not accept reference image payloads (image_1, image_2, etc.).
    // Character consistency relies on exhaustive text descriptions + seed anchoring.
    const raw = await client.post<Record<string, unknown>>(
      "/api/v1/image/generate",
      {
        model: DEFAULT_MODEL,
        prompt: pr.prompt,
        negative_prompt: pr.negativePrompt,
        resolution: DEFAULT_RESOLUTION,
        aspect_ratio: DEFAULT_ASPECT_RATIO,
        steps: DEFAULT_STEPS,
        cfg_scale: DEFAULT_CFG_SCALE,
        seed: pr.seed,
        hide_watermark: true,
        safe_mode: false,
      },
    );

    // Venice returns { images: ["base64string"] } or { images: [{ b64_json }] }.
    const rawImages = (raw as { images?: unknown[] }).images ?? [];
    if (rawImages.length === 0) {
      throw new Error("Venice API returned no images for reference-augmented generation.");
    }
    const first = rawImages[0];
    const b64 = typeof first === "string" ? first : (first as { b64_json: string }).b64_json;

    return {
      base64: b64,
      seed: undefined,
    };
  }
}
