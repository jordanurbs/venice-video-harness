// `-basic` Seedance ids are faces-off twins.
//
// Venice lists each Seedance lane twice: the plain id (face-capable) and a
// `-basic` twin that runs without face handling and refuses any input image
// that shows a person (422 provider_content_policy, refunded). Evidence: 31 of
// 32 takes with a character reference failed on a `-basic` id in one project.
//
// This test covers the three layers of the fix:
//   1. registry: the three `seedance-2-0-*-basic` specs carry `facesOff: true`
//      and `isFacesOffModel` / `faceCapableTwinId` read it (with an id-shape
//      fallback for the live-listed 2.5 spellings the registry does not list);
//   2. preflight: `checkFacesOffCompatible` reads the `hasFace` provenance
//      sidecars and refuses the combination, naming the twin;
//   3. routing + render: `resolveVideoModel` never picks a faces-off id for a
//      shot with people, and `renderVideoFile` refuses one that reaches it
//      through an explicit `unit.model`, before any HTTP call.
//
// Capture client; no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getVideoModel, isFacesOffModel, faceCapableTwinId, VIDEO_MODELS } from '../packages/core/dist/venice/models.js';
import {
  checkFacesOffCompatible,
  assertFacesOffCompatible,
  FacesOffModelError,
} from '../dist/venice/seedance-preflight.js';
import { resolveVideoModel, buildMultiShotPrompt } from '../dist/mini-drama/prompt-builder.js';
import { renderVideoFile } from '../dist/mini-drama/video-generator.js';

const BASIC_IDS = [
  'seedance-2-0-text-to-video-basic',
  'seedance-2-0-image-to-video-basic',
  'seedance-2-0-reference-to-video-basic',
];

// ---- 1. registry -----------------------------------------------------------

test('the three seedance-2-0-*-basic specs are flagged facesOff and nothing else is', () => {
  for (const id of BASIC_IDS) {
    assert.equal(getVideoModel(id)?.facesOff, true, `${id} should be facesOff`);
  }
  const flagged = VIDEO_MODELS.filter(m => m.facesOff).map(m => m.id).sort();
  assert.deepEqual(flagged, [...BASIC_IDS].sort());
});

test('isFacesOffModel reads the registry and falls back to the id shape for unlisted -basic spellings', () => {
  for (const id of BASIC_IDS) assert.equal(isFacesOffModel(id), true);
  assert.equal(isFacesOffModel('seedance-2-0-reference-to-video'), false);
  assert.equal(isFacesOffModel('seedance-2-5-reference-to-video'), false);
  assert.equal(isFacesOffModel('kling-o3-standard-reference-to-video'), false);
  // Live-listed but not in the registry: the id shape decides.
  assert.equal(getVideoModel('seedance-2-5-reference-to-video-basic'), undefined);
  assert.equal(isFacesOffModel('seedance-2-5-reference-to-video-basic'), true);
  // Not a Seedance id: the suffix alone is not enough.
  assert.equal(isFacesOffModel('some-other-model-basic'), false);
});

test('faceCapableTwinId strips -basic from faces-off ids and leaves everything else alone', () => {
  assert.equal(faceCapableTwinId('seedance-2-0-reference-to-video-basic'), 'seedance-2-0-reference-to-video');
  assert.equal(faceCapableTwinId('seedance-2-5-image-to-video-basic'), 'seedance-2-5-image-to-video');
  assert.equal(faceCapableTwinId('seedance-2-0-reference-to-video'), 'seedance-2-0-reference-to-video');
  assert.equal(faceCapableTwinId('kling-o3-pro-text-to-video'), 'kling-o3-pro-text-to-video');
  // Every faces-off registry entry has a registered face-capable twin.
  for (const id of BASIC_IDS) {
    assert.ok(getVideoModel(faceCapableTwinId(id)), `${faceCapableTwinId(id)} must be in the registry`);
  }
});

// ---- 2. preflight ----------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'faces-off-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function image(dir, name, hasFace) {
  const path = join(dir, name);
  writeFileSync(path, PNG);
  if (hasFace !== 'no-sidecar') {
    const prov = { generationModel: 'seedream-v5-lite', editModels: [] };
    if (hasFace !== undefined) prov.hasFace = hasFace;
    writeFileSync(path.replace(/\.png$/, '.provenance.json'), JSON.stringify(prov));
  }
  return path;
}

test('checkFacesOffCompatible: face-capable ids and image-less requests always pass', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const face = image(dir, 'front.png', true);
    assert.equal(await checkFacesOffCompatible({ model: 'seedance-2-0-reference-to-video', imagePaths: [face], characters: ['ARIA'] }), undefined);
    assert.equal(await checkFacesOffCompatible({ model: 'seedance-2-0-text-to-video-basic', imagePaths: [], characters: ['ARIA'] }), undefined);
    // Remote / data URLs carry no sidecar; nothing to screen.
    assert.equal(await checkFacesOffCompatible({ model: 'seedance-2-0-image-to-video-basic', imagePaths: ['data:image/png;base64,AAAA'], characters: [] }), undefined);
  } finally {
    cleanup();
  }
});

