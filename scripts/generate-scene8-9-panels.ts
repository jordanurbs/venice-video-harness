#!/usr/bin/env npx tsx
/**
 * Generate Scenes 8, 9 panels with BAROQUE OIL PAINTING aesthetic.
 *
 * FIRST AESTHETIC REGISTER SWITCH: from Clean Dystopia (white, sterile)
 * to Baroque Oil Painting (rich amber, Caravaggio chiaroscuro, canvas texture).
 *
 * Scene 8: EXT. OPEN FRONTIER - GOLDEN HOUR (ARCHIVAL / STYLIZED)
 *   - Visual departure: warm tones break the cold palette for the first time
 *   - Vast open landscape, single horseback figure, no fences, no walls
 *   - VO about economic freedom of a hundred years ago
 *
 * Scene 9: BEAT - 2 SECONDS
 *   - Golden landscape holds, wind through tall grass
 *   - Camera PULLS BACK to reveal it's on a cracked screen inside the concrete city
 *   - The warmth was a memory. A projection.
 *   - VO about income tax and keeping what you earned
 *
 * Usage: npx tsx scripts/generate-scene8-9-panels.ts
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

const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height.`;

// BAROQUE OIL PAINTING AESTHETIC
// Rich amber, Caravaggio chiaroscuro, oil canvas texture, visible brushstrokes
const BAROQUE = {
  style: 'Baroque oil painting, museum-quality canvas. Rich and luminous, painted with thick impasto brushstrokes. Caravaggio chiaroscuro with warm golden light.',
  palette: 'Rich amber, burnt sienna, gold leaf highlights, deep umber shadows, warm ochre grass, sepia-gold sky. Oil paint pigment saturation -- thick, vivid, tactile.',
  lighting: 'Single dramatic spotlight from above, Caravaggio chiaroscuro. Deep amber warmth, rich volumetric shadows, light through painted clouds. Golden hour radiance.',
  lens: 'Soft painterly edges, slight vignette, classical composition with golden ratio. Canvas texture visible throughout. 16:9 cinematic widescreen.',
  film: 'Oil on canvas texture, visible thick brushstrokes, craquelure aging, museum-quality surface. Not film at all -- paint. Rembrandt meets John Martin.',
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
  // ========== SCENE 8: EXT. OPEN FRONTIER - GOLDEN HOUR ==========
  // VO: "Laws restricting our affairs grow often and recede only rarely.
  //      Consider that the average man of a hundred years ago, compared to
  //      the average man of today -- who was more economically free?"
  // Action: Visual departure -- warm tones break the cold palette for the first time.
  //         Sepia-gold. Vast open landscape. Single figure on horseback at the horizon line.
  //         No fences. No walls.
  // 3 shots, ~18s
  {
    sceneNumber: 8,
    shotNumber: 1,
    imagePrompt: [
      `A baroque oil painting of a vast open frontier landscape at golden hour.`,
      `Endless rolling grassland stretching to the horizon under a luminous amber sky. Tall golden grass sways in the wind. No fences, no walls, no structures -- pure unbroken freedom.`,
      `In the far distance, a single tiny silhouette of a figure on horseback sits at the horizon line, facing away.`,
      `${BAROQUE.palette}`,
      `${BAROQUE.lighting}`,
      `${BAROQUE.film}`,
      `Wide establishing shot, low horizon line at the lower third. The sky dominates -- vast, golden, infinite. Painted with thick visible brushstrokes on canvas.`,
    ].join(' '),
    videoPrompt: `A slow crane shot rises over a vast open frontier painted in baroque golden tones. Endless grassland stretches to the horizon, tall amber grass swaying in warm wind. A single horseback figure sits as a tiny silhouette at the horizon line. No fences, no walls. Rich oil paint texture, thick brushstrokes, Caravaggio golden light from above. Sound of wind through grass and distant hoofbeats.`,
    videoDuration: '8s',
    cameraMovement: 'crane, rising slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'Laws restricting our affairs grow often and recede only rarely.',
    },
    ambient: 'wind through grass, distant hoofbeats',
  },
  {
    sceneNumber: 8,
    shotNumber: 2,
    imagePrompt: [
      `A baroque oil painting of a solitary horseback rider on an open frontier.`,
      `Medium-wide shot of a figure on a dark horse, silhouetted against a luminous amber sunset sky. The rider wears a weathered coat and hat. Rich sepia-gold tones.`,
      `Behind the rider, the landscape opens in every direction -- no fences, no walls, no borders. Just earth and sky.`,
      `${BAROQUE.palette}`,
      `${BAROQUE.lighting}`,
      `${BAROQUE.film}`,
      `Medium-wide shot, eye-level. The rider centered in the golden ratio. Thick impasto brushstrokes, canvas craquelure texture.`,
    ].join(' '),
    videoPrompt: `A slow push-in on a solitary horseback rider silhouetted against a luminous amber sunset. The horse shifts its weight, tail swaying. The landscape opens in every direction behind -- no fences, no borders. Rich baroque oil paint texture, golden Caravaggio light, thick brushstrokes. Sound of horse breathing and leather creaking.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'Consider that the average man of a hundred years ago, compared to the average man of today -- who was more economically free?',
    },
    ambient: 'horse breathing, leather creaking',
  },
  {
    sceneNumber: 8,
    shotNumber: 3,
    imagePrompt: [
      `A baroque oil painting extreme wide shot of an open frontier at golden hour.`,
      `The horseback rider is now a tiny speck in a vast golden landscape. The emphasis is on the sheer scale of freedom -- the land stretches endlessly in every direction.`,
      `Tall golden grass fills the foreground, bending in warm wind. The sky is a layered amber and gold, painted with sweeping brushstrokes.`,
      `${BAROQUE.palette}`,
      `${BAROQUE.lighting}`,
      `${BAROQUE.film}`,
      `Extreme wide shot, very low angle from grass level. Rider as a dot against infinite sky. Classical landscape composition. Visible canvas texture.`,
    ].join(' '),
    videoPrompt: `A slow pan across an immense golden frontier landscape, the horseback rider a tiny speck against the amber sky. Tall grass sways in the foreground. The scale is overwhelming -- pure freedom made visible. Baroque oil paint texture, warm golden chiaroscuro, thick brushstrokes. Sound of wind and distant birds.`,
    videoDuration: '5s',
    cameraMovement: 'pan, slowly',
    transition: 'CUT',
    characters: [],
    ambient: 'wind, distant birds',
  },

  // ========== SCENE 9: BEAT - 2 SECONDS ==========
  // VO: "A hundred and twenty years ago, there wasn't even an income tax.
  //      Things were so radical back then that you were actually permitted
  //      to keep what you earned."
  // Action: Golden landscape holds. Wind through tall grass.
  //         Camera PULLS BACK to reveal the frontier image is displayed on
  //         a cracked SCREEN inside the concrete city. The warmth was a memory.
  // 3 shots, ~16s (the reveal needs to land)
  {
    sceneNumber: 9,
    shotNumber: 1,
    imagePrompt: [
      `A baroque oil painting close-up of tall golden grass bending in warm wind against a luminous amber sky.`,
      `Rich detail of individual grass stalks painted with thick impasto brushstrokes. Golden light filters through the grass, creating a warm haze.`,
      `Freedom made visible. Warmth, openness, beauty.`,
      `${BAROQUE.palette}`,
      `${BAROQUE.lighting}`,
      `${BAROQUE.film}`,
      `Close-up, low angle from grass level. Shallow depth of field with soft painterly bokeh. Gold leaf highlights on grass tips.`,
    ].join(' '),
    videoPrompt: `A static close-up of tall golden grass swaying gently in warm wind. Amber light filters through the stalks, golden haze. Baroque oil paint texture, thick brushstrokes, warm chiaroscuro. Beautiful, peaceful, free. Sound of wind through grass and a single bird call.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: [],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'A hundred and twenty years ago, there wasn\'t even an income tax.',
    },
    ambient: 'wind through grass, bird call',
  },
  {
    sceneNumber: 9,
    shotNumber: 2,
    imagePrompt: [
      `A dramatic transition image: a golden frontier landscape DISPLAYED ON A CRACKED SCREEN. The image is being viewed on an old, damaged monitor or display panel.`,
      `The beautiful baroque golden landscape from the previous shots is visible on the screen, but now we see the screen's edges -- cracked glass, dead pixels, the frame of the monitor.`,
      `Around the screen edges, the cold concrete of the dystopian city is faintly visible. Sterile white walls surround the warm image. The warmth is contained, framed, imprisoned.`,
      `The golden landscape on the screen is painted in baroque style -- but the surrounding environment is clinical white.`,
      `Medium shot, straight-on view of the screen. The contrast between warm (screen) and cold (surroundings) is stark.`,
    ].join(' '),
    videoPrompt: `A slow dolly-out reveals that the golden frontier landscape is displayed on a cracked screen mounted on a sterile white wall. The warm baroque painting recedes as cold clinical concrete appears around its edges. Dead pixels flicker on the damaged display. The warmth was a memory -- a projection. Sound of the wind fading, replaced by a low electronic hum and fluorescent buzz.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-out, slowly',
    transition: 'CUT',
    characters: [],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'Things were so radical back then that you were actually permitted to keep what you earned.',
    },
    sfx: 'wind fading, electronic hum replacing it',
    ambient: 'fluorescent buzz',
  },
  {
    sceneNumber: 9,
    shotNumber: 3,
    imagePrompt: [
      `Wide shot of ${MAN_DESC} standing in a sterile white concrete corridor, looking at a cracked screen mounted on the wall.`,
      `On the screen, a small golden frontier landscape glows warmly -- the only warm light in the entire frame. Everything else is clinical white, flat ambient light.`,
      `The man stands alone, hands at his sides, gazing at the memory of freedom. His dark charcoal suit is the only dark element besides the screen's frame.`,
      `Ultra-sterile white minimalism surrounds the tiny warm portal of the screen. The contrast is devastating.`,
      `Wide shot, eye-level. Clean digital, sharp, symmetric framing. No shadows except the warm glow from the screen touching the man's face.`,
    ].join(' '),
    videoPrompt: `A static wide shot of a man in a dark charcoal suit standing alone in a sterile white corridor, gazing at a cracked screen showing a golden frontier landscape. The warm glow from the screen touches his face -- the only warmth in the clinical white world. He stands motionless. The warmth was a memory. Flat ambient light, no shadows except the screen's golden glow. Sound of distant fluorescent hum and faint wind from the screen.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    sfx: 'faint wind from screen',
    ambient: 'fluorescent hum',
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
