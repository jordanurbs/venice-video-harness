#!/usr/bin/env node
// Coverage smoke test for src/venice/models.ts.
// Asserts the registry contains every new model family added in the 2026-05
// sync (so a future blind merge that drops a family will fail loudly), and
// that the capability sets in src/series/types.ts are consistent with the
// registry (every R2V family in the registry is also listed in
// MODELS_SUPPORTING_REFERENCE_IMAGES, etc).
//
// Run with `node tests/test-registry-coverage.mjs` after `npm run build`.

import {
  VIDEO_MODELS,
  getVideoModel,
  IMAGE_GENERATION_MODELS,
  MUSIC_MODELS,
  getMusicModel,
  listMusicModels,
} from '../dist/venice/models.js';
import {
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_END_IMAGE,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_USING_IMAGE_TAGS,
} from '../dist/series/types.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

// ---- Coverage: every model id we expect to be in the registry ----

const REQUIRED_VIDEO_IDS = [
  // Seedance 2.0 (regular + fast variants)
  'seedance-2-0-image-to-video',
  'seedance-2-0-text-to-video',
  'seedance-2-0-reference-to-video',
  'seedance-2-0-fast-image-to-video',
  'seedance-2-0-fast-text-to-video',
  'seedance-2-0-fast-reference-to-video',
  // Runway Gen-4.5 family (added 2026-05)
  'runway-gen4-5',
  'runway-gen4-5-text',
  'runway-gen4-turbo',
  'runway-gen4-aleph',
  // Wan 2.7 (incl. spicy variant)
  'wan-2-7-image-to-video',
  'wan-2-7-spicy-image-to-video',
  'wan-2-7-reference-to-video',
  // Wan 2.6 (incl. new R2V variant)
  'wan-2.6-image-to-video',
  'wan-2.6-reference-to-video',
  // HappyHorse 1.0 (back-compat) + 1.1 (default happyhorse family, 2026-07)
  'happyhorse-1-0-image-to-video',
  'happyhorse-1-0-reference-to-video',
  'happyhorse-1-1-text-to-video',
  'happyhorse-1-1-image-to-video',
  'happyhorse-1-1-reference-to-video',
  // PixVerse C1 (new) + v5.6 (legacy)
  'pixverse-c1-image-to-video',
  'pixverse-c1-reference-to-video',
  'pixverse-c1-transition',
  'pixverse-v5.6-image-to-video',
  // Kling
  'kling-v3-4k-reference-to-video',
  'kling-v3-4k-text-to-video',
  'kling-o3-standard-reference-to-video',
  'kling-o3-4k-reference-to-video',
  // Grok Imagine (incl. new R2V variant)
  'grok-imagine-image-to-video',
  'grok-imagine-reference-to-video',
  'grok-imagine-video-to-video',
  // Topaz post-production upscaler (added 2026-07)
  'topaz-video-upscale',
  // Sora 2
  'sora-2-image-to-video',
  'sora-2-pro-image-to-video',
  // Veo 3.1
  'veo3.1-fast-image-to-video',
  // LTX 2 + Longcat + Vidu + OVI
  'ltx-2-fast-image-to-video',
  'longcat-image-to-video',
  'vidu-q3-image-to-video',
  'ovi-image-to-video',
];
for (const id of REQUIRED_VIDEO_IDS) {
  ok(`registry has ${id}`, getVideoModel(id) !== undefined);
}

// ---- Sora 2 Pro durations refreshed to 20s (was 12s) ----
const sora2pro = getVideoModel('sora-2-pro-image-to-video');
ok('sora-2-pro maxDurationSec is 20', sora2pro?.maxDurationSec === 20);
ok('sora-2-pro durations includes 20s', sora2pro?.durations.includes('20s'));

// ---- Topaz upscaler capability shape (post-production, not generative) ----
const topaz = getVideoModel('topaz-video-upscale');
ok('topaz is video-input', topaz?.videoInput === true);
ok('topaz has no audio output', topaz?.audio === false);
ok('topaz has no duration ladder (real seconds required)', topaz?.durations.length === 0);
ok('topaz maxDurationSec is 300 (per-request input cap)', topaz?.maxDurationSec === 300);

