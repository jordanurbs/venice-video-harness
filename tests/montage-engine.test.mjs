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
import { objectVehicleKind } from '../dist/mini-drama/plan-check.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MODEL = 'seedance-2-5-reference-to-video';

function shot(n, fields = {}) {
  return { shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', description: `beat ${n}`, characters: [], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...fields };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'montage-engine-'));
  for (const slug of ['anna', 'leo', 'cable-tram', 'red-umbrella']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', slug, 'three-quarter.png'), PNG);
  }
  for (const slug of ['market-street', 'tram-interior']) {
    mkdirSync(join(dir, 'locations', slug), { recursive: true });
    for (const view of ['north', 'east', 'south', 'west']) writeFileSync(join(dir, 'locations', slug, `${view}.png`), PNG);
  }
  const person = { gender: 'female', age: '30', description: '', voiceDescription: '', locked: true, seed: 1 };
  const series = {
    name: 'Engine test', slug: 'engine-test', outputDir: dir, episodes: [],
    characters: [
      { ...person, name: 'ANNA', fullDescription: 'A courier.', wardrobe: 'a yellow raincoat' },
      { ...person, name: 'LEO', fullDescription: 'A fruit seller.', wardrobe: 'a grey canvas apron' },
      { ...person, name: 'CABLE TRAM', gender: 'other', prop: true, description: 'a red cable tram with brass trim', fullDescription: 'A tram.', wardrobe: '' },
      { ...person, name: 'RED UMBRELLA', gender: 'other', prop: true, description: 'a red folding umbrella', fullDescription: 'An umbrella.', wardrobe: '' },
    ],
    locations: [
      { name: 'Market Street', slug: 'market-street', description: 'A steep market street lined with fruit stalls.', spatialAnchors: 'View 1 (north): the tram stop, the cable tram waiting at the kerb, its doors open. View 2 (east): the fruit stalls. View 3 (south): the bakery. View 4 (west): the empty tracks running uphill.', seed: 1 },
      { name: 'Tram Interior', slug: 'tram-interior', description: 'Inside the cable tram as it climbs the hill.', spatialAnchors: 'View 1 (north): the window seats, the lighthouse in the far window. View 2 (east): the driver\'s cabin. View 3 (south): the rear doors. View 4 (west): the hand straps.', seed: 2 },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    videoDefaults: { montageMode: true },
  };
  const journey = [
    shot(1, { location: 'market-street', characters: ['ANNA', 'LEO', 'CABLE TRAM'], description: 'LEO helps ANNA up the step of the CABLE TRAM.', continuity: { from: 'new-scene', endState: 'ANNA inside, the doors closing' } }),
    shot(2, { location: 'market-street', plateView: 'west', duration: '4s', characters: ['LEO', 'CABLE TRAM'], description: 'The CABLE TRAM pulls away uphill; LEO stays at the stop.', continuity: { from: 'continuous' } }),
    shot(3, { location: 'tram-interior', characters: ['ANNA'], description: 'ANNA takes a window seat; the lighthouse slides past.', stagedOn: 'the window seat, left of frame, the lighthouse in the window', continuity: { from: 'continuous' } }),
    shot(4, { location: 'tram-interior', type: 'insert', duration: '4s', characters: ['ANNA', 'RED UMBRELLA'], description: 'ANNA shakes out the RED UMBRELLA on her lap.', continuity: { from: 'continuous' } }),
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

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

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
    assert.match(plan.units[0].decisionReasons.join(' '), /market-street → tram-interior/);
    assert.match(plan.units[0].decisionReasons.join(' '), /across places/);
    const lone = planMontageUnits({ episode: 1, shots: [journey[0], { ...journey[3], continuity: undefined, location: 'market-street' }] }, series, single);
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

    const street = buildMontagePrompt(journey.slice(0, 2), plan.units[0], sequenceSeries);
    assert.match(street.prompt, /SEQUENCE:/);
    const expected = buildReferenceSlotPlan(sequenceSeries, { ...journey[0], characters: ['ANNA', 'LEO', 'CABLE TRAM'] }, MODEL, { characterNames: ['ANNA', 'LEO', 'CABLE TRAM'] });
    assert.deepEqual(street.referenceSlots, expected.slots);
    assert.ok(street.referenceSlots.filter(s => s.kind === 'location').every(s => s.label === 'market-street'));
    // The tram unit gets the tram's plates, which the merged unit's first shot never carried.
    const tram = buildMontagePrompt([journey[2]], plan.units[1], sequenceSeries);
    const tramPlates = tram.referenceSlots.filter(s => s.kind === 'location');
    assert.equal(tramPlates.length, 4);
    assert.ok(tramPlates.every(s => s.label === 'tram-interior'));
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
      'character-primary:CABLE TRAM:front.png',
      'location:market-street:north.png',
      'location:market-street:west.png',
      'location:tram-interior:north.png',
      'character-primary:RED UMBRELLA:front.png',
    ]);
    assert.deepEqual([...plan.placeByShot.entries()], [[1, 4], [2, 5], [3, 6], [4, 6]]);
    assert.match(plan.slots[3].roleClause, /^is Market Street \(the north view\), for shot 1 only: the tram stop, the cable tram waiting at the kerb/);
    assert.match(plan.slots[5].roleClause, /for shots 3 and 4 only: the window seat, left of frame, the lighthouse in the window\. It does not set where people, vehicles or props are in any other shot/);
    // `all` adds the other canonical views of each place and the second angles, after the essentials they belong to.
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

test('over budget, the staged plan keeps the cast and names a moved shot in the image it moved to', () => {
  const { dir, series } = fixture();
  try {
    // A cast member who enters late trails the place images; a place image goes before them.
    const lateCast = [
      shot(1, { location: 'market-street', plateView: 'north', characters: ['ANNA', 'LEO'] }),
      shot(2, { location: 'tram-interior', plateView: 'north', characters: ['ANNA'] }),
      shot(3, { location: 'tram-interior', plateView: 'north', characters: ['RED UMBRELLA'] }),
    ];
    const plan = buildMontageSlotPlan(series, lateCast, 'some-four-image-model');
    assert.deepEqual(slotNames(plan), [
      'character-primary:ANNA:front.png',
      'character-primary:LEO:front.png',
      'location:market-street:north.png',
      'character-primary:RED UMBRELLA:front.png',
    ]);
    assert.match(plan.dropped.join(' '), /location "tram-interior"/);
    assert.deepEqual([...plan.placeByShot.entries()], [[1, 3]]);

    // A later view of a place already shown is dropped; its shot moves to the
    // place's first image, and that image's clause names it.
    const twoViews = [
      shot(1, { location: 'market-street', plateView: 'north', characters: ['ANNA', 'LEO', 'CABLE TRAM'] }),
      shot(2, { location: 'market-street', plateView: 'west', characters: ['LEO'] }),
    ];
    const moved = buildMontageSlotPlan(series, twoViews, 'some-four-image-model');
    assert.deepEqual(slotNames(moved).slice(3), ['location:market-street:north.png']);
    assert.deepEqual([...moved.placeByShot.entries()], [[1, 4], [2, 4]]);
    assert.match(moved.slots[3].roleClause, /for shots 1 and 2 only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a unit whose shots name no plateView sends what a montage always sent', () => {
  const { dir, series, journey } = fixture();
  try {
    writeFileSync(join(dir, 'locations', 'market-street', 'reverse-angle.png'), PNG);
    const unstaged = journey.map(({ plateView, ...rest }) => rest);
    const cast = ['ANNA', 'LEO', 'CABLE TRAM'];

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
    assert.deepEqual(plates.map(s => s.label), [...Array(5).fill('market-street'), ...Array(4).fill('tram-interior')]);
    const tramFirst = plates.find(s => s.label === 'tram-interior').imageIndex;
    assert.equal(run.placeByShot.get(1), plates[0].imageIndex);
    assert.equal(run.placeByShot.get(4), tramFirst);
    assert.match(run.slots[tramFirst - 1].roleClause, /^is the location environment reference \(Tram Interior\)/);

    // The prompt points each shot at its place's first plate.
    const unit = montageUnit(unstaged.slice(0, 2), 5, 4);
    const { prompt, referenceSlots } = buildMontagePrompt(unstaged.slice(0, 2), unit, series);
    const streetFirst = referenceSlots.find(s => s.kind === 'location').imageIndex;
    assert.match(prompt, new RegExp(`\\nShot 1 \\| 0-5s \\| Market Street \\(@Image${streetFirst}\\):`));
    assert.match(prompt, new RegExp(`@Image${streetFirst} is the location environment reference \\(Market Street\\)`));
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
    assert.match(p, /^One continuous scene in 4 connected shots, in story order, moving through Market Street, then Tram Interior\. No music/);
    assert.match(p, /References, in the order they first appear:\n@Image1 is ANNA — wearing a yellow raincoat/);
    assert.match(p, /@Image3 is the CABLE TRAM, an object, not a person.*Exactly one CABLE TRAM in this scene, and no other vehicles/);
    assert.doesNotMatch(p, /Exactly one RED UMBRELLA/);
    assert.match(p, /\nShot 1 \| 0-5s \| Market Street \(@Image4\): .*@Image2 helps @Image1 up the step of the @Image3\./);
    assert.match(p, /\nCut to Shot 2 \| 5-9s \| Market Street \(@Image5\):/);
    assert.match(p, /\nCut to Shot 3 \| 9-14s \| Tram Interior \(@Image6\):/);
    assert.match(p, /Cut to Shot 2 \| 5-9s \| Market Street \(@Image5\): .*It starts where shot 1 ends: @Image1 inside, the doors closing\./);
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

test('the vehicle count line goes only to an object that is a vehicle', () => {
  assert.equal(objectVehicleKind('CABLE TRAM', 'a red cable tram with brass trim'), 'land');
  assert.equal(objectVehicleKind('OLD NUMBER NINE', 'a rusted green tram, its pole bent'), 'land');
  assert.equal(objectVehicleKind('THE ROWBOAT', 'a small blue rowboat'), 'water');
  assert.equal(objectVehicleKind('THE TRAIN'), 'land');
  for (const [name, description] of [
    ['CAR KEY', 'a silver car key on a ring'],
    ['BUS TICKET', 'a paper bus ticket'],
    ["SHIP'S COMPASS", "a brass ship's compass"],
    ['TRAIN SET', 'a toy wooden train set'],
    ['THE LEDGER', 'a green ledger with a tram timetable inside'],
  ]) {
    assert.equal(objectVehicleKind(name, description), undefined, name);
  }

  const { dir, series, journey } = fixture();
  try {
    mkdirSync(join(dir, 'characters', 'car-key'), { recursive: true });
    writeFileSync(join(dir, 'characters', 'car-key', 'front.png'), PNG);
    series.characters.push({ name: 'CAR KEY', gender: 'other', age: 'n/a', prop: true, description: 'a silver car key on a ring', fullDescription: 'A key.', wardrobe: '', voiceDescription: '', locked: true, seed: 4 });
    const withKey = [{ ...journey[2], characters: ['ANNA', 'CAR KEY'], description: 'ANNA turns the CAR KEY over in her hand.' }];
    const { prompt } = buildMontagePrompt(withKey, montageUnit(withKey, 5), series);
    assert.match(prompt, /is the CAR KEY, an object, not a person/);
    assert.doesNotMatch(prompt, /Exactly one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a place named after a cast member keeps its name, and a wardrobe ending in a full stop is not doubled', () => {
  const { dir, series, journey } = fixture();
  try {
    series.locations[0].name = 'Cable Tram Stop';
    series.characters[0].wardrobe = 'a yellow raincoat.';
    const unit = montageUnit(journey.slice(0, 2), 5, 4);
    const { prompt } = buildMontagePrompt(journey.slice(0, 2), unit, series);
    assert.match(prompt, /@Image4 is Cable Tram Stop \(the north view\), for shot 1 only/);
    assert.match(prompt, /\nShot 1 \| 0-5s \| Cable Tram Stop \(@Image4\):/);
    assert.match(prompt, /wearing a yellow raincoat\. Wardrobe locked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an over-long shot-list prompt: prose shrinks to 40% at the guard, below that only for the hard cap, STYLE whole', () => {
  const { dir, series, journey } = fixture();
  const build = (repeat, model = MODEL, blockingRepeat = 20) => {
    const long = journey.map(s => ({ ...s, description: `${s.description} ${'the light moves over the stalls, '.repeat(repeat)}`.trim(), blocking: 'ANNA screen left, LEO screen right. '.repeat(blockingRepeat) }));
    const unit = { ...montageUnit(long, 5, 4, 5, 4), model };
    return { long, prompt: quietly(() => buildMontagePrompt(long, unit, series).prompt) };
  };
  const line = (prompt, n) => prompt.split('\n').find(l => l.startsWith(`${n > 1 ? 'Cut to ' : ''}Shot ${n} |`));
  try {
    // Long blocking, short descriptions: the blocking shrinks, the descriptions stay whole.
    const blocky = build(0, MODEL, 70);
    assert.ok(blocky.prompt.length <= 8000, `fits the guard (${blocky.prompt.length})`);
    assert.match(line(blocky.prompt, 1), / @Image2 helps @Image1 up the step of the @Image3\. Blocking: @Image1 screen left[^\n]*…$/);

    // Long descriptions too: the blocking goes first, then the descriptions shrink.
    const near = build(60);
    assert.ok(near.prompt.length <= 8000, `fits the guard (${near.prompt.length})`);
    assert.match(near.prompt, /STYLE: .*No music, no BGM, no soundtrack, no subtitles, no on-screen text\.\nNegative: /);
    assert.match(near.prompt, /Every cut is an abrupt single-frame hard cut/);
    assert.doesNotMatch(line(near.prompt, 1), /Blocking:/);
    assert.match(line(near.prompt, 1), /the light moves over the stalls[^\n]*…$/);

    // At the 40% floor the prompt may go past the guard, never past the cap.
    const mid = build(140);
    assert.ok(mid.prompt.length > 8000 && mid.prompt.length <= 10000, `between the guard and the cap (${mid.prompt.length})`);
    assert.ok(line(mid.prompt, 1).length >= 0.4 * mid.long[0].description.length, 'descriptions keep at least 40%');
    assert.doesNotMatch(line(mid.prompt, 1), /Blocking:/);

    // Far over: the cap holds, and the STYLE tail is still whole.
    const far = build(400);
    assert.ok(far.prompt.length <= 10000, `at most the cap (${far.prompt.length})`);
    assert.match(far.prompt, /STYLE: .*no on-screen text\.\nNegative: /);

    // A model with a small cap (MiniMax H3, 2500) gets a prompt that fits it.
    const small = build(60, 'minimax-h3-reference-to-video');
    assert.ok(small.prompt.length <= 2500, `fits the H3 cap (${small.prompt.length})`);
    assert.match(small.prompt, /STYLE: .*\nNegative: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a montage prompt that cannot fit its cap without prose is refused, not cut', () => {
  const { dir, series, journey } = fixture();
  try {
    const chatty = journey.map(s => ({ ...s, characters: [...new Set([...s.characters, 'ANNA'])], dialogue: { character: 'ANNA', line: 'I will count every stall on this hill before the tram reaches the top, '.repeat(10) } }));
    const unit = { ...montageUnit(chatty, 5, 4, 5, 4), model: 'minimax-h3-reference-to-video' };
    assert.throws(() => quietly(() => buildMontagePrompt(chatty, unit, series)), /over this model's 2500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an over-long SEQUENCE prompt drops blocking first, keeps the 40% floor, and never cuts the STYLE tail', () => {
  const { dir, series, journey } = fixture();
  const sequenceSeries = { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar: 'sequence' } };
  const build = (shots) => quietly(() => buildMontagePrompt(shots, montageUnit(shots, 5, 4), sequenceSeries).prompt);
  const tail = /STYLE: .*Face stable throughout, no deformation\. Diegetic sound only, no music, no on-screen text\.\nNegative: [^\n]+\.$/;
  try {
    // Long blocking, short descriptions: the blocking shrinks, the descriptions stay whole.
    const blocky = journey.slice(0, 2).map(s => ({ ...s, blocking: 'LEO screen right by the stall, ANNA screen left at the tram step, '.repeat(40) }));
    const a = build(blocky);
    assert.ok(a.length <= 5000, `within the guard (${a.length})`);
    assert.match(a, /\n\[0:00-0:05\] @Image2 helps @Image1 up the step of the @Image3\. Blocking: @Image2 screen right[^\n]*…\n/);
    assert.match(a, tail);

    // Long descriptions: shrunk to fit, at word boundaries.
    const wordy = journey.slice(0, 2).map(s => ({ ...s, description: `${s.description} ${'the light moves over the stalls, '.repeat(90)}` }));
    const b = build(wordy);
    assert.ok(b.length <= 5000, `within the guard (${b.length})`);
    assert.match(b, /\[0:00-0:05\] @Image2 helps @Image1 up the step[^\n]*…/);
    assert.match(b, tail);

    // Too long for the guard even at 40%: it goes out longer (under the cap), whole.
    const huge = journey.slice(0, 2).map(s => ({ ...s, description: `${s.description} ${'the light moves over the stalls, '.repeat(240)}` }));
    const c = build(huge);
    assert.ok(c.length > 5000 && c.length <= 10000, `over the guard, under the cap (${c.length})`);
    const beat = c.split('\n').find(l => l.startsWith('[0:00-0:05]'));
    assert.ok(beat.length >= 0.4 * huge[0].description.length, 'descriptions keep at least 40%');
    assert.match(c, tail);
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
  // A boundary pushed by the minimum gap stops at the end of the render.
  const short = snapBoundaries([0.8, 0.9, 0.95], [], 0.8, 0.3, 1.0);
  assert.deepEqual(short.map(b => b.at), [0.8, 1.0, 1.0]);
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
