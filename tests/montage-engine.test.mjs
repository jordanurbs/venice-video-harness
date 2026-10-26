// The montage engine (2026-10-25): a continuous run across places stays one
// generation, its references are the staged views in first-appearance order,
// the prompt is a shot list, the cutter snaps to the detected cuts, and a
// re-take covers whole units. The SEQUENCE fallback keeps its old grouping and
// references, and a unit whose shots name no plateView keeps the old reference
// load. No network calls, no ffmpeg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupShotsIntoScenes, planMontageUnits, snapBoundaries } from '../dist/mini-drama/montage.js';
import { resolveUnitShots, unitIndicesForShots } from '../dist/mini-drama/generation-planner.js';
import { buildMontageSlotPlan, buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';
import { buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MODEL = 'seedance-2-5-reference-to-video';

function shot(n, fields = {}) {
  return { shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', description: `beat ${n}`, characters: [], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...fields };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'montage-engine-'));
  for (const slug of ['anna', 'leo', 'harbour-ferry', 'brass-compass']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', slug, 'three-quarter.png'), PNG);
  }
  for (const slug of ['ferry-landing', 'bay-deck']) {
    mkdirSync(join(dir, 'locations', slug), { recursive: true });
    for (const view of ['north', 'east', 'south', 'west']) writeFileSync(join(dir, 'locations', slug, `${view}.png`), PNG);
  }
  const person = { gender: 'female', age: '30', description: '', voiceDescription: '', locked: true, seed: 1 };
  const series = {
    name: 'Engine test', slug: 'engine-test', outputDir: dir, episodes: [],
    characters: [
      { ...person, name: 'ANNA', fullDescription: 'A newcomer.', wardrobe: 'a dove-grey overcoat' },
      { ...person, name: 'LEO', fullDescription: 'A steward.', wardrobe: 'navy livery' },
      { ...person, name: 'HARBOUR FERRY', gender: 'other', prop: true, description: 'a navy electric passenger ferry', fullDescription: 'A ferry.', wardrobe: '' },
      { ...person, name: 'BRASS COMPASS', gender: 'other', prop: true, description: 'a brass pocket compass', fullDescription: 'A compass.', wardrobe: '' },
    ],
    locations: [
      { name: 'Ferry Landing', slug: 'ferry-landing', description: 'The harbour landing stage.', spatialAnchors: 'View 1 (north): the ferry moored alongside, its gangway down. View 2 (east): the bow. View 3 (south): the colonnade. View 4 (west): open water, no boat.', seed: 1 },
      { name: 'Bay Deck', slug: 'bay-deck', description: 'The forward deck of the ferry under way.', spatialAnchors: 'View 1 (north): the bow rail, the city ahead. View 2 (east): open water. View 3 (south): the saloon front. View 4 (west): the wake.', seed: 2 },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    videoDefaults: { montageMode: true },
  };
  const journey = [
    shot(1, { location: 'ferry-landing', characters: ['ANNA', 'LEO', 'HARBOUR FERRY'], description: 'LEO hands ANNA onto the gangway of the HARBOUR FERRY.', continuity: { from: 'new-scene', endState: 'ANNA aboard, the gangway coming in' } }),
    shot(2, { location: 'ferry-landing', plateView: 'west', duration: '4s', characters: ['LEO', 'HARBOUR FERRY'], description: 'The HARBOUR FERRY pulls away; LEO stands on the stage.', continuity: { from: 'continuous' } }),
    shot(3, { location: 'bay-deck', characters: ['ANNA'], description: 'ANNA at the bow rail, the city ahead.', stagedOn: 'the bow rail, centre, the city ahead', continuity: { from: 'continuous' } }),
    shot(4, { location: 'bay-deck', type: 'insert', duration: '4s', characters: ['ANNA', 'BRASS COMPASS'], description: 'ANNA opens the BRASS COMPASS at the rail.', continuity: { from: 'continuous' } }),
  ];
  return { dir, series, journey };
}

const single = (s) => ({ unitId: `single-${s.shotNumber}`, unitType: 'single', shotNumbers: [s.shotNumber], outputFile: `shot-${s.shotNumber}.mp4`, model: MODEL, duration: s.duration, decisionReasons: [] });

function montageUnit(shots, ...windows) {
  let at = 0;
  const montageBeats = shots.map((s, i) => {
    const beat = { shotNumber: s.shotNumber, startSec: at, endSec: at + windows[i] };
    at += windows[i];
    return beat;
  });
  return { unitId: 'montage-s01', unitType: 'montage', shotNumbers: shots.map(s => s.shotNumber), outputFile: 'm.mp4', model: MODEL, duration: `${at}s`, decisionReasons: [], montageBeats };
}

const slotNames = (plan) => plan.slots.map(s => `${s.kind}:${s.label}:${s.path.split('/').pop()}`);

test('a continuous run stays one scene across places; new-scene and an unmarked place change still split', () => {
  const shots = [
    shot(1, { location: 'a' }),
    shot(2, { location: 'b', continuity: { from: 'continuous' } }),
    shot(3, { location: 'b' }),
    shot(4, { location: 'c', continuity: { from: 'later' } }),
    shot(5, { location: 'c' }),
    shot(6, { location: 'c', continuity: { from: 'new-scene' } }),
  ];
  const scenes = groupShotsIntoScenes(shots);
  assert.deepEqual(scenes.map(s => s.shots.map(x => x.shotNumber)), [[1, 2, 3], [4, 5], [6]]);
  assert.deepEqual(scenes[0].locations, ['a', 'b']);
  assert.equal(scenes[0].location, 'a');
  // Scripts without continuity group exactly as before.
  const old = groupShotsIntoScenes([shot(1, { location: 'a' }), shot(2, { location: 'b' }), shot(3, { location: 'b' }), shot(4), shot(5, { location: 'c' })]);
  assert.deepEqual(old.map(s => s.shots.map(x => x.shotNumber)), [[1], [2, 3, 4], [5]]);
  // The SEQUENCE grammar ignores continuity: one location per scene, as before it existed.
  const sequence = groupShotsIntoScenes(shots, { continuity: false });
  assert.deepEqual(sequence.map(s => s.shots.map(x => x.shotNumber)), [[1], [2, 3], [4, 5, 6]]);
  assert.ok(sequence.every(s => s.locations.length === 1));
});

test('the planner renders the journey as one montage; a continuous insert rides in it, a lone insert stays single', () => {
  const { dir, series, journey } = fixture();
  try {
    const plan = planMontageUnits({ episode: 1, shots: journey }, series, single);
    assert.equal(plan.units.length, 1);
    assert.equal(plan.units[0].unitType, 'montage');
    assert.deepEqual(plan.units[0].shotNumbers, [1, 2, 3, 4]);
    assert.match(plan.units[0].decisionReasons.join(' '), /ferry-landing → bay-deck/);
    assert.match(plan.units[0].decisionReasons.join(' '), /across places/);
    const lone = planMontageUnits({ episode: 1, shots: [journey[0], { ...journey[3], continuity: undefined, location: 'ferry-landing' }] }, series, single);
    assert.deepEqual(lone.units.map(u => [u.unitType, u.shotNumbers.join(',')]), [['montage', '1'], ['single', '4']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('montageGrammar sequence brings back the SEQUENCE grouping, single inserts and first-shot references', () => {
  const { dir, series, journey } = fixture();
  try {
    const sequenceSeries = { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar: 'sequence' } };
    const plan = planMontageUnits({ episode: 1, shots: journey }, sequenceSeries, single);
    // Split on the change of place, and the continuous insert is a single again.
    assert.deepEqual(plan.units.map(u => [u.unitType, u.shotNumbers.join(',')]), [['montage', '1,2'], ['montage', '3'], ['single', '4']]);
    assert.match(plan.units[0].decisionReasons.join(' '), /SEQUENCE/);
    assert.doesNotMatch(plan.units[0].decisionReasons.join(' '), /across places/);

    const landing = buildMontagePrompt(journey.slice(0, 2), plan.units[0], sequenceSeries);
    assert.match(landing.prompt, /SEQUENCE:/);
    const expected = buildReferenceSlotPlan(sequenceSeries, { ...journey[0], characters: ['ANNA', 'LEO', 'HARBOUR FERRY'] }, MODEL, { characterNames: ['ANNA', 'LEO', 'HARBOUR FERRY'] });
    assert.deepEqual(landing.referenceSlots, expected.slots);
    assert.ok(landing.referenceSlots.filter(s => s.kind === 'location').every(s => s.label === 'ferry-landing'));
    // The deck unit gets the deck's plates, which the merged unit's first shot never carried.
    const deck = buildMontagePrompt([journey[2]], plan.units[1], sequenceSeries);
    const deckPlates = deck.referenceSlots.filter(s => s.kind === 'location');
    assert.equal(deckPlates.length, 4);
    assert.ok(deckPlates.every(s => s.label === 'bay-deck'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the montage slot plan: first-appearance order, staged views only, and each place says which shots it serves', () => {
  const { dir, series, journey } = fixture();
  try {
    const plan = buildMontageSlotPlan(series, journey, MODEL);
    assert.deepEqual(slotNames(plan), [
      'character-primary:ANNA:front.png',
      'character-primary:LEO:front.png',
      'character-primary:HARBOUR FERRY:front.png',
      'location:ferry-landing:north.png',
      'location:ferry-landing:west.png',
      'location:bay-deck:north.png',
      'character-primary:BRASS COMPASS:front.png',
    ]);
    assert.deepEqual([...plan.placeByShot.entries()], [[1, 4], [2, 5], [3, 6], [4, 6]]);
    assert.match(plan.slots[3].roleClause, /^is Ferry Landing \(the north view\), for shot 1 only: the ferry moored alongside/);
    assert.match(plan.slots[5].roleClause, /for shots 3 and 4 only: the bow rail, centre, the city ahead\. It does not set where people, vehicles or props are in any other shot/);
    // `all` adds every view of each place and the second angles, after the essentials they belong to.
    const all = buildMontageSlotPlan(series, journey, MODEL, { views: 'all' });
    assert.equal(all.slots.filter(s => s.kind === 'location').length, 8);
    assert.equal(all.slots.filter(s => s.kind === 'character-angle').length, 4);
    // A short budget drops the extras first, then later views of a place already shown.
    const tight = buildMontageSlotPlan(series, journey, 'some-four-image-model', { views: 'all' });
    assert.equal(tight.slots.length, 4);
    assert.ok(tight.dropped.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a unit whose shots name no plateView sends what a montage always sent', () => {
  const { dir, series, journey } = fixture();
  try {
    writeFileSync(join(dir, 'locations', 'ferry-landing', 'reverse-angle.png'), PNG);
    const unstaged = journey.map(({ plateView, ...rest }) => rest);
    const cast = ['ANNA', 'LEO', 'HARBOUR FERRY'];

    // One place: exactly the plan the SEQUENCE grammar sends, every view, the
    // custom angle and the second angles, whatever montageReferenceViews says.
    for (const views of ['staged', 'all']) {
      const plan = buildMontageSlotPlan(series, unstaged.slice(0, 2), MODEL, { views });
      const old = buildReferenceSlotPlan(series, { ...unstaged[0], characters: cast }, MODEL, { characterNames: cast });
      assert.deepEqual(plan.slots, old.slots);
      assert.deepEqual(plan.slots.filter(s => s.kind === 'location').map(s => s.path.split('/').pop()),
        ['north.png', 'south.png', 'east.png', 'west.png', 'reverse-angle.png']);
      assert.equal(plan.slots.filter(s => s.kind === 'character-angle').length, 3);
      assert.ok(plan.slots.every(s => !/the north view|only:/.test(s.roleClause)), 'no claim about a staged view the script never named');
      const firstPlate = plan.slots.find(s => s.kind === 'location').imageIndex;
      assert.deepEqual([...plan.placeByShot.entries()], [[1, firstPlate], [2, firstPlate]]);
    }

    // A continuous run across places with no plateView: each place's plates, in order.
    const run = buildMontageSlotPlan(series, unstaged, MODEL);
    const plates = run.slots.filter(s => s.kind === 'location');
    assert.deepEqual(plates.map(s => s.label), [...Array(5).fill('ferry-landing'), ...Array(4).fill('bay-deck')]);
    const deckFirst = plates.find(s => s.label === 'bay-deck').imageIndex;
    assert.equal(run.placeByShot.get(1), plates[0].imageIndex);
    assert.equal(run.placeByShot.get(4), deckFirst);
    assert.match(run.slots[deckFirst - 1].roleClause, /^is the location environment reference \(Bay Deck\)/);

    // The prompt points each shot at its place's first plate.
    const unit = montageUnit(unstaged.slice(0, 2), 5, 4);
    const { prompt, referenceSlots } = buildMontagePrompt(unstaged.slice(0, 2), unit, series);
    const landingFirst = referenceSlots.find(s => s.kind === 'location').imageIndex;
    assert.match(prompt, new RegExp(`\\nShot 1 \\| 0-5s \\| Ferry Landing \\(@Image${landingFirst}\\):`));
    assert.match(prompt, new RegExp(`@Image${landingFirst} is the location environment reference \\(Ferry Landing\\)`));
    assert.equal(referenceSlots.length, 3 + 5 + 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shot-list prompt: places per shot, Cut to, the abrupt-cut line, a vehicle count line, @Image tags that match the slots', () => {
  const { dir, series, journey } = fixture();
  try {
    const unit = montageUnit(journey, 5, 4, 5, 4);
    const out = buildMontagePrompt(journey, unit, series);
    const p = out.prompt;
    assert.match(p, /^One continuous scene in 4 connected shots, in story order, moving through Ferry Landing, then Bay Deck\. No music/);
    assert.match(p, /References, in the order they first appear:\n@Image1 is ANNA — wearing a dove-grey overcoat/);
    assert.match(p, /@Image3 is the HARBOUR FERRY, an object, not a person.*Exactly one HARBOUR FERRY in this scene, and no other boats/);
    assert.doesNotMatch(p, /Exactly one BRASS COMPASS/);
    assert.match(p, /\nShot 1 \| 0-5s \| Ferry Landing \(@Image4\): .*@Image2 hands @Image1 onto the gangway of the @Image3\./);
    assert.match(p, /\nCut to Shot 2 \| 5-9s \| Ferry Landing \(@Image5\):/);
    assert.match(p, /\nCut to Shot 3 \| 9-14s \| Bay Deck \(@Image6\):/);
    assert.match(p, /Cut to Shot 2 \| 5-9s \| Ferry Landing \(@Image5\): .*It starts where shot 1 ends: @Image1 aboard, the gangway coming in\./);
    assert.match(p, /Every cut is an abrupt single-frame hard cut: the two images never blend\./);
    assert.match(p, /never carry one place's background into another place's shot/);
    assert.match(p, /STYLE: .*Face stable throughout, no deformation\. Diegetic sound only\. No music, no BGM/);
    assert.doesNotMatch(p, /SEQUENCE:|fast-cut montage|\d+ seconds\./);
    // The @ImageN in the prompt and the push order of reference_image_urls come from the same slot list.
    assert.deepEqual(out.referenceSlots.map(s => s.imageIndex), [1, 2, 3, 4, 5, 6, 7]);
    // The SEQUENCE grammar is one setting away.
    const old = buildMontagePrompt(journey, unit, { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar: 'sequence' } });
    assert.match(old.prompt, /fast-cut montage/);
    assert.match(old.prompt, /SEQUENCE:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a place named after a cast member keeps its name, and a wardrobe ending in a full stop is not doubled', () => {
  const { dir, series, journey } = fixture();
  try {
    series.locations[0].name = 'Harbour Ferry Landing';
    series.characters[0].wardrobe = 'a dove-grey overcoat.';
    const unit = montageUnit(journey.slice(0, 2), 5, 4);
    const { prompt } = buildMontagePrompt(journey.slice(0, 2), unit, series);
    assert.match(prompt, /@Image4 is Harbour Ferry Landing \(the north view\), for shot 1 only/);
    assert.match(prompt, /\nShot 1 \| 0-5s \| Harbour Ferry Landing \(@Image4\):/);
    assert.match(prompt, /wearing a dove-grey overcoat\. Wardrobe locked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an over-long shot-list prompt shrinks the shot prose, never below 40%, and keeps the STYLE tail', () => {
  const { dir, series, journey } = fixture();
  const build = (repeat) => {
    const long = journey.map(s => ({ ...s, description: `${s.description} ${'the light moves over the water, '.repeat(repeat)}`, blocking: 'ANNA screen left, LEO screen right. '.repeat(20) }));
    const warn = console.warn;
    console.warn = () => {};
    try {
      return { long, prompt: buildMontagePrompt(long, montageUnit(long, 5, 4, 5, 4), series).prompt };
    } finally {
      console.warn = warn;
    }
  };
  try {
    const { prompt } = build(60);
    assert.ok(prompt.length <= 8000, `shrunk to the guard (${prompt.length})`);
    assert.match(prompt, /STYLE: .*No music, no BGM, no soundtrack, no subtitles, no on-screen text\.\nNegative: /);
    assert.match(prompt, /Every cut is an abrupt single-frame hard cut/);
    assert.match(prompt.split('\n').find(line => line.startsWith('Shot 1 |')), /…/);

    // Far over: the prose stops at 40% of itself and the prompt goes out long, STYLE whole.
    const far = build(400);
    assert.ok(far.prompt.length > 8000);
    assert.match(far.prompt, /STYLE: .*no on-screen text\.\nNegative: /);
    const shotOne = far.prompt.split('\n').find(line => line.startsWith('Shot 1 |'));
    assert.ok(shotOne.length >= 0.4 * far.long[0].description.length, 'shot prose keeps at least 40%');
    assert.ok(shotOne.length < 0.5 * far.long[0].description.length + 1000, 'and is shrunk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an over-long SEQUENCE prompt shrinks the beat prose instead of cutting off the STYLE tail', () => {
  const { dir, series, journey } = fixture();
  try {
    const sequenceSeries = { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar: 'sequence' } };
    const shots = journey.slice(0, 2).map(s => ({ ...s, description: `${s.description} ${'the light moves over the water, '.repeat(90)}` }));
    const unit = montageUnit(shots, 5, 4);
    const warn = console.warn;
    console.warn = () => {};
    let prompt;
    try {
      ({ prompt } = buildMontagePrompt(shots, unit, sequenceSeries));
    } finally {
      console.warn = warn;
    }
    assert.ok(prompt.length <= 5000, `within the guard (${prompt.length})`);
    assert.match(prompt, /STYLE: .*Face stable throughout, no deformation\. Diegetic sound only, no music, no on-screen text\.\nNegative: [^\n]+\.$/);
    assert.match(prompt, /\[0:00-0:05\] @Image2 hands @Image1 onto the gangway[^\n]*…/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cutter snaps each planned cut to a detected cut, once each, in order', () => {
  const snapped = snapBoundaries([5, 9, 14, 18], [4.7, 8.75, 13.52, 17.99, 20.1]);
  assert.deepEqual(snapped.map(b => b.at), [4.7, 8.75, 13.52, 17.99]);
  assert.ok(snapped.every(b => b.snapped));
  assert.equal(snapped[0].offset, -0.3);
  // No cut near: keep the planned time.
  const missing = snapBoundaries([5, 9], [4.9]);
  assert.deepEqual(missing.map(b => [b.at, b.snapped]), [[4.9, true], [9, false]]);
  // One detected cut is never used for two boundaries.
  const shared = snapBoundaries([5, 5.5], [5.2]);
  assert.equal(shared.filter(b => b.snapped).length, 1);
  assert.ok(shared[1].at > shared[0].at);
});

test('a boundary never takes the next boundary\'s cut', () => {
  // Both real cuts landed 0.55 s early. Nearest-first gave the first boundary
  // 2.45 and ended clip 1 with shot 2's footage.
  const early = snapBoundaries([2, 3], [1.45, 2.45]);
  assert.deepEqual(early.map(b => [b.at, b.snapped]), [[1.45, true], [2.45, true]]);
  // The same with both cuts late.
  const late = snapBoundaries([2, 3], [2.55, 3.55]);
  assert.deepEqual(late.map(b => [b.at, b.snapped]), [[2.55, true], [3.55, true]]);
  // A lone cut between two boundaries goes to the nearer one.
  const lone = snapBoundaries([2, 3], [2.6]);
  assert.deepEqual(lone.map(b => [b.at, b.snapped]), [[2, false], [2.6, true]]);
  // A cut nobody planned, just before the real one, is left over.
  const extra = snapBoundaries([5, 10], [4.3, 4.95, 9.8]);
  assert.deepEqual(extra.map(b => b.at), [4.95, 9.8]);
  // Unsorted input with duplicates.
  assert.deepEqual(snapBoundaries([2, 3], [2.45, 1.45, 1.45]).map(b => b.at), [1.45, 2.45]);
});

test('a re-take covers the whole unit that holds the shot, by plan position', () => {
  const plan = { units: [
    { unitId: 'montage-s01-001-004', shotNumbers: [1, 2, 3, 4] },
    { unitId: 'unit-005', shotNumbers: [5] },
    { unitId: 'unit-005', shotNumbers: [5] },
    { unitId: 'montage-s02-006-008', shotNumbers: [6, 7, 8] },
  ] };
  assert.deepEqual(unitIndicesForShots(plan, [3]), [0]);
  // A number covers its suffixed insert, whose single shares the base shot's unit id.
  assert.deepEqual(unitIndicesForShots(plan, [5, 7]), [1, 2, 3]);
  assert.deepEqual(unitIndicesForShots(plan, [9]), []);
});

test('unit shots are matched in script order, so a suffixed insert keeps its own shot', () => {
  const shots = [shot(12), shot(13), { ...shot(13), shotIdSuffix: 'b', description: 'the insert' }, shot(14)];
  const plan = { units: [
    { unitId: 'unit-012', shotNumbers: [12] },
    { unitId: 'unit-013', shotNumbers: [13] },
    { unitId: 'unit-013', shotNumbers: [13] },
    { unitId: 'unit-014', shotNumbers: [14] },
  ] };
  const resolved = resolveUnitShots(plan, shots);
  assert.deepEqual(resolved.map(list => list.map(s => `${s.shotNumber}${s.shotIdSuffix ?? ''}`)), [['12'], ['13'], ['13b'], ['14']]);
  // Matching only the units that hold 13 (the old --retake) loses the base shot.
  const partial = resolveUnitShots({ units: plan.units.slice(1, 3) }, shots);
  assert.deepEqual(partial.map(list => list.map(s => `${s.shotNumber}${s.shotIdSuffix ?? ''}`)), [['13b'], ['13b']]);
});
