// Wan 3.0 R2V exact lip-sync rides `reference_audio_urls`, not `audio_url`.
//
// Drives the real generateEpisodeVideos → renderSingleShotUnit → renderVideoFile
// path with a fake client that captures the /video/queue body and throws, so no
// network call or spend. Needs ffmpeg (builds a short dialogue mp3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import {
  MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  lipSyncModelNeedsKeyframe,
  resolveLipSyncModel,
} from '../dist/series/types.js';
import { VIDEO_MODELS, getVideoModel } from '../dist/venice/models.js';

const SENTINEL = '__CAPTURED_QUEUE__';
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'venice-wan3-lipsync-'));
  const sceneDir = join(dir, 'episodes', 'ep1', 'scene-01');
  mkdirSync(sceneDir, { recursive: true });
  mkdirSync(join(dir, 'characters', 'sam'), { recursive: true });
  for (const img of [join(dir, 'characters', 'sam', 'front.png'), join(sceneDir, 'shot-001.png')]) {
    writeFileSync(img, PNG);
    writeFileSync(img.replace(/\.png$/, '.provenance.json'), JSON.stringify({ generationModel: 'grok-imagine-image-2-0', hasFace: true }));
  }
  const audioDir = join(dir, 'episodes', 'ep1', 'audio');
  mkdirSync(audioDir, { recursive: true });
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-ac', '1', '-y',
    join(audioDir, 'dialogue-shot-001.mp3')], { stdio: 'ignore' });
  return { dir, sceneDir };
}

function series(dir, videoDefaults) {
  return {
    name: 'Lip', slug: 'lip', concept: 'c', genre: 'explainer', setting: 's',
    aesthetic: { style: 'Photoreal', palette: 'navy', lighting: 'soft key', lensCharacteristics: '35mm', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    characters: [{
      name: 'SAM', gender: 'male', age: 'early 40s', description: 'creator', fullDescription: 'SAM, creator',
      wardrobe: 'charcoal sweater', voiceDescription: 'smooth, even', voiceId: 'Eric', locked: true, seed: 1,
    }],
    locations: [], episodes: [], videoDefaults, outputDir: dir, createdAt: '', updatedAt: '',
  };
}

const SHOT = {
  shotNumber: 1, type: 'dialogue', duration: '5s', videoModel: 'action', environment: 'INTERIOR',
  description: 'SAM speaks to camera from his desk.', characters: ['SAM'], motion: 'low', faceVisible: true,
  useReferenceImages: true, cameraMovement: 'static', transition: 'CUT',
  dialogue: { character: 'SAM', line: 'One sentence. That is all I typed.', delivery: 'warm, direct to camera' },
};

async function capture(s, sceneDir) {
  const state = {};
  const client = {
    async post(path, body) {
      if (path === '/api/v1/video/queue') { state.body = JSON.parse(JSON.stringify(body)); throw new Error(SENTINEL); }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  const plan = { units: [{
    unitId: 'unit-001', unitType: 'single', shotNumbers: [1], outputFile: 'shot-001.mp4', model: 'action',
    duration: SHOT.duration, startFrameStrategy: 'panel', endFrameStrategy: 'none', decisionReasons: [], fallbackToSingles: false,
  }] };
  try {
    await generateEpisodeVideos(client, s, [SHOT], sceneDir, plan);
  } catch (err) {
    if (!String(err?.message).includes(SENTINEL)) throw err;
  }
  return state.body;
}

test('registry flag and capability set agree', () => {
  const flagged = VIDEO_MODELS.filter(m => m.lipSyncViaReferenceAudio).map(m => m.id).sort();
  assert.deepEqual(flagged, [...MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO].sort());
  for (const id of MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO) {
    assert.equal(getVideoModel(id)?.supportsReferenceImages, true, `${id} needs a reference-image lane`);
    assert.ok(!MODELS_SUPPORTING_AUDIO_INPUT.has(id), `${id} rejects audio_url`);
    assert.ok(!MODELS_SUPPORTING_REFERENCE_AUDIO.has(id), `${id} is not a voice-donor lane`);
  }
});

test('wan-3-0 family lip-syncs in-family, no keyframe pre-pass', () => {
  assert.equal(resolveLipSyncModel('wan-3-0'), 'wan-3-0-reference-to-video');
  assert.equal(lipSyncModelNeedsKeyframe('wan-3-0-reference-to-video'), false);
});

test('Wan 3.0 R2V lip-sync: dialogue in reference_audio_urls, refs only, resolution pinned', async () => {
  const { dir, sceneDir } = project();
  const body = await capture(series(dir, {
    actionModel: 'wan-3-0-image-to-video', atmosphereModel: 'wan-3-0-image-to-video',
    characterConsistencyModel: 'wan-3-0-reference-to-video', lipSyncModel: 'wan-3-0-reference-to-video',
    audioStrategy: 'lip-sync', videoFamilyPreference: 'wan-3-0', resolution: '1080p',
  }), sceneDir);
  assert.ok(body, 'queue body captured');
  assert.equal(body.model, 'wan-3-0-reference-to-video');
  assert.equal(body.audio_url, undefined);
  assert.equal(body.image_url, undefined);
  assert.equal(body.reference_audio_urls?.length, 1);
  assert.match(body.reference_audio_urls[0], /^data:audio\/mpeg;base64,/);
  assert.ok(body.reference_image_urls?.length >= 1);
  assert.equal(body.resolution, '1080p');
  assert.equal(body.aspect_ratio, '16:9');
  assert.match(body.prompt, /precise lip sync to that audio/);
  assert.match(body.prompt, /One sentence\. That is all I typed\./);
});

test('Seedance lip-sync still uses audio_url', async () => {
  const { dir, sceneDir } = project();
  const body = await capture(series(dir, {
    actionModel: 'seedance-2-5-reference-to-video', atmosphereModel: 'seedance-2-5-reference-to-video',
    characterConsistencyModel: 'seedance-2-5-reference-to-video', lipSyncModel: 'seedance-2-5-reference-to-video',
    audioStrategy: 'lip-sync', voiceReferenceForDialogue: false,
  }), sceneDir);
  assert.ok(body, 'queue body captured');
  assert.match(body.audio_url ?? '', /^data:audio\//);
  assert.doesNotMatch(body.prompt, /precise lip sync to that audio/);
});