// ---- Capability sets are consistent with the registry ----
// Every registry entry that has supportsReferenceImages: true must be in
// MODELS_SUPPORTING_REFERENCE_IMAGES. Same for supportsEndImage / audioInput.
for (const m of VIDEO_MODELS) {
  if (m.supportsReferenceImages) {
    ok(`MODELS_SUPPORTING_REFERENCE_IMAGES includes ${m.id}`,
      MODELS_SUPPORTING_REFERENCE_IMAGES.has(m.id));
  }
  if (m.supportsEndImage) {
    ok(`MODELS_SUPPORTING_END_IMAGE includes ${m.id}`,
      MODELS_SUPPORTING_END_IMAGE.has(m.id));
  }
  if (m.audioInput) {
    ok(`MODELS_SUPPORTING_AUDIO_INPUT includes ${m.id}`,
      MODELS_SUPPORTING_AUDIO_INPUT.has(m.id));
  }
}

// Conversely, every model in the AUDIO_INPUT set should exist in the registry.
for (const id of MODELS_SUPPORTING_AUDIO_INPUT) {
  ok(`AUDIO_INPUT model exists in registry: ${id}`, getVideoModel(id) !== undefined);
}
for (const id of MODELS_SUPPORTING_REFERENCE_IMAGES) {
  ok(`REFERENCE_IMAGES model exists in registry: ${id}`, getVideoModel(id) !== undefined);
}
for (const id of MODELS_USING_IMAGE_TAGS) {
  ok(`IMAGE_TAGS model exists in registry: ${id}`, getVideoModel(id) !== undefined);
}

// ---- Image registry: new entries present, sunset entries absent ----
const imageIds = new Set(IMAGE_GENERATION_MODELS.map(m => m.id));
for (const id of [
  'ernie-image', 'ernie-image-turbo',
  'lustify-v8',
  'wan-2-7-text-to-image', 'wan-2-7-pro-text-to-image',
  'grok-imagine-image', 'grok-imagine-image-quality',
  // Existing entries that must remain (regression guards):
  'seedream-v5-lite', 'nano-banana-pro', 'gpt-image-2', 'bria-bg-remover',
]) {
  ok(`IMAGE_GENERATION_MODELS has ${id}`, imageIds.has(id));
}
// Sunset: the bare `qwen-image` (use qwen-image-2 instead).
ok('IMAGE_GENERATION_MODELS does NOT list sunset qwen-image', !imageIds.has('qwen-image'));

// ---- Music / audio registry: current live entries present ----
const musicIds = new Set(MUSIC_MODELS.map(m => m.id));
for (const id of [
  'elevenlabs-music', 'minimax-music-v2', 'minimax-music-v25', 'minimax-music-v26',
  'lyria-3-pro', 'ace-step-15', 'stable-audio-25', 'seed-audio-1-0',
]) {
  ok(`MUSIC_MODELS has ${id}`, musicIds.has(id));
}

// Seed Audio 1.0 capability metadata is wired for pre-flight validation.
const seed = getMusicModel('seed-audio-1-0');
ok('seed-audio-1-0 lookup resolves', seed !== undefined);
ok('seed-audio-1-0 is a music-type model', seed?.type === 'music');
ok('seed-audio-1-0 supports speed', seed?.supportsSpeed === true);
ok('seed-audio-1-0 speed bounds 0.5-2', seed?.minSpeed === 0.5 && seed?.maxSpeed === 2);
ok('seed-audio-1-0 exposes 25 voices', seed?.voices?.length === 25);
ok('seed-audio-1-0 default voice is "Describe in prompt"', seed?.defaultVoice === 'Describe in prompt');
ok('seed-audio-1-0 prompt limit 2048', seed?.promptCharacterLimit === 2048);
ok('seed-audio-1-0 supported formats mp3+wav', JSON.stringify(seed?.supportedFormats) === JSON.stringify(['mp3', 'wav']));
ok('listMusicModels(music) includes seed-audio-1-0',
  listMusicModels({ type: 'music' }).some(m => m.id === 'seed-audio-1-0'));

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
