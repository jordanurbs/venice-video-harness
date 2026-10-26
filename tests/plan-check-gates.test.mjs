// The plan check's gates (rule 64): a plate reader that could not read a shot
// leaves it unchecked (never a pass, rule 46) and approval refuses it; a
// registered plan provider supplies fixed locations and a reader; the
// workshop's automatic re-plan never costs the draft it was asked to fix.
// Stub clients and readers only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  describeWorkshopPlan, generateWorkshop, reviewWorkshopPlan, reviewWorkshopPlanForApproval, setWorkshopPlanProvider,
} = await import('../dist/mini-drama/workshop.js');
const { createSeries } = await import('../dist/series/manager.js');

const QUAY = {
  slug: 'stone-quay',
  name: 'Stone Quay',
  description: 'A stone quay with a bench.',
  spatialAnchors: 'View 1 (north): the bench at centre, 2 m away.',
  seed: 1,
};
const SHOTS = [
  { shotNumber: 1, location: QUAY.slug, plateView: 'north', description: 'ANNA sits on the bench.', characters: ['ANNA'] },
  { shotNumber: 2, location: QUAY.slug, plateView: 'north', description: 'ANNA stands on the quay.', characters: ['ANNA'] },
];
const SERIES = { name: 'Gates', outputDir: tmpdir(), locations: [], characters: [], episodes: [], videoDefaults: {} };
const FIXED = { fixedLocation: location => location.slug === QUAY.slug };
const CLIENT = { chatJson: async () => { throw new Error('the reader, not the client, reads plates in these tests'); } };

function draftOf(shots = SHOTS) {
  return { locations: [QUAY], characters: [], script: { shots: structuredClone(shots) } };
}

test('a reader that fails leaves every shot on a fixed location unchecked, never fine', async () => {
  const readPlates = async () => { throw new Error('HTTP 503 upstream'); };
  const report = await reviewWorkshopPlan(CLIENT, SERIES, draftOf(), { ...FIXED, readPlates, visionModel: 'vision-x' });
  assert.deepEqual(report.plateFit.unchecked.map(entry => entry.shot), ['1', '2']);
  assert.match(report.plateFit.unchecked[0].reason, /plate check failed \(HTTP 503 upstream\)/);
  const lines = describeWorkshopPlan(report);
  assert.match(lines[0], /2 shot\(s\) were never checked against their plates/);
  assert.doesNotMatch(lines.join('\n'), /every shot stands on a plate/);
});

test('a reader\'s misfit blocks, its unread shots stay unchecked, and a fit moves the shot to its view first', async () => {
  const readPlates = async ({ visionModel }) => ({
    results: [{ shot: '1', location: QUAY.slug, fits: true, view: 'east' }, { shot: '2', location: QUAY.slug, fits: false, missing: 'the quay edge' }],
    skipped: [],
    unchecked: [],
    model: visionModel,
  });
  const draft = draftOf();
  const report = await reviewWorkshopPlan(CLIENT, SERIES, draft, { ...FIXED, readPlates, visionModel: 'vision-x' });
  assert.equal(draft.script.shots[0].plateView, 'east');
  assert.deepEqual(report.moved, ['shot 1: north -> east (stone-quay)']);
  const misfit = report.findings.find(f => f.kind === 'plate-misfit');
  assert.equal(misfit?.shot, '2');
  assert.equal(misfit?.severity, 'block');
});

test('no reader runs without a client, and none runs by default', async () => {
  let called = 0;
  const readPlates = async () => { called += 1; return { results: [], skipped: [], unchecked: [], model: 'x' }; };
  await reviewWorkshopPlan(null, SERIES, draftOf(), { ...FIXED, readPlates });
  assert.equal(called, 0);
  const report = await reviewWorkshopPlan(CLIENT, SERIES, draftOf());
  assert.equal(report.plateFit, undefined);
});

