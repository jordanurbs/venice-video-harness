#!/usr/bin/env npx tsx
/**
 * Generate Scenes 5, 6, 7 panels with Clean Dystopia aesthetic.
 * Scene 5: EXT. CONCRETE CANYON / CITY STREETS - man walks among citizens
 * Scene 6: BEAT - man stops, buildings form cage overhead
 * Scene 7: EXT. ALLEY / WALL - shadow chained to wall
 *
 * Usage: npx tsx scripts/generate-scene5-7-panels.ts
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
const PROJECT_DIR = resolve('output/erik-voorhees-manifesto');

const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height. Wearing a dark rumpled charcoal suit, slightly creased, dark olive shirt underneath, no tie.`;

const CLEAN_DYSTOPIA = {
  style: 'Ultra-sterile white minimalism, THX-1138 meets Black Mirror. Totalitarianism as design perfection.',
  palette: 'Pure white, clinical gray. The man\'s dark charcoal suit is the only contrast.',
  lighting: 'Soft ambient light from everywhere and nowhere -- no visible source, no shadows. Flat, even, inescapable illumination.',
  lens: 'Clean digital, impossibly sharp, symmetric framing, deep focus. 16:9 cinematic widescreen.',
  film: 'Ultra-clean digital -- no grain, no imperfection, no warmth. Clinical and perfect.',
};

interface ShotPlan {
  sceneNumber: number;
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

const allShots: ShotPlan[] = [
  // ========== SCENE 5: EXT. CONCRETE CANYON / CITY STREETS ==========
  // VO: "But if you require permission to spend and to trade, then you require permission to exist."
  // Action: Man walks through monolithic concrete corridors. Citizens in dark coats, downcast eyes.
  // 3 shots, ~13s
  {
    sceneNumber: 5,
    shotNumber: 1,
    imagePrompt: [
      `Wide shot of a man walking through monolithic white concrete corridors in an ultra-sterile cityscape.`,
      `${MAN_DESC}`,
      `He walks forward, the only figure with his head slightly raised. Other CITIZENS pass in both directions -- all in dark coats, all with downcast eyes.`,
      `The corridors are pristine white concrete, impossibly clean. Blue-white light bleeds from unseen sources. Steam rises from white grates in the floor.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `Wide shot, eye-level, 24mm lens. One-point perspective down the corridor. Deep focus.`,
    ].join(' '),
    videoPrompt: `A slow tracking shot follows a man in a dark charcoal suit walking through monolithic white concrete corridors. Other citizens in dark coats pass in both directions, all with downcast eyes. Blue-white light bleeds from unseen sources, steam rises from floor grates. Pristine white walls, flat ambient light, no shadows. Sound of echoing footsteps and distant hum.`,
    videoDuration: '5s',
    cameraMovement: 'tracking, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'But if you require permission to spend and to trade, then you require permission to exist.',
    },
    ambient: 'echoing footsteps, distant hum',
  },
  {
    sceneNumber: 5,
    shotNumber: 2,
    imagePrompt: [
      `Medium shot of citizens walking through a white concrete corridor, all in identical dark coats with downcast eyes.`,
      `Faces are visible but expressionless -- mechanical movement, no eye contact. They pass each other without acknowledgment.`,
      `Blue-white fluorescent light reflects off pristine white walls. Steam wisps curl upward from floor grates.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Medium shot, slightly elevated angle, 35mm lens. Multiple figures in frame, all moving in the same mechanical rhythm.`,
    ].join(' '),
    videoPrompt: `A static medium shot of citizens in dark coats walking through a pristine white corridor, all with downcast eyes, expressionless. They pass each other without acknowledgment in mechanical rhythm. Blue-white light, steam from floor grates. Flat ambient light, no shadows. Sound of shuffling footsteps and a low electronic drone.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: [],
    ambient: 'shuffling footsteps, low electronic drone',
  },
  {
    sceneNumber: 5,
    shotNumber: 3,
    imagePrompt: [
      `Close-up profile of ${MAN_DESC}`,
      `He walks forward with a slight tension in his jaw, eyes focused ahead. The only figure not looking down.`,
      `Behind him, out-of-focus citizens in dark coats flow past like a river of obedience.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up profile, eye-level, 85mm lens. Shallow depth of field -- man sharp, background soft.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot tracks alongside a man's profile as he walks through the white corridor. His jaw set, eyes forward -- the only one not looking down. Behind him, blurred citizens in dark coats flow past. Pristine white walls, flat light. Sound of his breathing and distant footsteps fading.`,
    videoDuration: '3s',
    cameraMovement: 'tracking, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    ambient: 'breathing, distant footsteps fading',
  },

  // ========== SCENE 6: BEAT - 3 SECONDS ==========
  // VO: "So why do we accept this world in which you are free to transact only on the conditional approval of strangers?"
  // Action: Man stops walking. Pedestrians part around him. Buildings converge overhead forming cage.
  // 2 shots, ~8s
  {
    sceneNumber: 6,
    shotNumber: 1,
    imagePrompt: [
      `Wide shot of a man standing still in the center of a white concrete corridor while pedestrians in dark coats flow around him like water around a stone.`,
      `${MAN_DESC}`,
      `He has stopped walking. He looks upward. Citizens continue past without acknowledging him.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Wide shot, eye-level, 24mm lens. The man is centered, pedestrians streaming around him in symmetric flow.`,
    ].join(' '),
    videoPrompt: `A static wide shot of a man in a dark charcoal suit standing frozen in the center of a white corridor while citizens in dark coats flow around him like water around a stone. He looks upward. No one stops. Pristine white walls, flat ambient light, no shadows. Sound of rushing footsteps and wind through a canyon.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'So why do we accept this world in which you are free to transact only on the conditional approval of strangers?',
    },
    ambient: 'rushing footsteps, wind through canyon',
  },
  {
    sceneNumber: 6,
    shotNumber: 2,
    imagePrompt: [
      `Extreme low-angle shot looking straight up from a man's perspective. White concrete buildings converge overhead, their walls angling inward to form a cage of geometry against a flat white sky.`,
      `The buildings are pristine, impossibly tall, their edges converging toward a single vanishing point directly above. A cage made of architecture.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Extreme low angle looking straight up, 14mm ultra-wide lens. Vertigo-inducing convergence.`,
    ].join(' '),
    videoPrompt: `A slow crane shot tilts upward from a man's face to the sky, revealing white concrete buildings converging overhead, their walls angling inward to form a cage of geometry. The buildings close in like a trap. Pristine white surfaces, flat light, no shadows. Sound of distant wind and a low rumble building.`,
    videoDuration: '3s',
    cameraMovement: 'crane, tilting up',
    transition: 'CUT',
    characters: [],
    sfx: 'low rumble building',
    ambient: 'distant wind',
  },

  // ========== SCENE 7: EXT. ALLEY / WALL ==========
  // VO: "This, of course, is not freedom. It is subservience. It is serfdom."
  // Action: Man's shoe steps into frame. His SHADOW is CHAINED to the wall. Iron link from shadow's ankle to rusted bolt.
  // Transition: DISSOLVE TO
  // 3 shots, ~13s
  {
    sceneNumber: 7,
    shotNumber: 1,
    imagePrompt: [
      `Low angle shot of a man's polished dark shoe stepping forward on a pristine white floor.`,
      `Behind the shoe, on a flat white wall, his SHADOW stretches tall and distorted.`,
      `The shadow has a heavy iron chain running from its ankle to a rusted bolt in the white floor. The chain is clearly visible against the white surface.`,
      `The man walks freely but his shadow is anchored, unable to follow.`,
      `${CLEAN_DYSTOPIA.lighting} The only shadow in this world -- and it is imprisoned.`,
      `${CLEAN_DYSTOPIA.film}`,
      `Low angle, 35mm lens. The shoe and chain fill the lower frame, the chained shadow stretches above.`,
    ].join(' '),
    videoPrompt: `A low-angle shot of a polished dark shoe stepping forward on a pristine white floor. Behind it, a man's shadow stretches tall on the white wall -- but the shadow is chained. A heavy iron link runs from the shadow's ankle to a rusted bolt in the ground. The man walks forward, his shadow strains but cannot follow. Flat white environment, clinical light. Sound of a footstep and chain clinking.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'This, of course, is not freedom. It is subservience. It is serfdom.',
    },
    sfx: 'chain clinking, footstep',
  },
  {
    sceneNumber: 7,
    shotNumber: 2,
    imagePrompt: [
      `Close-up of a heavy iron chain attached to a rusted bolt embedded in a pristine white floor.`,
      `The chain stretches upward toward a shadow on the white wall. The links are old and corroded -- the only imperfect objects in this sterile world.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up, low angle, 50mm macro lens. The chain fills the frame, bolt in the foreground, shadow connection above.`,
    ].join(' '),
    videoPrompt: `A slow push-in on a heavy iron chain attached to a rusted bolt in a pristine white floor. The chain stretches upward to a shadow on the wall. Old corroded links -- the only imperfect things in this sterile world. The chain rattles faintly as the shadow strains. Flat white light. Sound of metal creaking under tension.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: [],
    sfx: 'metal creaking under tension',
  },
  {
    sceneNumber: 7,
    shotNumber: 3,
    imagePrompt: [
      `Wide shot of ${MAN_DESC} walking away down a pristine white corridor.`,
      `On the wall behind him, his shadow remains anchored by a chain to a bolt in the floor. The shadow stretches, distorted, reaching after the man but unable to follow.`,
      `The man walks freely into white fog. His shadow stays behind.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Wide shot, eye-level, 24mm lens. Man walking away from camera toward vanishing point, shadow anchored behind.`,
    ].join(' '),
    videoPrompt: `A static wide shot of a man in a dark charcoal suit walking away down a pristine white corridor into fog. On the wall behind him, his shadow remains anchored by a chain to a bolt in the floor, stretching and straining but unable to follow. The man disappears into white. His shadow stays. Flat ambient light. Sound of fading footsteps and a final chain rattle dissolving into silence.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'DISSOLVE',
    characters: ['MAN'],
    sfx: 'chain rattle dissolving into silence',
    ambient: 'fading footsteps',
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
    panelId: `S${shot.sceneNumber}-P${shot.shotNumber}`,
    sceneNumber: shot.sceneNumber,
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
  // Group shots by scene
  const scenes = new Map<number, ShotPlan[]>();
  for (const shot of allShots) {
    if (!scenes.has(shot.sceneNumber)) scenes.set(shot.sceneNumber, []);
    scenes.get(shot.sceneNumber)!.push(shot);
  }

  for (const [sceneNum, shots] of scenes) {
    const sceneDir = join(PROJECT_DIR, `scene-${String(sceneNum).padStart(3, '0')}`);
    if (!existsSync(sceneDir)) mkdirSync(sceneDir, { recursive: true });

    console.log(`\n=== Scene ${sceneNum} (${shots.length} shots) ===`);

    for (const shot of shots) {
      const label = `shot-${String(shot.shotNumber).padStart(3, '0')}`;
      const pngPath = join(sceneDir, `${label}.png`);
      const jsonPath = join(sceneDir, `${label}.video.json`);

      console.log(`[S${sceneNum}-${label}] Generating panel...`);

      try {
        const imageBuffer = await generateImage(shot.imagePrompt);
        writeFileSync(pngPath, imageBuffer);
        console.log(`[S${sceneNum}-${label}] Panel saved (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

        const videoJson = buildVideoJson(shot);
        writeFileSync(jsonPath, JSON.stringify(videoJson, null, 2));
        console.log(`[S${sceneNum}-${label}] Video JSON saved`);
      } catch (err) {
        console.error(`[S${sceneNum}-${label}] FAILED: ${err instanceof Error ? err.message : err}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('\n=== All panels generated ===');
  for (const [sceneNum, shots] of scenes) {
    console.log(`Scene ${sceneNum}: ${shots.length} panels`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
