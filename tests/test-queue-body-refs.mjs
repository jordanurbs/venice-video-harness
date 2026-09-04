#!/usr/bin/env node
// End-to-end QUEUE BODY assertion for voice + location references.
//
// Drives the REAL generateEpisodeVideos → renderSingleShotUnit → renderVideoFile
// path with a fake VeniceClient whose `.post()` captures the queue body and
// throws a sentinel, so we can assert the exact body the harness would send to
// POST /api/v1/video/queue — WITHOUT any network call or generation budget.
//
// Asserts (reference-first upgrade, 2026-07-30):
//   1. Seedance R2V dialogue shot → body.reference_audio_urls carries the
//      speaker's voice-donor clip, the FULL slot plan lands in
//      body.reference_image_urls (character primary, location angles, second
//      character angle), and NO image_url is sent (pure reference mode).
//   2. Seedance R2V shot with 3 characters STAYS on Seedance (9-image budget;
//      the old 3+ → Kling fallback only fires when characters overflow the
//      budget) with one ref-audio clip for the speaker.
//   3. Kling O3 R2V (explicit consistency model) → location lands in
//      body.scene_image_urls and NO reference_audio_urls.
//
// Run: `npm run build && node tests/test-queue-body-refs.mjs`. Requires ffmpeg.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

// Minimal 12-byte PNG signature — data-URI encoders just base64 the bytes.
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const SENTINEL = '__CAPTURED_QUEUE__';

const dir = mkdtempSync(join(tmpdir(), 'venice-queuebody-'));
const sceneDir = join(dir, 'episodes', 'ep1', 'scene-01');
mkdirSync(sceneDir, { recursive: true });

// A real short mp3 so probeAudioDurationSec accepts it (2-15s window).
const voicePath = join(dir, 'characters', 'aria', 'voice-reference.mp3');
mkdirSync(join(dir, 'characters', 'aria'), { recursive: true });
try {
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
    '-ac', '1', '-y', voicePath,
  ], { stdio: 'ignore' });
} catch (err) {
  console.error('ffmpeg not available — cannot build the voice-ref clip:', err.message);
  process.exit(1);
}

// Write a `hasFace:false` provenance sidecar so the Seedance preflight gate
// skips the image (no launder path — the fake client has no postBinary, and we
// only care about body assembly here, not face compatibility).
function faceless(imgPath) {
  writeFileSync(imgPath, PNG);
  writeFileSync(
    imgPath.replace(/\.png$/, '.provenance.json'),
    JSON.stringify({ generationModel: 'seedream-v5-lite', hasFace: false }, null, 2),
  );
}

// Character reference images (front + three-quarter) for ARIA / BEX / CID.
for (const name of ['aria', 'bex', 'cid']) {
  mkdirSync(join(dir, 'characters', name), { recursive: true });
  faceless(join(dir, 'characters', name, 'front.png'));
  faceless(join(dir, 'characters', name, 'three-quarter.png'));
}
// ARIA already has a valid voice reference (written above) so no auto-gen fires.

// Location reference images.
mkdirSync(join(dir, 'locations', 'workshop'), { recursive: true });
faceless(join(dir, 'locations', 'workshop', 'wide.png'));
faceless(join(dir, 'locations', 'workshop', 'medium.png'));

// Panels for both shots.
faceless(join(sceneDir, 'shot-001.png'));
faceless(join(sceneDir, 'shot-002.png'));

const baseSeries = {
  name: 'Smoke', slug: 'smoke', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: {
    style: 'Cinematic photography', palette: 'warm amber palette',
    lighting: 'natural lighting', lensCharacteristics: 'shallow depth of field',
    filmStock: 'digital',
  },
  storyboardAspectRatio: '16:9',
  characters: [
    {
      name: 'ARIA', gender: 'female', age: 'mid 20s', description: 'inventor',
      fullDescription: 'ARIA, inventor', wardrobe: 'jacket',
      voiceDescription: 'bright, warm feminine voice',
      voiceReferencePath: 'characters/aria/voice-reference.mp3',
      voiceReferenceModel: 'seed-audio-1-0', locked: true, seed: 42,
    },
    {
      name: 'BEX', gender: 'male', age: '40s', description: 'foreman',
      fullDescription: 'BEX, foreman', wardrobe: 'coveralls',
      voiceDescription: 'gravelly baritone', locked: true, seed: 43,
    },
    {
      name: 'CID', gender: 'nonbinary', age: '30s', description: 'runner',
      fullDescription: 'CID, runner', wardrobe: 'scarf',
      voiceDescription: 'quick tenor', locked: true, seed: 44,
    },
  ],
  locations: [{
    name: 'Workshop', slug: 'workshop',
    description: 'a cramped sietch workshop of copper pipes and warm lamplight',
    lightingNotes: 'warm amber lamplight, deep shadows', seed: 7,
    referenceModel: 'nano-banana-pro',
  }],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-reference-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
    characterConsistencyModel: 'seedance-2-0-reference-to-video',
    imageDefaults: { generationModel: 'seedream-v5-lite', editModel: 'seedream-v5-lite-edit' },
    seedanceCompatibility: 'launder',
  },
  outputDir: dir,
  createdAt: '', updatedAt: '',
};

