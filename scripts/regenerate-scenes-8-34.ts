#!/usr/bin/env npx tsx
/**
 * Regenerate Scenes 8-34 with concept-driven imagery.
 *
 * The narrator speaks about abstract concepts -- permission, serfdom, plunder,
 * rebellion, freedom. The visuals must ILLUSTRATE those ideas, not just show
 * a man walking through corridors.
 *
 * Three visual registers:
 *   CLEAN DYSTOPIA (scenes 10-15, 17-28): Sterile white, THX-1138
 *   BAROQUE (scenes 8-9): Oil painting, golden, Hudson River School
 *   WARM ANALOG (scenes 29-32): Kodak Ektachrome, golden hour, real light
 *   END CARDS (scenes 33-34): White text on black
 *
 * Usage: npx tsx scripts/regenerate-scenes-8-34.ts [startScene] [endScene]
 *   e.g. npx tsx scripts/regenerate-scenes-8-34.ts         (all 8-34)
 *   e.g. npx tsx scripts/regenerate-scenes-8-34.ts 12 15   (scenes 12-15 only)
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
  style: 'Ultra-sterile white minimalism, THX-1138 meets Black Mirror. Totalitarianism as design perfection.',
  palette: 'Pure white, clinical gray, glass-green tint. No color except rare accent glows.',
  lighting: 'Soft ambient light from everywhere and nowhere -- no visible source, no shadows. Flat, even, inescapable illumination.',
  lens: 'Clean digital, impossibly sharp, symmetric framing, deep focus. 16:9 cinematic widescreen.',
  film: 'Ultra-clean digital -- no grain, no imperfection, no warmth. Clinical and perfect.',
  suffix() { return `${this.lighting} ${this.lens} ${this.film} ${this.palette}`; },
};

const BAROQUE = {
  style: 'Classical Hudson River School meets Caravaggio. The past as a masterpiece.',
  palette: 'Rich amber, burnt sienna, gold leaf, deep umber shadows, warm ochre grass. Oil paint pigment saturation.',
  lighting: 'Single dramatic spotlight from above, Caravaggio chiaroscuro. Deep amber warmth, rich shadows, volumetric light through painted clouds.',
  lens: 'Soft painterly edges, slight vignette, classical composition with golden ratio. Canvas texture overlay. 16:9 cinematic widescreen.',
  film: 'Oil on canvas texture, visible brushstrokes, craquelure aging, museum-quality surface.',
  suffix() { return `${this.lighting} ${this.lens} ${this.film} ${this.palette}`; },
};

const WARM_ANALOG = {
  style: 'Real golden light, not memory. Kodak Ektachrome warmth, freedom made tangible.',
  palette: 'Golden hour amber, soft peach sky, warm sepia undertones, faded Ektachrome color shift.',
  lighting: 'Natural golden hour sunlight, soft and directional. Gentle lens flare, warm rim light.',
  lens: 'Vintage lens character, soft focus edges, gentle barrel distortion, shallow depth of field. 16:9 cinematic widescreen.',
  film: 'Kodak Ektachrome 64T pushed warm, gentle grain structure, slightly faded like a photograph left in sunlight.',
  suffix() { return `${this.lighting} ${this.lens} ${this.film} ${this.palette}`; },
};

// ── SHOT INTERFACE ───────────────────────────────────────────────────
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
// SCENE DEFINITIONS -- concept-driven, visually illustrating narration
// ══════════════════════════════════════════════════════════════════════

const scenes: ScenePlan[] = [

  // ── SCENE 8: OPEN FRONTIER (BAROQUE) ─────────────────────────────
  // VO: "Laws restricting our affairs grow often and recede only rarely.
  //      Consider that the average man of a hundred years ago... who was more economically free?"
  // Visual: Warm tones break the cold palette. Vast open landscape. Freedom of the past.
  {
    sceneNumber: 8,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A vast open frontier landscape painted in the style of a Hudson River School oil painting. Endless rolling grasslands under a towering golden sky, no fences, no walls, no roads. A single figure on horseback at the distant horizon line, tiny against the immensity of untamed land. Thick visible brushstrokes, rich impasto texture, gilt-frame energy. ${BAROQUE.suffix()}`,
        videoPrompt: `A slow pan across a vast frontier landscape painted in oil. Endless grasslands under golden sky, a lone horseman at the horizon. Wind stirs the tall grass. Thick brushstrokes visible, canvas texture, warm amber light. Sound of wind through open plains and distant hoofbeats.`,
        videoDuration: '8s',
        cameraMovement: 'slow pan right',
        transition: 'DISSOLVE',
        characters: [],
        ambient: 'wind through plains, distant hoofbeats',
      },
      {
        shotNumber: 2,
        imagePrompt: `Oil painting of an old-world open market. Merchants and farmers trade freely at wooden stalls under golden sunlight. No uniforms, no officials, no barriers. Piles of grain, handshake transactions, children running between stalls. Caravaggio chiaroscuro lighting, rich amber tones, visible brushstrokes on canvas. ${BAROQUE.suffix()}`,
        videoPrompt: `A tracking shot through an old-world open market rendered as oil painting. Merchants trade freely, no officials visible. Golden chiaroscuro light, rich amber, visible brushstrokes. Sound of bustling trade, laughter, wooden carts.`,
        videoDuration: '5s',
        cameraMovement: 'tracking right',
        transition: 'CUT',
        characters: [],
        ambient: 'bustling market sounds',
      },
      {
        shotNumber: 3,
        imagePrompt: `Oil painting closeup of two hands shaking over a wooden table -- a simple handshake deal. No paperwork, no stamps, no card readers. Golden light illuminates the hands from above. The wood grain is richly textured. Behind them, an open doorway reveals endless countryside. Caravaggio lighting, canvas craquelure. ${BAROQUE.suffix()}`,
        videoPrompt: `A static close-up of two hands completing a handshake over a wooden table. No paperwork, no stamps. Golden Caravaggio light from above. Oil paint texture, visible brushstrokes. Sound of a quiet room, distant birdsong through an open window.`,
        videoDuration: '3s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        ambient: 'quiet room, birdsong',
      },
    ],
  },

  // ── SCENE 9: BEAT (BAROQUE → DYSTOPIA) ───────────────────────────
  // VO: "120 years ago, no income tax. You were permitted to keep what you earned.
  //      You could cross borders without a passport."
  // Visual: The golden landscape is revealed as a projection on a cracked screen inside the white city.
  {
    sceneNumber: 9,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Oil painting of a vast open frontier at golden hour. Tall grass swaying in wind, infinite horizon, no borders or fences visible. A single dirt road leads to the vanishing point. Freedom made visible as landscape. Thick impasto brushstrokes, warm ochre and amber. ${BAROQUE.suffix()}`,
        videoPrompt: `Wind moves through tall golden grass in an oil painting landscape. A dirt road stretches to the infinite horizon. No fences, no walls. Warm amber light, painterly texture. Sound of wind and rustling grass.`,
        videoDuration: '5s',
        cameraMovement: 'static, wind movement',
        transition: 'CUT',
        characters: [],
        ambient: 'wind, rustling grass',
      },
      {
        shotNumber: 2,
        imagePrompt: `The camera has pulled back: the golden frontier oil painting is actually displayed on a cracked, dusty screen mounted on a pristine white wall. The warm image bleeds at the edges into the sterile white corridor surrounding it. A hairline crack runs diagonally across the screen. The contrast is devastating -- warmth trapped inside coldness. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The camera slowly pulls back to reveal the golden frontier is a projection on a cracked screen inside a sterile white corridor. The warmth bleeds at the edges into clinical whiteness. A hairline crack runs across the display. The past was always just a memory here. Sound of a faint electrical buzz replacing wind.`,
        videoDuration: '8s',
        cameraMovement: 'slow pull-back',
        transition: 'DISSOLVE',
        characters: [],
        ambient: 'electrical buzz',
      },
    ],
  },

  // ── SCENE 10: SURVEILLANCE CORRIDOR (CLEAN DYSTOPIA) ─────────────
  // VO: "America experienced the greatest period of growth the world had ever seen."
  // Visual: Infinite desks, rubber stamps in mechanical rhythm. Bureaucracy as machine.
  {
    sceneNumber: 10,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `An infinite corridor of identical glass desks stretching to a vanishing point in white fog. At every desk sits a faceless figure in gray -- heads made of slowly churning dark smoke. Rubber stamps mid-air, frozen in the act of descending. Hundreds of desks in perfect geometric rows. The scale is overwhelming, bureaucratic, mechanical. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A slow dolly forward through an infinite corridor of glass desks. At each desk a faceless smoke-headed figure stamps documents in mechanical rhythm. Rubber stamps rise and fall in perfect synchronization. Hundreds of desks stretching into white fog. Sound of rhythmic stamping, like a heartbeat.`,
        videoDuration: '8s',
        cameraMovement: 'slow dolly forward',
        transition: 'CUT',
        characters: [],
        ambient: 'rhythmic rubber stamps',
      },
      {
        shotNumber: 2,
        imagePrompt: `Extreme close-up of a rubber stamp pressing down onto white paper, leaving a red "APPROVED" mark. Beside it, a stack of identical papers stretches upward out of frame. The stamp is held by a gray hand with no fingerprints -- smooth, featureless skin. Everything pristine white except the red ink. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of a featureless gray hand pressing a rubber stamp onto paper. Red APPROVED mark appears. The hand lifts, moves to the next page. Mechanical, inhuman rhythm. Stack of papers stretches infinitely upward. Sound of stamp impact, paper shuffle.`,
        videoDuration: '3s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        sfx: 'stamp impact',
      },
    ],
  },

  // ── SCENE 11: CONCRETE CANYON (CLEAN DYSTOPIA) ───────────────────
  // VO: "That society in which labor and capital are unpermissioned is the society that tends to grow the fastest."
  // Visual: Footsteps that leave no mark. Ground polished smooth by millions of steps.
  {
    sceneNumber: 11,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Looking down at a pristine white floor from above. Dozens of identical shoe prints are visible as faint ghostly impressions, layered on top of each other -- millions of identical steps have polished the surface mirror-smooth. The floor reflects everything. No individual footprint survives. Overhead view, symmetric, clinical. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Overhead shot looking down at a mirror-smooth white floor. Ghostly impressions of millions of identical footsteps are layered into the surface. No single print survives. Slow push-in reveals the depth of the polished erosion. Sound of echoing footsteps, overlapping into a constant murmur.`,
        videoDuration: '5s',
        cameraMovement: 'overhead push-in',
        transition: 'CUT',
        characters: [],
        ambient: 'overlapping echoing footsteps',
      },
      {
        shotNumber: 2,
        imagePrompt: `A single dark shoe (charcoal suit trouser visible above) stepping onto a pristine white floor. Where the shoe lifts, NO mark is left -- the floor is impossibly smooth and untouched. Behind the shoe, identical citizens in dark coats walk in the same direction, their steps equally traceless. Wide shot, symmetrically framed corridor. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A dark shoe steps forward on pristine white floor and lifts -- no mark left behind. The floor remains immaculate. Behind, identical citizens walk in formation, all equally traceless. Clinical white corridor, flat light. Sound of footsteps on tile, no echo -- absorbed by the walls.`,
        videoDuration: '5s',
        cameraMovement: 'low angle tracking',
        transition: 'CUT',
        characters: ['MAN'],
        ambient: 'muffled footsteps',
      },
    ],
  },

  // ── SCENE 12: BEAT (CLEAN DYSTOPIA) ──────────────────────────────
  // VO: "But some men love to plunder."
  //     "The permission to keep what you earned and to move freely was gradually retracted."
  // Visual: A hand reaches from above, takes from a man's pocket. He doesn't flinch.
  {
    sceneNumber: 12,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A large pale hand descends from the top of the frame, reaching into the breast pocket of a dark charcoal suit. The hand is smooth, institutional, featureless -- no rings, no fingerprints, inhuman. It extracts a small glowing golden object (representing earned wealth). The man wearing the suit does not react. Medium shot, front view, white background. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A large pale featureless hand reaches down from above into the breast pocket of a dark suit. It slowly extracts a small glowing golden object. The man wearing the suit stands motionless -- he doesn't flinch. The hand withdraws upward out of frame. Clinical white background. Sound of fabric rustling, then silence.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'But some men love to plunder.' },
        sfx: 'fabric rustling',
      },
      {
        shotNumber: 2,
        imagePrompt: `Multiple pale hands now -- three, five, seven hands reaching from above, from the sides, all extracting small golden objects from a man's pockets, his cuffs, his collar. His dark charcoal suit is being systematically emptied. His expression is blank, resigned. He has been conditioned not to resist. White featureless background. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Multiple pale featureless hands reach from every direction, extracting golden objects from a man's suit pockets, cuffs, collar. He stands motionless, face blank with resignation. The hands multiply -- three, five, seven. The plundering is systematic and normalized. Sound of quiet extraction, like pickpocketing elevated to institution.`,
        videoDuration: '5s',
        cameraMovement: 'slow push-in',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'The permission to keep what you earned and to move freely across borders was gradually retracted.' },
      },
    ],
  },

  // ── SCENE 13: CHAINED SHADOW (CLEAN DYSTOPIA) ───────────────────
  // VO: "Today, across all the taxes that you bear, half of your money is stolen by the state."
  // Visual: Return to the chained shadow. More links added.
  {
    sceneNumber: 13,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Close-up of a heavy iron chain bolted to a pristine white floor. The chain stretches upward toward a shadow cast on the white wall -- a man's shadow, weighed down and distorted by the chain's pull. New links are being added to the chain -- they appear to materialize from the white wall itself, growing like crystalline formations. The chain is already thick and heavy. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of a heavy iron chain on pristine white floor. New links materialize from the wall, growing like crystals, adding weight. The chain stretches upward to a man's shadow on the wall, pulling it downward. The shadow strains. Sound of metallic clinks, chain links forming.`,
        videoDuration: '5s',
        cameraMovement: 'slow tilt up along chain',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'Today, across all the taxes that you bear, half of your money is stolen by the state.' },
        sfx: 'metallic clinks, chain growing',
      },
      {
        shotNumber: 2,
        imagePrompt: `Wide shot of a pristine white wall. A man's shadow is cast upon it, but the shadow is bowed, hunched, dragged downward by heavy chains that run from its ankles to a bolt in the floor. The real man is NOT visible -- only his shadow exists in this frame. The shadow appears to be straining against the weight. The wall is perfectly clean except for this one tormented silhouette. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of a clean white wall with a man's shadow bowed under heavy chains. The shadow strains against the weight. No person visible -- only the shadow exists. The chains multiply slowly, dragging the shadow lower. Sound of straining metal, slow grinding.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        ambient: 'straining metal',
      },
    ],
  },

  // ── SCENE 14: BEAT (CLEAN DYSTOPIA) ──────────────────────────────
  // VO: "The state is just a set of strangers. Half of your money is stolen by a set of strangers."
  // Visual: Chain multiplies. Shadow sags.
  {
    sceneNumber: 14,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `The shadow on the white wall is now nearly crushed to the ground. Chains have multiplied -- dozens of thick links running in every direction, pinning the shadow flat. The shadow's form is barely recognizable as human. It has become a dark stain beneath the weight of iron. Pristine white everywhere except this one defeated silhouette. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The shadow on the white wall sags under multiplying chains. Links grow in real time, pinning the silhouette flatter and flatter. The human form is barely recognizable beneath the iron. Sound of chains dragging, the shadow's form compressing.`,
        videoDuration: '5s',
        cameraMovement: 'slow push-in',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'But the state is just a set of strangers. So half of your money is stolen by a set of strangers.' },
        sfx: 'chains dragging',
      },
    ],
  },

  // ── SCENE 15: BRUTALIST CITYSCAPE (CLEAN DYSTOPIA) ───────────────
  // VO: "What excuse do you tell yourself to cope with such embarrassment?"
  // Visual: Man's reflection in rain-streaked glass. An OPEN sign glows behind.
  {
    sceneNumber: 15,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `${MAN_DESC} His face is reflected in rain-streaked glass. Behind the glass, a neon "OPEN" sign glows green in the darkness -- the only color in the frame. His eyes are searching, haunted. Water streaks distort his features. He looks like a man remembering a world he never lived in. Extreme close-up, shallow focus on the reflection. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Extreme close-up of a man's face reflected in rain-streaked glass. Behind the glass a green neon OPEN sign pulses faintly. Water runs down the surface, distorting his features. His hazel eyes search for something lost. The only color is the neon green. Sound of rain on glass, faint neon buzz.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT TO BLACK',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'What excuse do you tell yourself to cope with such embarrassment?' },
        sfx: 'rain on glass',
        ambient: 'neon buzz',
      },
    ],
  },

  // ── SCENE 16: BLACK / ACT THREE (DARKNESS) ──────────────────────
  // VO: "The permission to build your own life is being withdrawn by those who plunder you
  //      and tell you it's for your own good."
  // Visual: Black screen. Then fade in on a slow reveal.
  {
    sceneNumber: 16,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Pure black frame. Nothing visible. Absolute darkness. Total black, no stars, no texture, no gradient. The void.`,
        videoPrompt: `Black screen. Complete darkness. Nothing visible. Only the narrator's voice exists. The most important line lands in total darkness. Silence except for voice.`,
        videoDuration: '5s',
        cameraMovement: 'none',
        transition: 'FADE',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'The permission to build your own life is being withdrawn by those who plunder you and tell you it\'s for your own good.' },
      },
    ],
  },

  // ── SCENE 17: CONCRETE CANYON (CLEAN DYSTOPIA) ──────────────────
  // VO: "What prevents the man of tomorrow from even greater servitude?
  //      What force resists an increasingly permissioned existence?"
  // Visual: The man stops. Turns to face camera for the first time.
  {
    sceneNumber: 17,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A long white corridor stretches infinitely in both directions. Citizens in dark coats walk in orderly streams. In the center of the frame, one figure has STOPPED -- ${MAN_DESC} -- facing directly toward the camera. He is the only person not moving. The crowd flows around him like water around a stone. His expression is questioning, defiant. Wide shot, symmetric framing. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A wide shot of a white corridor with citizens flowing in orderly streams. One man in a dark charcoal suit has stopped walking and turns to face the camera. He is the only person not moving. The crowd parts around him without noticing. His expression is direct, questioning. Sound of footsteps flowing around a single point of stillness.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'So what prevents this trend from continuing? What prevents the man of tomorrow from even greater servitude?' },
        ambient: 'flowing footsteps',
      },
    ],
  },

  // ── SCENE 18: BEAT (CLEAN DYSTOPIA) ─────────────────────────────
  // VO: "We do."
  //     "We are building the economic defense of modern society against plunder."
  // Visual: Direct address. Eyes meet lens. The turn.
  {
    sceneNumber: 18,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Extreme close-up of a man's eyes looking directly into the camera. ${MAN_DESC} Deep-set hazel eyes, no longer searching -- now certain. Defiant. The first direct confrontation with the viewer. The white walls of the corridor are soft-focused behind him. His brow is set. This is the moment the film pivots from diagnosis to defiance. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Extreme close-up of hazel eyes staring directly into the camera. The man's gaze is unwavering, defiant. The first direct address. White corridor soft-focused behind him. He blinks once, slowly. This is the turn. Sound drops to near-silence, then percussive music fades in underneath.`,
        videoDuration: '3s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'We do.' },
      },
      {
        shotNumber: 2,
        imagePrompt: `Medium shot of a man in a dark charcoal suit standing in a pristine white space. His posture has shifted -- shoulders squared, chin raised. Behind him, barely visible in the white fog, the silhouettes of other people are beginning to STOP walking. One has turned. Then another. A wave of stillness beginning to ripple through the crowd. The resistance is starting. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Medium shot of a man standing firm in white space. Behind him, silhouettes in the fog begin stopping one by one. A wave of stillness ripples outward. People are turning. The resistance begins. Percussive music rises underneath. Sound of footsteps slowing, then stopping.`,
        videoDuration: '5s',
        cameraMovement: 'slow push-in',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'You may not realize it, but what we are building is the economic defense of modern society against plunder and restriction by the state.' },
        ambient: 'footsteps slowing',
      },
    ],
  },

  // ── SCENE 19: FACTORY HALL (CLEAN DYSTOPIA) ─────────────────────
  // VO: "We are saying no to the perpetual encroachment of permissioned existence."
  //     "It is not the political process that saves us."
  // Visual: Workers look up. Heads rising like a wave.
  {
    sceneNumber: 19,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Vast industrial hall with rows upon rows of identical workers in gray uniforms at white metal desks, heads bowed. But ONE worker in the near row has looked up -- their face is still featureless smoke, but the head is raised, chin tilted toward something above. The others remain bowed. Wide shot emphasizing the scale of the hall and the singularity of this one defiant head. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of a vast hall of identical gray-uniformed workers with bowed heads. One worker looks up. Then another beside them. A ripple begins -- heads rising in a wave moving through the rows. The awakening spreads. Sound of chairs creaking, a collective exhale.`,
        videoDuration: '8s',
        cameraMovement: 'slow crane rising',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'We are saying no to the perpetual encroachment of permissioned existence.' },
        sfx: 'chairs creaking',
      },
      {
        shotNumber: 2,
        imagePrompt: `Close-up of a rubber stamp frozen mid-descent. Below it, the paper is blank -- UNSTAMPED. The featureless gray hand that holds the stamp has paused. For the first time, permission has not been granted. The stamp hovers motionless in the air. White background, clinical perfection -- except for this one hesitation. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of a rubber stamp frozen mid-air above blank paper. The gray hand holds it motionless. The bureaucratic machine has hesitated. Permission suspended. Static shot, the stamp does not descend. Sound of silence where rhythmic stamping used to be.`,
        videoDuration: '3s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'It is not the political process -- the political circus -- that saves us from this phenomenon.' },
      },
    ],
  },

  // ── SCENE 20: CHAIN SHATTERING (CLEAN DYSTOPIA) ─────────────────
  // VO: "Our salvation is our own responsibility."
  //     "It is ourselves. Our minds. Our hands. And our decision to act --"
  //     "-- and we are doing so without permission."
  // Visual: Man grips the chain. It shatters. Fragments scatter like sparks.
  {
    sceneNumber: 20,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A human hand -- real, weathered, with visible knuckles and veins -- reaches down toward a heavy iron chain bolted to a white floor. The hand is about to grip the chain. This is the first time a human has touched what binds their shadow. The shadow on the wall behind watches. Close-up of hand approaching chain. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Close-up of a human hand reaching down to grip a heavy iron chain on white floor. The hand closes around the metal. Knuckles whiten. This is the first defiant touch. The shadow on the wall behind strains toward the hand. Sound of metal under pressure, a low frequency building.`,
        videoDuration: '3s',
        cameraMovement: 'static close-up',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'Now, as free men and free women, our salvation is our own responsibility.' },
        sfx: 'metal under pressure',
      },
      {
        shotNumber: 2,
        imagePrompt: `The iron chain EXPLODING into fragments. Links shatter outward like sparks against a pristine white wall. The pieces scatter in a starburst pattern. Where the chain was, the shadow stands upright -- free, unbound, tall. Metal fragments frozen mid-flight, glinting. Dynamic, explosive composition against clinical white. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `The chain shatters explosively. Iron fragments scatter like sparks against white walls. Links fly outward in a starburst. The shadow on the wall springs upright -- free for the first time. Metal glints as it tumbles through flat white light. Sound of shattering metal, then ringing silence.`,
        videoDuration: '3s',
        cameraMovement: 'static, explosive action',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'It is us. It is ourselves. Our minds. Our hands. And our decision to act --' },
        sfx: 'shattering metal, ringing silence',
      },
      {
        shotNumber: 3,
        imagePrompt: `Wide shot of a pristine white wall. The bolt in the floor where the chain was anchored is empty -- broken, pulled from the concrete. Iron fragments litter the white floor like dark confetti. The shadow on the wall stands tall, upright, arms at its sides -- liberated. The shadow is darker now, more defined, more human than before. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of white wall with empty bolt, iron fragments scattered across the floor. The shadow on the wall stands tall and free for the first time. It moves slightly -- independent now. Sound of the last chain links settling on the floor, then pure silence.`,
        videoDuration: '5s',
        cameraMovement: 'slow pull-back',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: '-- and we are doing so without permission.' },
        ambient: 'settling metal, then silence',
      },
    ],
  },

  // ── SCENE 21: SHADOW WALKS FREE (CLEAN DYSTOPIA) ────────────────
  // Visual: The shadow stands upright and walks in a different direction than the man.
  // ACT FOUR: THE DECLARATION
  {
    sceneNumber: 21,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A pristine white wall with a man's shadow cast upon it. But the shadow has STEPPED AWAY from its owner's position -- it walks to the LEFT while the faint outline of the man moves RIGHT. The shadow has become autonomous, free, self-directed. It moves with confidence, head up, stride long. Two diverging paths -- one cast, one chosen. Wide shot, minimal composition. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A shadow on a white wall begins walking independently of its owner. The shadow moves left while the man's faint outline moves right. Two paths diverge. The shadow walks with confidence -- head up, stride long. For the first time it is not dragged, not chained, not bowed. Pure silence. The separation is complete.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: [],
      },
    ],
  },

  // ── SCENE 22: EMPTY SURVEILLANCE CORRIDOR (CLEAN DYSTOPIA) ──────
  // VO: "Permission is what the kindergarten child attains to go to the bathroom.
  //      It is not what the respectable man attains in his financial affairs."
  // Visual: The corridor is empty now. Desks abandoned. Card readers dark.
  {
    sceneNumber: 22,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `The infinite glass-desk corridor from before, but every desk is now EMPTY. No faceless figures. No smoke heads. The chairs are pushed back as if recently abandoned. Card readers sit dark on every desk -- no green lights. Wisps of dark smoke dissipate in the air, the last traces of the bureaucrats. The corridor is pristine but hollow. Wide shot, symmetric framing, deep perspective vanishing point. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A slow dolly through the surveillance corridor. Every desk is empty, chairs pushed back. Card readers sit dark. Wisps of smoke dissipate in the air -- the bureaucrats have dissolved. The corridor stretches to infinity, pristine but hollow. Authority has evaporated. Sound of air conditioning hum in an empty room.`,
        videoDuration: '8s',
        cameraMovement: 'slow dolly forward',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'Permission is what the kindergarten child attains to go to the bathroom. It is not what the respectable man attains in his financial affairs.' },
        ambient: 'air conditioning hum, empty room',
      },
    ],
  },

  // ── SCENE 23: CHANGED STRIDE (CLEAN DYSTOPIA) ──────────────────
  // VO: "If I may transact only by the good graces of those watching from above --
  //      I am a subject. I am not a man, but a child."
  // Visual: The man walks with changed posture. Shoulders back.
  {
    sceneNumber: 23,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A white corridor. A man in a dark charcoal suit walks toward the camera with a TRANSFORMED posture -- shoulders back, head raised, stride confident and unhurried. ${MAN_DESC} Behind him, other citizens continue walking with bowed heads and shuffling steps. The contrast between his upright defiance and their submission is stark. He walks against the flow. Wide shot, symmetric framing. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Wide shot of a white corridor. Citizens shuffle with bowed heads in one direction. One man walks the opposite way -- shoulders back, chin raised, stride purposeful. He is the only upright figure. The crowd parts around him but doesn't look up. His transformed posture is the rebellion made physical. Sound of his confident footsteps against the shuffle of others.`,
        videoDuration: '5s',
        cameraMovement: 'static',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'For if I may transact with you only by the good graces of those watching me from above -- I am a subject. I am not a man, but a child.' },
        ambient: 'contrasting footsteps',
      },
    ],
  },

  // ── SCENE 24: PRISON FROM ABOVE (CLEAN DYSTOPIA) ────────────────
  // VO: "Do you feel similarly loved by the Central Intelligence Agency?"
  // Visual: The prison from above -- walls shorter than we thought. A figure steps over.
  {
    sceneNumber: 24,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `High aerial view looking directly down on the miniature prison compound from scene 1 -- the circuit-board prison yard. But from this new angle, the walls are revealed to be ANKLE HEIGHT. The guard towers are small. The razor wire is decorative. The whole apparatus of control is revealed as miniature, pathetic, easily overcome. One tiny figure is mid-step OVER the wall. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `High aerial shot looking down on the circuit-board prison. From this angle the walls are revealed as ankle-height. The guard towers are toys. One figure steps over the wall casually. The entire apparatus of control was always a facade. Sound of a quiet footstep on gravel -- that's all it takes.`,
        videoDuration: '5s',
        cameraMovement: 'static overhead',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'Children are generally loved by their parents. Do you feel similarly loved by the Central Intelligence Agency?' },
        sfx: 'footstep on gravel',
      },
      {
        shotNumber: 2,
        imagePrompt: `Multiple tiny figures stepping over the ankle-height prison walls in different directions. The guard towers are empty. The razor wire is just string. The whole miniature compound is being casually abandoned. Some figures walk away into the white expanse. The prison was always voluntary. High angle, wide shot. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `More figures step over the tiny walls. Guard towers empty, razor wire just string. The compound is being casually abandoned from every side. Figures walk into the white expanse. The prison was always voluntary. Sound of footsteps scattering in different directions, growing faint.`,
        videoDuration: '5s',
        cameraMovement: 'slow pull-back to wider',
        transition: 'CUT',
        characters: [],
        ambient: 'scattering footsteps',
      },
    ],
  },

  // ── SCENE 25: FARM ANIMALS METAPHOR (CLEAN DYSTOPIA) ────────────
  // VO: "Farm animals, perhaps, is the better metaphor. We graze in the pen.
  //      We produce. We are harvested."
  // Visual: No protagonist. Pure concept -- the pen, the grazing, the harvest.
  {
    sceneNumber: 25,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A sterile white room with perfectly spaced identical gray figures standing in a grid pattern inside a low white fence -- a PEN. They stand motionless, equidistant, like livestock in a holding area. The fence is waist-height, clearly not a physical barrier. Above them, large pale hands descend from the ceiling, methodically taking items from each figure's pockets. Production and harvest made visual. Overhead view. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Overhead shot of identical gray figures standing in a grid inside a low white fence. They stand motionless like livestock. Large pale hands descend from above, methodically extracting items from each figure. They graze. They produce. They are harvested. Sound of mechanical extraction, rhythmic and clinical.`,
        videoDuration: '8s',
        cameraMovement: 'slow overhead pan',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'Farm animals, perhaps, is the better metaphor. We have allowed ourselves to be treated like farm animals. We graze in the pen. We produce. We are harvested.' },
        ambient: 'mechanical extraction sounds',
      },
    ],
  },

  // ── SCENE 26: EMPTY POLITICAL CHAMBER (CLEAN DYSTOPIA) ──────────
  // VO: "I look out at the political class... their ornaments of authority...
  //      I find no reason to submit."
  // Visual: A vast ornate chamber. Empty thrones. Gold leaf peeling. Velvet ropes around nothing.
  {
    sceneNumber: 26,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A vast ornate chamber with impossibly high white ceilings. Empty gilded thrones on a raised white platform. Gold leaf peeling from the walls in strips, revealing pristine white plaster beneath. Velvet ropes cordon off absolutely nothing -- empty space behind them. The "ornaments of authority" are present but unoccupied. Power as abandoned set dressing. Grand wide shot, slightly low angle. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `A slow dolly forward into a vast ornate chamber. Empty gilded thrones on a white platform. Gold leaf peels from walls revealing white beneath. Velvet ropes cordon off nothing. The ornaments of authority are hollow, abandoned. Power as set dressing in an empty room. Sound of echoing footsteps in a marble hall, dust settling.`,
        videoDuration: '8s',
        cameraMovement: 'slow dolly forward',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'I look out at the political class, that legion of bureaucrats, suckling at the teat of plundered wealth with all their ornaments of authority, and I find no reason to submit to the provisions under which they seek to restrain me.' },
        ambient: 'echoing marble hall',
      },
    ],
  },

  // ── SCENE 27: DUST MOTES (CLEAN DYSTOPIA) ──────────────────────
  // VO: "To such people we owe nothing. But to humanity we owe much."
  // Visual: Dollying through empty chamber. Dust motes in light.
  {
    sceneNumber: 27,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Camera moves through the empty political chamber. Dust motes drift lazily in a shaft of white light that cuts through the space like a blade. The thrones recede behind. Gold leaf fragments drift downward like confetti. The chamber is beautiful in its abandonment -- power decomposing into dust. Medium shot, atmospheric. ${CLEAN_DYSTOPIA.suffix()}`,
        videoPrompt: `Slow dolly through the empty chamber. Dust motes drift in shafts of white light. Gold leaf fragments flutter down like decaying confetti. The thrones shrink behind. Power decomposing into dust and silence. Sound of deep ambient silence, dust settling.`,
        videoDuration: '5s',
        cameraMovement: 'slow dolly through',
        transition: 'CUT TO BLACK',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'To such people we owe nothing. But to humanity we owe much.' },
        ambient: 'deep silence',
      },
    ],
  },

  // ── SCENE 28: BLACK / SILENCE ───────────────────────────────────
  // Visual: Black. Silence. Then --
  {
    sceneNumber: 28,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Pure black frame. Absolute darkness. Total black, no texture, no gradient. The void before the dawn.`,
        videoPrompt: `Black screen. Complete darkness. Silence holds for a full beat. Then, at the very end, the faintest hint of golden light appears at the bottom edge of the frame -- dawn approaching. Sound of absolute silence breaking into a distant bird call.`,
        videoDuration: '5s',
        cameraMovement: 'none',
        transition: 'FADE',
        characters: [],
        ambient: 'silence, then distant bird',
      },
    ],
  },

  // ── SCENE 29: OPEN LANDSCAPE AT DAWN (WARM ANALOG) ─────────────
  // VO: "That's why we're here."
  // Visual: Real golden light. Dawn over open terrain. No walls. No chains.
  {
    sceneNumber: 29,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `Dawn breaking over an open landscape. Real golden sunlight floods the frame -- not oil painting, not projection, but genuine warm light. Tall grass catches the amber glow. The horizon is vast and unbroken. No walls, no corridors, no white surfaces. The first REAL warmth in the entire film. A man in a dark charcoal suit stands small at the edge of the frame, facing the sunrise. ${WARM_ANALOG.suffix()}`,
        videoPrompt: `Dawn breaks over an open landscape. Golden sunlight floods through tall grass. The horizon is vast and free -- no walls, no fences. A man in a dark suit stands at the frame's edge facing the sunrise. This warmth is real, not a memory on a screen. Kodak Ektachrome warmth, gentle grain. Sound of wind through grass, distant birdsong, warmth you can hear.`,
        videoDuration: '8s',
        cameraMovement: 'slow pan right with sunrise',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: "That's why we're here." },
        ambient: 'wind through grass, birdsong',
      },
      {
        shotNumber: 2,
        imagePrompt: `Close-up of tall golden grass swaying in morning wind. Each blade is lit by golden sunlight from behind, creating halos of warm light. Dew drops catch and scatter the light into tiny prisms. Shallow depth of field, vintage lens softness, gentle barrel distortion. Ektachrome color warmth. ${WARM_ANALOG.suffix()}`,
        videoPrompt: `Close-up of golden grass blades swaying in morning wind, backlit by sunrise. Dew drops scatter light into warm prisms. Shallow focus, vintage lens softness. The natural world is free and beautiful. Sound of gentle wind, grass rustling.`,
        videoDuration: '3s',
        cameraMovement: 'static with wind movement',
        transition: 'CUT',
        characters: [],
        ambient: 'gentle wind',
      },
    ],
  },

  // ── SCENE 30: TITLE CARDS / REBELLION (WARM ANALOG → BLACK) ────
  // VO: "And crypto is our rebellion."
  //     "It is a rebellion against a system unworthy of its authority."
  //     "Crypto is our rebellion against permission."
  // Visual: Title card white text on black, intercut with dawn landscape
  {
    sceneNumber: 30,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `White text on pure black background. The words: "WITHOUT PERMISSION" centered in a clean, minimal sans-serif typeface. Nothing else. The text glows slightly against the darkness. Cinematic, authoritative, final.`,
        videoPrompt: `Black screen. White text fades in: WITHOUT PERMISSION. Clean sans-serif typeface. The words glow against pure darkness. They hold, breathing in the black. Sound of a single low note resolving.`,
        videoDuration: '5s',
        cameraMovement: 'none',
        transition: 'CUT',
        characters: [],
        dialogue: { character: 'MAN (V.O.)', line: 'And crypto is our rebellion. Crypto is our rebellion against permission.' },
      },
    ],
  },

  // ── SCENE 31: WALKING INTO LIGHT (WARM ANALOG) ─────────────────
  // VO: "A noble reclamation of dignity and grace as free and sovereign individuals
  //      in the service of peaceful civilization."
  // Visual: Man walks forward into the light. City recedes behind.
  {
    sceneNumber: 31,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `${MAN_DESC} He walks forward toward golden dawn light, seen from behind. His suit is still rumpled but his posture is transformed -- upright, purposeful, free. Behind him on the distant horizon, the concrete city is visible -- tiny, gray, receding, irrelevant. The open landscape stretches in every direction. Warm golden light, Ektachrome grain, vintage lens flare. ${WARM_ANALOG.suffix()}`,
        videoPrompt: `A man in a dark suit walks forward into golden dawn light, seen from behind. Shoulders back, stride free. Behind him, the concrete city shrinks on the horizon -- gray and irrelevant. The landscape is open and warm. Kodak Ektachrome warmth, gentle grain, lens flare. Sound of footsteps on earth, soaring music, wind.`,
        videoDuration: '8s',
        cameraMovement: 'slow follow behind',
        transition: 'CUT',
        characters: ['MAN'],
        dialogue: { character: 'MAN (V.O.)', line: 'And it is no less than a noble reclamation of dignity and grace as free and sovereign individuals in the service of peaceful civilization.' },
        ambient: 'footsteps on earth, wind',
      },
      {
        shotNumber: 2,
        imagePrompt: `Wide landscape shot. The man is now a small silhouette against the golden horizon, walking away from camera into pure light. The concrete city behind is barely visible, a thin gray smudge. The sky is immense -- amber, peach, gold. The figure dissolves into the landscape. Freedom as dissolution into beauty. ${WARM_ANALOG.suffix()}`,
        videoPrompt: `Wide shot of a man as a small silhouette walking into the golden horizon. The concrete city is a gray smudge behind. The sky is immense amber and gold. The figure slowly dissolves into the landscape. Freedom as dissolution into beauty. Music swells. Sound of wind, the horizon breathing.`,
        videoDuration: '5s',
        cameraMovement: 'static wide',
        transition: 'FADE',
        characters: ['MAN'],
        ambient: 'wind, music swell',
      },
    ],
  },

  // ── SCENE 32: DISSOLVING INTO LANDSCAPE (WARM ANALOG) ──────────
  // Visual: The horizon holds. Breathing room. The world beyond the walls.
  {
    sceneNumber: 32,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `A vast open landscape at golden hour. No human figure visible. Just the horizon -- earth meeting sky in a gentle amber gradient. Tall grass sways in the foreground. Rolling hills extend endlessly. The frame breathes. There is a world beyond the walls. ${WARM_ANALOG.suffix()}`,
        videoPrompt: `Wide landscape. No human figure. Just earth meeting sky in amber gradient. Tall grass sways. Rolling hills extend endlessly. The frame breathes. Music swells and resolves. Sound of wind through open space, then peaceful silence.`,
        videoDuration: '8s',
        cameraMovement: 'static',
        transition: 'FADE TO BLACK',
        characters: [],
        ambient: 'wind, then silence',
      },
    ],
  },

  // ── SCENE 33: END CARD ─────────────────────────────────────────
  {
    sceneNumber: 33,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `White text centered on a pure black background. Three lines: "Erik Voorhees" in larger type, then "Bitcoin 2019 Conference" in smaller type, then "San Francisco" in smallest type. Clean minimal sans-serif typeface. Cinematic end card.`,
        videoPrompt: `Black screen. White text fades in: Erik Voorhees. Bitcoin 2019 Conference. San Francisco. The text holds. Silence.`,
        videoDuration: '5s',
        cameraMovement: 'none',
        transition: 'FADE',
        characters: [],
      },
    ],
  },

  // ── SCENE 34: THE END ──────────────────────────────────────────
  {
    sceneNumber: 34,
    shots: [
      {
        shotNumber: 1,
        imagePrompt: `White text on black: "WITHOUT PERMISSION" in clean minimal sans-serif. Below in smaller type: "FADE OUT." Pure black background, nothing else.`,
        videoPrompt: `Black screen. White text: WITHOUT PERMISSION. It holds for a beat. Then fades. Pure black remains. Silence.`,
        videoDuration: '5s',
        cameraMovement: 'none',
        transition: 'FADE OUT',
        characters: [],
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

// ── BACKUP OLD FILES ─────────────────────────────────────────────────
function backupOldShots(sceneDir: string) {
  if (!existsSync(sceneDir)) return;
  const files = readdirSync(sceneDir);
  for (const f of files) {
    // Backup old video.json files (but not .video.json.bak files)
    if (f.match(/^shot-\d+\.video\.json$/) && !f.endsWith('.bak')) {
      const src = join(sceneDir, f);
      const dst = join(sceneDir, f + '.bak');
      try { renameSync(src, dst); } catch {}
    }
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const startScene = args[0] ? parseInt(args[0]) : 8;
  const endScene = args[1] ? parseInt(args[1]) : 34;

  const filteredScenes = scenes.filter(s => s.sceneNumber >= startScene && s.sceneNumber <= endScene);
  const totalShots = filteredScenes.reduce((sum, s) => sum + s.shots.length, 0);

  console.log(`\nRegenerating scenes ${startScene}-${endScene} (${filteredScenes.length} scenes, ${totalShots} shots)`);
  console.log(`Concept-driven imagery -- no generic corridor walking\n`);

  let shotsDone = 0;

  for (const scene of filteredScenes) {
    const sceneDir = join(PROJECT_DIR, `scene-${String(scene.sceneNumber).padStart(3, '0')}`);
    mkdirSync(sceneDir, { recursive: true });

    console.log(`── Scene ${scene.sceneNumber} (${scene.shots.length} shots) ──`);

    // Backup old video.json files so they don't get picked up by video generation
    backupOldShots(sceneDir);

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

      // Rate limit delay
      await new Promise(r => setTimeout(r, 600));
    }

    console.log();
  }

  console.log(`\nDone! Generated ${shotsDone} concept-driven panels across ${filteredScenes.length} scenes.`);
  console.log(`Old video.json files backed up as .bak to prevent conflicts.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
