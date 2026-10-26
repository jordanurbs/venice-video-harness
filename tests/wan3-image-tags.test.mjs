// Wan 3.0 R2V renders in pure reference mode with @ImageN tags (probe 2026-10-26).
//
// Drives generateEpisodeVideos with a fake client that captures the
// /video/queue body and throws, so no network call or spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import { MODELS_USING_IMAGE_TAGS, MODELS_SUPPORTING_REFERENCE_IMAGES } from '../packages/core/dist/series/types.js';

const SENTINEL = '__CAPTURED_QUEUE__';
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

test('wan-3-0-reference-to-video is an @Image-tag reference lane', () => {
  assert.ok(MODELS_USING_IMAGE_TAGS.has('wan-3-0-reference-to-video'));
  assert.ok(MODELS_SUPPORTING_REFERENCE_IMAGES.has('wan-3-0-reference-to-video'));
});

test('a native-dialogue Wan 3.0 R2V shot sends refs only and tags the characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-wan3-tags-'));
  const sceneDir = join(dir, 'episodes', 'ep1', 'scene-01');
  mkdirSync(sceneDir, { recursive: true });
  const images = [join(sceneDir, 'shot-001.png')];
  for (const name of ['ann', 'bob']) {
    mkdirSync(join(dir, 'characters', name), { recursive: true });
    images.push(join(dir, 'characters', name, 'front.png'));
  }
  for (const img of images) {
    writeFileSync(img, PNG);
    writeFileSync(img.replace(/\.png$/, '.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', hasFace: true }));
  }
  const character = (name, wardrobe) => ({
    name, gender: 'female', age: '30s', description: 'd', fullDescription: `${name}, d`,
    wardrobe, voiceDescription: 'warm', locked: true, seed: 1,
  });
  const series = {
    name: 'Tags', slug: 'tags', concept: 'c', genre: 'drama', setting: 's',
    aesthetic: { style: 'Photoreal', palette: 'muted', lighting: 'hard key', lensCharacteristics: '35mm', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    characters: [character('ANN', 'cream cardigan'), character('BOB', 'brown suit')],
    locations: [], episodes: [], outputDir: dir, createdAt: '', updatedAt: '',
    videoDefaults: {
      actionModel: 'wan-3-0-reference-to-video', atmosphereModel: 'wan-3-0-reference-to-video',
      characterConsistencyModel: 'wan-3-0-reference-to-video', audioStrategy: 'native',
      videoFamilyPreference: 'wan-3-0', voiceReferenceForDialogue: false,
    },
  };
  const shot = {
    shotNumber: 1, type: 'dialogue', duration: '5s', videoModel: 'action', environment: 'INTERIOR',
    description: 'ANN stands at frame left; BOB sits tied to a chair at frame right.',
    characters: ['ANN', 'BOB'], motion: 'low', faceVisible: true, useReferenceImages: true,
    cameraMovement: 'static', transition: 'CUT',
    dialogue: { character: 'ANN', line: 'You said it twice.', delivery: 'deadpan' },
  };
  const state = {};
  const client = {
    async post(path, body) {
      if (path === '/api/v1/video/queue') { state.body = JSON.parse(JSON.stringify(body)); throw new Error(SENTINEL); }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  const plan = { units: [{
    unitId: 'unit-001', unitType: 'single', shotNumbers: [1], outputFile: 'shot-001.mp4', model: 'character',
    duration: '5s', startFrameStrategy: 'panel', endFrameStrategy: 'none', decisionReasons: [], fallbackToSingles: false,
  }] };
  try {
    await generateEpisodeVideos(client, series, [shot], sceneDir, plan);
  } catch (err) {
    if (!String(err?.message).includes(SENTINEL)) throw err;
  }
  const body = state.body;
  assert.ok(body, 'queue body captured');
  assert.equal(body.model, 'wan-3-0-reference-to-video');
  assert.equal(body.image_url, undefined, 'pure reference mode sends no start frame');
  assert.equal(body.reference_image_urls?.length, 2);
  assert.match(body.prompt, /@Image1/);
  assert.match(body.prompt, /@Image2/);
});