test('a registered provider supplies fixed locations and a reader; the caller\'s options win', async () => {
  let reads = 0;
  setWorkshopPlanProvider(series => (series.name === 'Gates' ? {
    ...FIXED,
    readPlates: async () => { reads += 1; return { results: [], skipped: [], unchecked: [], model: 'provider-vision' }; },
  } : {}));
  try {
    const shot = { shotNumber: 1, location: QUAY.slug, plateView: 'north', description: 'ANNA climbs the bell tower staircase.', characters: ['ANNA'] };
    const report = await reviewWorkshopPlan(CLIENT, SERIES, draftOf([shot]), { visionModel: 'vision-x' });
    assert.equal(reads, 1);
    assert.equal(report.findings.find(f => f.noun === 'stairs')?.severity, 'block');
    const callerWins = await reviewWorkshopPlan(CLIENT, SERIES, draftOf([shot]), { fixedLocation: () => false, planCheck: false });
    assert.equal(callerWins.findings.find(f => f.noun === 'stairs')?.severity, 'warn');
    assert.equal(reads, 1);
  } finally {
    setWorkshopPlanProvider(null);
  }
});

test('approval re-checks the words on the draft it approves and keeps saved unchecked shots', async () => {
  const draft = draftOf();
  draft.planReport = {
    findings: [],
    checkedAt: '2026-10-25T00:00:00Z',
    plateFit: { results: [], skipped: [], unchecked: [{ shot: '1', location: QUAY.slug, reason: 'timeout' }, { shot: '2', location: QUAY.slug, reason: 'timeout' }], model: 'vision-x' },
  };
  const gate = await reviewWorkshopPlanForApproval(SERIES, draft);
  assert.equal(gate.plateFit.unchecked.length, 2);
  // A shot removed from the draft since the check is no longer counted, and a new problem is found.
  draft.script.shots = [draft.script.shots[0], { shotNumber: 3, location: 'nowhere', description: 'ANNA waits.', characters: ['ANNA'] }];
  const again = await reviewWorkshopPlanForApproval(SERIES, draft);
  assert.deepEqual(again.plateFit.unchecked.map(entry => entry.shot), ['1']);
  assert.equal(again.findings.some(f => f.kind === 'unknown-location' && f.severity === 'block'), true);
});

// ---- The automatic re-plan -------------------------------------------------

function film(workspace) {
  return createSeries('Replans', 'A pilot follows a signal', 'science fiction', 'Earth orbit', {
    workspace, projectType: 'film', audioStrategy: 'native', videoFamilyPreference: 'seedance',
  });
}

