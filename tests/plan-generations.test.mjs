// plan-generations: the continuity ledger, the packaging agent's answer checked
// by the validator (with a rules fallback), the reference audit, and the
// approval that generate-videos honours or refuses. The agent and the quote
// endpoint are stubs: no network calls.

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
  checkPlanApproval, hashPackagingInputs, loadPlanProposal, packagingInputs, savePlanProposal,
} from '../dist/mini-drama/generation-plan-approval.js';
import { buildGenerationPlan, buildGenerationPlanFromGroups, resolveUnitShots } from '../dist/mini-drama/generation-planner.js';
import { buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { collectProjectStatus } from '../dist/session/status.js';
import { PIPELINE_BRANCHES } from '../packages/core/dist/agent/pipeline.js';
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
    assert.equal(planning.packagingHash, hashPackagingInputs(packagingInputs(script, series)));
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

test('plans built from groups keep to the route: no montage units with montage off, and exact lip-sync shots render alone', async () => {
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

    // A shot's words change its prompt line, not its packaging.
    let edited = withShot(script, 2, { description: 'The tram pulls away from the stone stop.', blocking: 'LEO left', stagedOn: 'the stop', dialogue: { character: 'LEO', line: 'Safe trip.' } });
    edited = withShot(edited, 1, { continuity: { from: 'new-scene', endState: 'ANNA inside' } });
    assert.equal(checkPlanApproval(proposal, edited, series).status, 'approved');

    const stale = (s, settings = {}) => {
      const result = checkPlanApproval(proposal, s, { ...series, videoDefaults: { ...series.videoDefaults, ...settings } });
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
    assert.match(stale({ ...script, shots: [...script.shots.slice(0, 3), shot(3, { shotIdSuffix: 'b', location: 'tram-interior' }), ...script.shots.slice(3)] }), /shot 3b is new/);
    assert.match(stale(withShot(script, 5, { characters: ['ANNA', 'LEO'] })), /shot 5: cast ANNA → ANNA, LEO/);

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

// ---- The commands -----------------------------------------------------------

function run(args) {
  return new Promise((resolve, reject) => {
    const config = mkdtempSync(join(tmpdir(), 'plan-generations-config-'));
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

function project() {
  const { dir, series, script } = fixture();
  writeFileSync(join(dir, 'series.json'), JSON.stringify(series, null, 2));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  mkdirSync(join(episodeDir, 'scene-001'), { recursive: true });
  const writeScript = (s) => writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ ...s, status: 'approved' }, null, 2));
  writeScript(script);
  return { dir, series, script, episodeDir, writeScript };
}

test('plan-generations writes a proposal beside the rendered plan; generate-videos warns about it until it is approved', async () => {
  const { dir, episodeDir } = project();
  try {
    const planned = await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent']);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /planned by rules, not approved yet/);
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed.json')));
    assert.match(readFileSync(join(episodeDir, 'generation-plan.proposed.md'), 'utf-8'), /^# Generation plan, episode 1/);
    assert.ok(!existsSync(join(episodeDir, 'generation-plan.json')), 'the rendered plan is not touched');

    const render = await run(['generate-videos', '-p', dir, '-e', '1', '--skip-qa']);
    assert.notEqual(render.status, 0);
    assert.match(render.stderr, /A generation plan proposal is waiting for approval/);
    assert.match(render.stderr, /plan-generations -p .* -e 1 --approve/);
    assert.match(render.stderr, /Venice API key is required/, 'it went on to the key, as before');
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed.json')), 'the proposal survives a run');

    const replanned = await run(['plan-generations', '-p', dir, '-e', '1', '--no-agent']);
    assert.equal(replanned.status, 0, replanned.stderr);
    assert.ok(existsSync(join(episodeDir, 'generation-plan.proposed-v1.json')), 'the previous proposal is archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved plan renders while it applies; once the shots change, generate-videos and --approve refuse, and status says to plan again', async () => {
  const { dir, script, episodeDir, writeScript } = project();
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

    writeFileSync(join(episodeDir, 'qa-report.json'), '{}');
    writeFileSync(join(episodeDir, 'qa-approved.json'), '{}');
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(episodeDir, 'scene-001', `shot-00${n}.png`), PNG);
    const status = await collectProjectStatus(dir);
    assert.equal(status.episodes[0].stage, 'approved generation plan out of date');
    assert.equal(status.episodes[0].nextCommand, 'plan-generations -e 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pipeline and the agent guide name plan-generations, and approving it is a human decision', () => {
  const branch = PIPELINE_BRANCHES.find(b => b.id === 'plan-generations');
  assert.ok(branch, 'PIPELINE_BRANCHES lists plan-generations');
  assert.equal(branch.command, 'plan-generations -p <project> -e <n>');
  assert.match(branch.note, /human decision/);
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
