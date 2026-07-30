/**
 * STAGE 3 — Video clip generation
 *
 * Generates 6 × 5s video clips using:
 *  - Seedance 2.0 i2v       for empty/no-character shots (1, 6)
 *  - Seedance 2.0 R2V       for 1-2 character shots      (3, 4, 5)
 *  - Kling O3 standard R2V  for the 4-character shot     (2)
 *
 * For R2V models the panel still acts as the start-frame anchor (image_url),
 * and reference_image_urls / elements provide identity.
 *
 * Re-runnable: skips files that already exist on disk. Pass `--force` to regen
 *              (prior MP4s are archived per shot-asset-safety rule). Pass
 *              `--only=N` to render a single shot. Pass `--quote-only` to just
 *              print Venice cost quotes without spending.
 */

import "dotenv/config";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";

import { VeniceClient, VeniceRequestError } from "../../src/venice/client.js";
import { quoteVideo } from "../../src/venice/video.js";
import { ensureSeedanceCompatibility } from "../../src/venice/seedance-preflight.js";
import { isSeedanceVideoModel } from "../../src/series/types.js";

import {
  SHOTLIST,
  SHOTS_DIR,
  CHARACTERS_DIR,
  ARCHIVE_DIR,
  MODELS,
  STYLE_BLOCK,
  type ShotSpec,
  type Routing,
  getCharacter,
} from "./config.js";
import { banner, journal, sleep } from "./utils.js";

const FORCE = process.argv.includes("--force");
const QUOTE_ONLY = process.argv.includes("--quote-only");
const ONLY_NUM = process.argv.find(a => a.startsWith("--only="))?.split("=")[1];

const VIDEO_QUEUE_PATH = "/api/v1/video/queue";
const VIDEO_RETRIEVE_PATH = "/api/v1/video/retrieve";
const VIDEO_COMPLETE_PATH = "/api/v1/video/complete";

const POLL_INTERVAL_MS = 8_000;
const MAX_POLL_ATTEMPTS = 120;
const MIN_REAL_VIDEO_BYTES = 50_000;

// ---- helpers --------------------------------------------------------------

function shotMp4Path(num: number): string {
  return join(SHOTS_DIR, `shot-${String(num).padStart(3, "0")}.mp4`);
}

function shotPanelPath(num: number): string {
  return join(SHOTS_DIR, `shot-${String(num).padStart(3, "0")}.png`);
}