function rawDraft(locations) {
  return {
    logline: 'A pilot follows a signal.', synopsis: 'A complete story.', themes: ['choice'],
    structure: [{ name: 'Launch', purpose: 'Commit', beats: ['Ignition'] }],
    aesthetic: { style: 'documentary', palette: 'cold blue', lighting: 'hard sun', lensCharacteristics: 'large format', filmStock: 'fine grain' },
    characters: [],
    locations: [{ name: 'Orbital Capsule', slug: 'orbital-capsule', description: 'a compact cockpit', seed: 4 }],
    script: { title: 'Replans', shots: locations.map((location, index) => ({ shotNumber: index + 1, type: 'wide', location, duration: '15s', description: 'The capsule hums.', characters: [], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' })) },
    productionNotes: { audioApproach: 'native', continuityPriorities: [], risks: [], openQuestions: [] },
  };
}

const INPUTS = { objective: 'A short film', targetDuration: '1 minute' };

function scripted(...answers) {
  const calls = [];
  return {
    calls,
    chatJson: async () => {
      calls.push(1);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
  };
}

test('a re-plan that fails keeps the draft it was asked to fix', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-fail-')));
  const client = scripted(rawDraft(['nowhere']), new Error('HTTP 500 from the model'));
  const draft = await generateWorkshop(client, series, INPUTS, 'model-x');
  assert.equal(client.calls.length, 2);
  assert.equal(draft.script.shots[0].location, 'nowhere');
  assert.equal(draft.planReport.replanFailed, 'HTTP 500 from the model');
  assert.match(describeWorkshopPlan(draft.planReport).join('\n'), /re-plan failed/);
});

test('a re-plan that does no better is saved aside, and the draft before it is kept', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-worse-')));
  const client = scripted(rawDraft(['nowhere']), rawDraft(['nowhere', 'elsewhere']));
  const draft = await generateWorkshop(client, series, INPUTS, 'model-x');
  assert.equal(draft.script.shots.length, 1);
  assert.equal(draft.planReport.replanRejected.blocking, 2);
  assert.equal(draft.planReport.replanRejected.kept, 1);
  assert.ok(existsSync(draft.planReport.replanRejected.file));
  const saved = JSON.parse(readFileSync(draft.planReport.replanRejected.file, 'utf-8'));
  assert.equal(saved.script.shots.length, 2);
});

test('a re-plan that fixes the problems replaces the draft', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-better-')));
  const client = scripted(rawDraft(['nowhere']), rawDraft(['orbital-capsule']));
  const draft = await generateWorkshop(client, series, INPUTS, 'model-x');
  assert.equal(draft.script.shots[0].location, 'orbital-capsule');
  assert.equal(draft.planReport.replans, 1);
  assert.equal(draft.planReport.findings.filter(f => f.severity === 'block').length, 0);
});

test('--no-plate-check (planCheck: false) makes one call and no plan report', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-off-')));
  const client = scripted(rawDraft(['nowhere']));
  const draft = await generateWorkshop(client, series, INPUTS, 'model-x', null, undefined, { planCheck: false });
  assert.equal(client.calls.length, 1);
  assert.equal(draft.planReport, undefined);
});

// ---- Review fixes (#77) ----------------------------------------------------

test('the headline does not call a plan with warnings clean', () => {
  const lines = describeWorkshopPlan({ findings: [{ shot: '1', kind: 'description-only', severity: 'warn', message: 'look at it' }], checkedAt: 'x' });
  assert.match(lines[0], /nothing blocks; 1 warning\(s\)/);
});

test('a plan check that crashes on the first draft keeps the paid draft, unchecked', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-crash-')));
  setWorkshopPlanProvider(() => ({ fixedLocation: () => { throw new Error('boom'); } }));
  try {
    const draft = await generateWorkshop(scripted(rawDraft(['orbital-capsule'])), series, INPUTS, 'model-x');
    assert.equal(draft.planReport.checkFailed, 'boom');
    assert.match(describeWorkshopPlan(draft.planReport)[0], /the check itself failed/);
  } finally {
    setWorkshopPlanProvider(null);
  }
});

test('an accepted re-plan saves the draft it replaced', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-saved-')));
  const draft = await generateWorkshop(scripted(rawDraft(['nowhere']), rawDraft(['orbital-capsule'])), series, INPUTS, 'model-x');
  assert.ok(existsSync(draft.planReport.replacedDraft));
  assert.equal(JSON.parse(readFileSync(draft.planReport.replacedDraft, 'utf-8')).script.shots[0].location, 'nowhere');
});

test('a revision does not send the old plan report to the model', async () => {
  const series = film(mkdtempSync(join(tmpdir(), 'replan-revise-')));
  const prompts = [];
  const client = { chatJson: async ({ userPrompt }) => { prompts.push(userPrompt); return rawDraft(['orbital-capsule']); } };
  const previous = { ...rawDraft(['orbital-capsule']), revision: 1, feedbackHistory: [], planReport: { findings: [{ kind: 'unknown-location', severity: 'block', message: 'STALE-FINDING' }], checkedAt: 'x' } };
  await generateWorkshop(client, series, INPUTS, 'model-x', previous, 'tighten act two');
  assert.doesNotMatch(prompts[0], /STALE-FINDING/);
});
