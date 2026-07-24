#!/usr/bin/env node
// Smoke test for voice references (@AudioN) + location references (@ImageN env
// slot). Run with `node tests/test-voice-and-location-refs.mjs` after
// `npm run build`. No network / no generation budget — exercises the pure
// prompt-builder wiring + manager location helpers against on-disk fixtures.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVideoPrompt } from '../dist/mini-drama/prompt-builder.js';
import {
  addLocation, getLocation, getLocationDir, locationSlugify,
} from '../dist/series/manager.js';
import {
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  MODELS_SUPPORTING_SCENE_IMAGES,
} from '../dist/series/types.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

const dir = mkdtempSync(join(tmpdir(), 'venice-refs-smoke-'));

// ── Fixtures on disk ───────────────────────────────────────────────────
mkdirSync(join(dir, 'characters', 'aria'), { recursive: true });
writeFileSync(join(dir, 'characters', 'aria', 'front.png'), PNG);
writeFileSync(join(dir, 'characters', 'aria', 'three-quarter.png'), PNG);
writeFileSync(join(dir, 'characters', 'aria', 'voice-reference.mp3'), Buffer.from('ID3'));

mkdirSync(join(dir, 'locations', 'workshop'), { recursive: true });
writeFileSync(join(dir, 'locations', 'workshop', 'wide.png'), PNG);

// ── Scratch series ─────────────────────────────────────────────────────
const series = {
  name: 'Smoke', slug: 'smoke', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: {
    style: 'Cinematic photography', palette: 'warm amber palette',
    lighting: 'natural lighting', lensCharacteristics: 'shallow depth of field',
    filmStock: 'digital',
  },
  storyboardAspectRatio: '16:9',
  characters: [{
    name: 'ARIA', gender: 'female', age: 'mid 20s',
    description: 'inventor', fullDescription: 'ARIA, inventor', wardrobe: 'jacket',
    voiceDescription: 'bright, warm feminine voice',
    voiceReferencePath: 'characters/aria/voice-reference.mp3',
    voiceReferenceModel: 'seed-audio-1-0',
    locked: true, seed: 42,
  }],
  locations: [],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-reference-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
    characterConsistencyModel: 'seedance-2-0-reference-to-video',
    // No lipSyncModel → dialogue shots stay on Seedance R2V (reference-audio capable).
    imageDefaults: { generationModel: 'seedream-v5-lite', editModel: 'seedream-v5-lite-edit' },
    seedanceCompatibility: 'launder',
  },
  outputDir: dir,
  createdAt: '', updatedAt: '',
};

// ── manager location helpers ───────────────────────────────────────────
addLocation(series, {
  name: 'Workshop', slug: 'workshop',
  description: 'a cramped sietch workshop of copper pipes and warm lamplight',
  lightingNotes: 'warm amber lamplight, deep shadows',
  seed: 7,
});
ok('addLocation persists on series.locations', series.locations.length === 1);
ok('getLocation finds by slug', getLocation(series, 'workshop')?.name === 'Workshop');
ok('getLocationDir resolves to on-disk dir', getLocationDir(series, 'workshop') === join(dir, 'locations', 'workshop'));
ok('locationSlugify kebab-cases', locationSlugify('Sietch Workshop') === 'sietch-workshop');

// ── capability sets ────────────────────────────────────────────────────
ok('Seedance R2V supports reference audio', MODELS_SUPPORTING_REFERENCE_AUDIO.has('seedance-2-0-reference-to-video'));
ok('HappyHorse R2V supports reference audio', MODELS_SUPPORTING_REFERENCE_AUDIO.has('happyhorse-1-1-reference-to-video'));
ok('Seedance R2V does NOT support scene images', !MODELS_SUPPORTING_SCENE_IMAGES.has('seedance-2-0-reference-to-video'));

// ── buildVideoPrompt: dialogue shot with voice ref + location ──────────
const shot = {
  shotNumber: 1, type: 'dialogue', duration: '15s', videoModel: 'action',
  environment: 'NIGHT_INTERIOR',
  description: 'ARIA leans over the workbench and speaks.',
  characters: ['ARIA'],
  location: 'workshop',
  motion: 'high', // keep on Seedance R2V (not Wan 2.7 lip-sync)
  dialogue: { character: 'ARIA', line: 'It finally works.', delivery: 'hushed, breathless awe' },
  sfx: null, cameraMovement: 'slow dolly forward', transition: 'CUT',
};

const p = buildVideoPrompt(shot, series);

ok('resolved to Seedance R2V', p.model === 'seedance-2-0-reference-to-video');
ok('voiceReferenceSlots has one slot', Array.isArray(p.voiceReferenceSlots) && p.voiceReferenceSlots.length === 1);
ok('voice slot bound to ARIA @Audio1', p.voiceReferenceSlots?.[0]?.characterName === 'ARIA' && p.voiceReferenceSlots?.[0]?.audioIndex === 1);
ok('prompt binds @Audio1 for voice identity', /Use @Audio1 only for voice identity/.test(p.prompt));
ok('locationEnvSlot present at @Image2 (1 char + location)', p.locationEnvSlot?.slug === 'workshop' && p.locationEnvSlot?.imageIndex === 2);
ok('prompt tags @Image2 as location environment', /@Image2 is the location environment reference/.test(p.prompt));
ok('prompt injects the locked location description', /cramped sietch workshop/.test(p.prompt));

// ── A voice-over (NARRATOR) line must NOT get a voice ref ───────────────
const voShot = { ...shot, dialogue: { character: 'NARRATOR', line: 'And so it began.' } };
const pvo = buildVideoPrompt(voShot, series);
ok('NARRATOR line gets no voice ref slot', !pvo.voiceReferenceSlots || pvo.voiceReferenceSlots.length === 0);

// ── Voice refs disabled series-wide → no slot ──────────────────────────
const seriesOff = { ...series, videoDefaults: { ...series.videoDefaults, voiceReferenceForDialogue: false } };
const poff = buildVideoPrompt(shot, seriesOff);
ok('voiceReferenceForDialogue:false disables voice ref slot', !poff.voiceReferenceSlots || poff.voiceReferenceSlots.length === 0);

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll voice + location reference smoke checks passed.');
