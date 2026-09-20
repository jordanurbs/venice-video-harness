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
  modelWantsSimplePrompt,
  supportsCameraTrajectory,
  buildOrbitTrajectory,
  buildStartEndTrajectory,
  validateCameraTrajectory,
  CAMERA_MAX_AZIMUTH_TRAVEL_DEG,
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
  // MiniMax H3 (added 2026-07-31)
  'minimax-h3-text-to-video',
  'minimax-h3-image-to-video',
  'minimax-h3-reference-to-video',
  // MiniMax H3 Max + Max Turbo (added 2026-09-03)
  'minimax-h3-max-text-to-video',
  'minimax-h3-max-image-to-video',
  'minimax-h3-max-reference-to-video',
  'minimax-h3-max-turbo-text-to-video',
  'minimax-h3-max-turbo-image-to-video',
  // MiniMax H3 Max Multi-Angle (added 2026-09-15) — camera_trajectory lane
  'minimax-h3-max-multi-angle',
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

// ---- MiniMax H3: the two constraints that differ from every other family ----
// Both are hard HTTP 400s at queue time, so the registry has to carry them:
// 2K is the only resolution, and the duration ladder starts at 5s.
for (const id of ['minimax-h3-text-to-video', 'minimax-h3-image-to-video', 'minimax-h3-reference-to-video']) {
  const m = getVideoModel(id);
  ok(`${id} offers 2K only`, JSON.stringify(m?.resolutions) === JSON.stringify(['2K']));
  ok(`${id} duration ladder starts at 5s`, m?.durations[0] === '5s');
  ok(`${id} rejects sub-5s durations`, !m?.durations.includes('3s') && !m?.durations.includes('4s'));
  ok(`${id} maxDurationSec is 15`, m?.maxDurationSec === 15);
  ok(`${id} audio is on and not configurable`, m?.audio === true && m?.audioConfigurable === false);
}
// Only the R2V lane takes reference images and a top-level audio_url.
ok('minimax-h3 R2V supports reference images',
  getVideoModel('minimax-h3-reference-to-video')?.supportsReferenceImages === true);
ok('minimax-h3 i2v does not claim reference images',
  getVideoModel('minimax-h3-image-to-video')?.supportsReferenceImages === false);
ok('minimax-h3 R2V accepts audio input',
  getVideoModel('minimax-h3-reference-to-video')?.audioInput === true);
ok('minimax-h3 i2v does not accept audio input',
  getVideoModel('minimax-h3-image-to-video')?.audioInput === false);
// i2v inherits aspect from the start image — sending aspect_ratio would 400.
ok('minimax-h3 i2v exposes no aspect ratios',
  getVideoModel('minimax-h3-image-to-video')?.aspectRatios.length === 0);

// ---- MiniMax H3 Max: inverted resolution + simple prompts (probe 2026-09-03)
// H3 Max shares the name and the 5-15s ladder with H3 and almost nothing else.
// The two that cost real money if they drift: 768P (2K is a hard 400 — the
// OPPOSITE of H3) and promptStyle 'simple', which is what keeps the directorial
// stack out of these prompts.
const H3_MAX_IDS = [
  'minimax-h3-max-text-to-video',
  'minimax-h3-max-image-to-video',
  'minimax-h3-max-reference-to-video',
  'minimax-h3-max-turbo-text-to-video',
  'minimax-h3-max-turbo-image-to-video',
];
for (const id of H3_MAX_IDS) {
  const m = getVideoModel(id);
  ok(`${id} offers 768P/480P and NOT 2K`,
    JSON.stringify(m?.resolutions) === JSON.stringify(['768P', '480P']));
  ok(`${id} prefers 768P over the 480P draft tier`, m?.resolutions[0] === '768P');
  ok(`${id} wants simple prompts`, m?.promptStyle === 'simple');
  ok(`${id} is private`, m?.privacy === 'private');
  ok(`${id} duration ladder starts at 5s`, m?.durations[0] === '5s');
  ok(`${id} rejects sub-5s durations`, !m?.durations.includes('3s') && !m?.durations.includes('4s'));
  ok(`${id} maxDurationSec is 15`, m?.maxDurationSec === 15);
  ok(`${id} audio is on and not configurable`, m?.audio === true && m?.audioConfigurable === false);
}
ok('modelWantsSimplePrompt is true for H3 Max',
  H3_MAX_IDS.every(id => modelWantsSimplePrompt(id)));
ok('modelWantsSimplePrompt is false for base H3 and Seedance',
  !modelWantsSimplePrompt('minimax-h3-text-to-video')
  && !modelWantsSimplePrompt('seedance-2-5-reference-to-video'));
ok('base MiniMax H3 stays 2K-only (H3 Max must not leak into it)',
  JSON.stringify(getVideoModel('minimax-h3-text-to-video')?.resolutions) === JSON.stringify(['2K']));
// Only the non-turbo R2V lane carries references + audio_url; Turbo ships no
// R2V at all ("Specified model not found"), so identity work crosses families.
ok('H3 Max R2V supports reference images',
  getVideoModel('minimax-h3-max-reference-to-video')?.supportsReferenceImages === true);
ok('H3 Max R2V accepts audio input',
  getVideoModel('minimax-h3-max-reference-to-video')?.audioInput === true);
ok('H3 Max i2v claims neither references nor audio input',
  getVideoModel('minimax-h3-max-image-to-video')?.supportsReferenceImages === false
  && getVideoModel('minimax-h3-max-image-to-video')?.audioInput === false);