test('checkFacesOffCompatible: a faces-off id with a hasFace:true image is refused, naming the twin', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const face = image(dir, 'front.png', true);
    const plate = image(dir, 'north.png', false);
    const v = await checkFacesOffCompatible({
      model: 'seedance-2-0-reference-to-video-basic',
      imagePaths: [face, plate],
      characters: ['ARIA'],
    });
    assert.ok(v, 'expected a violation');
    assert.equal(v.faceCapableModel, 'seedance-2-0-reference-to-video');
    assert.deepEqual(v.faceImages, [face], 'the faceless plate must not be listed');
    assert.match(v.message, /ARIA/);
    assert.match(v.message, /seedance-2-0-reference-to-video-basic runs without Seedance's face handling/);
    assert.match(v.message, /Use seedance-2-0-reference-to-video/);
    assert.match(v.message, /No request was submitted/);
  } finally {
    cleanup();
  }
});

test('checkFacesOffCompatible: only an explicit hasFace:false clears an image when the shot has people', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const unknown = image(dir, 'panel.png', undefined);       // sidecar without hasFace
    const noSidecar = image(dir, 'anchor.png', 'no-sidecar'); // no sidecar at all
    const plate = image(dir, 'north.png', false);
    const withPeople = await checkFacesOffCompatible({
      model: 'seedance-2-0-image-to-video-basic',
      imagePaths: [unknown, noSidecar, plate],
      characters: ['BEX'],
    });
    assert.ok(withPeople);
    assert.deepEqual(withPeople.faceImages.sort(), [unknown, noSidecar].sort());

    // Same images, no people on the shot: undecided images are not assumed to show a face.
    const noPeople = await checkFacesOffCompatible({
      model: 'seedance-2-0-image-to-video-basic',
      imagePaths: [unknown, noSidecar, plate],
      characters: [],
    });
    assert.equal(noPeople, undefined);
  } finally {
    cleanup();
  }
});

test('assertFacesOffCompatible throws FacesOffModelError carrying the violation', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const face = image(dir, 'front.png', true);
    await assert.rejects(
      assertFacesOffCompatible({ model: 'seedance-2-0-reference-to-video-basic', imagePaths: [face] }),
      (err) => err instanceof FacesOffModelError && err.violation.faceCapableModel === 'seedance-2-0-reference-to-video',
    );
  } finally {
    cleanup();
  }
});

// ---- 3. routing + render ---------------------------------------------------

const series = (videoDefaults) => ({
  name: 'S', slug: 's', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic', palette: 'warm', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters: [{ name: 'ARIA', gender: 'female', age: '20s', description: 'inventor', fullDescription: 'ARIA', wardrobe: 'jacket', locked: true, seed: 1 }],
  locations: [],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-reference-to-video',
    atmosphereModel: 'seedance-2-0-text-to-video-basic',
    imageDefaults: { generationModel: 'seedream-v5-lite', editModel: 'seedream-v5-lite-edit' },
    ...videoDefaults,
  },
  outputDir: '/tmp/unused',
  createdAt: '', updatedAt: '',
});

const shot = (characters, extra = {}) => ({
  shotNumber: 1, type: 'action', duration: '5s', videoModel: 'atmosphere',
  environment: 'DAY_EXTERIOR', description: 'd', characters, cameraMovement: 'static', transition: 'CUT',
  ...extra,
});

test('resolveVideoModel: a faces-off characterConsistencyModel is swapped for its twin on shots with people', () => {
  const s = series({ characterConsistencyModel: 'seedance-2-0-reference-to-video-basic' });
  const withPeople = resolveVideoModel(shot(['ARIA']), s);
  assert.equal(withPeople.modelId, 'seedance-2-0-reference-to-video');
  assert.match(withPeople.reason, /runs without face handling/);
  // No people: the configured faces-off atmosphere id is fine (text-only render).
  const noPeople = resolveVideoModel(shot([]), s);
  assert.equal(noPeople.modelId, 'seedance-2-0-text-to-video-basic');
});

test('resolveVideoModel: a faces-off lipSyncModel is swapped too', () => {
  const s = series({
    characterConsistencyModel: 'seedance-2-0-reference-to-video',
    lipSyncModel: 'seedance-2-0-reference-to-video-basic',
    audioStrategy: 'lip-sync',
  });
  const r = resolveVideoModel(shot(['ARIA'], {
    type: 'dialogue', motion: 'low',
    dialogue: { character: 'ARIA', line: 'hi', delivery: 'soft' },
  }), s);
  assert.equal(r.modelId, 'seedance-2-0-reference-to-video');
});

test('buildMultiShotPrompt: an explicit faces-off unit.model is swapped when any shot in the unit has people', () => {
  const s = series({});
  const shots = [shot([], { shotNumber: 1 }), shot(['ARIA'], { shotNumber: 2 })];
  const unit = {
    unitId: 'u', unitType: 'multi-shot', shotNumbers: [1, 2], outputFile: 'u.mp4',
    model: 'seedance-2-0-reference-to-video-basic', duration: '10s',
    startFrameStrategy: 'none', endFrameStrategy: 'none', decisionReasons: [], fallbackToSingles: false,
  };
  assert.equal(buildMultiShotPrompt(shots, unit, s).model, 'seedance-2-0-reference-to-video');
});

test('renderVideoFile refuses a faces-off id with a face-bearing reference before any HTTP call', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const face = image(dir, 'front.png', true);
    const calls = [];
    const client = { async post(path) { calls.push(path); throw new Error('must not be called'); } };
    await assert.rejects(
      renderVideoFile(client, {
        prompt: { prompt: 'p', model: 'seedance-2-0-reference-to-video-basic', duration: '5s', audio: true },
        outputPath: join(dir, 'out.mp4'),
        referenceImagePaths: [face],
        characters: ['ARIA'],
        forceRequeue: true,
      }),
      FacesOffModelError,
    );
    assert.equal(calls.length, 0, 'no HTTP call may be made');
  } finally {
    cleanup();
  }
});
