#!/usr/bin/env npx tsx
/**
 * Generate Scene 4 panels with Clean Dystopia aesthetic.
 * Scene: BEAT - 2 SECONDS (visual-only breathing beat, Act 1 closer)
 * Very short -- 1 VO line, 2 shots. Ends with SMASH CUT to Act Two.
 *
 * Usage: npx tsx scripts/generate-scene4-panels.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
const IMAGE_MODEL = 'nano-banana-pro';
const SCENE_DIR = resolve('output/erik-voorhees-manifesto/scene-004');

const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height. Wearing a dark rumpled charcoal suit, slightly creased, dark olive shirt underneath, no tie.`;

const CLEAN_DYSTOPIA = {
  style: 'Ultra-sterile white minimalism, THX-1138 meets Black Mirror. Totalitarianism as design perfection.',
  palette: 'Pure white, clinical gray. The man\'s dark charcoal suit is the only contrast. Workers in identical gray uniforms.',
  lighting: 'Soft ambient light from everywhere and nowhere -- no visible source, no shadows. Flat, even, inescapable illumination.',
  lens: 'Clean digital, impossibly sharp, symmetric framing, deep focus. 16:9 cinematic widescreen.',
  film: 'Ultra-clean digital -- no grain, no imperfection, no warmth. Clinical and perfect.',
};

interface ShotPlan {
  shotNumber: number;
  imagePrompt: string;
  videoPrompt: string;
  videoDuration: string;
  cameraMovement: string;
  transition: string;
  characters: string[];
  dialogue?: { character: string; line: string };
  sfx?: string;
  ambient?: string;
}

// Scene 4: BEAT - 2 SECONDS
// Action: Slow push past the man's shoulder. Workers breathe in unison. A clock ticks.
// VO: "As long as you behave, citizen, the permission will be there."
// Transition: SMASH CUT TO (Act Two begins)
//
// 2 shots, ~8s total:
//   1. Over-shoulder push: Camera slides past man's shoulder toward workers (5s)
//   2. Close-up: Workers breathing in unison, clock tick (3s) -- ends on SMASH CUT

const shots: ShotPlan[] = [
  {
    shotNumber: 1,
    imagePrompt: [
      `Over-the-shoulder shot looking past a man in a dark rumpled charcoal suit toward rows of workers.`,
      `${MAN_DESC}`,
      `His shoulder and profile visible in the left foreground, slightly out of focus.`,
      `Beyond him, rows of identical workers in gray uniforms sit at white metal desks, heads bowed, breathing in synchronized rhythm.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Over-shoulder medium shot, eye-level, 50mm lens. Man in foreground soft, workers in background sharp.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot pushes forward past a man's shoulder in a dark charcoal suit, moving toward rows of identical workers in gray uniforms at white metal desks. All heads bowed, breathing in perfect unison -- chests rising and falling together. Pristine white environment, flat ambient light, no shadows. Sound of synchronized breathing and a loud clock ticking steadily.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'As long as you behave, citizen, the permission will be there.',
    },
    sfx: 'clock ticking steadily',
    ambient: 'synchronized breathing',
  },
  {
    shotNumber: 2,
    imagePrompt: [
      `Extreme close-up of identical workers in gray uniforms at white metal desks, seen from low angle.`,
      `Multiple torsos and bowed heads fill the frame. All breathe in perfect unison -- chests slightly expanded.`,
      `A clock face is visible in the upper corner of frame, its second hand frozen mid-tick.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Extreme close-up, low angle, 85mm lens. Tight framing, clinical sharpness.`,
    ].join(' '),
    videoPrompt: `A static extreme close-up of workers' torsos and bowed heads in gray uniforms, breathing in perfect unison. Chests rise and fall together in mechanical rhythm. A clock ticks louder and louder. Flat white light, no shadows. Suddenly the breathing stops -- frozen silence. Sound of a single loud clock tick that echoes into nothing.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'SMASH CUT',
    characters: [],
    sfx: 'clock tick echoing into silence',
    ambient: 'breathing stops suddenly',
  },
];

async function generateImage(prompt: string): Promise<Buffer> {
  const body = {
    model: IMAGE_MODEL,
    prompt,
    resolution: '1K',
    aspect_ratio: '16:9',
    steps: 30,
    cfg_scale: 7,
    hide_watermark: true,
    safe_mode: false,
  };

  const res = await fetch(`${BASE_URL}/api/v1/image/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image generation failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { images: string[] };
  if (!data.images || data.images.length === 0) {
    throw new Error('No images returned from API');
  }

  const b64 = typeof data.images[0] === 'string' ? data.images[0] : (data.images[0] as any).b64_json;
  return Buffer.from(b64, 'base64');
}

function buildVideoJson(shot: ShotPlan) {
  return {
    panelId: `S4-P${shot.shotNumber}`,
    sceneNumber: 4,
    shotNumber: shot.shotNumber,
    video: {
      model: 'kling-o3-pro-image-to-video',
      prompt: shot.videoPrompt,
      duration: shot.videoDuration,
      audio: true,
    },
    metadata: {
      imagePrompt: shot.imagePrompt,
      characters: shot.characters,
      ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
      ...(shot.sfx ? { sfx: shot.sfx } : {}),
      ...(shot.ambient ? { ambient: shot.ambient } : {}),
      transition: shot.transition,
      cameraMovement: shot.cameraMovement,
    },
  };
}

async function main() {
  if (!existsSync(SCENE_DIR)) {
    mkdirSync(SCENE_DIR, { recursive: true });
  }

  console.log(`Generating Scene 4 with ${shots.length} shots (Clean Dystopia aesthetic)`);
  console.log(`Scene: BEAT - 2 SECONDS (Act 1 closer)`);
  console.log(`Output: ${SCENE_DIR}\n`);

  for (const shot of shots) {
    const label = `shot-${String(shot.shotNumber).padStart(3, '0')}`;
    const pngPath = join(SCENE_DIR, `${label}.png`);
    const jsonPath = join(SCENE_DIR, `${label}.video.json`);

    console.log(`[${label}] Generating panel...`);
    console.log(`  Prompt: ${shot.imagePrompt.slice(0, 100)}...`);

    try {
      const imageBuffer = await generateImage(shot.imagePrompt);
      writeFileSync(pngPath, imageBuffer);
      console.log(`[${label}] Panel saved (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

      const videoJson = buildVideoJson(shot);
      writeFileSync(jsonPath, JSON.stringify(videoJson, null, 2));
      console.log(`[${label}] Video JSON saved`);
    } catch (err) {
      console.error(`[${label}] FAILED: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\nDone! Generated panels:');
  for (const shot of shots) {
    const label = `shot-${String(shot.shotNumber).padStart(3, '0')}`;
    console.log(`  ${label}.png + ${label}.video.json`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