ok('H3 Max Turbo has NO R2V lane in the registry',
  getVideoModel('minimax-h3-max-turbo-reference-to-video') === undefined);
// i2v inherits aspect from the start image — sending aspect_ratio would 400.
for (const id of ['minimax-h3-max-image-to-video', 'minimax-h3-max-turbo-image-to-video']) {
  ok(`${id} exposes no aspect ratios`, getVideoModel(id)?.aspectRatios.length === 0);
}

// ---- MiniMax H3 Max Multi-Angle: camera_trajectory lane (probe 2026-09-15) ----
// Same H3 Max family (simple prompts, private, 5-15s), but two things differ and
// both cost money if they drift: it is the ONLY H3 Max lane that renders 1080P
// (base H3 Max caps at 768P), and it is the ONLY model that accepts
// camera_trajectory.
const MA = getVideoModel('minimax-h3-max-multi-angle');
ok('multi-angle is registered', MA !== undefined);
ok('multi-angle is image-to-video', MA?.type === 'image-to-video');
ok('multi-angle offers 1080P/768P/480P (1080P finish tier)',
  JSON.stringify(MA?.resolutions) === JSON.stringify(['1080P', '768P', '480P']));
ok('multi-angle prefers 1080P finish tier first', MA?.resolutions[0] === '1080P');
ok('multi-angle wants simple prompts', MA?.promptStyle === 'simple');
ok('multi-angle is private', MA?.privacy === 'private');
ok('multi-angle duration ladder starts at 5s and tops at 15s',
  MA?.durations[0] === '5s' && MA?.maxDurationSec === 15);
ok('multi-angle rejects sub-5s durations', !MA?.durations.includes('4s'));
ok('multi-angle audio is on and not configurable',
  MA?.audio === true && MA?.audioConfigurable === false);
ok('multi-angle exposes no aspect ratios (inherited from image)', MA?.aspectRatios.length === 0);
ok('multi-angle claims neither reference images nor audio input',
  MA?.supportsReferenceImages === false && MA?.audioInput === false);
ok('multi-angle carries supportsCameraTrajectory flag', MA?.supportsCameraTrajectory === true);

// The camera_trajectory capability is exclusive to multi-angle.
ok('supportsCameraTrajectory(multi-angle) is true', supportsCameraTrajectory('minimax-h3-max-multi-angle'));
ok('supportsCameraTrajectory is false for base H3 Max and Seedance',
  !supportsCameraTrajectory('minimax-h3-max-image-to-video')
  && !supportsCameraTrajectory('seedance-2-5-reference-to-video'));
ok('exactly one registry model supports camera_trajectory',
  VIDEO_MODELS.filter(m => m.supportsCameraTrajectory).length === 1);

// buildStartEndTrajectory maps the "start/finish frame angle+distance" ask.
const se = buildStartEndTrajectory({ azimuth: 0, elevation: 0, distance: 1 }, { azimuth: 360, elevation: 12, distance: 0.8 });
ok('buildStartEndTrajectory returns 2 keyframes at time 0 and 1',
  se.length === 2 && se[0].time === 0 && se[1].time === 1 && se[1].azimuth === 360);
ok('buildStartEndTrajectory validates', validateCameraTrajectory(se).ok);

// buildOrbitTrajectory: a full 360° turn with a speed ramp is valid and eased.
const orbit = buildOrbitTrajectory({ azimuthTravel: 360, ramp: 'ease-in-out', keyframes: 6 });
ok('buildOrbitTrajectory yields 6 keyframes', orbit.length === 6);
ok('orbit ends at a full turn', Math.round(orbit[orbit.length - 1].azimuth) === 360);
ok('orbit time is strictly increasing 0..1',
  orbit.every((k, i) => k.time >= 0 && k.time <= 1 && (i === 0 || k.time > orbit[i - 1].time)));
ok('ease-in-out is non-linear (mid azimuth != 180 at t=0.4)',
  buildOrbitTrajectory({ azimuthTravel: 360, ramp: 'ease-in', keyframes: 5 })[1].azimuth < 90);
ok('buildOrbitTrajectory validates', validateCameraTrajectory(orbit).ok);

// Validator catches the server-enforced limits.
ok('validator rejects a single keyframe',
  !validateCameraTrajectory([{ time: 0, azimuth: 0, elevation: 0, distance: 1 }]).ok);
ok('validator rejects azimuth travel beyond 32 turns',
  !validateCameraTrajectory([{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 1, azimuth: CAMERA_MAX_AZIMUTH_TRAVEL_DEG + 361, elevation: 0, distance: 1 }]).ok);
ok('validator rejects elevation out of [-90,90]',
  !validateCameraTrajectory([{ time: 0, azimuth: 0, elevation: -120, distance: 1 }, { time: 1, azimuth: 90, elevation: 0, distance: 1 }]).ok);
ok('validator rejects non-increasing time',
  !validateCameraTrajectory([{ time: 0.5, azimuth: 0, elevation: 0, distance: 1 }, { time: 0.5, azimuth: 90, elevation: 0, distance: 1 }]).ok);
ok('validator rejects distance <= 0',
  !validateCameraTrajectory([{ time: 0, azimuth: 0, elevation: 0, distance: 0 }, { time: 1, azimuth: 90, elevation: 0, distance: 1 }]).ok);

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