async function fileToDataUriPng(path: string): Promise<string> {
  const buf = await readFile(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function archiveExisting(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await mkdir(ARCHIVE_DIR, { recursive: true });
  let v = 1;
  let archivePath = join(ARCHIVE_DIR, `${basename(dirname(path))}__${basename(path).replace(/\.mp4$/, "")}.v${v}.mp4`);
  while (existsSync(archivePath)) {
    v++;
    archivePath = join(ARCHIVE_DIR, `${basename(dirname(path))}__${basename(path).replace(/\.mp4$/, "")}.v${v}.mp4`);
  }
  await rename(path, archivePath);
}

/**
 * Pick the model and the input images for a given shot.
 *
 * Returns: { model, referenceImagePaths?, elements? }
 *   - i2v       → no references
 *   - r2v       → up to 4 reference_image_urls (Seedance 2.0)
 *   - r2v-multi → 4 elements with frontal_image_url each (Kling O3)
 */
function planRoute(routing: Routing): {
  model: string;
  referenceImagePaths?: string[];
  elements?: Array<{ frontalImageUrl: string; referenceImageUrls?: string[] }>;
  characters: string[];
} {
  if (routing.kind === "i2v") {
    return { model: MODELS.i2vAtmosphere, characters: [] };
  }

  if (routing.kind === "r2v") {
    // Seedance R2V — pass front + three-quarter for each character (cap at 4 total).
    const refs: string[] = [];
    for (const slug of routing.characters) {
      refs.push(join(CHARACTERS_DIR, slug, "front.png"));
      if (refs.length < 4) {
        refs.push(join(CHARACTERS_DIR, slug, "three-quarter.png"));
      }
      if (refs.length >= 4) break;
    }
    return {
      model: MODELS.r2vCharacter,
      referenceImagePaths: refs.slice(0, 4),
      characters: routing.characters,
    };
  }

  // r2v-multi → Kling O3 standard R2V with elements[]
  const elements = routing.characters.map(slug => {
    const c = getCharacter(slug);
    return {
      frontalImageUrl: join(CHARACTERS_DIR, c.slug, "front.png"),
      referenceImageUrls: [join(CHARACTERS_DIR, c.slug, "three-quarter.png")],
    };
  });
  return {
    model: MODELS.r2vMultiCharacter,
    elements,
    characters: routing.characters,
  };
}

/**
 * Build the final video prompt string. For Seedance R2V, characters are
 * already represented in the prompt as @Image1 / @Image2 (per AGENTS.md
 * learning #19). For Kling O3 R2V we keep character names; the model uses
 * elements[] to anchor identity. For i2v we just front-load STYLE_BLOCK.
 */
function buildVideoPrompt(shot: ShotSpec): string {
  // Front-load style per AGENTS.md learning #11.
  return `${STYLE_BLOCK} ${shot.videoPrompt}`;
}

// ---- main per-shot pipeline ----------------------------------------------

async function quoteOne(client: VeniceClient, shot: ShotSpec): Promise<number> {
  const route = planRoute(shot.routing);
  try {
    const r = await quoteVideo(client, {
      model: route.model,
      duration: shot.duration,
      aspect_ratio: "16:9",
      resolution: route.model.includes("seedance") ? "720p" : null,
      audio: route.model.includes("kling") || route.model.includes("seedance"),
    });
    console.log(`  Shot ${shot.num} (${route.model}, ${shot.duration}): $${r.quote.toFixed(3)}`);
    return r.quote;
  } catch (err) {
    const msg = err instanceof VeniceRequestError ? `${err.status}: ${err.message}` : String(err);
    console.warn(`  Shot ${shot.num} quote failed: ${msg}`);
    return 0;
  }
}

interface QueueResp { model: string; queue_id: string; status: string }

async function generateOne(client: VeniceClient, shot: ShotSpec): Promise<void> {
  const out = shotMp4Path(shot.num);
  if (existsSync(out) && !FORCE) {
    console.log(`  ✓ exists: shot-${String(shot.num).padStart(3, "0")}.mp4`);
    return;
  }
  if (existsSync(out) && FORCE) {
    await archiveExisting(out);
    console.log(`  📦 archived prior shot-${String(shot.num).padStart(3, "0")}.mp4`);
  }

  const route = planRoute(shot.routing);
  const panelPath = shotPanelPath(shot.num);
  if (!existsSync(panelPath)) {
    throw new Error(`Missing panel for shot ${shot.num}: ${panelPath}`);
  }

  // Seedance pre-flight (provenance check on every input image)
  if (isSeedanceVideoModel(route.model)) {
    const action = await ensureSeedanceCompatibility(
      client,
      route.model,
      {
        imageUrl: panelPath,
        referenceImagePaths: route.referenceImagePaths,
      },
      { mode: "fallback" },
    );
    if (action.type === "fallback") {
      console.warn(`  ⚠ Seedance pre-flight fallback: ${action.reason}`);
      route.model = action.newModel;
    } else if (action.type === "laundered") {
      console.log(`  Laundered ${action.lauderedPaths.length} image(s)`);
    }
  }

  const prompt = buildVideoPrompt(shot);
  const body: Record<string, unknown> = {
    model: route.model,
    prompt,
    duration: shot.duration,
    image_url: await fileToDataUriPng(panelPath),
    audio: false, // we'll mix our own VO/music/SFX
  };

  // R2V models need explicit aspect_ratio (per AGENTS.md learning #13).
  // i2v models derive aspect from the panel image — sending aspect_ratio
  // here causes a 400 (`{ details: { aspect_ratio: ... }, issues: [...] }`).
  if (route.model.includes("reference-to-video")) {
    body.aspect_ratio = "16:9";
  }

  if (route.model.includes("seedance")) {
    body.resolution = "720p";
  }

  if (route.referenceImagePaths && route.referenceImagePaths.length > 0) {
    body.reference_image_urls = await Promise.all(
      route.referenceImagePaths.map(p => fileToDataUriPng(p)),
    );
  }

  if (route.elements && route.elements.length > 0) {
    body.elements = await Promise.all(
      route.elements.map(async el => ({
        frontal_image_url: await fileToDataUriPng(el.frontalImageUrl),
        ...(el.referenceImageUrls && el.referenceImageUrls.length > 0 ? {
          reference_image_urls: await Promise.all(el.referenceImageUrls.map(u => fileToDataUriPng(u))),
        } : {}),
      })),
    );
  }

  console.log(`  Submitting shot ${shot.num}: model=${route.model}, refs=${route.referenceImagePaths?.length ?? 0}, elements=${route.elements?.length ?? 0}, prompt=${prompt.length} chars`);

  let queueResp: QueueResp;
  try {
    queueResp = await client.post<QueueResp>(VIDEO_QUEUE_PATH, body);
  } catch (err) {
    const fullBody = err instanceof VeniceRequestError ? JSON.stringify(err.body, null, 2) : "(no body)";
    const msg = err instanceof VeniceRequestError
      ? `${err.status} ${err.message}\n\nFull body:\n\`\`\`json\n${fullBody}\n\`\`\``
      : err instanceof Error ? err.message : String(err);
    if (err instanceof VeniceRequestError) {
      console.error(`  Venice 400 details:\n${fullBody}`);
    }
    await journal(
      "Stage 3 — Video generation",
      "MODEL",
      `Queue rejected for shot ${shot.num}`,
      `Model: \`${route.model}\`\nPrompt (truncated):\n\`\`\`\n${prompt.slice(0, 600)}\n\`\`\`\n\n${msg}`,
    );
    throw err;
  }

  console.log(`  Queued: ${queueResp.queue_id}`);

  // Poll for completion
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(POLL_INTERVAL_MS);

    const resp = await client.postBinaryOrJson<{ status: string; execution_duration?: number; average_execution_time?: number }>(
      VIDEO_RETRIEVE_PATH,
      { model: queueResp.model, queue_id: queueResp.queue_id },
    );

    if (Buffer.isBuffer(resp.value)) {
      const buf = resp.value;
      if (buf.length < MIN_REAL_VIDEO_BYTES) {
        await journal(
          "Stage 3 — Video generation",
          "MODEL",
          `Tiny video buffer for shot ${shot.num}`,
          `Got ${buf.length}-byte buffer for shot ${shot.num}; expected >50KB.`,
        );
        throw new Error(`Video buffer too small (${buf.length} bytes) — likely moderation rejection.`);
      }
      await mkdir(SHOTS_DIR, { recursive: true });
      await writeFile(out, buf);
      try {
        await client.post(VIDEO_COMPLETE_PATH, { model: queueResp.model, queue_id: queueResp.queue_id });
      } catch { /* cleanup is optional */ }
      console.log(`  ✨ shot-${String(shot.num).padStart(3, "0")}.mp4  (${(buf.length / 1024 / 1024).toFixed(2)}MB)`);
      return;
    }

    const status = resp.value as { status?: string; execution_duration?: number; average_execution_time?: number };
    if (status.status === "PROCESSING") {
      const elapsed = Math.round((status.execution_duration ?? 0) / 1000);
      const avg = Math.round((status.average_execution_time ?? 0) / 1000);
      console.log(`    [${attempt + 1}/${MAX_POLL_ATTEMPTS}] processing... ${elapsed}s/${avg || "?"}s avg`);
    }
  }

  throw new Error(`Timed out waiting for video shot ${shot.num} (${queueResp.queue_id})`);
}

// ---- main -----------------------------------------------------------------

async function main(): Promise<void> {
  banner(QUOTE_ONLY ? "STAGE 3 — Quote video clips" : "STAGE 3 — Generate video clips");
  if (!process.env.VENICE_API_KEY) {
    console.error("VENICE_API_KEY not set in environment.");
    process.exit(1);
  }

  const client = new VeniceClient();
  const targets = ONLY_NUM
    ? SHOTLIST.filter(s => s.num === parseInt(ONLY_NUM, 10))
    : SHOTLIST;

  if (targets.length === 0) {
    console.error(`No shot matched --only=${ONLY_NUM}`);
    process.exit(1);
  }

  console.log(`Shots: ${targets.map(s => s.num).join(", ")}`);
  console.log(`Force: ${FORCE ? "YES (prior MP4s archived)" : "no"}`);
  console.log("");

  if (QUOTE_ONLY) {
    console.log("Quoting shots (no spend):");
    let total = 0;
    for (const shot of targets) {
      const q = await quoteOne(client, shot);
      total += q;
      await sleep(150);
    }
    console.log(`\nQuote total: $${total.toFixed(3)} for ${targets.length} shot(s)`);
    return;
  }

  for (const shot of targets) {
    console.log(`\n──── Shot ${shot.num} (${shot.routing.kind}) ────`);
    try {
      await generateOne(client, shot);
    } catch (err) {
      console.error(`Shot ${shot.num} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    await sleep(200);
  }

  banner(`STAGE 3 COMPLETE — ${targets.length} clip(s) attempted`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