function captureClient() {
  const state = {};
  return {
    state,
    client: {
      async post(path, body) {
        if (path === '/api/v1/video/queue') {
          state.body = JSON.parse(JSON.stringify(body));
          throw new Error(SENTINEL);
        }
        throw new Error(`unexpected POST ${path}`);
      },
    },
  };
}

async function captureBody(series, shot) {
  const { client, state } = captureClient();
  const plan = {
    units: [{
      unitId: 'unit-001', unitType: 'single', shotNumbers: [shot.shotNumber],
      outputFile: `shot-00${shot.shotNumber}.mp4`, model: shot.videoModel,
      duration: shot.duration, startFrameStrategy: 'panel', endFrameStrategy: 'none',
      decisionReasons: [], fallbackToSingles: false,
    }],
  };
  try {
    await generateEpisodeVideos(client, series, [shot], sceneDir, plan);
  } catch (err) {
    if (!String(err?.message).includes(SENTINEL)) throw err;
  }
  return state.body;
}

// ── Case 1: Seedance R2V dialogue shot (voice ref + location in refs) ──────
const seedanceShot = {
  shotNumber: 1, type: 'dialogue', duration: '15s', videoModel: 'action',
  environment: 'NIGHT_INTERIOR', description: 'ARIA leans over the workbench and speaks.',
  characters: ['ARIA'], location: 'workshop', motion: 'high', useReferenceImages: true,
  dialogue: { character: 'ARIA', line: 'It finally works.', delivery: 'hushed awe' },
  cameraMovement: 'slow dolly forward', transition: 'CUT',
};

const seedanceBody = await captureBody(baseSeries, seedanceShot);
ok('Seedance: queue body captured', Boolean(seedanceBody));
ok('Seedance: model is reference-to-video', String(seedanceBody?.model).includes('reference-to-video'));
ok('Seedance: reference_audio_urls present (1 clip)',
  Array.isArray(seedanceBody?.reference_audio_urls) && seedanceBody.reference_audio_urls.length === 1);
ok('Seedance: reference audio is an audio data URI',
  /^data:audio\/(mpeg|wav);base64,/.test(seedanceBody?.reference_audio_urls?.[0] ?? ''));
// Slot plan: @Image1 ARIA front, @Image2 workshop wide, @Image3 workshop
// medium, @Image4 ARIA three-quarter (second angle) = 4 refs.
ok('Seedance: reference_image_urls carries the full slot plan (4)',
  Array.isArray(seedanceBody?.reference_image_urls) && seedanceBody.reference_image_urls.length === 4);
