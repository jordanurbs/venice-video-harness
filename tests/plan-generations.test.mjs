// plan-generations: the continuity ledger, the packaging agent's answer checked
// by the validator (with a rules fallback), the reference audit, and the
// approval that generate-videos honours or refuses. The agent, the quote
// endpoint and the pending-job store are stubs: no network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditPlan, buildContinuityLedger, describeGenerationPlan, planGenerations, planMarkdown, SHOT_NOTE_MAX_CHARS,
  toProposal, unitQuoter, unusedShotNotes, validatePackaging,
} from '../dist/mini-drama/generation-planning.js';
import {
  checkPlanApproval, describePlanAfterEdit, hashPackagingInputs, loadPlanProposal, packagingInputs, savePlanProposal,
} from '../dist/mini-drama/generation-plan-approval.js';
import {
  buildGenerationPlan, buildGenerationPlanFromGroups, resolveUnitShots, retakeTokensForUnit, unitIndicesForShotIds,
} from '../dist/mini-drama/generation-planner.js';
import { montageBlockReason } from '../dist/mini-drama/montage.js';
import { assertShotDurationsValid } from '../dist/mini-drama/video-generator.js';
import { vehicleKinds } from '../dist/mini-drama/plan-check.js';
import { buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';
import { inFlightOutsidePlan } from '../dist/mini-drama/in-flight.js';
import { setWorkshopPlanProvider } from '../dist/mini-drama/workshop.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { collectProjectStatus, qualifyCommand } from '../dist/session/status.js';
import { PIPELINE_BRANCHES, PIPELINE_STAGES } from '../packages/core/dist/agent/pipeline.js';
import { formatGuide } from '../packages/core/dist/agent/guide.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MODEL = 'seedance-2-5-reference-to-video';
const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');

function shot(n, fields = {}) {
  return { shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', description: `beat ${n}`, characters: [], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...fields };
}

const ids = (shots) => shots.map(s => `${s.shotNumber}${s.shotIdSuffix ?? ''}`);

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

function fixture(videoDefaults = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-generations-'));
  for (const slug of ['anna', 'leo', 'cable-tram', 'car-key']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
  }
  for (const slug of ['market-street', 'tram-interior', 'hill-station']) {
    mkdirSync(join(dir, 'locations', slug), { recursive: true });
    writeFileSync(join(dir, 'locations', slug, 'north.png'), PNG);
  }
  const person = { gender: 'female', age: '30', description: '', voiceDescription: '', locked: true, seed: 1, fullDescription: '' };
  const series = {
    name: 'Planning test', slug: 'planning-test', outputDir: dir, concept: 'c', genre: 'drama', setting: 's',
    episodes: [{ number: 1, title: 'The climb', status: 'draft' }],
    characters: [
      { ...person, name: 'ANNA', wardrobe: 'a yellow raincoat' },
      { ...person, name: 'LEO', wardrobe: 'a grey canvas apron' },
      { ...person, name: 'CABLE TRAM', gender: 'other', prop: true, description: 'a red cable tram with brass trim', wardrobe: '' },
      { ...person, name: 'CAR KEY', gender: 'other', prop: true, description: 'a brass car key on a red fob', wardrobe: '' },
    ],
    locations: [
      { name: 'Market Street', slug: 'market-street', description: 'A steep market street with the tram stop.', seed: 1 },
      { name: 'Tram Interior', slug: 'tram-interior', description: 'Inside the cable tram as it climbs the hill.', seed: 2 },
      { name: 'Hill Station', slug: 'hill-station', description: 'A glass station hall at the top of the hill.', seed: 3 },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    videoDefaults: { actionModel: MODEL, atmosphereModel: MODEL, characterConsistencyModel: MODEL, montageMode: true, ...videoDefaults },
  };
  const script = { episode: 1, title: 'The climb', shots: [
    shot(1, { location: 'market-street', characters: ['LEO', 'ANNA', 'CABLE TRAM'], description: 'LEO helps ANNA up the step of the tram.', continuity: { from: 'new-scene' } }),
    shot(2, { location: 'market-street', characters: ['LEO', 'CABLE TRAM'], duration: '4s', description: 'The tram pulls away uphill from the stop.', continuity: { from: 'continuous' } }),
    shot(3, { location: 'tram-interior', characters: ['ANNA'], description: 'ANNA takes a window seat inside the tram.', continuity: { from: 'continuous' } }),
    shot(4, { location: 'hill-station', characters: ['ANNA'], description: 'Later, ANNA walks into the hill station past a parked bus and another bus.', continuity: { from: 'later' } }),
    shot(5, { location: 'hill-station', characters: ['ANNA'], description: 'She looks up at the departures board; a bus waits outside the window.', continuity: { from: 'continuous' } }),
  ] };
  return { dir, series, script };
}

const GOOD = {
  units: [{ shots: ['1', '2', '3'], reason: 'the tram and LEO carry across both cuts' }, { shots: ['4', '5'], reason: 'later, at the station' }],
  splits: [{ after: '3', reason: 'a time skip; nothing carries' }],
  shotNotes: [{ shot: '2', note: 'The doors fold shut and the tram starts to climb' }],
  notes: ['cast the bus if it returns'],
};

/** A packaging the rules planner would not make: shot 3 in a generation of its own. */
const SPLIT = {
  units: [{ shots: ['1', '2'], reason: 'the boarding' }, { shots: ['3'], reason: 'inside, alone' }, { shots: ['4', '5'], reason: 'later' }],
};

/** A staging ref as stage-ref records it; the image need not exist for the plan. */
const staged = (use, extra = {}) => ({
  path: 'episodes/episode-001/staging/shot-003/s1/1-gpt-image-2-edit.png', use, source: 'locations/tram-interior/north.png',
  ...(use === 'plate' ? { replacesView: 'north' } : {}), model: 'gpt-image-2-edit', prompt: 'remove the poster',
  sha256: 'a'.repeat(64), session: 'episodes/episode-001/staging/shot-003/s1', pickedAt: '2026-10-26T00:00:00.000Z', ...extra,
});

function stubAgent(answer) {
  const calls = [];
  return { calls, client: { async chatJson(options) { calls.push(options); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer() : answer; } } };
}

async function approvedProposal(series, script, answer = GOOD) {
  const { client } = stubAgent(answer);
  const result = await planGenerations(client, series, script, { model: 'stub-model' });
  const proposal = toProposal(result);
  proposal.planning = { ...proposal.planning, approved: true, approvedBy: 'Tester', approvedAt: '2026-10-26T00:00:00.000Z' };
  return proposal;
}

const withShot = (script, n, fields) => ({ ...script, shots: script.shots.map(s => (s.shotNumber === n ? { ...s, ...fields } : s)) });

test('the ledger: what carries across each cut, the state a shot changes, and the vehicles with no reference', () => {
  const { dir, series, script } = fixture();
  try {
    const ledger = buildContinuityLedger(series, script.shots);
    const join12 = ledger.joins.find(j => j.from === '1');
    assert.deepEqual(join12.carries.sort(), ['CABLE TRAM', 'LEO']);
    assert.equal(join12.stateChange, 'pulls away');
    const join23 = ledger.joins.find(j => j.from === '2');
    assert.equal(join23.placeChange, true);
    // "inside the tram" in shot 3 is the cast tram, not a second one with no reference.
    assert.deepEqual(join23.carries, ['CABLE TRAM']);
    assert.ok(!ledger.entities.some(e => e.name === 'tram'));
    assert.equal(ledger.entities.find(e => e.name === 'CABLE TRAM').kind, 'vehicle');
    // A bus only the words name, in two shots, is a risk; "parked" and "waits" are not state changes.
    assert.ok(ledger.risks.some(r => /The bus is in shots 4, 5 with no reference of its own/.test(r)));
    assert.equal(ledger.joins.find(j => j.from === '3').stateChange, undefined);
    assert.ok(ledger.risks.some(r => /Shot 2 changes a state \("pulls away"\)/.test(r)));
    // What a cast object is decides whether it is a vehicle: a CAR KEY is an object.
    const keyed = buildContinuityLedger(series, [shot(1, { characters: ['ANNA', 'CAR KEY'], description: 'ANNA turns the CAR KEY over.' })]);
    assert.equal(keyed.entities.find(e => e.name === 'CAR KEY').kind, 'object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vehicle word that only qualifies another thing is not a vehicle in the shot; its parts and its verbs still are', () => {
  const kinds = (text) => [...vehicleKinds(text)];
  assert.deepEqual(kinds("Close on the ship's compass."), []);
  assert.deepEqual(kinds('She holds out a bus ticket.'), []);
  assert.deepEqual(kinds('He reads the tram timetable on the wall.'), []);
  assert.deepEqual(kinds('A train ticket falls from her hand.'), []);
  assert.deepEqual(kinds('She waits at the tram stop.'), []);
  assert.deepEqual(kinds('A bus-ticket stub on the floor.'), []);
  assert.deepEqual(kinds('The train doors close.'), ['train']);
  assert.deepEqual(kinds("She grips the ship's rail."), ['ship']);
  assert.deepEqual(kinds('The tram stops at the corner.'), ['tram']);
  assert.deepEqual(kinds('A gondola passes the steps.'), ['gondola']);
  // A place's words read as before: a tram stop in a location still names a tram there.
  assert.deepEqual([...vehicleKinds('A steep street with the tram stop.', 'place')], ['tram']);

  const { dir, series } = fixture();
  try {
    const ledger = buildContinuityLedger(series, [
      shot(1, { characters: ['ANNA'], description: 'ANNA shows a bus ticket to LEO.' }),
      shot(2, { characters: ['ANNA'], description: "ANNA checks the tram timetable and the ship's compass." }),
    ]);
    assert.ok(!ledger.entities.some(e => e.kind === 'vehicle'), JSON.stringify(ledger.entities));
    assert.ok(!ledger.risks.some(r => /no reference of its own/.test(r)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the validator accepts a clean answer, flattens its notes, and names every structural problem in a bad one', () => {
  const { dir, series, script } = fixture();
  try {
    const good = validatePackaging({
      ...GOOD,
      units: [{ shots: [1, '2', '003'], reason: 'the tram carries' }, { shots: ['4', 5], reason: 'later' }],
      shotNotes: [{ shot: 2, note: 'The doors fold shut\nand the tram\tstarts to climb.' }, { shot: 99, note: 'x' }],
    }, series, script.shots);
    assert.deepEqual(good.problems, []);
    assert.deepEqual(good.groups, [{ shots: ['1', '2', '3'], reason: 'the tram carries' }, { shots: ['4', '5'], reason: 'later' }]);
    assert.deepEqual(good.shotNotes, { 2: 'The doors fold shut and the tram starts to climb.' });
    assert.ok(good.notes.some(n => /names shot 99, which is not in the script; dropped/.test(n)));
    assert.deepEqual(good.splits, [{ after: '3', reason: 'a time skip; nothing carries' }]);

    const bad = validatePackaging({ units: [{ shots: [1, 3] }, { shots: [2] }, { shots: [3, 4, 'x9'] }] }, series, script.shots);
    const text = bad.problems.join(' | ');
    assert.match(text, /unit 1 \(shots 1, 3\) is not a run of consecutive shots/);
    assert.match(text, /units 1 and 2 are out of script order/);
    assert.match(text, /unit 3 names shots that are not in the script: x9/);
    assert.match(text, /shots not in any unit: 5/);
    assert.match(text, /shots in more than one unit: 3/);
    assert.deepEqual(validatePackaging(null, series, script.shots).problems, ['the planner did not answer with a JSON object']);
    assert.deepEqual(validatePackaging({ units: 'all of them' }, series, script.shots).problems, ['the planner returned no units']);
    // A bare list of ids is a unit without a reason.
    const lists = validatePackaging({ units: [['1', '2', '3'], ['4', '5']] }, series, script.shots);
    assert.deepEqual(lists.problems, []);
    assert.ok(lists.notes.some(n => /unit 1 \(shots 1, 2, 3\) gives no reason/.test(n)));
    assert.ok(lists.notes.some(n => /no reason given for the split after shot 3/.test(n)));
    // Values String() cannot convert are named, never thrown on.
    const odd = validatePackaging({
      units: [{ shots: [{ toString: 1 }, '1', '2', '3', '4', '5'] }],
      splits: [{ after: { toString: 1 } }],
      shotNotes: [{ shot: { toString: 1 }, note: 'x' }],
    }, series, script.shots);
    assert.match(odd.problems.join(' | '), /unit 1 names shots that are not in the script: \{"toString":1\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the validator records a unit whose references overflow its model\'s budget, as a note', () => {
  const { dir, series, script } = fixture({ montageModel: 'seedance-2-0-reference-to-video', montageReferenceViews: 'all' });
  try {
    for (const slug of ['market-street', 'tram-interior', 'hill-station']) {
      for (const view of ['east', 'south', 'west']) writeFileSync(join(dir, 'locations', slug, `${view}.png`), PNG);
    }
    const shots = script.shots.map(s => ({ ...s, plateView: 'north' }));
    const result = validatePackaging(GOOD, series, shots);
    assert.deepEqual(result.problems, []);
    const note = result.notes.find(n => /needs more reference images/.test(n));
    assert.match(note, /^unit 1 \(shots 1, 2, 3\) needs more reference images than seedance-2-0-reference-to-video takes \(9\): \d+ dropped \(.*over 9-image budget.*\)\. A split keeps them\.$/);
    assert.ok(!result.notes.some(n => /^unit 2 .*needs more reference images/.test(n)), 'one place and one person fit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer of the wrong shape falls back to rules instead of crashing after the paid call', async () => {
  const { dir, series, script } = fixture();
  try {
    for (const [answer, problem] of [
      [{ ...GOOD, splits: 'after 3' }, /"splits" is not a list/],
      [{ ...GOOD, splits: [null] }, /split 1 is not/],
      [{ ...GOOD, shotNotes: { 2: 'x' } }, /"shotNotes" is not a list/],
      [{ ...GOOD, shotNotes: [{ shot: '2', note: 7 }] }, /shot note 1 is not/],
      [{ units: [null, { shots: ['1', '2', '3', '4', '5'] }] }, /unit 1 is not/],
      ['garbage', /did not answer with a JSON object/],
    ]) {
      const { client } = stubAgent(answer);
      const result = await planGenerations(client, series, script, { model: 'stub-model' });
      assert.equal(result.plan.planning.by, 'rules');
      assert.match(result.plan.planning.problems.join(' | '), problem);
      assert.deepEqual(result.plan.units.map(u => u.unitId), buildGenerationPlan(script, series).units.map(u => u.unitId));
    }
    const failed = await planGenerations(stubAgent(new Error('HTTP 500\nbody')).client, series, script, { model: 'stub-model' });
    assert.equal(failed.plan.planning.by, 'rules');
    assert.deepEqual(failed.plan.planning.problems, ['the planner failed: HTTP 500']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shot ids tell an insert from its base shot, in the answer, the beats and the clips on disk', async () => {
  const { dir, series } = fixture();
  try {
    const shots = [
      shot(12, { location: 'hill-station', characters: ['ANNA'] }),
      shot(13, { location: 'hill-station', characters: ['ANNA'], description: 'ANNA reaches the lamp.', continuity: { from: 'continuous' } }),
      shot(13, { shotIdSuffix: 'b', location: 'hill-station', characters: ['ANNA'], description: 'The lamp lights up.', continuity: { from: 'continuous' } }),
      shot(14, { location: 'hill-station', characters: ['ANNA'], continuity: { from: 'continuous' } }),
    ];
    const once = validatePackaging({ units: [{ shots: [12, 13, 14], reason: 'one run' }] }, series, shots);
    assert.match(once.problems.join(' | '), /shots not in any unit: 13b/);
    const twice = validatePackaging({ units: [{ shots: [12, 13, 13, 14], reason: 'one run' }] }, series, shots);
    assert.match(twice.problems.join(' | '), /shots not in any unit: 13b/);
    assert.match(twice.problems.join(' | '), /shots in more than one unit: 13/);

    const answer = { units: [{ shots: ['12', '13', '13B'], reason: 'the lamp carries' }, { shots: ['14'], reason: 'after' }], splits: [{ after: '13b', reason: 'a pause' }], shotNotes: [{ shot: '13b', note: 'Warm light spreads across the floor' }] };
    const valid = validatePackaging(answer, series, shots);
    assert.deepEqual(valid.problems, []);
    assert.deepEqual(valid.groups.map(g => g.shots), [['12', '13', '13b'], ['14']]);
    assert.deepEqual(valid.shotNotes, { '13b': 'Warm light spreads across the floor' });

    const script = { episode: 1, title: 't', shots };
    const plan = buildGenerationPlanFromGroups(script, series, { groups: valid.groups, shotNotes: valid.shotNotes });
    assert.deepEqual(resolveUnitShots(plan, shots).map(ids), [['12', '13', '13b'], ['14']]);
    // The insert's beat carries its suffix, so its clip is shot-013b.mp4, not its base shot's.
    assert.deepEqual(plan.units[0].montageBeats.map(b => `${b.shotNumber}${b.shotIdSuffix ?? ''}`), ['12', '13', '13b']);
    assert.deepEqual(plan.units[0].shotNotes, { '13b': 'Warm light spreads across the floor' });
    // The note goes on the insert's line, not on its base shot's.
    const { prompt } = buildMontagePrompt(resolveUnitShots(plan, shots)[0], plan.units[0], series);
    assert.match(prompt, /\nCut to Shot 3 \| 10-15s \| Hill Station \(@Image\d+\): [^.]+\. The lamp lights up\. Warm light spreads across the floor\.\n/);
    assert.doesNotMatch(prompt.split('\n').find(line => /^Cut to Shot 2 /.test(line)), /Warm light/);
    assert.throws(() => buildGenerationPlanFromGroups(script, series, { groups: [{ shots: ['12', '13', '14'] }] }), /13b/);

    // The audit reads each shot's own clip: 13b's is on disk, 13's is not.
    const sceneDir = join(dir, 'scene-001');
    mkdirSync(sceneDir, { recursive: true });
    writeFileSync(join(sceneDir, 'shot-012.mp4'), PNG);
    writeFileSync(join(sceneDir, 'shot-013b.mp4'), PNG);
    const audits = await auditPlan(series, shots, plan, buildContinuityLedger(series, shots), { sceneDir });
    assert.deepEqual(audits[0].shots, ['12', '13', '13b']);
    assert.deepEqual(audits[0].onDisk, { clips: 2, of: 3, master: false });
    assert.match(describeGenerationPlan({ plan, audits }).join('\n'), /on disk: 2 of 3 clips: the unit renders whole, and those clips are archived \(-vN\) and cut again/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a re-take names shot ids that select exactly one unit', async () => {
  const { dir, series } = fixture();
  try {
    const shots = [
      shot(12, { location: 'hill-station', characters: ['ANNA'] }),
      shot(13, { location: 'hill-station', characters: ['ANNA'], continuity: { from: 'continuous' } }),
      shot(13, { shotIdSuffix: 'b', location: 'hill-station', characters: ['ANNA'], continuity: { from: 'continuous' } }),
      shot(14, { location: 'hill-station', characters: ['ANNA'], continuity: { from: 'continuous' } }),
    ];
    const script = { episode: 1, title: 't', shots };
    const plan = buildGenerationPlanFromGroups(script, series, { groups: [{ shots: ['12', '13'] }, { shots: ['13b', '14'] }] });
    assert.deepEqual(resolveUnitShots(plan, shots).map(ids), [['12', '13'], ['13b', '14']]);
    // A bare number covers its inserts; an id with its suffix names that insert alone.
    assert.deepEqual(unitIndicesForShotIds(plan, shots, ['13']), [0, 1]);
    assert.deepEqual(unitIndicesForShotIds(plan, shots, ['13b']), [1]);
    assert.deepEqual(unitIndicesForShotIds(plan, shots, ['13B', '14']), [1]);
    const unitIds = [['12', '13'], ['13b', '14']];
    assert.deepEqual(retakeTokensForUnit(unitIds, 0), { tokens: ['12'], alsoRetakes: [] });
    assert.deepEqual(retakeTokensForUnit(unitIds, 1), { tokens: ['13b', '14'], alsoRetakes: [] });
    assert.deepEqual(retakeTokensForUnit([['12', '13', '13b'], ['14']], 0), { tokens: ['12', '13'], alsoRetakes: [] });
    // No shot of the unit can be named apart: the bare number, and what else it re-takes.
    assert.deepEqual(retakeTokensForUnit([['14'], ['14b', '15']], 0), { tokens: ['14'], alsoRetakes: [1] });

    // Every clip on disk and no master: the audit's re-take line picks only that unit.
    const sceneDir = join(dir, 'scene-001');
    mkdirSync(sceneDir, { recursive: true });
    for (const key of ['012', '013', '013b', '014']) writeFileSync(join(sceneDir, `shot-${key}.mp4`), PNG);
    const audits = await auditPlan(series, shots, plan, buildContinuityLedger(series, shots), { sceneDir });
    const text = describeGenerationPlan({ plan, audits }, { project: dir, episode: 1 }).join('\n');
    assert.match(text, /To render shots 12, 13 again as one generation: generate-videos -p \S+ -e 1 --retake 12$/m);
    assert.match(text, /To render shots 13b, 14 again as one generation: generate-videos -p \S+ -e 1 --retake 13b,14$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent\'s plan is used when valid: units, reasons, splits and a shot note in the prompt', async () => {
  const { dir, series, script } = fixture();
  try {
    const { client, calls } = stubAgent(GOOD);
    const result = await planGenerations(client, series, script, { model: 'stub-model' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'stub-model');
    assert.equal(calls[0].maxTokens, 32000);
    assert.match(calls[0].systemPrompt, /3 of 3 takes, against 0 of 4/);
    assert.match(calls[0].systemPrompt, /Never write commentary about plates, references, units or this plan in a shotNote/);
    assert.match(calls[0].systemPrompt, /"13b" is a shot inserted after 13/);
    assert.match(calls[0].userPrompt, /"stateChange": "pulls away"/);
    const planning = result.plan.planning;
    assert.equal(planning.by, 'agent');
    assert.equal(planning.model, 'stub-model');
    // The hash binds the description of the shot the note amends, and no other.
    assert.equal(planning.packagingHash, hashPackagingInputs(packagingInputs(script, series, planning.shotNotes)));
    assert.match(planning.inputs.shots[1].description, /^[0-9a-f]{16}$/);
    assert.equal(planning.inputs.shots[0].description, undefined);
    assert.deepEqual(planning.groups.map(g => g.shots), [['1', '2', '3'], ['4', '5']]);
    assert.deepEqual(result.plan.units.map(u => u.shotNumbers), [[1, 2, 3], [4, 5]]);
    assert.match(result.plan.units[0].decisionReasons[0], /^planner: the tram and LEO carry/);
    assert.match(result.plan.units[0].decisionReasons.join(' '), /one planned run across places/);
    assert.deepEqual(result.plan.units[0].shotNotes, { 2: 'The doors fold shut and the tram starts to climb' });
    assert.deepEqual(planning.splits, [{ after: '3', reason: 'a time skip; nothing carries' }]);
    assert.ok(planning.notes.includes('cast the bus if it returns'));
    const text = describeGenerationPlan(result).join('\n');
    assert.match(text, /planned by the packaging agent \(stub-model\), not approved yet/);
    assert.match(text, /shot 2 note: The doors fold shut/);
    assert.match(planMarkdown(1, describeGenerationPlan(result)), /^# Generation plan, episode 1\n\nGeneration plan: 2 unit\(s\)[^\n]*\n- montage-s01-001-003/);

    const { prompt } = buildMontagePrompt(script.shots.slice(0, 3), result.plan.units[0], series);
    assert.match(prompt, /\nCut to Shot 2 \| 5-9s \| Market Street \(@Image\d+\): [^.]+\. The tram pulls away uphill from the stop\. The doors fold shut and the tram starts to climb\.\n/);

    // The agent is told what renders alone; a shot's view is not its business.
    const viewed = withShot(withShot(script, 1, { plateView: 'east' }), 3, { stagingRef: staged('plate') });
    const asked = stubAgent(GOOD);
    await planGenerations(asked.client, series, viewed, { model: 'stub-model' });
    assert.doesNotMatch(asked.calls[0].userPrompt, /"view"/);
    assert.match(asked.calls[0].userPrompt, /"alone": "a picked staging ref \(stage-ref\) that only its own render sends"/);

    const rules = await planGenerations(null, series, script, { agent: false });
    assert.equal(rules.plan.planning.by, 'rules');
    assert.equal(rules.plan.planning.groups, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shot notes are one capped line, never an @Image tag, inside the length guard and the model\'s cap, and a note no prompt reads is recorded', async () => {
  const { dir, series, script } = fixture();
  try {
    const long = `The doors fold shut. ${'The cable runs taut under the street and the brake lets go of the wheels. '.repeat(8)}`;
    const capped = validatePackaging({ ...GOOD, shotNotes: [{ shot: '2', note: long }, { shot: '3', note: '@Image3 turns to the window.' }] }, series, script.shots);
    assert.ok(capped.shotNotes['2'].length <= SHOT_NOTE_MAX_CHARS);
    assert.match(capped.shotNotes['2'], /^The doors fold shut\. The cable runs .*wheels\.$/);
    assert.ok(capped.notes.some(n => /the note for shot 2 ran to \d+ characters; shortened/.test(n)));
    assert.equal(capped.shotNotes['3'], undefined);
    assert.ok(capped.notes.some(n => /the note for shot 3 cites a reference tag/.test(n)));

    // The guard shrinks a note with its shot's description; the model's hard cap holds it too.
    const wordy = script.shots.slice(0, 3).map(s => ({ ...s, description: `${s.description} ${'The street slides past the windows and the light shifts. '.repeat(55)}` }));
    const note = 'The doors fold shut and the tram starts to climb, its bell ringing as the stop falls behind it and the street opens out.';
    const unit = buildGenerationPlanFromGroups({ episode: 1, shots: wordy }, series, { groups: [{ shots: ['1', '2', '3'] }], shotNotes: { 2: note } }).units[0];
    const { prompt } = quietly(() => buildMontagePrompt(wordy, unit, series));
    assert.ok(prompt.length <= 8000, `prompt is ${prompt.length} characters`);
    assert.ok(!prompt.includes(note), 'the note shrank with the prose');
    assert.ok(prompt.includes('The doors fold shut and the tram'));
    const h3 = { ...series, videoDefaults: { ...series.videoDefaults, montageModel: 'minimax-h3-reference-to-video' } };
    const h3Unit = buildGenerationPlanFromGroups({ episode: 1, shots: wordy }, h3, { groups: [{ shots: ['1', '2', '3'] }], shotNotes: { 2: note } }).units[0];
    const h3Prompt = quietly(() => buildMontagePrompt(wordy, h3Unit, h3)).prompt;
    assert.ok(h3Prompt.length <= 2500, `prompt is ${h3Prompt.length} characters`);
    assert.ok(!h3Prompt.includes(note));

    // A note on a shot that renders alone, and the SEQUENCE grammar, are recorded.
    const lone = withShot(script, 2, { type: 'insert', continuity: { from: 'later' } });
    const result = await planGenerations(stubAgent(GOOD).client, series, lone, { model: 'stub-model' });
    assert.equal(result.plan.planning.by, 'agent');
    assert.ok(result.plan.planning.notes.some(n => /the note for shot 2 is not used: the shot renders alone/.test(n)));
    assert.ok(result.plan.units.every(u => !u.shotNotes));
    const sequence = { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar: 'sequence' } };
    const plan = buildGenerationPlanFromGroups(script, sequence, { groups: [{ shots: ['1', '2', '3'] }, { shots: ['4', '5'] }], shotNotes: { 2: note } });
    assert.ok(plan.units.every(u => !u.shotNotes));
    // The SEQUENCE grammar still splits a group on every change of place.
    assert.deepEqual(plan.units.map(u => u.shotNumbers), [[1, 2], [3], [4, 5]]);
    assert.match(unusedShotNotes(plan, script.shots, { 2: note }, sequence)[0], /only the shot-list montage grammar/);
    const asked = stubAgent(GOOD);
    const sequenced = await planGenerations(asked.client, sequence, script, { model: 'stub-model' });
    assert.equal(asked.calls.length, 0);
    assert.ok(sequenced.plan.planning.notes.some(n => /grammar is "sequence"/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plans built from groups keep to the route: no montage units with montage off, exact lip-sync and staged shots render alone', async () => {
  const { dir, series, script } = fixture();
  try {
    const off = { ...series, videoDefaults: { ...series.videoDefaults, montageMode: false } };
    const plan = buildGenerationPlanFromGroups(script, off, { groups: [{ shots: ['1', '2'] }, { shots: ['3', '4', '5'] }] });
    assert.ok(plan.units.every(u => u.unitType !== 'montage'));
    // Never a unit across a group's end: shots 2 and 3 are in different groups.
    assert.ok(plan.units.every(u => !(u.shotNumbers.includes(2) && u.shotNumbers.includes(3))));
    assert.ok(plan.units.some(u => u.unitType === 'multishot' && u.shotNumbers.join() === '4,5'));
    // The standard route never asks the agent.
    const asked = stubAgent(GOOD);
    const result = await planGenerations(asked.client, off, script, { model: 'stub-model' });
    assert.equal(asked.calls.length, 0);
    assert.equal(result.plan.planning.by, 'rules');
    assert.ok(result.plan.planning.notes.some(n => /Montage mode is off/.test(n)));

    const speaking = withShot(script, 2, { dialogue: { character: 'LEO', line: 'Safe trip.' } });
    const lipSync = { ...series, videoDefaults: { ...series.videoDefaults, audioStrategy: 'lip-sync' } };
    const lip = buildGenerationPlanFromGroups(speaking, lipSync, { groups: [{ shots: ['1', '2', '3'] }, { shots: ['4', '5'] }] });
    assert.deepEqual(lip.units.map(u => [u.unitType, u.shotNumbers.join()]), [['montage', '1'], ['single', '2'], ['montage', '3'], ['montage', '4,5']]);

    // A staged shot renders alone even when its mustStaySingle was edited away.
    const picked = withShot(script, 2, { stagingRef: staged('plate'), mustStaySingle: false });
    assert.equal(montageBlockReason(picked.shots[1], series.videoDefaults), 'staged');
    assert.equal(montageBlockReason(withShot(picked, 2, { mustStaySingle: true }).shots[1], series.videoDefaults), 'staged');
    const grouped = buildGenerationPlanFromGroups(picked, series, { groups: [{ shots: ['1', '2', '3'] }, { shots: ['4', '5'] }] });
    assert.deepEqual(grouped.units.map(u => [u.unitType, u.shotNumbers.join()]), [['montage', '1'], ['single', '2'], ['montage', '3'], ['montage', '4,5']]);
    assert.deepEqual(buildGenerationPlan(picked, series).units.find(u => u.shotNumbers.includes(2)).unitType, 'single');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit flags a carry across a cut between generations, quotes each unit, and reports what is on disk', async () => {
  const { dir, series, script } = fixture();
  try {
    const unmarked = { ...script, shots: script.shots.map(s => ({ ...s, continuity: undefined })) };
    const plan = buildGenerationPlan(unmarked, series);
    const ledger = buildContinuityLedger(series, script.shots);
    const sceneDir = join(dir, 'scene-001');
    mkdirSync(sceneDir, { recursive: true });
    writeFileSync(join(sceneDir, 'shot-004.mp4'), PNG);
    writeFileSync(join(sceneDir, 'shot-005.mp4'), PNG);
    const quoted = [];
    const audits = await auditPlan(series, script.shots, plan, ledger, {
      sceneDir,
      quote: async (unit, model) => { quoted.push(model); if (unit.shotNumbers.includes(3)) throw new Error('offline'); return Number(unit.duration.replace('s', '')) * 0.29; },
    });
    // By the location rule, shots 2 and 3 are separate generations though the tram must carry.
    const street = audits.find(a => a.shots.includes('2'));
    assert.ok(street.carriesOut.includes('CABLE TRAM into shot 3'));
    assert.equal(street.model, MODEL);
    // Three cast members and the street's plate, against the model's budget.
    assert.deepEqual([street.references, street.budget], [4, 30]);
    assert.equal(audits.find(a => a.shots.includes('3')).costUsd, undefined);
    assert.equal(typeof audits.find(a => a.shots.includes('4')).costUsd, 'number');
    assert.deepEqual(audits.find(a => a.shots.includes('4')).onDisk, { clips: 2, of: 2, master: false });
    const text = describeGenerationPlan({ plan, audits }, { project: dir, episode: 1 }).join('\n');
    assert.match(text, /on disk: every clip, but no montage-s03-004-005\.mp4: generate-videos keeps the cuts and bills nothing, and qa-videos checks the unit from its clips\. To render shots 4, 5 again as one generation: generate-videos -p .* -e 1 --retake 4,5/);
    assert.match(text, /Quoted: \$\d+\.\d\d for the units that would render \(\$2\.90 more for units already on disk, if re-taken\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a single shorter than its model renders is found before any spend: in the audit and the duration preflight, through the lane hint', async () => {
  const { dir, series, script } = fixture();
  try {
    // Shot 3 renders alone (a staged plate pick) at 3 s; Seedance 2.5 renders 4-30 s. Its unit's model is the
    // shot's lane hint ("action"), which the registry does not know: the preflight used to skip it, and the 400
    // came back from the queue in the middle of a paid run.
    const shots = script.shots.map(s => (s.shotNumber === 3 ? { ...s, duration: '3s', stagingRef: staged('plate') } : s));
    const plan = buildGenerationPlan({ ...script, shots }, series);
    const single = plan.units.find(u => u.shotNumbers.includes(3));
    assert.equal(single.unitType, 'single');
    assert.equal(single.model, 'action');

    const audits = await auditPlan(series, shots, plan, buildContinuityLedger(series, shots), { quote: async () => undefined });
    assert.match(audits.find(a => a.shots.includes('3')).findings[0], /^cannot render: Duration 3s is not supported by seedance-2-5-reference-to-video .*; try 4s$/);
    assert.ok(audits.filter(a => !a.shots.includes('3')).every(a => !a.findings.some(f => f.startsWith('cannot render'))));

    assert.throws(() => assertShotDurationsValid(shots, plan, series),
      /shot 3: duration "3s" \(3s\) is shorter than model "seedance-2-5-reference-to-video" renders \(4s at least\)\. Make it 4s, or render it inside a unit with its neighbours\./);
    // Without the project there is nothing to resolve the hint with: the old behaviour, no throw.
    assert.doesNotThrow(() => assertShotDurationsValid(shots, plan));
    const fixed = shots.map(s => (s.shotNumber === 3 ? { ...s, duration: '4s' } : s));
    assert.doesNotThrow(() => assertShotDurationsValid(fixed, buildGenerationPlan({ ...script, shots: fixed }, series), series));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit reads the plate inventories the workshop reads, and a staged shot\'s clip from before its pick renders again', async () => {
  const { dir, series, script } = fixture();
  setWorkshopPlanProvider(() => ({
    fixedLocation: location => location.slug === 'market-street',
    plateInventory: location => (location.slug === 'market-street'
      ? { north: { vehicles: [{ what: 'red bus', distance: 'near', count: 1 }], places: [], objects: [] } }
      : undefined),
  }));
  try {
    const picked = withShot(script, 3, { stagingRef: staged('start-frame'), mustStaySingle: true });
    const plan = buildGenerationPlan(picked, series);
    const sceneDir = join(dir, 'scene-001');
    mkdirSync(sceneDir, { recursive: true });
    // Shot 3's clip predates its pick: no .video.json records the pick's hash.
    writeFileSync(join(sceneDir, 'shot-003.mp4'), PNG);
    for (const n of [4, 5]) writeFileSync(join(sceneDir, `shot-00${n}.mp4`), PNG);
    writeFileSync(join(sceneDir, plan.units.find(u => u.shotNumbers.includes(4)).outputFile), PNG);
    const audits = await auditPlan(series, picked.shots, plan, buildContinuityLedger(series, picked.shots), {
      sceneDir,
      quote: async unit => Number(unit.duration.replace('s', '')) * 0.1,
    });
    const street = audits.find(a => a.shots.includes('1'));
    assert.ok(street.findings.some(f => /names the tram at market-street \(north\), but that plate shows a red bus/.test(f)), street.findings.join('\n'));
    const alone = audits.find(a => a.shots.includes('3'));
    assert.equal(alone.unitType, 'single');
    assert.deepEqual(alone.onDisk, { clips: 0, of: 1, master: false, stale: ['3'] });
    const text = describeGenerationPlan({ plan, audits }, { project: dir, episode: 1 }).join('\n');
    assert.match(text, /on disk: the clip of shot 3 predates its staging ref \(stage-ref\): generate-videos renders it again from the pick \(billed\)/);
    assert.doesNotMatch(text.split('\n').filter(line => /shot 3/.test(line)).join('\n'), /bills nothing/);
    // Its quote counts among the units that would render; only shots 4 and 5 are kept.
    assert.match(text, /Quoted: \$1\.40 for the units that would render \(\$1\.00 more for units already on disk, if re-taken\)/);

    // A clip rendered from the current pick is kept.
    writeFileSync(join(sceneDir, 'shot-003.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'a'.repeat(64) } } }));
    const kept = await auditPlan(series, picked.shots, plan, buildContinuityLedger(series, picked.shots), { sceneDir });
    assert.deepEqual(kept.find(a => a.shots.includes('3')).onDisk, { clips: 1, of: 1, master: false });
  } finally {
    setWorkshopPlanProvider(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quotes ask what the render would send, once per request, and stop after a failure that is not the request\'s', async () => {
  const { dir, series, script } = fixture();
  try {
    const plan = buildGenerationPlan(script, series);
    const bodies = [];
    const client = { async post(path, body) {
      bodies.push({ path, body });
      if (body.duration === '9s') throw new VeniceRequestError('bad duration', 400, {});
      return { quote: 1.25 };
    } };
    const quoter = unitQuoter(client, series);
    const unit = plan.units[0];
    assert.equal(await quoter.quote(unit, MODEL), 1.25);
    assert.equal(await quoter.quote({ ...unit }, MODEL), 1.25);
    assert.equal(bodies.length, 1, 'the same request is asked once');
    assert.equal(bodies[0].path, '/api/v1/video/quote');
    assert.deepEqual(bodies[0].body, { model: MODEL, duration: unit.duration, resolution: '720p', aspect_ratio: '16:9', audio: true });
    assert.equal(await quoter.quote({ ...unit, duration: '9s' }, MODEL), undefined);
    assert.equal(quoter.stopped, undefined, 'a rejected request costs only its own quote');

    // A single renders at videoDefaults.resolution when its model lists it, as the render does; a montage does not.
    const sharp = { ...series, videoDefaults: { ...series.videoDefaults, resolution: '1080p' } };
    const seen = [];
    const hd = unitQuoter({ async post(path, body) { seen.push(body); return { quote: 2 }; } }, sharp);
    const single = { ...unit, unitType: 'single', unitId: 'unit-002', outputFile: 'shot-002.mp4', duration: '4s' };
    await hd.quote(single, MODEL);
    await hd.quote(unit, MODEL);
    await hd.quote({ ...single, duration: '5s' }, 'minimax-h3-reference-to-video');
    assert.deepEqual(seen.map(body => body.resolution), ['1080p', '720p', '2K']);

    let calls = 0;
    const offline = unitQuoter({ async post() { calls += 1; throw new TypeError('fetch failed'); } }, series);
    assert.equal(await offline.quote(unit, MODEL), undefined);
    assert.equal(await offline.quote({ ...unit, duration: '6s' }, MODEL), undefined);
    assert.equal(calls, 1, 'no further calls after the network failed');
    assert.equal(offline.stopped, 'fetch failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved plan applies while what decides its packaging is unchanged, rebuilt with the settings of the run', async () => {
  const { dir, series, script } = fixture();
  try {
    assert.deepEqual(checkPlanApproval(null, script, series), { status: 'none' });
    const proposal = await approvedProposal(series, script);
    const unapproved = checkPlanApproval({ ...proposal, planning: { ...proposal.planning, approved: false } }, script, series);
    assert.equal(unapproved.status, 'unapproved');
    assert.deepEqual(unapproved.changes, []);

    const ok = checkPlanApproval(proposal, script, series);
    assert.equal(ok.status, 'approved');
    assert.notEqual(ok.plan, proposal);
    assert.deepEqual(ok.plan.units.map(u => u.unitId), proposal.units.map(u => u.unitId));
    assert.deepEqual(ok.plan.units[0].shotNotes, { 2: 'The doors fold shut and the tram starts to climb' });
    assert.equal(ok.plan.planning.approvedBy, 'Tester');

    // A shot's words, view and type change its prompt line, not its packaging; nor does the order of its cast.
    let edited = withShot(script, 3, { description: 'ANNA sits by the window.', blocking: 'ANNA right', stagedOn: 'the bench', plateView: 'east', type: 'close-up' });
    edited = withShot(edited, 2, { blocking: 'LEO left', dialogue: { character: 'LEO', line: 'Safe trip.' }, characters: ['CABLE TRAM', 'LEO'] });
    edited = withShot(edited, 1, { continuity: { from: 'new-scene', endState: 'ANNA inside' } });
    assert.equal(checkPlanApproval(proposal, edited, series).status, 'approved');

    const stale = (s, settings = {}, from = proposal) => {
      const result = checkPlanApproval(from, s, { ...series, videoDefaults: { ...series.videoDefaults, ...settings } });
      assert.equal(result.status, 'stale');
      return result.changes.join(' | ');
    };
    assert.match(stale(withShot(script, 2, { duration: '6s' })), /shot 2: 4 s → 6 s/);
    assert.match(stale(script, { montageMode: false }), /montage mode: on → off/);
    assert.match(stale(script, { montageMaxDurationSec: 12 }), /montage ceiling: 30 s → 12 s/);
    assert.match(stale(script, { montageModel: 'seedance-2-0-reference-to-video' }), /montage model: seedance-2-5-reference-to-video → seedance-2-0-reference-to-video/);
    assert.match(stale(script, { montageGrammar: 'sequence' }), /montage grammar: shots → sequence/);
    assert.match(stale(withShot(script, 2, { dialogue: { character: 'LEO', line: 'Go.' } }), { audioStrategy: 'lip-sync' }), /shot 2: now renders as an exact lip-sync clip/);
    assert.match(stale(withShot(script, 3, { continuity: { from: 'later' } })), /shot 3: continuity continuous → later/);
    assert.match(stale(withShot(script, 4, { description: 'Title card: LATER' })), /shot 4: now a title card/);
    assert.match(stale(withShot(script, 5, { type: 'insert' })), /shot 5: now an insert/);
    assert.match(stale({ ...script, shots: [...script.shots.slice(0, 3), shot(3, { shotIdSuffix: 'b', location: 'tram-interior' }), ...script.shots.slice(3)] }), /shot 3b is new/);
    assert.match(stale(withShot(script, 5, { characters: ['ANNA', 'LEO'] })), /shot 5: cast ANNA → ANNA, LEO/);

    // A shot note amends its shot's description: rewriting that shot stales the plan.
    assert.match(stale(withShot(script, 2, { description: 'The tram stays at the stop, its doors open.' })), /shot 2: description rewritten, and the plan's shot note for it was written for the old one/);
    assert.equal(checkPlanApproval(proposal, withShot(script, 2, { description: '  The tram pulls away   uphill from the stop. ' }), series).status, 'approved', 'whitespace is not a rewrite');

    // A staging ref picked (stage-ref) renders its shot alone: said once, not as a mustStaySingle change too.
    const picked = withShot(script, 3, { stagingRef: staged('plate'), mustStaySingle: true });
    const pickChanges = stale(picked);
    assert.match(pickChanges, /shot 3: staging ref picked \(plate, stage-ref\): it renders alone/);
    assert.doesNotMatch(pickChanges, /mustStaySingle/);
    const stagedProposal = await approvedProposal(series, picked);
    assert.equal(checkPlanApproval(stagedProposal, picked, series).status, 'approved');
    assert.equal(checkPlanApproval(stagedProposal, withShot(picked, 3, { stagingRef: staged('plate', { sha256: 'b'.repeat(64) }) }), series).status, 'approved', 'another pick of the same use');
    assert.match(stale(withShot(picked, 3, { stagingRef: staged('start-frame') }), {}, stagedProposal), /shot 3: staging ref now used as a start-frame/);
    assert.match(stale(script, {}, stagedProposal), /shot 3: staging ref cleared/);
    // A staged shot renders alone whatever its mustStaySingle says: editing it away keeps the plan.
    assert.equal(checkPlanApproval(stagedProposal, withShot(picked, 3, { mustStaySingle: false }), series).status, 'approved');
    assert.match(stale(withShot(script, 3, { mustStaySingle: true })), /shot 3: mustStaySingle false → true/);

    // An exact lip-sync shot that turns high-motion leaves the lip-sync lane: the approval follows.
    const lipSeries = { ...series, videoDefaults: { ...series.videoDefaults, audioStrategy: 'lip-sync' } };
    const speaking = withShot(script, 2, { dialogue: { character: 'LEO', line: 'Go.' } });
    const lipProposal = await approvedProposal(lipSeries, speaking);
    assert.equal(checkPlanApproval(lipProposal, speaking, lipSeries).status, 'approved');
    const high = checkPlanApproval(lipProposal, withShot(speaking, 2, { motion: 'high' }), lipSeries);
    assert.equal(high.status, 'stale');
    assert.match(high.changes.join(' | '), /shot 2: no longer renders as an exact lip-sync clip/);

    // The planner packaging the same inputs differently refuses too.
    const tampered = { ...proposal, units: proposal.units.map((u, i) => (i === 0 ? { ...u, shotNumbers: [1, 2] } : u)) };
    assert.match(checkPlanApproval(tampered, script, series).changes.join(' | '), /the planner now packages the shots differently/);

    // A rules plan is rebuilt by rules.
    const rules = toProposal(await planGenerations(null, series, script, { agent: false }));
    rules.planning.approved = true;
    const rulesCheck = checkPlanApproval(rules, script, series);
    assert.equal(rulesCheck.status, 'approved');
    assert.deepEqual(rulesCheck.plan.units.map(u => u.unitId), buildGenerationPlan(script, series).units.map(u => u.unitId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on the standard route the approval reads what that planner reads: no montage settings or continuity, but establishing shots and allowMultiShot', async () => {
  const { dir, series, script } = fixture({ montageMode: false });
  try {
    const proposal = toProposal(await planGenerations(null, series, script, { agent: false }));
    proposal.planning.approved = true;
    assert.deepEqual(Object.keys(proposal.planning.inputs.settings), ['montage']);
    const check = (s, settings = {}) => checkPlanApproval(proposal, s, { ...series, videoDefaults: { ...series.videoDefaults, ...settings } });
    assert.equal(check(script, { montageModel: 'seedance-2-0-reference-to-video', montageGrammar: 'sequence', montageMaxDurationSec: 12 }).status, 'approved');
    assert.equal(check(withShot(script, 3, { continuity: { from: 'new-scene' } })).status, 'approved');
    assert.equal(check(withShot(script, 1, { characters: ['CABLE TRAM', 'ANNA', 'LEO'] })).status, 'approved');
    assert.match(check(withShot(script, 4, { type: 'establishing' })).changes.join(' | '), /shot 4: now an establishing shot/);
    assert.match(check(withShot(script, 5, { allowMultiShot: false })).changes.join(' | '), /shot 5: allowMultiShot true → false/);
    assert.match(check(withShot(script, 5, { characters: [] })).changes.join(' | '), /shot 5: cast ANNA → none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a script edit outside plan-generations says when it makes the plan stale or valid again, and what to run next', async () => {
  const { dir, series, script } = fixture();
  try {
    const ref = '-p "/x" -e 1';
    const proposal = await approvedProposal(series, script);
    const picked = withShot(script, 3, { stagingRef: staged('plate'), mustStaySingle: true });
    const approved = checkPlanApproval(proposal, script, series);
    const stale = checkPlanApproval(proposal, picked, series);
    const toStale = describePlanAfterEdit(approved, stale, ref);
    assert.match(toStale.lines[0], /^This makes the generation plan approved by Tester out of date \(shot 3: staging ref picked \(plate, stage-ref\): it renders alone\)\. generate-videos refuses to run until/);
    assert.equal(toStale.next, 'plan-generations -p "/x" -e 1');
    const back = describePlanAfterEdit(stale, approved, ref);
    assert.deepEqual(back, { lines: ['The generation plan approved by Tester applies again: generate-videos renders it.'], next: 'generate-videos -p "/x" -e 1' });

    const waiting = { ...proposal, planning: { ...proposal.planning, approved: false } };
    const current = checkPlanApproval(waiting, script, series);
    const outOfDate = checkPlanApproval(waiting, picked, series);
    assert.match(describePlanAfterEdit(current, outOfDate, ref).lines[0], /proposal waiting for approval out of date \(shot 3: staging ref picked/);
    assert.equal(describePlanAfterEdit(current, outOfDate, ref).next, 'plan-generations -p "/x" -e 1');
    assert.deepEqual(describePlanAfterEdit(outOfDate, current, ref), { lines: ['The generation plan proposal waiting for approval matches the script again: approve it to render it.'], next: 'plan-generations -p "/x" -e 1 --approve "<your name>"' });
    assert.deepEqual(describePlanAfterEdit({ status: 'none' }, { status: 'none' }, ref), { lines: [], next: 'generate-videos -p "/x" -e 1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renders in flight under another packaging are the ones a plan would never collect', () => {
  const { dir, series, script } = fixture();
  try {
    const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    const job = (file, fields = {}) => ({
      kind: 'video', model: MODEL, queueId: `q-${file}`, outputPath: join(sceneDir, file), project: dir,
      createdAt: '2026-10-26T11:50:00.000Z', updatedAt: '2026-10-26T11:55:00.000Z', pid: 1, ...fields,
    });
    const picked = withShot(script, 2, { stagingRef: staged('plate'), mustStaySingle: true });
    const plan = buildGenerationPlan(picked, series);
    assert.deepEqual(plan.units.map(u => u.outputFile), ['montage-s01-001-001.mp4', 'shot-002.mp4', 'montage-s01-003-003.mp4', 'montage-s02-004-005.mp4']);
    const jobs = [
      job('montage-s01-001-001.mp4'),
      job('shot-002.mp4'),
      job('shot-002-r2v-keyframe.mp4'),
      job('montage-s01-001-003.mp4'),
      job('shot-004.mp4'),
      job('montage-s01-002-003.mp4', { updatedAt: '2026-10-26T05:00:00.000Z' }),
      job('montage-s01-001-002.mp4', { kind: 'audio' }),
      { ...job('montage-s01-001-002.mp4'), outputPath: join(dir, 'episodes', 'episode-002', 'scene-001', 'montage-s01-001-002.mp4') },
    ];
    // Another packaging's master and a single's clip that this plan cuts from a montage; not
    // a job past the queue's lifetime, an audio job, or another episode's.
    assert.deepEqual(inFlightOutsidePlan(jobs, sceneDir, plan, picked.shots, now).map(item => item.queueId), ['q-montage-s01-001-003.mp4', 'q-shot-004.mp4']);
    assert.deepEqual(inFlightOutsidePlan([], sceneDir, plan, picked.shots, now), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The commands -----------------------------------------------------------

function run(args, { pending } = {}) {
  return new Promise((resolve, reject) => {
    const config = mkdtempSync(join(tmpdir(), 'plan-generations-config-'));
    // The pending-job store, stubbed with the registry's own file.
    if (pending) writeFileSync(join(config, 'pending-jobs.json'), JSON.stringify({ version: 1, jobs: pending }, null, 2));
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, VENICE_API_KEY: '', VENICE_VIDEO_CONFIG_DIR: config, VENICE_VIDEO_NO_OPEN: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', status => { rmSync(config, { recursive: true, force: true }); resolve({ status, stdout, stderr }); });
  });
}

function project(edit = s => s) {
  const { dir, series, script: base } = fixture();
  const script = edit(base);
  writeFileSync(join(dir, 'series.json'), JSON.stringify(series, null, 2));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  mkdirSync(join(episodeDir, 'scene-001'), { recursive: true });
  const writeScript = (s) => writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ ...s, status: 'approved' }, null, 2));
  writeScript(script);
  // QA cleared and every panel drawn, so status reaches the render.
  const qaCleared = () => {
    writeFileSync(join(episodeDir, 'qa-report.json'), '{}');
    writeFileSync(join(episodeDir, 'qa-approved.json'), '{}');
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(episodeDir, 'scene-001', `shot-00${n}.png`), PNG);
  };
  return { dir, series, script, episodeDir, writeScript, qaCleared };
}

test('plan-generations writes a proposal beside the rendered plan; generate-videos refuses to bypass it until it is approved', async () => {
  const { dir, episodeDir, qaCleared } = project();
  try {
    const planned = await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent']);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /planned by rules, not approved yet/);
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed.json')));
    assert.match(readFileSync(join(episodeDir, 'generation-plan.proposed.md'), 'utf-8'), /^# Generation plan, episode 1/);
    assert.ok(!existsSync(join(episodeDir, 'generation-plan.json')), 'the rendered plan is not touched');

    const render = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa']);
    assert.equal(render.status, 1);
    assert.match(render.stderr, /Blocked: a generation plan proposal is waiting for approval \(.*generation-plan\.proposed\.md\): 2 unit\(s\), planned by rules\. This run would render by the rules planner instead/);
    assert.match(render.stderr, /To render it, approve it: {2}plan-generations -p .* -e 1 --approve "<your name>"/);
    assert.doesNotMatch(render.stderr, /API key/, 'refused before the key is read');
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed.json')), 'the proposal survives a run');

    qaCleared();
    const status = await collectProjectStatus(dir);
    assert.equal(status.episodes[0].stage, 'generation plan awaiting approval');
    assert.equal(status.episodes[0].nextCommand, `plan-generations -p "${dir}" -e 1 --approve "<your name>"`);

    const ignored = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--ignore-plan']);
    assert.match(ignored.stderr, /--ignore-plan: the generation plan proposal waiting for approval \(.*\) is left as it is; rendering by the rules planner/);
    assert.match(ignored.stderr, /Venice API key is required/, 'it went on to the key');

    const replanned = await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent']);
    assert.equal(replanned.status, 0, replanned.stderr);
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed-v1.json')), 'the previous proposal is archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved plan renders while it applies; once the shots change, generate-videos and --approve refuse, and status says to plan again', async () => {
  const { dir, script, episodeDir, writeScript, qaCleared } = project();
  try {
    assert.equal((await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent'])).status, 0);
    const approve = await run(['plan-generations', '-p', dir, '-e', '1', '--approve', 'Tester']);
    assert.equal(approve.status, 0, approve.stderr);
    assert.equal((await loadPlanProposal(episodeDir)).planning.approvedBy, 'Tester');
    assert.match(readFileSync(join(episodeDir, 'generation-plan.proposed.md'), 'utf-8'), /approved by Tester/);

    const ok = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa']);
    assert.match(ok.stdout, /Using the approved generation plan/);
    assert.match(ok.stderr, /Venice API key is required/);

    writeScript(withShot(script, 2, { duration: '6s' }));
    const blocked = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa']);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Blocked: the generation plan approved by Tester .* no longer matches/);
    assert.match(blocked.stderr, /shot 2: 4 s → 6 s/);
    assert.match(blocked.stderr, /plan-generations -p .* -e 1 --approve/);
    assert.doesNotMatch(blocked.stderr, /API key/, 'refused before anything else');

    const montageOff = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--no-montage']);
    assert.match(montageOff.stderr, /montage mode: on → off/);

    const ignored = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--ignore-plan']);
    assert.match(ignored.stderr, /--ignore-plan: the approved generation plan no longer applies/);
    assert.match(ignored.stderr, /Venice API key is required/);

    const reapprove = await run(['plan-generations', '-p', dir, '-e', '1', '--approve', 'Tester']);
    assert.equal(reapprove.status, 1);
    assert.match(reapprove.stderr, /shot 2: 4 s → 6 s/);

    qaCleared();
    const status = await collectProjectStatus(dir);
    assert.equal(status.episodes[0].stage, 'approved generation plan out of date');
    assert.equal(status.episodes[0].nextCommand, `plan-generations -p "${dir}" -e 1`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate-videos refuses, before the key, while renders queued under another packaging are in flight', async () => {
  const { dir, series, script, episodeDir, qaCleared } = project();
  try {
    // An approved plan that packages shot 3 alone; the rules planner keeps 1-3 together.
    await savePlanProposal(episodeDir, await approvedProposal(series, script, SPLIT), '# x\n');
    const rules = buildGenerationPlan(script, series);
    assert.equal(rules.units[0].outputFile, 'montage-s01-001-003.mp4');
    const now = new Date().toISOString();
    const queued = (file, fields = {}) => ({
      kind: 'video', model: MODEL, queueId: 'q-rules-1', outputPath: join(episodeDir, 'scene-001', file), project: dir,
      createdAt: now, updatedAt: now, pid: 1, ...fields,
    });
    const pending = [queued('montage-s01-001-003.mp4')];

    const blocked = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa'], { pending });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /Using the approved generation plan/);
    assert.match(blocked.stderr, /Blocked: 1 render\(s\) for this episode are still in flight under another packaging of the shots, and the plan this run renders would never collect them \(rule 43\)/);
    assert.match(blocked.stderr, /montage-s01-001-003\.mp4 \(seedance-2-5-reference-to-video, queue id q-rules-1, queued [^)]+\); collect it with generate-videos -p \S+ -e 1 --ignore-plan \(the rules planner's packaging\)/);
    assert.match(blocked.stderr, /venice-video queue/);
    assert.match(blocked.stderr, /--ignore-in-flight renders anyway; it does not collect them/);
    assert.doesNotMatch(blocked.stderr, /API key/, 'refused before the key is read');

    // The packaging that queued it collects it: nothing to refuse.
    const collect = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--ignore-plan'], { pending });
    assert.doesNotMatch(collect.stderr, /in flight/);
    assert.match(collect.stderr, /Venice API key is required/);

    // Rendering anyway is a decision someone states.
    const anyway = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--ignore-in-flight'], { pending });
    assert.match(anyway.stderr, /--ignore-in-flight: 1 render\(s\) queued under another packaging stay uncollected/);
    assert.match(anyway.stderr, /Venice API key is required/);

    // A job past the queue's lifetime is gone: nothing to collect, nothing to refuse.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const expired = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa'], { pending: [queued('montage-s01-001-003.mp4', { createdAt: old, updatedAt: old })] });
    assert.doesNotMatch(expired.stderr, /in flight/);
    assert.match(expired.stderr, /Venice API key is required/);

    // status says the same (rule 45), from the same registry.
    qaCleared();
    const config = mkdtempSync(join(tmpdir(), 'plan-generations-status-'));
    const before = process.env.VENICE_VIDEO_CONFIG_DIR;
    process.env.VENICE_VIDEO_CONFIG_DIR = config;
    try {
      writeFileSync(join(config, 'pending-jobs.json'), JSON.stringify({ version: 1, jobs: pending }));
      const status = await collectProjectStatus(dir);
      assert.equal(status.episodes[0].stage, '1 render(s) in flight under another packaging');
      assert.equal(status.episodes[0].nextCommand, `generate-videos -p "${dir}" -e 1 --ignore-plan`);
      // Queued under a packaging neither planner makes now: look at them.
      writeFileSync(join(config, 'pending-jobs.json'), JSON.stringify({ version: 1, jobs: [queued('montage-s09-002-004.mp4')] }));
      const unknown = await collectProjectStatus(dir);
      assert.equal(unknown.episodes[0].nextCommand, 'queue');
      assert.equal(qualifyCommand('queue', dir), 'queue', 'queue takes no project');
    } finally {
      if (before === undefined) delete process.env.VENICE_VIDEO_CONFIG_DIR;
      else process.env.VENICE_VIDEO_CONFIG_DIR = before;
      rmSync(config, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage-ref --clear says when it makes the approved plan stale, or valid again', async () => {
  const { dir, script, writeScript } = project(s => withShot(s, 3, { stagingRef: staged('plate'), mustStaySingle: true }));
  try {
    assert.equal((await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent'])).status, 0);
    assert.equal((await run(['plan-generations', '-p', dir, '-e', '1', '--approve', 'Tester'])).status, 0);
    const cleared = await run(['stage-ref', '-p', dir, '-e', '1', '--shot', '3', '--clear']);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared shot 3's staging ref/);
    assert.match(cleared.stdout, /This makes the generation plan approved by Tester out of date \(shot 3: staging ref cleared\)/);
    assert.match(cleared.stdout, /Next:\n {2}venice-video plan-generations -p "[^"]+" -e 1\n/);

    // Planned and approved without the pick, then picked again (by hand): the clear restores the plan.
    assert.equal((await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent'])).status, 0);
    assert.equal((await run(['plan-generations', '-p', dir, '-e', '1', '--approve', 'Tester'])).status, 0);
    writeScript(withShot(script, 3, { stagingRef: staged('plate'), mustStaySingle: true }));
    const restored = await run(['stage-ref', '-p', dir, '-e', '1', '--shot', '3', '--clear']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /The generation plan approved by Tester applies again: generate-videos renders it\./);
    assert.match(restored.stdout, /Next:\n {2}venice-video generate-videos -p "[^"]+" -e 1\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate-videos --retake takes shot ids, refuses ones the script does not have, and refuses a staged shot before the key', async () => {
  const { dir } = project();
  const pickedProject = project(s => withShot(s, 3, { stagingRef: staged('plate'), mustStaySingle: true }));
  try {
    const unknown = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--retake', '2b,x,3']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /--retake 2b,x,3: shot\(s\) x, 2b are not in episode 1\. Nothing was rendered or archived\./);
    const known = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--retake', '003']);
    assert.match(known.stderr, /Venice API key is required/);

    // The picked image is gone: nothing is archived, and no key is needed to say so.
    const refused = await run(['generate-videos', '-p', pickedProject.dir, '-e', '1', '--skip-qa', '--retake', '3']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--retake 3: 1 staged shot\(s\) cannot render from their staging ref\. Nothing was archived or rendered\./);
    assert.match(refused.stderr, /shot 3: the staging ref image \S+ is not on disk/);
    assert.doesNotMatch(refused.stderr, /API key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pickedProject.dir, { recursive: true, force: true });
  }
});

test('the pipeline and the agent guide name plan-generations, and approving it is a human decision', () => {
  const branch = PIPELINE_BRANCHES.find(b => b.id === 'plan-generations');
  assert.ok(branch, 'PIPELINE_BRANCHES lists plan-generations');
  assert.equal(branch.command, 'plan-generations -p <project> -e <n>');
  assert.match(branch.note, /human decision/);
  const render = PIPELINE_STAGES.find(stage => stage.id === 'render');
  assert.match(render.gate, /plan-generations -p <project> -e <n> --approve "<name>"/);
  assert.match(render.gate, /--ignore-plan renders by rules for one run; it does not approve or update the plan/);
  assert.match(render.gate, /--ignore-in-flight does not collect them/);
  assert.match(formatGuide(), /plan-generations --approve/);
});

test('a saved proposal round-trips through disk', async () => {
  const { dir, series, script } = fixture();
  try {
    const episodeDir = join(dir, 'episodes', 'episode-001');
    mkdirSync(episodeDir, { recursive: true });
    const proposal = await approvedProposal(series, script);
    await savePlanProposal(episodeDir, proposal, '# x\n');
    const loaded = await loadPlanProposal(episodeDir);
    assert.equal(checkPlanApproval(loaded, script, series).status, 'approved');
    writeFileSync(join(episodeDir, 'generation-plan.proposed.json'), '{ not json');
    await assert.rejects(loadPlanProposal(episodeDir), /could not be parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
