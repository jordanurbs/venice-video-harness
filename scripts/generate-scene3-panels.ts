#!/usr/bin/env npx tsx
/**
 * Generate Scene 3 panels with Clean Dystopia aesthetic.
 * Scene: INT. FACTORY HALL - NIGHT
 * Short scene -- 1 VO line, 2 shots.
 *
 * Usage: npx tsx scripts/generate-scene3-panels.ts
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
const SCENE_DIR = resolve('output/erik-voorhees-manifesto/scene-003');

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

// Scene 3: Short scene, 1 VO line (~3s of speech):
// "And you don't notice because permission is usually granted."
// Action: REVERSE ANGLE on the man, standing at front of vast industrial hall.
// Rows of IDENTICAL WORKERS in gray uniforms at metal desks, heads down.
//
// 2 shots, ~10s total:
//   1. Reverse wide: Man seen from behind, facing the vast hall of workers (5s)
//   2. Detail: Rows of workers, heads down, not looking up (5s)

const shots: ShotPlan[] = [
  {
    shotNumber: 1,
    imagePrompt: [
      `Reverse angle wide shot of a vast industrial hall rendered in ultra-sterile white minimalism.`,
      `${MAN_DESC}`,
      `He stands at the front of the hall, seen from behind, a dark silhouette against pristine white.`,
      `Before him, rows upon rows of identical workers in gray uniforms sit at white metal desks, heads bowed down. They do not look up.`,
      `The hall stretches deep into the frame with perfect symmetric one-point perspective.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Wide shot from behind the man, slightly elevated angle, 24mm lens. Deep focus revealing every row of workers.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot pushes forward past a man in a dark charcoal suit, seen from behind, standing at the front of a vast white industrial hall. Before him, rows upon rows of identical workers in gray uniforms sit at white metal desks, all heads bowed down. None look up. Pristine white walls and floor, flat ambient light from no visible source, no shadows. Symmetric one-point perspective. Sound of rhythmic breathing in unison and a distant clock ticking.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: "And you don't notice because permission is usually granted.",
    },
    ambient: 'rhythmic breathing in unison, distant clock ticking',
  },
  {
    shotNumber: 2,
    imagePrompt: [
      `Close detail shot of rows of identical workers in gray uniforms seated at white metal desks in a vast sterile hall.`,
      `All heads are bowed down, faces hidden. Uniform posture, mechanical stillness. They do not look up.`,
      `The desks form a perfect grid pattern receding into white fog.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Medium shot, slightly elevated angle, 35mm lens. Shallow depth of field -- front row sharp, back rows dissolving into white.`,
    ].join(' '),
    videoPrompt: `A slow tracking shot glides across rows of identical workers in gray uniforms, all seated at white metal desks with heads bowed. None move except for the faint rise and fall of breathing in unison. Perfect grid pattern, pristine white environment, flat ambient light, no shadows. Sound of synchronized breathing and a ticking clock growing louder.`,
    videoDuration: '5s',
    cameraMovement: 'tracking, slowly',
    transition: 'CUT',
    characters: [],
    sfx: 'clock ticking growing louder',
    ambient: 'synchronized breathing',
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
    panelId: `S3-P${shot.shotNumber}`,
    sceneNumber: 3,
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

  console.log(`Generating Scene 3 with ${shots.length} shots (Clean Dystopia aesthetic)`);
  console.log(`Scene: INT. FACTORY HALL`);
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
