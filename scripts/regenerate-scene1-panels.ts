#!/usr/bin/env npx tsx
/**
 * Regenerate Scene 1 panels with Clean Dystopia aesthetic.
 * Produces 4 panels + matching video.json files.
 *
 * Usage: npx tsx scripts/regenerate-scene1-panels.ts
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
const SCENE_DIR = resolve('output/erik-voorhees-manifesto/scene-001');

// MAN character description (from project.json)
const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height. Wearing a dark rumpled charcoal suit, slightly creased, dark olive shirt underneath, no tie.`;

// Clean Dystopia aesthetic -- ONLY this register
const CLEAN_DYSTOPIA = {
  style: 'Ultra-sterile white minimalism, THX-1138 meets Black Mirror. Totalitarianism as design perfection.',
  palette: 'Pure white, clinical gray, glass-green tint. The man\'s dark charcoal suit is the only contrast. No color except rare accent glows.',
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

const shots: ShotPlan[] = [
  {
    shotNumber: 1,
    imagePrompt: [
      `Ultra-sterile white cityscape seen from high above in tilt-shift miniaturization effect.`,
      `A miniature prison compound materializes on what appears to be a circuit board. Guard towers with razor wire, tiny gray figures shuffling between partitioned white zones.`,
      `Everything is impossibly clean and orderly -- pristine white surfaces, clinical perfection.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Extreme wide shot, high angle looking down, 14mm ultra-wide lens. Symmetric composition, deep focus.`,
    ].join(' '),
    videoPrompt: `A slow crane shot rises upward revealing a miniature prison compound built on a circuit board, viewed through tilt-shift miniaturization. Guard towers with razor wire, tiny gray figures shuffling between partitioned white zones. Ultra-sterile clinical white surfaces, soft ambient light from no visible source, no shadows. Everything impossibly clean and orderly. Deep focus, symmetric framing. Sound of a low electronic hum and distant shuffling.`,
    videoDuration: '8s',
    cameraMovement: 'crane, slowly',
    transition: 'CUT',
    characters: [],
    ambient: 'low electronic hum, distant shuffling',
  },
  {
    shotNumber: 2,
    imagePrompt: [
      `Tilt-shift close-up of miniature guard towers and razor wire gleaming under flat clinical light.`,
      `Tiny figures in gray uniforms move in mechanical rhythm between partitioned zones on a circuit board compound.`,
      `Shallow depth of field from tilt-shift effect. Pristine white surfaces, no shadows, no grain.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Medium-wide shot, slightly elevated angle, tilt-shift lens effect.`,
    ].join(' '),
    videoPrompt: `A slow push-in on guard towers and razor wire gleaming under flat clinical light. Tiny figures in gray uniforms move in mechanical rhythm between partitioned zones. Tilt-shift shallow depth of field. Pristine white surfaces, no shadows, no grain. Sound of metallic creak and distant footsteps.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: [],
    sfx: 'metallic creak',
    ambient: 'distant footsteps',
  },
  {
    shotNumber: 3,
    imagePrompt: [
      `A miniature compound that is indistinguishable from a microchip. Circuit traces become corridors, capacitors become guard towers.`,
      `The boundary where architecture becomes electronics is impossible to locate. Ultra-clean white, deep focus, clinical perfection.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Medium shot, eye-level, macro lens perspective revealing circuit board details merging with architectural elements.`,
    ].join(' '),
    videoPrompt: `A slow dolly forward reveals the compound is indistinguishable from a microchip -- circuit traces become corridors, capacitors become guard towers. The camera crosses the threshold where architecture becomes electronics. Ultra-clean white, deep focus, clinical perfection. Sound of a low electrical hum building.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: [],
    ambient: 'low electrical hum building',
  },
  {
    shotNumber: 4,
    imagePrompt: [
      `${MAN_DESC}`,
      `He stands before the miniature compound/microchip, the only dark element in a pristine white world. Expression neutral and composed.`,
      `Medium shot, eye-level. He is the sole source of contrast in an impossibly clean environment.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Flat ambient light, no shadows. Symmetric framing.`,
    ].join(' '),
    videoPrompt: `A static medium shot of a man in a dark rumpled charcoal suit, the only dark element in a pristine white world. He stands before the miniature compound, expression neutral and composed. Short brown hair, close-trimmed beard, deep-set hazel eyes. Flat ambient light, no shadows. Sound of distant traffic.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: { character: 'MAN (V.O.)', line: 'Every time you pay with your card, you\'re being granted permission.' },
    ambient: 'distant traffic',
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

  // images[0] is a raw base64 string
  const b64 = typeof data.images[0] === 'string' ? data.images[0] : (data.images[0] as any).b64_json;
  return Buffer.from(b64, 'base64');
}

function buildVideoJson(shot: ShotPlan) {
  return {
    panelId: `S1-P${shot.shotNumber}`,
    sceneNumber: 1,
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

  console.log(`Regenerating Scene 1 with ${shots.length} shots (Clean Dystopia aesthetic)`);
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

      // Write video JSON
      const videoJson = buildVideoJson(shot);
      writeFileSync(jsonPath, JSON.stringify(videoJson, null, 2));
      console.log(`[${label}] Video JSON saved`);
    } catch (err) {
      console.error(`[${label}] FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // Rate limit delay
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
