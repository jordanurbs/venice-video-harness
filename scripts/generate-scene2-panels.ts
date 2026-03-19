#!/usr/bin/env npx tsx
/**
 * Generate Scene 2 panels with Clean Dystopia aesthetic.
 * Scene: INT. SURVEILLANCE CORRIDOR - NIGHT
 * Produces 5 panels + matching video.json files.
 *
 * Usage: npx tsx scripts/generate-scene2-panels.ts
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
const SCENE_DIR = resolve('output/erik-voorhees-manifesto/scene-002');

// MAN character description (consistent with Scene 1)
const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height. Wearing a dark rumpled charcoal suit, slightly creased, dark olive shirt underneath, no tie.`;

// FACELESS FIGURE description
const FACELESS_DESC = `A humanoid figure in a bureaucratic gray uniform, sitting behind a glass desk. Its head is a swirling cloud of dark smoke, featureless and opaque. No face, no eyes -- just a constantly shifting plume of black-gray smoke where the head should be. Body posture is rigid, official, seated upright.`;

// Clean Dystopia aesthetic -- ONLY this register
const CLEAN_DYSTOPIA = {
  style: 'Ultra-sterile white minimalism, THX-1138 meets Black Mirror. Totalitarianism as design perfection.',
  palette: 'Pure white, clinical gray, glass-green tint on desks. The man\'s dark charcoal suit is the only warm contrast. Smoke-black on faceless heads. No color except the small green glow of the card reader.',
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

// Scene 2 has two VO blocks (~15-20s of speech total):
// VO1: "It appears as though the permission is simply whether you had enough money,
//       but in reality there is another, much more insidious, layer of approval taking place."
// VO2: "The bank. The financial institution. The government. Numerous parties all along the line.
//       Strangers to you. People you will never meet -- bless each of your transactions."
//
// Shot plan: 5 shots, ~28s total video
//   1. Establishing: Man facing faceless figure at glass desk, corridor stretching behind (8s)
//   2. Detail: Card held toward reader, green light, smoke-face studying (5s)
//   3. Perspective: Endless corridor of glass desks with motionless faceless figures (8s)
//   4. Reaction: Smoke-face tilts, deciding (5s)
//   5. Wide: Man alone amid the corridor of watchers (3s)

const shots: ShotPlan[] = [
  {
    shotNumber: 1,
    imagePrompt: [
      `Interior surveillance corridor, ultra-sterile white minimalist environment.`,
      `${MAN_DESC}`,
      `He stands holding a payment card toward a glass desk where a FACELESS FIGURE sits. ${FACELESS_DESC}`,
      `Behind them, an endless corridor of identical glass desks stretches into soft white fog. Other faceless smoke-headed figures sit motionless at each station.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Wide shot, eye-level, 24mm lens. Symmetric one-point perspective composition with the corridor vanishing point dead center.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot pushes forward into a pristine white corridor. A man in a dark rumpled charcoal suit stands holding a card toward a glass desk where a faceless figure sits, its head a swirl of dark smoke. Behind them, an endless corridor of identical glass desks stretches into white fog, motionless smoke-headed figures at each station. Ultra-sterile white surfaces, flat ambient light from no visible source, no shadows. Symmetric one-point perspective. Sound of a low fluorescent hum and the man's breathing.`,
    videoDuration: '8s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'It appears as though the permission is simply whether you had enough money, but in reality there is another, much more insidious, layer of approval taking place.',
    },
    ambient: 'low fluorescent hum, breathing',
  },
  {
    shotNumber: 2,
    imagePrompt: [
      `Close-up detail shot of a hand holding a payment card toward a card reader on a pristine glass desk.`,
      `The card reader emits a small green light -- APPROVED. A subtle green glow illuminates the card surface.`,
      `Behind the desk, a faceless figure with a head of swirling dark smoke tilts slightly, studying the card. ${FACELESS_DESC}`,
      `Ultra-sterile white environment. ${CLEAN_DYSTOPIA.lighting}`,
      `${CLEAN_DYSTOPIA.film} ${CLEAN_DYSTOPIA.palette}`,
      `Close-up shot, slightly low angle looking up at the smoke face. Sharp focus on card and reader, smoke-head slightly soft.`,
    ].join(' '),
    videoPrompt: `A static close-up of a hand holding a payment card near a glass-topped reader. A small green light pulses -- APPROVED. Behind the desk, a faceless figure's smoke-swirl head tilts slowly, studying, deciding. The green glow reflects off pristine white surfaces. Flat ambient light, no shadows. Sound of a soft electronic chime and smoke hissing faintly.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    sfx: 'electronic chime, card approval beep',
    ambient: 'smoke hissing faintly',
  },
  {
    shotNumber: 3,
    imagePrompt: [
      `Extreme wide shot of an endless corridor of identical glass desks stretching into white fog.`,
      `At each desk sits a faceless figure -- humanoid body in gray uniform, head replaced by a swirl of dark smoke. All sit motionless, rigid, upright.`,
      `The corridor has pristine white walls, ceiling, and floor. Glass-green tint on the desk surfaces. Symmetric one-point perspective vanishing into infinity.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Extreme wide shot, eye-level, 14mm ultra-wide lens. Perfect symmetry, deep focus revealing every desk into the distance.`,
    ].join(' '),
    videoPrompt: `A slow tracking shot glides down an endless corridor of identical glass desks. At each desk sits a faceless figure in gray, its head a swirl of dark smoke, all perfectly still. Pristine white walls and floor stretch into fog. Glass-green tint on desk surfaces. Flat ambient light from everywhere, no shadows, no warmth. Deep focus, symmetric framing. Sound of distant shuffling, a low hum, and the echo of the man's footsteps behind us.`,
    videoDuration: '8s',
    cameraMovement: 'tracking, slowly',
    transition: 'CUT',
    characters: [],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'The bank. The financial institution. The government. Numerous parties all along the line. Strangers to you. People you will never meet -- bless each of your transactions.',
    },
    ambient: 'distant shuffling, low hum, echoing footsteps',
  },
  {
    shotNumber: 4,
    imagePrompt: [
      `Medium close-up of a faceless figure behind a glass desk. ${FACELESS_DESC}`,
      `Its smoke-swirl head tilts at an angle, as if studying or deciding something. The smoke shifts and curls with subtle menace.`,
      `The glass desk surface has a faint green glow from the card reader below.`,
      `Ultra-sterile white background. ${CLEAN_DYSTOPIA.lighting}`,
      `${CLEAN_DYSTOPIA.film} ${CLEAN_DYSTOPIA.palette}`,
      `Medium close-up, eye-level, 50mm lens. The smoke head fills the upper portion of frame.`,
    ].join(' '),
    videoPrompt: `A static medium close-up of a faceless figure behind a glass desk. Its head is a slowly churning cloud of dark smoke, featureless and menacing. The smoke-head tilts deliberately to one side, studying, judging. A faint green glow from the card reader reflects off the glass surface. Pristine white walls behind, flat light, no shadows. Sound of smoke hissing and a distant approval tone fading.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: [],
    sfx: 'smoke hissing, distant approval tone',
  },
  {
    shotNumber: 5,
    imagePrompt: [
      `${MAN_DESC}`,
      `He stands alone in the center of the endless white corridor, seen from behind at medium distance. The only dark element in a pristine white world.`,
      `On either side, rows of glass desks with motionless smoke-headed faceless figures recede into fog.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Medium-wide shot from behind, slightly elevated angle. The man is a dark silhouette centered in perfect white symmetry.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot pulls back from the man in his dark charcoal suit, standing alone in the center of an endless white corridor. On both sides, motionless smoke-headed figures sit at glass desks receding into fog. He is the only dark element in a pristine sterile world. Flat ambient light, no shadows, symmetric framing. Sound of distant footsteps fading and a low electronic drone.`,
    videoDuration: '3s',
    cameraMovement: 'dolly-out, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    ambient: 'distant footsteps fading, low electronic drone',
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
    panelId: `S2-P${shot.shotNumber}`,
    sceneNumber: 2,
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

  console.log(`Generating Scene 2 with ${shots.length} shots (Clean Dystopia aesthetic)`);
  console.log(`Scene: INT. SURVEILLANCE CORRIDOR`);
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
