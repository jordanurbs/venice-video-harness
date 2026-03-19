#!/usr/bin/env npx tsx
/**
 * Generate video clips for a scene with frame chaining for visual continuity.
 *
 * For each shot:
 * - Shot 1: image_url = panel PNG (first frame reference)
 * - Shot N>1: image_url = last frame extracted from previous video (chain continuity)
 *           + end_image_url = next panel PNG (Kling O3 Pro only, target end frame)
 *
 * Usage:
 *   npx tsx scripts/generate-scene-videos.ts <project-dir> <scene-number> [model]
 *
 * Examples:
 *   npx tsx scripts/generate-scene-videos.ts output/erik-voorhees-manifesto 1
 *   npx tsx scripts/generate-scene-videos.ts output/erik-voorhees-manifesto 1 vidu-q3-image-to-video
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

// Load .env
const envPath = resolve('.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const API_KEY = process.env.VENICE_API_KEY;
if (!API_KEY) {
  console.error('VENICE_API_KEY not found in .env');
  process.exit(1);
}

const BASE_URL = 'https://api.venice.ai';
const POLL_INTERVAL_MS = 10_000;

// Model-specific config
interface ModelConfig {
  name: string;
  maxPollAttempts: number;  // timeout = this * POLL_INTERVAL_MS
  supportsEndImage: boolean;
  extraParams: Record<string, unknown>;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'kling-o3-pro-image-to-video': {
    name: 'kling-o3-pro-image-to-video',
    maxPollAttempts: 150,  // ~25 min (Venice reports ~19 min avg under load)
    supportsEndImage: true,
    extraParams: {},  // NO resolution, NO aspect_ratio
  },
  'vidu-q3-image-to-video': {
    name: 'vidu-q3-image-to-video',
    maxPollAttempts: 150,
    supportsEndImage: false,
    extraParams: { resolution: '1080p' },
  },
  'veo3.1-fast-image-to-video': {
    name: 'veo3.1-fast-image-to-video',
    maxPollAttempts: 20,  // ~3 min
    supportsEndImage: false,
    extraParams: { resolution: '720p' },
  },
};

interface VideoJson {
  panelId: string;
  sceneNumber: number;
  shotNumber: number;
  video: {
    model: string;
    prompt: string;
    duration: string;
    audio: boolean;
  };
  metadata: {
    imagePrompt?: string;
    characters: string[];
    dialogue?: { character: string; line: string };
    sfx?: string;
    ambient?: string;
    transition: string;
    cameraMovement: string;
  };
}

// --- Frame extraction ---

function extractLastFrame(mp4Path: string, outputPath: string): string {
  // Get video duration via ffprobe
  const durationStr = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp4Path}"`,
    { encoding: 'utf-8' }
  ).trim();
  const duration = parseFloat(durationStr);

  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for ${mp4Path}`);
  }

  // Seek to 50ms before end and grab 1 frame
  const seekTo = Math.max(0, duration - 0.05);
  execSync(
    `ffmpeg -y -ss ${seekTo} -i "${mp4Path}" -frames:v 1 -q:v 2 "${outputPath}"`,
    { encoding: 'utf-8', stdio: 'pipe' }
  );

  if (!existsSync(outputPath)) {
    throw new Error(`Failed to extract last frame from ${mp4Path}`);
  }

  return outputPath;
}

// --- Venice API calls ---

interface QueueBody {
  model: string;
  prompt: string;
  duration: string;
  image_url: string;
  audio: boolean;
  end_image_url?: string;
  [key: string]: unknown;
}

async function queueVideo(body: QueueBody): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/video/queue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Queue failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { queue_id: string };
  return data.queue_id;
}

async function pollForVideo(queueId: string, model: string, maxAttempts: number): Promise<Buffer> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(`${BASE_URL}/api/v1/video/retrieve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, queue_id: queueId }),
    });

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('video/mp4') || contentType.includes('application/octet-stream')) {
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    if (res.ok) {
      const status = await res.json() as { status: string; execution_duration?: number; average_execution_time?: number };
      const elapsed = status.execution_duration ? Math.round(status.execution_duration / 1000) : '?';
      const avg = status.average_execution_time ? Math.round(status.average_execution_time / 1000) : '?';
      process.stdout.write(`  poll ${attempt + 1}/${maxAttempts}: ${status.status} (${elapsed}s / ~${avg}s avg)      \r`);
    } else {
      const text = await res.text();
      console.warn(`  poll warning (${res.status}): ${text}`);
    }
  }

  throw new Error(`Timed out waiting for video (queue_id: ${queueId})`);
}

async function completeVideo(queueId: string, model: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/v1/video/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, queue_id: queueId }),
    });
  } catch {
    // Non-critical cleanup
  }
}

function archiveExisting(mp4Path: string): void {
  if (!existsSync(mp4Path)) return;
  const base = mp4Path.replace(/\.mp4$/, '');
  let version = 1;
  while (existsSync(`${base}-v${version}.mp4`)) {
    version++;
  }
  const archivePath = `${base}-v${version}.mp4`;
  renameSync(mp4Path, archivePath);
  console.log(`  Archived existing -> ${archivePath}`);
}

// --- Main pipeline ---

async function main() {
  const projectDir = resolve(process.argv[2] || 'output/erik-voorhees-manifesto');
  const sceneNum = parseInt(process.argv[3] || '1', 10);
  const modelName = process.argv[4] || 'kling-o3-pro-image-to-video';

  const modelConfig = MODEL_CONFIGS[modelName];
  if (!modelConfig) {
    console.error(`Unknown model: ${modelName}`);
    console.error(`Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const sceneDirName = `scene-${String(sceneNum).padStart(3, '0')}`;
  const sceneDir = join(projectDir, sceneDirName);

  if (!existsSync(sceneDir)) {
    console.error(`Scene directory not found: ${sceneDir}`);
    process.exit(1);
  }

  // Discover shots by finding video.json files
  const shotFiles = readdirSync(sceneDir)
    .filter(f => f.match(/^shot-\d+\.video\.json$/))
    .sort();

  if (shotFiles.length === 0) {
    console.error(`No video.json files found in ${sceneDir}`);
    process.exit(1);
  }

  console.log(`Project: ${projectDir}`);
  console.log(`Scene: ${sceneNum} (${sceneDirName})`);
  console.log(`Model: ${modelConfig.name}`);
  console.log(`Shots: ${shotFiles.length}`);
  console.log(`Frame chaining: enabled`);
  console.log(`End image targeting: ${modelConfig.supportsEndImage ? 'enabled' : 'not supported by model'}`);
  console.log(`---`);

  let previousMp4Path: string | null = null;
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < shotFiles.length; i++) {
    const videoJsonFile = shotFiles[i];
    const shotNum = videoJsonFile.replace('shot-', '').replace('.video.json', '');
    const label = `shot-${shotNum}`;
    const pngPath = join(sceneDir, `shot-${shotNum}.png`);
    const mp4Path = join(sceneDir, `shot-${shotNum}.mp4`);
    const lastframePath = join(sceneDir, `lastframe-${shotNum}.png`);

    console.log(`\n[${label}] Processing...`);

    if (!existsSync(pngPath)) {
      console.error(`[${label}] Panel PNG not found: ${pngPath}`);
      failed++;
      continue;
    }

    // Read video JSON
    const videoJson = JSON.parse(readFileSync(join(sceneDir, videoJsonFile), 'utf-8')) as VideoJson;
    const videoBlock = videoJson.video;

    // Determine image_url: panel for shot 1, last frame of previous video for subsequent shots
    let imageBase64: string;
    if (i === 0 || !previousMp4Path) {
      // First shot: use the panel
      console.log(`[${label}] Using panel as first frame`);
      imageBase64 = readFileSync(pngPath).toString('base64');
    } else {
      // Subsequent shots: extract last frame from previous video
      console.log(`[${label}] Extracting last frame from previous video for continuity...`);
      try {
        extractLastFrame(previousMp4Path, lastframePath);
        imageBase64 = readFileSync(lastframePath).toString('base64');
        console.log(`[${label}] Using chained frame from ${previousMp4Path}`);
      } catch (err) {
        console.warn(`[${label}] Frame extraction failed, falling back to panel: ${err instanceof Error ? err.message : err}`);
        imageBase64 = readFileSync(pngPath).toString('base64');
      }
    }

    // Build request body
    const body: QueueBody = {
      model: modelConfig.name,
      prompt: videoBlock.prompt,
      duration: videoBlock.duration,
      image_url: `data:image/png;base64,${imageBase64}`,
      audio: videoBlock.audio !== false,
      ...modelConfig.extraParams,
    };

    // Add end_image_url if supported and there's a next shot
    if (modelConfig.supportsEndImage && i < shotFiles.length - 1) {
      const nextShotNum = shotFiles[i + 1].replace('shot-', '').replace('.video.json', '');
      const nextPngPath = join(sceneDir, `shot-${nextShotNum}.png`);
      if (existsSync(nextPngPath)) {
        const nextBase64 = readFileSync(nextPngPath).toString('base64');
        body.end_image_url = `data:image/png;base64,${nextBase64}`;
        console.log(`[${label}] End frame target: shot-${nextShotNum}.png`);
      }
    }

    try {
      console.log(`[${label}] Queuing video (${videoBlock.duration}, ${modelConfig.name})...`);
      const queueId = await queueVideo(body);
      console.log(`[${label}] Queued (id: ${queueId.slice(0, 8)}...). Polling...`);

      const startTime = Date.now();
      const mp4Buffer = await pollForVideo(queueId, modelConfig.name, modelConfig.maxPollAttempts);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n[${label}] Video received (${(mp4Buffer.length / 1024 / 1024).toFixed(1)} MB, ${elapsed}s)`);

      // Archive existing and save
      archiveExisting(mp4Path);
      writeFileSync(mp4Path, mp4Buffer);
      console.log(`[${label}] Saved -> ${mp4Path}`);

      // Update video JSON with actual model used
      videoJson.video.model = modelConfig.name;
      writeFileSync(join(sceneDir, videoJsonFile), JSON.stringify(videoJson, null, 2));

      // Cleanup
      await completeVideo(queueId, modelConfig.name);

      previousMp4Path = mp4Path;
      completed++;
    } catch (err) {
      console.error(`\n[${label}] FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
      // Don't chain from a failed shot -- next shot will use its own panel
      previousMp4Path = null;
    }
  }

  console.log(`\n=== DONE: ${completed} videos generated, ${failed} failed out of ${shotFiles.length} total ===`);
  if (completed === shotFiles.length) {
    console.log(`\nAll shots complete! Run assembly:`);
    console.log(`  npx tsx src/cli.ts assemble -p ${projectDir} --render-scene ${sceneNum}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
