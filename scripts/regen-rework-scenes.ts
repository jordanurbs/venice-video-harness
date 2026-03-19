#!/usr/bin/env npx tsx
/**
 * Rework key scenes based on creative review:
 *
 * SCENE 1: Zoom out from credit card chip microchip → prison compound → purchase scene
 * SCENE 3-4: Merged into single scene (factory hall, one beat, workers breathing)
 * SCENE 5: Rework with passport/border checkpoint concept (VO: "permission to exist")
 * SCENE 6: Rework with taxation visual (VO: "freedom to transact")
 * SCENE 7: Stronger chained shadow -- the man ALMOST becoming smoke-headed
 * SCENE 9: Add passport/tax era flashback shots to the Baroque register
 * SCENE 11: Rework -- show "unpermissioned growth" vs permissioned stagnation
 * SCENE 15: Mirror/reflection dissolving into smoke-headed figure
 *
 * THEMATIC UPGRADE: Smoke-headed figures = what the system WANTS everyone to become.
 * The man is clinging to life, resisting dissolution into facelessness.
 *
 * Usage: npx tsx scripts/regen-rework-scenes.ts [sceneNumber]
 *   e.g. npx tsx scripts/regen-rework-scenes.ts       (all reworked scenes)
 *   e.g. npx tsx scripts/regen-rework-scenes.ts 1     (scene 1 only)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── ENV ──────────────────────────────────────────────────────────────
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
if (!API_KEY) { console.error('VENICE_API_KEY not found in .env'); process.exit(1); }

const BASE_URL = 'https://api.venice.ai';
const IMAGE_MODEL = 'nano-banana-pro';
const PROJECT_DIR = resolve('output/erik-voorhees-manifesto');

// ── CHARACTER ────────────────────────────────────────────────────────
const MAN_DESC = `A man in his mid-30s, Caucasian, short brown hair slightly disheveled, deep-set hazel eyes with a weary searching quality, strong angular jawline, close-trimmed brown beard, prominent brow, subtle crow's feet. Lean build, average height. Wearing a dark rumpled charcoal suit, slightly creased, dark olive shirt underneath, no tie.`;

// ── AESTHETIC REGISTERS ──────────────────────────────────────────────
const CLEAN_DYSTOPIA = {
  suffix() {
    return 'Soft ambient light from everywhere and nowhere -- no visible source, no shadows. Flat, even, inescapable illumination. Clean digital, impossibly sharp, symmetric framing, deep focus. 16:9 cinematic widescreen. Ultra-clean digital -- no grain, no imperfection, no warmth. Clinical and perfect. Pure white, clinical gray, glass-green tint. No color except rare accent glows.';
  },
};

const BAROQUE = {
  suffix() {
    return 'Single dramatic spotlight from above, Caravaggio chiaroscuro. Deep amber warmth, rich shadows, volumetric light through painted clouds. Soft painterly edges, slight vignette, classical composition with golden ratio. Canvas texture overlay. 16:9 cinematic widescreen. Oil on canvas texture, visible brushstrokes, craquelure aging, museum-quality surface. Rich amber, burnt sienna, gold leaf, deep umber shadows, warm ochre grass.';
  },
};

// ── TYPES ────────────────────────────────────────────────────────────
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

interface ScenePlan {
  sceneNumber: number;
  shots: ShotPlan[];
}

// ══════════════════════════════════════════════════════════════════════
// REWORKED SCENE DEFINITIONS
// ══════════════════════════════════════════════════════════════════════

const scenes: ScenePlan[] = [

  // ── SCENE 1: CHIP → PRISON → PURCHASE ────────────────────────────
  // VO: "Every time you pay with your card, you're being granted permission."
  // Visual: Extreme macro on a credit card chip. Zoom out reveals the chip IS
  // the prison compound. Continue zooming out to reveal the purchase scene.
  {
    sceneNumber: 1,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Extreme macro close-up of a credit card chip. The gold contacts and circuit traces fill the entire frame. At this magnification, the chip's internal geometry looks like a prison compound from above -- partitioned zones, guard-tower-like capacitors, razor-wire-like trace lines. The boundary between microchip and prison architecture is impossible to determine. Ultra-sterile, clinical lighting. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Extreme macro on a gold credit card chip. The circuit traces and contacts fill the frame. At this scale it resembles a prison compound -- partitioned zones, guard tower structures, razor wire traces. The camera very slowly pulls back. Sound of a faint electronic hum.`,
        videoDuration: '8s',
        cameraMovement: 'slow zoom out',
        transition: 'CUT',
        characters: [],
        ambient: 'faint electronic hum',
      },
      {
        shotNumber: 2,
        imagePrompt: `A credit card seen from above, slightly angled on a pristine white surface. The gold chip on the card is visible, and surrounding it the card's surface extends outward. From this intermediate distance, the chip still faintly resembles a miniature prison compound. Tiny gray figures appear to shuffle within the chip's geometry. Tilt-shift miniaturization effect. Ultra-clean white surface. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The camera continues pulling back. The microchip is now visible as part of a credit card lying on a white surface. Tilt-shift effect makes the chip's geometry look like a miniature compound with tiny shuffling figures. The card comes into focus. Sound of distant footsteps and electronic hum building.`,
        videoDuration: '5s',
        cameraMovement: 'continued zoom out',
        transition: 'CUT',
        characters: [],
        ambient: 'electronic hum building',
      },
      {
        shotNumber: 3,
        imagePrompt: `A hand holding a credit card toward a glass-topped card reader. The green APPROVED light glows on the reader. Behind the reader, a faceless figure in gray bureaucratic uniform sits at a glass desk -- its head is a slowly churning cloud of dark smoke, featureless and inhuman. The figure studies the card, deciding. The man's hand (dark charcoal suit sleeve visible) extends the card. Pristine white corridor stretches behind into fog. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The zoom out completes: a hand in a dark charcoal sleeve holds a credit card toward a reader at a glass desk. A smoke-headed faceless figure in gray sits behind the desk, studying the card. The green APPROVED light pulses. The compound-on-a-chip is now just a card in someone's hand. Permission is being requested. Sound of card reader beep, then silence.`,
        videoDuration: '5s',
        cameraMovement: 'final pull-back to medium shot',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: "Every time you pay with your card, you're being granted permission." },
        sfx: 'card reader beep',
      },
    ],
  },

  // ── SCENE 3+4 MERGED: FACTORY HALL (single beat) ─────────────────
  // VO: "And you don't notice because permission is usually granted."
  //     "As long as you behave, citizen, the permission will be there."
  // Visual: Vast hall of workers. But now the workers are MID-TRANSFORMATION --
  // some have wispy smoke beginning to form where their heads should be.
  // The system is turning them into faceless figures. Most don't notice.
  {
    sceneNumber: 3,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A vast white industrial hall. Rows upon rows of workers in gray uniforms sit at white metal desks, heads bowed. Most appear normal -- but in the back rows, some workers' heads are beginning to DISSOLVE into wispy smoke. The transformation is subtle, gradual -- tendrils of dark smoke replacing hair, features blurring. The workers closest to camera look human. Those further away progressively lose their faces to smoke. The system is converting them. Wide shot from the front, deep perspective vanishing point. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of a vast white hall with rows of workers at desks. Heads bowed. In the back rows, workers' heads dissolve into wisps of smoke. The transformation is gradual -- human faces in front, faceless smoke in back. The system is converting them and they don't notice. Sound of synchronized breathing, rhythmic and mechanical.`,
        videoDuration: '8s',
        cameraMovement: 'slow dolly forward',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: "And you don't notice because permission is usually granted." },
        ambient: 'synchronized breathing',
      },
      {
        shotNumber: 2,
        imagePrompt: `Close-up of three workers at adjacent white desks. The worker on the left is fully human -- tired face, eyes down. The worker in the middle has smoke beginning to curl from the top of their head, features slightly blurred. The worker on the right is almost completely smoke-headed -- only a faint chin outline remains. A clock on the white wall behind them ticks. All three breathe in perfect unison. The transition from person to bureaucratic ghost, captured in three bodies side by side. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of three workers side by side. Left: fully human, tired. Middle: smoke beginning to replace their head. Right: nearly all smoke. They breathe in perfect unison. The transformation gradient -- person to ghost -- captured in one frame. A clock ticks on the wall. Sound of breathing and clock ticking.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'As long as you behave, citizen, the permission will be there.' },
        sfx: 'clock ticking',
        ambient: 'synchronized breathing',
      },
    ],
  },

  // ── SCENE 4: DELETE (merged into scene 3 above) ──────────────────
  // We'll mark scene 4 as a single black frame / beat transition
  {
    sceneNumber: 4,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Extreme close-up of smoke tendrils curling upward from where a human head used to be. The collar of a gray uniform is visible below. The smoke is dense and dark, slowly churning. Inside the smoke, for a brief instant, the ghost of a human face is almost visible -- eyes, a mouth -- then it dissolves. The system has completed its work on this one. White background. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Extreme close-up of smoke curling from a gray collar where a head should be. Inside the smoke, a ghost of a human face flickers -- eyes, a mouth -- then dissolves. The conversion is complete. Sound of a low exhale fading into static.`,
        videoDuration: '3s',
        cameraMovement: 'static',
        transition: 'SMASH CUT',
        characters: [],
        sfx: 'exhale fading to static',
      },
    ],
  },

  // ── SCENE 5: BORDER CHECKPOINT / PERMISSION TO EXIST ─────────────
  // VO: "If you require permission to spend and to trade, then you require permission to exist."
  // Visual: A sterile white border checkpoint. Citizens queue in perfect lines.
  // Each holds an identical white passport. Smoke-headed officials stamp and decide.
  {
    sceneNumber: 5,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A vast sterile white border checkpoint. Dozens of citizens in dark coats stand in perfectly ordered queues separated by glass partition walls. Each person holds an identical white passport booklet. At the front of each queue, a smoke-headed figure in gray uniform sits behind a glass desk with a stamp. The queues stretch back into white fog. Overhead, a massive sign reads "PERMISSION" in clean sans-serif type. The citizens' faces show blank compliance. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of a sterile white border checkpoint. Citizens in dark coats queue in perfect lines behind glass partitions, each holding identical white passports. Smoke-headed officials sit at glass desks with stamps. The word PERMISSION hangs overhead. Sound of shuffling feet, stamps hitting paper in rhythm.`,
        videoDuration: '8s',
        cameraMovement: 'slow dolly through the queues',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'But if you require permission to spend and to trade, then you require permission to exist.' },
        sfx: 'rhythmic stamps',
        ambient: 'shuffling feet',
      },
      {
        shotNumber: 2,
        imagePrompt: `Close-up of a smoke-headed official's gray hands holding a white passport open. One hand holds a large rubber stamp poised above it. The passport pages are covered in identical stamps -- rows and rows of "APPROVED" in red. But one page has a single "DENIED" stamp in black, bleeding through the paper. The smoke from the official's head curls down toward the passport, as if it wants to consume the identity within. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of gray featureless hands holding a passport open. Rows of APPROVED stamps in red. One DENIED stamp in black bleeds through the page. Smoke from the official's head curls down toward the document. The identity inside is being consumed. Sound of stamp impact, paper crinkle, smoke hissing.`,
        videoDuration: '5s',
        cameraMovement: 'static close-up',
        transition: 'CUT',
        characters: [],
        sfx: 'stamp impact, smoke hiss',
      },
    ],
  },

  // ── SCENE 6: TAXATION / FREEDOM TO TRANSACT ──────────────────────
  // VO: "So why do we accept this world in which you are free to transact
  //      only on the conditional approval of strangers?"
  // Visual: The man stops walking. Above him, giant pale hands descend from
  // the ceiling in a grid pattern, each hand poised to take. The buildings
  // overhead converge into a cage geometry -- but the bars are HANDS.
  {
    sceneNumber: 6,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Looking upward from ground level. White brutalist buildings converge overhead forming a cage of geometry. But the structural elements bridging the buildings are not beams -- they are ENORMOUS PALE HANDS reaching across the gap, fingers interlocked, forming a ceiling of grasping palms above the street. Dozens of giant institutional hands creating a cage of extraction. A small dark figure (the man) stands below, looking up. The hands are the only non-white element besides the man. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Low angle looking up at white buildings converging overhead. The structures bridging them are enormous pale hands, fingers interlocked, forming a cage-ceiling of grasping palms. A small dark figure stands below looking up. The hands cage the sky. Sound of wind whistling through the hand-cage, a low ominous drone.`,
        videoDuration: '5s',
        cameraMovement: 'slow crane tilt upward',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'So why do we accept this world in which you are free to transact only on the conditional approval of strangers?' },
        ambient: 'wind through cage, ominous drone',
      },
      {
        shotNumber: 2,
        imagePrompt: `The man stands frozen in a white corridor. Citizens in dark coats walk past him in both directions without looking. From the man's suit, thin golden threads are being pulled upward by invisible forces -- his wealth, his labor, his autonomy being extracted strand by strand through the ceiling. The golden threads rise like puppet strings in reverse. He is being drained but the other citizens don't see it because their own threads are being pulled too. Wide shot, symmetric framing. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot. The man stands still while citizens walk past. Thin golden threads are pulled upward from his suit by invisible forces -- wealth extracted strand by strand. Other citizens have threads too but don't notice. The extraction is universal and invisible. Sound of golden threads humming under tension.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'DISSOLVE',
        characters: ['MAN'],
        ambient: 'threads humming under tension',
      },
    ],
  },

  // ── SCENE 7: THE CHAINED SHADOW (REWORKED) ───────────────────────
  // VO: "This, of course, is not freedom. It is subservience. It is serfdom."
  // Visual: The man's shadow is chained, BUT the shadow's head is SMOKE.
  // The shadow is what the system wants him to become. The chain binds
  // his future-self -- the faceless version -- to the ground.
  {
    sceneNumber: 7,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Low angle on a pristine white wall. A man's shadow is cast upon it, but the shadow is WRONG -- the shadow's head is a churning mass of smoke, like the faceless bureaucrats. The shadow is what the system wants him to become. Heavy iron chains run from the shadow's ankles to a rusted bolt in the white floor. The shadow strains against the chains, smoke-head churning. The man himself is NOT in frame -- only his shadow, his potential future as a faceless figure, chained and waiting. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Low angle on a white wall. A man's shadow with a smoke-head is chained to the floor. The shadow is his future -- what the system wants him to become. A faceless, chained figure. The smoke churns where the head should be. The chains are heavy and rusted against pristine white. Sound of chains clinking, smoke churning softly.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'This, of course, is not freedom. It is subservience. It is serfdom.' },
        sfx: 'chains clinking',
        ambient: 'smoke churning',
      },
      {
        shotNumber: 2,
        imagePrompt: `Split composition. On the LEFT side of the frame: the man in his dark charcoal suit, seen in profile, face visible -- human, alive, hazel eyes, stubble, crow's feet. He is warm and real. On the RIGHT side, directly mirroring him, his SHADOW on the white wall -- but the shadow's head is dissolving smoke, its posture is hunched, and heavy chains drag from its ankles. The shadow reaches toward the man as if trying to pull him into its world. The man leans AWAY. Two versions of the same person: one alive, one consumed by the system. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Split frame. Left: the man in profile, face visible, alive, human. Right: his shadow on the wall, smoke-headed, chained, reaching for him. Two versions -- one alive, one consumed. The man leans away from his own shadow. The shadow's smoke-head churns and reaches. Sound of chains dragging, a whispered static where the shadow's voice would be.`,
        videoDuration: '5s',
        cameraMovement: 'slow push-in',
        transition: 'DISSOLVE',
        characters: ['MAN'],
        sfx: 'chains dragging',
        ambient: 'whispered static',
      },
    ],
  },

  // ── SCENE 9: BAROQUE FLASHBACK + PASSPORT/TAX ────────────────────
  // VO: "120 years ago, no income tax... permitted to keep what you earned...
  //      cross borders without a passport."
  // Visual: The golden landscape holds, then specific images:
  //   - A man keeping gold coins (no hand taking them)
  //   - People crossing an open border (no checkpoint, no papers)
  //   Then: pull back reveals the cracked screen in the white city.
  {
    sceneNumber: 9,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Oil painting of a man at a wooden table, placing gold coins into his own leather pouch. The coins glow with warm amber light. NO other hands are present -- no one takes from him. He keeps everything he earns. His expression is calm, dignified. The scene is lit by a single window showing open countryside. Thick brushstrokes, warm ochre palette, Caravaggio chiaroscuro. ${BAROQUE.suffix()}`,
        videoPrompt: `Oil painting of a man placing gold coins into his own pouch. Warm amber light from a window. No hands take from him -- he keeps what he earns. Dignified, calm. Canvas texture, visible brushstrokes. Sound of coins clinking, a warm room, crackling fire.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: "A hundred and twenty years ago, there wasn't even an income tax. Things were so radical back then that you were actually permitted to keep what you earned." },
        sfx: 'coins clinking',
        ambient: 'crackling fire',
      },
      {
        shotNumber: 2,
        imagePrompt: `Oil painting of an open dirt road at a national border. A simple wooden marker on the roadside is the only indication of a boundary. People walk freely across in both directions -- families, merchants with carts, a man on horseback. No checkpoint, no officials, no papers, no passports. The road is unobstructed. Golden afternoon light, rolling countryside on both sides. The border is a concept, not a wall. Thick impasto, canvas craquelure. ${BAROQUE.suffix()}`,
        videoPrompt: `Oil painting of people freely crossing an open border -- just a wooden marker on a dirt road. Families, merchants, horsemen pass without stopping. No checkpoint, no papers, no officials. The border is a concept, not a wall. Golden afternoon light. Sound of cart wheels, conversation, hoofbeats, freedom of movement.`,
        videoDuration: '5s',
        cameraMovement: 'slow pan right',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: "You could even cross borders without one of those adorable books of stamps we call a passport." },
        ambient: 'cart wheels, conversation, hoofbeats',
      },
      {
        shotNumber: 3,
        imagePrompt: `The camera has pulled back: the golden oil painting of the open border is displayed on a cracked, dusty screen mounted on a pristine white wall inside the sterile dystopian corridor. The warm image bleeds at the edges into clinical whiteness. A hairline crack runs diagonally across the screen. Flanking the screen on both sides, glass partition walls of a BORDER CHECKPOINT are visible -- the white dystopia's version of borders. The past and present of border crossing, side by side. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The camera pulls back to reveal the golden painting is on a cracked screen inside a sterile white corridor. The warm open border is just a memory. On either side of the screen, glass partition walls of a modern checkpoint are visible -- the dystopia's version. Freedom was real once, now it's a picture on a broken screen. Sound of the painting's warmth fading into fluorescent buzz.`,
        videoDuration: '8s',
        cameraMovement: 'slow pull-back',
        transition: 'DISSOLVE',
        characters: [],
        ambient: 'warmth fading to fluorescent buzz',
      },
    ],
  },

  // ── SCENE 11: UNPERMISSIONED GROWTH vs PERMISSIONED STAGNATION ───
  // VO: "That society in which labor and capital are unpermissioned
  //      is the society that tends to grow the fastest."
  // Visual: Split -- one side shows vibrant growth, other shows stagnation
  {
    sceneNumber: 11,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A pristine white floor seen from above. On the LEFT half, the polished surface is cracked and a single green plant is pushing through -- a weed, alive, growing WITHOUT permission through the sterile surface. Tiny wildflowers surround it. Life forcing its way through perfection. On the RIGHT half, the floor is immaculate, unmarked, dead. The unauthorized growth is beautiful. The permitted surface is barren. Overhead view, symmetric split composition. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Overhead shot of white floor split in two. Left side: cracks with green plants pushing through, unauthorized life growing. Right side: immaculate, dead perfection. The unpermissioned side grows. The controlled side is barren. Sound of cracking ceramic, tiny plant movement, then silence on the right.`,
        videoDuration: '5s',
        cameraMovement: 'static overhead',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'That society in which labor and capital are unpermissioned is the society that tends to grow the fastest.' },
        sfx: 'cracking ceramic',
      },
    ],
  },

  // ── SCENE 15: MIRROR / DISSOLVING INTO SMOKE ─────────────────────
  // VO: "What excuse do you tell yourself to cope with such embarrassment?"
  // Visual: The man looks into a mirror. His reflection is a smoke-headed
  // figure. He is seeing what he is becoming. The confrontation with self.
  {
    sceneNumber: 15,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A man in a dark charcoal suit stands before a large mirror on a pristine white wall. ${MAN_DESC} He is human, alive, face visible in three-quarter view. But his REFLECTION in the mirror is a smoke-headed figure -- same charcoal suit, same posture, but where his face should be reflected there is only churning dark smoke. The reflection is what the system sees when it looks at him. The reflection is what he is becoming. The man stares at his smoke-headed double. The green neon word "OPEN" glows faintly in the mirror's background. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A man in a dark suit stands before a mirror. He is human, alive. But his reflection is smoke-headed -- same suit, same posture, face replaced by churning darkness. He stares at what the system wants him to become. The reflection stares back with no eyes. A faint green OPEN sign glows in the mirror. Sound of static where a heartbeat should be.`,
        videoDuration: '5s',
        cameraMovement: 'slow push-in toward mirror',
        transition: 'CUT TO BLACK',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'What excuse do you tell yourself to cope with such embarrassment?' },
        sfx: 'static replacing heartbeat',
      },
      {
        shotNumber: 2,
        imagePrompt: `Extreme close-up of the mirror surface. The man's real hand presses against the glass from one side. From the other side, the reflection's hand presses back -- but the reflection's hand is beginning to dissolve into smoke at the fingertips. Dark tendrils of smoke seep through the glass surface around the hand, reaching toward the real hand. The mirror is the boundary between human and faceless. The smoke is trying to cross over. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Extreme close-up of a hand pressing against mirror glass. On the other side, the reflection's hand presses back but its fingers dissolve into smoke. Dark tendrils seep through the glass reaching for the real hand. The boundary between human and faceless. Sound of glass vibrating, smoke hissing through cracks.`,
        videoDuration: '3s',
        cameraMovement: 'static extreme close-up',
        transition: 'CUT TO BLACK',
        characters: ['MAN'],
        sfx: 'glass vibrating, smoke hissing',
      },
    ],
  },
];

// ── IMAGE GENERATION ─────────────────────────────────────────────────
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

// ── VIDEO JSON BUILDER ───────────────────────────────────────────────
function buildVideoJson(sceneNumber: number, shot: ShotPlan) {
  return {
    panelId: `S${sceneNumber}-P${shot.shotNumber}`,
    sceneNumber,
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

// ── BACKUP + CLEAN ───────────────────────────────────────────────────
function prepareSceneDir(sceneDir: string) {
  mkdirSync(sceneDir, { recursive: true });
  if (!existsSync(sceneDir)) return;
  const files = readdirSync(sceneDir);
  for (const f of files) {
    // Backup old video.json files
    if (f.match(/^shot-\d+\.video\.json$/) && !f.endsWith('.bak')) {
      try { renameSync(join(sceneDir, f), join(sceneDir, f + '.bak')); } catch {}
    }
    // Backup old PNGs (rename to .old.png so they don't get picked up)
    if (f.match(/^shot-\d+\.png$/)) {
      try { renameSync(join(sceneDir, f), join(sceneDir, f.replace('.png', '.old.png'))); } catch {}
    }
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const targetScene = args[0] ? parseInt(args[0]) : null;

  const filteredScenes = targetScene
    ? scenes.filter(s => s.sceneNumber === targetScene)
    : scenes;

  if (filteredScenes.length === 0) {
    console.error(`No scene ${targetScene} found in rework definitions.`);
    console.error(`Available: ${scenes.map(s => s.sceneNumber).join(', ')}`);
    process.exit(1);
  }

  const totalShots = filteredScenes.reduce((sum, s) => sum + s.shots.length, 0);
  console.log(`\nReworking ${filteredScenes.length} scenes (${totalShots} shots)`);
  console.log(`Scenes: ${filteredScenes.map(s => s.sceneNumber).join(', ')}\n`);

  let shotsDone = 0;

  for (const scene of filteredScenes) {
    const sceneDir = join(PROJECT_DIR, `scene-${String(scene.sceneNumber).padStart(3, '0')}`);
    prepareSceneDir(sceneDir);

    console.log(`── Scene ${scene.sceneNumber} (${scene.shots.length} shots) ──`);

    for (const shot of scene.shots) {
      const label = `shot-${String(shot.shotNumber).padStart(3, '0')}`;
      const pngPath = join(sceneDir, `${label}.png`);
      const jsonPath = join(sceneDir, `${label}.video.json`);

      shotsDone++;
      console.log(`  [${label}] (${shotsDone}/${totalShots}) Generating...`);

      try {
        const imageBuffer = await generateImage(shot.imagePrompt);
        writeFileSync(pngPath, imageBuffer);
        console.log(`  [${label}] Panel saved (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

        const videoJson = buildVideoJson(scene.sceneNumber, shot);
        writeFileSync(jsonPath, JSON.stringify(videoJson, null, 2));
        console.log(`  [${label}] Video JSON saved`);
      } catch (err) {
        console.error(`  [${label}] FAILED: ${err instanceof Error ? err.message : err}`);
      }

      await new Promise(r => setTimeout(r, 600));
    }

    console.log();
  }

  console.log(`Done! Reworked ${shotsDone} shots across ${filteredScenes.length} scenes.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
