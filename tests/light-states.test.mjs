// Location light states (relights): a shot with `lightState` sends that
// light's plates (`<location dir>/light/<key>/<view>.png`) and words, in every
// lane, and a shot whose light has no plate for its staged view is refused
// before anything is billed. Runs under `npm test` after `npm run build`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMontageSlotPlan, buildReferenceSlotPlan, lightStateProblems, stagedPlateFor } from '../dist/mini-drama/reference-slots.js';
import { buildMontagePrompt, buildVideoPrompt } from '../dist/mini-drama/prompt-builder.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MODEL = 'seedance-2-5-reference-to-video';
const NIGHT = 'Night: the lagoon is deep blue, warm lantern points along the quay, never black';

function shot(n, fields = {}) {
  return { shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', description: `beat ${n}`, characters: ['ANNA'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...fields };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'light-states-'));
  mkdirSync(join(dir, 'characters', 'anna'), { recursive: true });
  writeFileSync(join(dir, 'characters', 'anna', 'front.png'), PNG);
  for (const slug of ['quay', 'bridge']) {
    mkdirSync(join(dir, 'locations', slug, 'light', 'night'), { recursive: true });
    for (const view of ['north', 'east', 'south', 'west']) writeFileSync(join(dir, 'locations', slug, `${view}.png`), PNG);
  }
  writeFileSync(join(dir, 'locations', 'quay', 'light', 'night', 'north.png'), PNG);
  writeFileSync(join(dir, 'locations', 'quay', 'light', 'night', 'west.png'), PNG);
  writeFileSync(join(dir, 'locations', 'bridge', 'light', 'night', 'east.png'), PNG);
  const series = {
    name: 'Light test', slug: 'light-test', outputDir: dir, episodes: [],
    characters: [{ name: 'ANNA', gender: 'female', age: '30', description: '', fullDescription: 'A courier.', wardrobe: 'a yellow raincoat', voiceDescription: '', locked: true, seed: 1 }],
    locations: [
      { name: 'The Quay', slug: 'quay', description: 'A stone quay.', lightingNotes: 'Morning, a low sun in haze', seed: 1, lightStates: { night: { name: 'night nocturne', lightingNotes: NIGHT } } },
      { name: 'The Bridge', slug: 'bridge', description: 'A stone footbridge.', lightingNotes: 'Morning, a low sun in haze', seed: 2, lightStates: { night: { name: 'night nocturne', lightingNotes: NIGHT } } },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'a low veiled morning sun', lensCharacteristics: '35mm', filmStock: 'digital' },
    videoDefaults: { montageMode: true },
  };
  return { dir, series };
}

const file = (slot) => slot.path.split('/locations/')[1];

test('a shot in a light state sends that light\'s plates, staged view first, and says so', () => {
  const { dir, series } = fixture();
  try {
    const plan = buildReferenceSlotPlan(series, shot(1, { location: 'quay', plateView: 'west', lightState: 'night' }), MODEL);
    const places = plan.slots.filter(s => s.kind === 'location');
    assert.deepEqual(places.map(file), ['quay/light/night/west.png', 'quay/light/night/north.png']);
    assert.match(places[0].roleClause, /staged on \(The Quay, west view, in its night nocturne light\)/);
    const day = buildReferenceSlotPlan(series, shot(2, { location: 'quay', plateView: 'west' }), MODEL);
    assert.deepEqual(day.slots.filter(s => s.kind === 'location').map(file), ['quay/west.png', 'quay/north.png', 'quay/south.png', 'quay/east.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a montage keeps one place in two lights apart, and each image names its light', () => {
  const { dir, series } = fixture();
  try {
    const shots = [
      shot(1, { location: 'quay', plateView: 'north' }),
      shot(2, { location: 'quay', plateView: 'north', lightState: 'night', continuity: { from: 'later' } }),
      shot(3, { location: 'bridge', plateView: 'east', lightState: 'night', continuity: { from: 'continuous' } }),
    ];
    const plan = buildMontageSlotPlan(series, shots, MODEL);
    const places = plan.slots.filter(s => s.kind === 'location');
    assert.deepEqual(places.map(file), ['quay/north.png', 'quay/light/night/north.png', 'bridge/light/night/east.png']);
    assert.doesNotMatch(places[0].roleClause, /night/);
    assert.match(places[1].roleClause, /\(the north view, in its night nocturne light\), for shot 2 only/);
    assert.equal(stagedPlateFor(series, shots[2]).light.key, 'night');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the light\'s words replace the location\'s and the look\'s lighting', () => {
  const { dir, series } = fixture();
  try {
    const lit = buildVideoPrompt(shot(1, { location: 'quay', plateView: 'north', lightState: 'night' }), series).prompt;
    assert.match(lit, new RegExp(`Lighting: ${NIGHT}\\.`));
    assert.doesNotMatch(lit, /low sun in haze|morning sun/);
    const day = buildVideoPrompt(shot(2, { location: 'quay', plateView: 'north' }), series).prompt;
    assert.match(day, /Lighting: Morning, a low sun in haze\./);
    assert.match(day, /a low veiled morning sun/);

    const night = [shot(1, { location: 'quay', plateView: 'north', lightState: 'night' }), shot(2, { location: 'bridge', plateView: 'east', lightState: 'night', continuity: { from: 'continuous' } })];
    const unit = { unitId: 'montage-s01', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'm.mp4', model: MODEL, duration: '10s', decisionReasons: [], montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }, { shotNumber: 2, startSec: 5, endSec: 10 }] };
    const montage = buildMontagePrompt(night, unit, series).prompt;
    assert.match(montage, /warm lantern points/);
    assert.doesNotMatch(montage, /morning sun/);
    // A unit that mixes lights keeps the look's own lighting line.
    const mixed = buildMontagePrompt([shot(1, { location: 'quay', plateView: 'north' }), night[1]], unit, series).prompt;
    assert.match(mixed, /a low veiled morning sun/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a light the place lacks, or a staged view not relit, is refused before spend', () => {
  const { dir, series } = fixture();
  try {
    assert.deepEqual(lightStateProblems(series, [shot(1, { location: 'quay', plateView: 'north', lightState: 'night' })]), []);
    const [noView] = lightStateProblems(series, [shot(2, { location: 'quay', plateView: 'east', lightState: 'night' })]);
    assert.match(noView, /Shot 2: no east plate in "night" light/);
    const [noState] = lightStateProblems(series, [shot(3, { location: 'quay', plateView: 'north', lightState: 'dusk' })]);
    assert.match(noState, /plays in "dusk" light, and The Quay has no such light state \(it has night\)/);
    assert.throws(() => buildReferenceSlotPlan(series, shot(3, { location: 'quay', lightState: 'dusk' }), MODEL), /no such light state/);
    // A picked plate or first frame stands in for the view.
    const staged = shot(4, { location: 'quay', plateView: 'east', lightState: 'night', stagingRef: { use: 'start-frame', path: 'x.png' } });
    assert.deepEqual(lightStateProblems(series, [staged]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
