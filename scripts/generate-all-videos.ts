#!/usr/bin/env npx tsx
/**
 * Generate video clips for all shots across all scenes of a project.
 * Uses Venice AI's Veo 3.1 image-to-video model.
 *
 * Usage: npx tsx scripts/generate-all-videos.ts <project-dir>
 * Example: npx tsx scripts/generate-all-videos.ts output/venice-should-have-used
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Load .env manually
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
    // Strip surrounding quotes
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
const VIDEO_MODEL = 'veo3.1-fast-image-to-video';
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 40; // ~6.5 minutes max wait
const CONCURRENCY = 3; // parallel video jobs

interface VideoJson {
  panelId: string;
  sceneNumber: number;
  shotNumber: number;
  veo: {
    prompt: string;
    durationSeconds: string;
  };
  metadata: {
    characters: string[];
    dialogue?: { character: string; line: string };
    sfx?: string;
    ambient?: string;
    transition: string;
    cameraMovement: string;
  };
}

interface QueueResponse {
  model: string;
  queue_id: string;
}

interface ShotJob {
  sceneDir: string;
  sceneName: string;
  shotNum: string;
  pngPath: string;
  videoJsonPath: string;
  mp4Path: string;
}

async function queueVideo(imageBase64: string, prompt: string): Promise<string> {
  const body = {
    model: VIDEO_MODEL,
    prompt,
    duration: '8s',
    image_url: `data:image/png;base64,${imageBase64}`,
    resolution: '720p',
    audio: true,
  };

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

  const data = await res.json() as QueueResponse;
  return data.queue_id;
}

async function pollForVideo(queueId: string): Promise<Buffer> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(`${BASE_URL}/api/v1/video/retrieve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: VIDEO_MODEL, queue_id: queueId }),
    });

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('video/mp4') || contentType.includes('application/octet-stream')) {
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // Still processing
    if (res.ok) {
      const status = await res.json() as { status: string; execution_duration?: number };
      const elapsed = status.execution_duration ? Math.round(status.execution_duration / 1000) : '?';
      process.stdout.write(`  poll ${attempt + 1}: ${status.status} (${elapsed}s elapsed)\r`);
    } else {
      const text = await res.text();
      console.warn(`  poll warning (${res.status}): ${text}`);
    }
  }

  throw new Error(`Timed out waiting for video (queue_id: ${queueId})`);
}

async function completeVideo(queueId: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/v1/video/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: VIDEO_MODEL, queue_id: queueId }),
    });
  } catch {
    // Non-critical cleanup
  }
}

function archiveExisting(mp4Path: string): void {
  if (!existsSync(mp4Path)) return;

  // Find next available version number
  const base = mp4Path.replace(/\.mp4$/, '');
  let version = 1;
  while (existsSync(`${base}-v${version}.mp4`)) {
    version++;
  }
  const archivePath = `${base}-v${version}.mp4`;
  renameSync(mp4Path, archivePath);
  console.log(`  Archived existing -> ${archivePath}`);
}

async function processShot(job: ShotJob): Promise<boolean> {
  const label = `${job.sceneName}/shot-${job.shotNum}`;

  try {
    // Read video JSON for prompt
    const videoJson = JSON.parse(readFileSync(job.videoJsonPath, 'utf-8')) as VideoJson;

    // Read image as base64
    const imageBuffer = readFileSync(job.pngPath);
    const imageBase64 = imageBuffer.toString('base64');

    // Build an optimized prompt -- use the veo prompt but trim if too long
    let prompt = videoJson.veo.prompt;
    if (prompt.length > 600) {
      // Truncate to ~150 words
      const words = prompt.split(/\s+/).slice(0, 150);
      prompt = words.join(' ');
    }

    console.log(`\n[${label}] Queuing video generation...`);
    const queueId = await queueVideo(imageBase64, prompt);
    console.log(`[${label}] Queued (id: ${queueId.slice(0, 8)}...). Polling...`);

    const mp4Buffer = await pollForVideo(queueId);
    console.log(`[${label}] Video received (${(mp4Buffer.length / 1024 / 1024).toFixed(1)} MB)`);

    // Archive existing file if present
    archiveExisting(job.mp4Path);

    // Save MP4
    writeFileSync(job.mp4Path, mp4Buffer);
    console.log(`[${label}] Saved -> ${job.mp4Path}`);

    // Cleanup
    await completeVideo(queueId);

    return true;
  } catch (err) {
    console.error(`[${label}] FAILED: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function processWithConcurrency(jobs: ShotJob[], concurrency: number): Promise<void> {
  let completed = 0;
  let failed = 0;
  const total = jobs.length;

  // Process in batches
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(job => processShot(job)));

    for (const success of results) {
      if (success) completed++;
      else failed++;
    }

    console.log(`\n--- Progress: ${completed + failed}/${total} (${completed} ok, ${failed} failed) ---`);

    // Small delay between batches to be kind to the API
    if (i + concurrency < jobs.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n=== DONE: ${completed} videos generated, ${failed} failed out of ${total} total ===`);
}

// Main
const projectDir = resolve(process.argv[2] || 'output/venice-should-have-used');

if (!existsSync(projectDir)) {
  console.error(`Project directory not found: ${projectDir}`);
  process.exit(1);
}

console.log(`Project: ${projectDir}`);
console.log(`Model: ${VIDEO_MODEL}`);
console.log(`Concurrency: ${CONCURRENCY}`);

// Discover all scenes and shots
const jobs: ShotJob[] = [];

const entries = readdirSync(projectDir).filter(e => e.startsWith('scene-')).sort();

for (const sceneName of entries) {
  const sceneDir = join(projectDir, sceneName);
  const files = readdirSync(sceneDir).filter(f => f.endsWith('.png')).sort();

  for (const pngFile of files) {
    const shotNum = pngFile.replace('shot-', '').replace('.png', '');
    const pngPath = join(sceneDir, pngFile);
    const videoJsonPath = join(sceneDir, pngFile.replace('.png', '.video.json'));
    const mp4Path = join(sceneDir, pngFile.replace('.png', '.mp4'));

    if (!existsSync(videoJsonPath)) {
      console.warn(`Warning: Missing video JSON for ${sceneName}/${pngFile}, skipping`);
      continue;
    }

    // Skip if MP4 already exists (don't regenerate)
    if (existsSync(mp4Path)) {
      console.log(`Skip: ${sceneName}/shot-${shotNum} (MP4 already exists)`);
      continue;
    }

    jobs.push({ sceneDir, sceneName, shotNum, pngPath, videoJsonPath, mp4Path });
  }
}

console.log(`\nFound ${jobs.length} shots to generate videos for`);
console.log(`Estimated time: ~${Math.ceil(jobs.length / CONCURRENCY) * 90} seconds\n`);

if (jobs.length === 0) {
  console.log('Nothing to do!');
  process.exit(0);
}

processWithConcurrency(jobs, CONCURRENCY).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