ok('Seedance: reference images are image data URIs',
  (seedanceBody?.reference_image_urls ?? []).every(u => /^data:image\//.test(u)));
ok('Seedance: prompt binds @Audio1 for voice identity',
  /Use @Audio1 only for voice identity/.test(seedanceBody?.prompt ?? ''));
ok('Seedance: prompt declares @Image1 is ARIA',
  /@Image1 is ARIA/.test(seedanceBody?.prompt ?? ''));
ok('Seedance: prompt tags @Image2 location environment',
  /@Image2 is the location environment reference/.test(seedanceBody?.prompt ?? ''));
ok('Seedance: prompt tags @Image3 as a second location angle',
  /@Image3 is a second angle of the same location/.test(seedanceBody?.prompt ?? ''));
ok('Seedance: prompt tags @Image4 as a second ARIA angle',
  /@Image4 is a second angle of ARIA/.test(seedanceBody?.prompt ?? ''));
ok('Seedance: NO image_url (pure reference mode)',
  seedanceBody?.image_url === undefined);
ok('Seedance: no scene_image_urls (not scene-capable)',
  seedanceBody?.scene_image_urls === undefined);

// ── Case 2: Seedance R2V with 3 characters STAYS in-family (9-image budget) ─
const threeCharShot = {
  shotNumber: 2, type: 'dialogue', duration: '10s', videoModel: 'action',
  environment: 'NIGHT_INTERIOR', description: 'ARIA, BEX and CID argue over the console.',
  characters: ['ARIA', 'BEX', 'CID'], location: 'workshop', motion: 'medium',
  useReferenceImages: true,
  dialogue: { character: 'ARIA', line: 'We do it now.', delivery: 'urgent' },
  cameraMovement: 'static', transition: 'CUT',
};

const threeCharBody = await captureBody(baseSeries, threeCharShot);
ok('Seedance 3-char: queue body captured', Boolean(threeCharBody));
ok('Seedance 3-char: stays on Seedance R2V (no Kling fallback under the 9-image budget)',
  String(threeCharBody?.model).includes('seedance') && String(threeCharBody?.model).includes('reference-to-video'));
// 3 primaries + 2 location angles + 3 second angles = 8 ≤ 9.
ok('Seedance 3-char: reference_image_urls carries 8 refs',
  Array.isArray(threeCharBody?.reference_image_urls) && threeCharBody.reference_image_urls.length === 8);
ok('Seedance 3-char: speaker voice ref present',
  Array.isArray(threeCharBody?.reference_audio_urls) && threeCharBody.reference_audio_urls.length === 1);

// ── Case 3: Kling O3 R2V (explicit) → location via scene_image_urls ────────
const klingSeries = {
  ...baseSeries,
  videoDefaults: {
    ...baseSeries.videoDefaults,
    actionModel: 'kling-o3-standard-reference-to-video',
    characterConsistencyModel: 'kling-o3-standard-reference-to-video',
  },
};
const klingShot = { ...threeCharShot, shotNumber: 2 };

const klingBody = await captureBody(klingSeries, klingShot);
ok('Kling: queue body captured', Boolean(klingBody));
ok('Kling: model is Kling O3 R2V',
  String(klingBody?.model).includes('kling') && String(klingBody?.model).includes('reference-to-video'));
ok('Kling: location in scene_image_urls (1)',
  Array.isArray(klingBody?.scene_image_urls) && klingBody.scene_image_urls.length === 1);
ok('Kling: scene image is an image data URI',
  /^data:image\//.test(klingBody?.scene_image_urls?.[0] ?? ''));
ok('Kling: NO reference_audio_urls (not reference-audio-capable)',
  klingBody?.reference_audio_urls === undefined);

// ── Case 4: MiniMax H3 R2V → 2K pinned, `audio` omitted, refs carried ──────
// H3's two hard constraints are enforced in the body, not just documented:
// 2K is its only resolution, and `audio` is not configurable so the field
// must not be sent at all (same shape as HappyHorse 1.1).
const h3Series = {
  ...baseSeries,
  videoDefaults: {
    ...baseSeries.videoDefaults,
    actionModel: 'minimax-h3-image-to-video',
    atmosphereModel: 'minimax-h3-image-to-video',
    characterConsistencyModel: 'minimax-h3-reference-to-video',
    videoFamilyPreference: 'minimax-h3',
  },
};
const h3Shot = { ...seedanceShot, shotNumber: 1, duration: '10s' };

const h3Body = await captureBody(h3Series, h3Shot);
ok('MiniMax H3: queue body captured', Boolean(h3Body));
ok('MiniMax H3: routes to the H3 R2V lane',
  h3Body?.model === 'minimax-h3-reference-to-video');
ok('MiniMax H3: resolution pinned to 2K', h3Body?.resolution === '2K');
ok('MiniMax H3: `audio` field omitted entirely (not configurable)',
  !Object.prototype.hasOwnProperty.call(h3Body ?? {}, 'audio'));
ok('MiniMax H3: aspect_ratio sent on the R2V lane', h3Body?.aspect_ratio === '16:9');
ok('MiniMax H3: duration stays on the 5-15s ladder',
  /^(5|6|7|8|9|10|11|12|13|14|15)s$/.test(h3Body?.duration ?? ''));
ok('MiniMax H3: reference_image_urls carried',
  Array.isArray(h3Body?.reference_image_urls) && h3Body.reference_image_urls.length > 0);
// Venice rejects image_url alongside reference media on this model, so pure
// reference mode is mandatory, not an optimization.
ok('MiniMax H3: NO image_url (pure reference mode is required, not optional)',
  h3Body?.image_url === undefined);
ok('MiniMax H3: NO end_image_url (same rejection rule)',
  h3Body?.end_image_url === undefined);
ok('MiniMax H3: prompt binds the @Image tags',
  /@Image1 is ARIA/.test(h3Body?.prompt ?? ''));
ok('MiniMax H3: no scene_image_urls (not scene-capable)',
  h3Body?.scene_image_urls === undefined);
ok('MiniMax H3: no elements (not elements-capable)',
  h3Body?.elements === undefined);

// ── Case 5: MiniMax H3 Max R2V → 768P pinned + a LEAN prompt ──────────────
// The two regressions this guards, both silent until a paid render:
//   1. `minimax-h3-max` must NOT fall through the `minimax-h3` substring
//      branch and get pinned to 2K — H3 Max rejects 2K outright.
//   2. `promptStyle: 'simple'` must actually strip the directorial blocks.
//      Identity (@ImageN) and the beat survive; blocking, the locked location
//      description, and the geography-hold lecture do not.
const h3MaxSeries = {
  ...baseSeries,
  videoDefaults: {
    ...baseSeries.videoDefaults,
    actionModel: 'minimax-h3-max-image-to-video',
    atmosphereModel: 'minimax-h3-max-image-to-video',
    characterConsistencyModel: 'minimax-h3-max-reference-to-video',
    videoFamilyPreference: 'minimax-h3-max',
  },
};
const h3MaxShot = {
  ...seedanceShot,
  shotNumber: 1,
  duration: '15s',
  blocking: 'ARIA at the workbench, screen left, facing right toward the door',
};

const h3MaxBody = await captureBody(h3MaxSeries, h3MaxShot);
ok('H3 Max: queue body captured', Boolean(h3MaxBody));
ok('H3 Max: routes to the H3 Max R2V lane',
  h3MaxBody?.model === 'minimax-h3-max-reference-to-video');
ok('H3 Max: resolution pinned to 768P, NOT 2K', h3MaxBody?.resolution === '768P');
ok('H3 Max: `audio` field omitted entirely (not configurable)',
  !Object.prototype.hasOwnProperty.call(h3MaxBody ?? {}, 'audio'));
ok('H3 Max: 15s duration survives (top of the ladder)', h3MaxBody?.duration === '15s');
ok('H3 Max: reference_image_urls carried',
  Array.isArray(h3MaxBody?.reference_image_urls) && h3MaxBody.reference_image_urls.length > 0);
ok('H3 Max: NO image_url (pure reference mode)', h3MaxBody?.image_url === undefined);
// Simple prompt: what stays.
ok('H3 Max: prompt still binds @Image1 to ARIA',
  /@Image1 is ARIA/.test(h3MaxBody?.prompt ?? ''));
ok('H3 Max: prompt still carries the beat',
  /leans over the workbench/.test(h3MaxBody?.prompt ?? ''));
ok('H3 Max: prompt still carries the dialogue line',
  /It finally works\./.test(h3MaxBody?.prompt ?? ''));
// Simple prompt: what goes.
ok('H3 Max: prompt drops the Blocking: clause',
  !/Blocking:/.test(h3MaxBody?.prompt ?? ''));
ok('H3 Max: prompt drops the locked Location: description',
  !/Location: a cramped sietch workshop/.test(h3MaxBody?.prompt ?? ''));
ok('H3 Max: prompt drops the geography-hold lecture',
  !/do not mirror, swap, or rearrange/.test(h3MaxBody?.prompt ?? '')
  && !/holds their stated position/.test(h3MaxBody?.prompt ?? ''));
ok('H3 Max: prompt is materially shorter than the directorial H3 prompt',
  (h3MaxBody?.prompt?.length ?? 0) < (h3Body?.prompt?.length ?? 0));
// And the base-H3 prompt must still be the FULL directorial one — the simple
// branch is opt-in per model, not a global downgrade.
ok('base H3 keeps the directorial Location: block',
  /Location: a cramped sietch workshop/.test(h3Body?.prompt ?? ''));

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} queue-body check(s) failed.`);
  process.exit(1);
}
console.log('\nAll queue-body reference checks passed.');
