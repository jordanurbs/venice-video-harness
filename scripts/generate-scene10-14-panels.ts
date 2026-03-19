#!/usr/bin/env npx tsx
/**
 * Generate Scenes 10-14 panels with Clean Dystopia aesthetic.
 *
 * Scene 10: INT. SURVEILLANCE CORRIDOR - CONTINUOUS
 *   - Return to corridor, desks MULTIPLIED infinitely, rubber stamps rise/fall
 *   - VO about America's greatest growth period
 *
 * Scene 11: EXT. CONCRETE CANYON - CONTINUOUS
 *   - Man walks, footsteps leave no mark, ground polished by millions
 *   - VO about unpermissioned labor and capital
 *
 * Scene 12: BEAT - 1 SECOND
 *   - HAND reaches from above, takes from man's pocket. He doesn't flinch.
 *   - VO: "But some men love to plunder."
 *
 * Scene 13: EXT. ALLEY / WALL - NIGHT
 *   - Return to chained shadow. CLOSE ON chain -- another link added, and another.
 *   - VO about half your money stolen by the state
 *
 * Scene 14: BEAT - 2 SECONDS
 *   - Chain multiplies. Shadow sags under its weight.
 *   - VO about strangers stealing half your money
 *
 * Usage: npx tsx scripts/generate-scene10-14-panels.ts
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

const FACELESS_DESC = `Faceless figures -- their heads are swirls of dark smoke, their bodies in bureaucratic gray suits. No faces, no eyes, just smoke where a head should be.`;

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
  // ========== SCENE 10: INT. SURVEILLANCE CORRIDOR - CONTINUOUS ==========
  // VO: "It's amazing that society could even exist under that kind of anarchy.
  //      And yet, without any income tax or immigration restrictions, America
  //      experienced the greatest period of growth that the world had ever seen."
  // Action: Back in corridor from Scene 2, but desks MULTIPLIED -- infinite.
  //         Every station occupied by faceless figure. Rubber stamps rise and fall.
  // 2 shots, ~10s
  {
    sceneNumber: 10,
    shotNumber: 1,
    imagePrompt: [
      `Wide shot of an endless white corridor lined with identical glass desks stretching to infinity.`,
      `At every desk sits a ${FACELESS_DESC}`,
      `The desks are multiplied beyond counting -- rows upon rows receding into a white vanishing point. Rubber stamps sit on every desk.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film}`,
      `${CLEAN_DYSTOPIA.palette}`,
      `Wide shot, one-point perspective, 24mm lens. Symmetric framing. Infinite repetition.`,
    ].join(' '),
    videoPrompt: `A slow dolly shot pushes forward through an infinite white corridor of identical glass desks. At every desk, a faceless figure with a smoke-swirl head stamps papers in mechanical rhythm. Rubber stamps rise and fall in unison. The desks stretch to a white vanishing point. Flat ambient light, no shadows. Sound of rhythmic stamping and a low bureaucratic hum.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: [],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'It\'s amazing that society could even exist under that kind of anarchy.',
    },
    sfx: 'rhythmic stamping',
    ambient: 'low bureaucratic hum',
  },
  {
    sceneNumber: 10,
    shotNumber: 2,
    imagePrompt: [
      `Close-up of a glass desk surface in a sterile white corridor. A rubber stamp comes down firmly on a white document, leaving a red "APPROVED" mark.`,
      `A ${FACELESS_DESC} -- only its smoke-swirl head and gray-suited arm visible -- operates the stamp with mechanical precision.`,
      `Other stamps can be seen rising and falling at adjacent desks in the background, all in identical rhythm.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up, slightly elevated angle, 50mm lens. The stamp impact fills the frame.`,
    ].join(' '),
    videoPrompt: `A static close-up of a rubber stamp coming down on a white document with mechanical precision. A smoke-headed figure in gray stamps with rhythmic regularity. In the background, identical stamps rise and fall in unison at dozens of desks. Pristine white surfaces. Sound of stamps hitting paper in rhythm, like a heartbeat.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: [],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'And yet, without any income tax or immigration restrictions, America experienced the greatest period of growth that the world had ever seen.',
    },
    sfx: 'stamps hitting paper rhythmically',
  },

  // ========== SCENE 11: EXT. CONCRETE CANYON - CONTINUOUS ==========
  // VO: "That society in which labor and capital are unpermissioned is the
  //      society that tends to grow the fastest."
  // Action: Man walks. Footsteps leave NO MARK. Ground polished smooth by millions.
  // 2 shots, ~8s
  {
    sceneNumber: 11,
    shotNumber: 1,
    imagePrompt: [
      `Low-angle shot of ${MAN_DESC} walking through a pristine white concrete corridor.`,
      `His feet step on a perfectly polished white floor -- impossibly smooth, worn by millions of identical footsteps before him. His shoes leave absolutely no mark, no scuff, no trace.`,
      `The floor is a mirror-smooth white surface reflecting flat ambient light. Other citizens in dark coats walk ahead, their footsteps equally invisible.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Low angle, 35mm lens. Focus on the feet meeting the polished floor. No marks, no traces.`,
    ].join(' '),
    videoPrompt: `A low-angle tracking shot follows a man's feet as he walks along a mirror-smooth white floor. His shoes touch down and lift, leaving absolutely no mark. The floor is polished by millions of identical steps. Pristine white corridor stretches ahead. Flat ambient light. Sound of muted footsteps on glass-smooth surface.`,
    videoDuration: '5s',
    cameraMovement: 'tracking, low angle',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'That society in which labor and capital are unpermissioned is the society that tends to grow the fastest.',
    },
    ambient: 'muted footsteps on smooth surface',
  },
  {
    sceneNumber: 11,
    shotNumber: 2,
    imagePrompt: [
      `Extreme wide shot of ${MAN_DESC} walking alone through a vast white concrete canyon.`,
      `He is a small dark figure in an enormous white space. The floor stretches in all directions, mirror-smooth. No footprints anywhere. No marks. No evidence anyone has ever walked here before, despite millions having done so.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.lens}`,
      `${CLEAN_DYSTOPIA.film} ${CLEAN_DYSTOPIA.palette}`,
      `Extreme wide shot, eye-level. The man tiny in the center of vast white. Symmetric framing.`,
    ].join(' '),
    videoPrompt: `A static extreme wide shot of a man in a dark charcoal suit walking alone through a vast white concrete canyon. He is tiny in the frame. The floor is mirror-smooth -- no footprints anywhere, no evidence of passage. Pristine, empty, enormous. Flat ambient light. Sound of a single set of footsteps echoing in vast space.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    ambient: 'single footsteps echoing in vast space',
  },

  // ========== SCENE 12: BEAT - 1 SECOND ==========
  // VO: "But some men love to plunder." + "The permission to keep what you
  //      earned and to move freely across borders was gradually retracted."
  // Action: A HAND reaches from above, takes something from man's pocket. He doesn't flinch.
  // 2 shots, ~8s
  {
    sceneNumber: 12,
    shotNumber: 1,
    imagePrompt: [
      `Medium shot of ${MAN_DESC} walking forward in a sterile white corridor.`,
      `A disembodied HAND in a gray bureaucratic sleeve reaches into frame from above, reaching into the man's coat pocket. The hand is extracting something -- a wallet, a document, something of value.`,
      `The man does NOT react. His expression is unchanged. He doesn't flinch, doesn't look up. He is used to this.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Medium shot, slightly elevated angle. The reaching hand is prominent in the upper frame, the man's passive face below.`,
    ].join(' '),
    videoPrompt: `A medium shot of a man walking forward as a disembodied hand in a gray sleeve reaches down from above into his coat pocket, extracting something. The man does not flinch, does not react. He is used to it. He keeps walking. Sterile white corridor, flat ambient light. Sound of fabric rustling and the man's steady footsteps.`,
    videoDuration: '5s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'But some men love to plunder.',
    },
    sfx: 'fabric rustling',
  },
  {
    sceneNumber: 12,
    shotNumber: 2,
    imagePrompt: [
      `Close-up of a man's coat pocket as a gray-sleeved hand withdraws from it, holding folded paper money. The hand retracts upward out of frame.`,
      `The man continues walking, his pocket now emptied. His expression visible in profile -- indifferent, resigned, accustomed.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up, eye-level, 85mm lens. Focus on the hand and pocket.`,
    ].join(' '),
    videoPrompt: `A close-up of a gray-sleeved hand withdrawing from a man's coat pocket, clutching folded paper money. The hand retracts upward and disappears. The man walks on, expression unchanged. Sterile white background. Sound of paper crinkling and steady footsteps continuing.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'The permission to keep what you earned and to move freely across borders was gradually retracted.',
    },
    sfx: 'paper crinkling',
  },

  // ========== SCENE 13: EXT. ALLEY / WALL - NIGHT ==========
  // VO: "Today, across all the taxes that you bear, half of your money is
  //      stolen by the state."
  // Action: Return to chained shadow. CLOSE ON chain -- another link added, and another.
  // 2 shots, ~8s
  {
    sceneNumber: 13,
    shotNumber: 1,
    imagePrompt: [
      `Close-up of a heavy iron chain attached to a rusted bolt in a pristine white floor, same as Scene 7 but now with MORE LINKS.`,
      `The chain is thicker, heavier. New links are being added -- we can see freshly forged iron links appearing at the end of the chain, extending it further.`,
      `Above the chain, a man's shadow on the white wall sags lower under the increased weight.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up, low angle, 50mm lens. The chain fills the frame with its growing weight.`,
    ].join(' '),
    videoPrompt: `A slow push-in on a heavy iron chain growing heavier. New links appear -- forged from nothing, adding to the chain's weight. The shadow above sags lower. The bolt in the pristine white floor groans under increasing burden. Sound of metal clinking and grinding as new links form.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'Today, across all the taxes that you bear, half of your money is stolen by the state.',
    },
    sfx: 'metal clinking and grinding',
  },
  {
    sceneNumber: 13,
    shotNumber: 2,
    imagePrompt: [
      `Wide shot showing the chained shadow from Scene 7, but now the chain is much heavier and longer.`,
      `The shadow on the white wall is visibly weighed down, hunched, barely standing under the burden of the multiplied chain. Links pile at its feet.`,
      `The man walks freely ahead in the distance, but the shadow strains and sags.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film} ${CLEAN_DYSTOPIA.palette}`,
      `Wide shot, eye-level. Shadow prominent on the left wall, man distant on the right.`,
    ].join(' '),
    videoPrompt: `A static wide shot of a man's shadow chained to a white wall, the chain now much heavier than before. The shadow hunches under the weight, barely standing. Links pile at its base. In the distance, the man walks freely, unaware. Flat ambient light. Sound of chain weight creaking and the shadow straining.`,
    videoDuration: '3s',
    cameraMovement: 'static',
    transition: 'CUT',
    characters: ['MAN'],
    sfx: 'chain weight creaking',
  },

  // ========== SCENE 14: BEAT - 2 SECONDS ==========
  // VO: "But the state is just a set of strangers. So half of your money
  //      is stolen by a set of strangers."
  // Action: Chain multiplies. Shadow sags under its weight.
  // 1 shot, ~5s (tight beat)
  {
    sceneNumber: 14,
    shotNumber: 1,
    imagePrompt: [
      `Close-up of a man's shadow on a pristine white wall, now almost CRUSHED under the weight of multiple heavy chains.`,
      `The chains have multiplied -- three, four, five chains now bind the shadow to the floor. The shadow is bent, sagging, almost on its knees.`,
      `The weight is visible, tangible. The shadow that was once tall and upright in Scene 7 is now broken by accumulation.`,
      `${CLEAN_DYSTOPIA.lighting} ${CLEAN_DYSTOPIA.film}`,
      `Close-up, eye-level. The burdened shadow fills the frame, chains radiating downward like a web.`,
    ].join(' '),
    videoPrompt: `A slow push-in on a shadow almost crushed under multiplied chains. Five heavy chains now bind it to the pristine white floor. The shadow sags, nearly kneeling under the accumulated weight. Links clink and groan. The shadow strains but cannot rise. Flat white light. Sound of chains grinding and a low, oppressive rumble.`,
    videoDuration: '5s',
    cameraMovement: 'dolly-in, slowly',
    transition: 'CUT',
    characters: ['MAN'],
    dialogue: {
      character: 'MAN (V.O.)',
      line: 'But the state is just a set of strangers. So half of your money is stolen by a set of strangers.',
    },
    sfx: 'chains grinding, low oppressive rumble',
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
