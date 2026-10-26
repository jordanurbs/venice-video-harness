// The shot plan check with what each plate image shows (`PlanLocation.inventory`,
// read by a caller's vision pass): the image is evidence beside the words, and
// a vehicle the staged plate shows close to the camera that is not the shot's
// own is a `competing-vehicle` finding. A shot with a staging ref (stage-ref)
// for that view is not checked against the old plate. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkShotPlan, viewEvidence } = await import('../dist/mini-drama/plan-check.js');
const { reviewWorkshopPlan } = await import('../dist/mini-drama/workshop.js');

// A fixed set whose words name one passing launch; its north plate shows two
// motor launches near the camera, one moored at the water steps.
const STEPS = {
  slug: 'harbour-steps',
  name: 'Harbour Steps',
  description: 'An arcade over stone water steps on the harbour, with mooring posts.',
  spatialAnchors: 'View 1 (north): the arcade and the stone water steps at centre; the passing launch is in the lower LEFT third. View 2 (east): along the quay. View 3 (south): the open water. View 4 (west): a bridge.',
  fixed: true,
};
const LAUNCHES = {
  vehicles: [{ what: 'blue motor launch with a wooden cabin', count: 2, where: 'one moored at the foot of the water steps, one under way at lower left', distance: 'near', state: 'moored' }],
  objects: [{ what: 'mooring posts', count: 4, where: 'along the steps', distance: 'near' }],
};
const FERRY_SHOT = {
  shotNumber: 8, location: STEPS.slug, plateView: 'north', characters: ['ANNA'],
  description: 'The harbour ferry lies moored alongside the stone water steps. ANNA stands on the ferry\'s open forward deck and hands a note to LEO on the bottom step.',
};

test('a ferry staged where the plate draws other boats is flagged once the plate is read; another class of boat blocks', () => {
  const unread = checkShotPlan({ shots: [FERRY_SHOT], locations: [STEPS] });
  assert.equal(unread.some(f => f.kind === 'competing-vehicle'), false, 'the words alone miss it');

  // Launches are motor boats like a ferry: the plate's boat might be the ferry itself, so a warning; the words
  // (no plate names a ferry) still block.
  const read = checkShotPlan({ shots: [FERRY_SHOT], locations: [{ ...STEPS, inventory: { north: LAUNCHES } }] });
  const finding = read.find(f => f.kind === 'competing-vehicle');
  assert.equal(finding?.severity, 'warn');
  assert.equal(finding.noun, 'ferry');
  assert.match(finding.message, /2 × blue motor launch/);
  assert.match(finding.message, /Unless that is the ferry itself/);
  assert.match(finding.message, /stage-ref \(--from-plate north/);
  assert.ok(read.some(f => f.kind === 'not-in-plates' && f.noun === 'ferry' && f.severity === 'block'));
  assert.match(viewEvidence({ ...STEPS, inventory: { north: LAUNCHES } }).north, /The plate shows: 2 blue motor launch with a wooden cabin near the camera moored/);

  // Gondolas are another class of boat: a block, and the one finding for the ferry.
  const gondolas = { vehicles: [{ what: 'black gondola with a gilded prow', count: 3, where: 'moored at the water steps', distance: 'near' }] };
  const blocked = checkShotPlan({ shots: [FERRY_SHOT], locations: [{ ...STEPS, inventory: { north: gondolas } }] });
  assert.equal(blocked.find(f => f.kind === 'competing-vehicle')?.severity, 'block');
  assert.equal(blocked.some(f => f.kind === 'not-in-plates' && f.noun === 'ferry'), false);
});

test('a vehicle the shot only names, and does not use, warns instead of blocking', () => {
  const gondolas = { vehicles: [{ what: 'black gondola', count: 2, where: 'at the steps', distance: 'near' }] };
  const shot = { shotNumber: 4, location: STEPS.slug, plateView: 'north', characters: ['ANNA'], description: 'ANNA waits under the arcade, watching for the harbour ferry.' };
  const finding = checkShotPlan({ shots: [shot], locations: [{ ...STEPS, inventory: { north: gondolas } }] }).find(f => f.kind === 'competing-vehicle');
  assert.equal(finding?.severity, 'warn');
  assert.match(finding.message, /names the ferry/);
});

test('an edited plate for that view, a launch shot, or only far boats pass', () => {
  const located = { ...STEPS, inventory: { north: LAUNCHES } };
  const stagedShot = { ...FERRY_SHOT, stagingRef: { use: 'plate', replacesView: 'north' } };
  assert.deepEqual(checkShotPlan({ shots: [stagedShot], locations: [located] }).filter(f => f.shot === '8'), []);
  const startFrame = { ...FERRY_SHOT, stagingRef: { use: 'start-frame' } };
  assert.deepEqual(checkShotPlan({ shots: [startFrame], locations: [located] }).filter(f => f.shot === '8'), []);
  const otherView = { ...FERRY_SHOT, stagingRef: { use: 'plate', replacesView: 'east' } };
  assert.ok(checkShotPlan({ shots: [otherView], locations: [located] }).some(f => f.kind === 'competing-vehicle'), 'an edit of another view does not count');

  const launchShot = { ...FERRY_SHOT, description: 'ANNA steps from the moored launch onto the water steps.' };
  assert.equal(checkShotPlan({ shots: [launchShot], locations: [located] }).some(f => f.kind === 'competing-vehicle'), false);

  const far = { ...STEPS, inventory: { north: { vehicles: [{ what: 'motor launch', count: 1, where: 'on the far side of the harbour', distance: 'far' }] } } };
  assert.equal(checkShotPlan({ shots: [FERRY_SHOT], locations: [far] }).some(f => f.kind === 'competing-vehicle'), false);

  const both = { ...STEPS, inventory: { north: { vehicles: [{ what: 'blue ferry', count: 1, where: 'at the steps', distance: 'mid' }, { what: 'motor launch', count: 1, where: 'beside the camera', distance: 'near' }] } } };
  const warn = checkShotPlan({ shots: [FERRY_SHOT], locations: [both] }).find(f => f.kind === 'competing-vehicle');
  assert.equal(warn?.severity, 'warn');
  assert.match(warn.message, /also shows a motor launch/);
});

test('a place the image shows counts; a boat part it lists on another boat proves nothing', () => {
  // The words of this set never name its steps; the north image shows them.
  const quiet = { ...STEPS, description: 'An arcade on the harbour.', spatialAnchors: 'View 1 (north): the arcade at centre. View 2 (east): along the quay.' };
  const stepsShot = { shotNumber: 2, location: quiet.slug, plateView: 'north', characters: ['ANNA'], description: 'ANNA walks down the stone water steps.' };
  assert.ok(checkShotPlan({ shots: [stepsShot], locations: [quiet] }).some(f => f.noun === 'stairs'), 'the words alone miss the steps');
  const north = { vehicles: [], places: [{ what: 'stone water steps', count: 1, where: 'beneath the arcade, centre', distance: 'mid' }] };
  assert.equal(checkShotPlan({ shots: [stepsShot], locations: [{ ...quiet, inventory: { north } }] }).some(f => f.noun === 'stairs'), false, 'the image shows them');

  // A barge's bow in the west image is not the ferry's bow, and a far mention never makes a thing look far off.
  const west = { vehicles: [{ what: 'dark wooden cargo barge, small lamp at the bow', count: 1, where: 'centre of the canal', distance: 'near' }] };
  const bowShot = { shotNumber: 3, location: STEPS.slug, plateView: 'north', characters: ['ANNA'], description: 'ANNA leans on the rail at the bow of the moored launch.' };
  const findings = checkShotPlan({ shots: [bowShot], locations: [{ ...STEPS, inventory: { north: LAUNCHES, west } }] });
  assert.equal(findings.some(f => /west view shows it close/.test(f.message)), false, 'a barge\'s bow is not the launch\'s');
});

test('"the terminus ferry" names a boat, not a station', () => {
  const shot = { shotNumber: 3, location: STEPS.slug, plateView: 'north', characters: [], description: 'The terminus ferry pulls away from the water steps.' };
  assert.equal(checkShotPlan({ shots: [shot], locations: [STEPS] }).some(f => f.noun === 'station'), false);
  const station = { ...shot, description: 'ANNA walks out of the terminus onto the quay.' };
  assert.ok(checkShotPlan({ shots: [station], locations: [STEPS] }).some(f => f.noun === 'station'));
});

test('only a vehicle of the same kind of travel competes', () => {
  const quay = { vehicles: [
    { what: 'wooden luggage cart loaded with crates', count: 1, where: 'on the quay', distance: 'near' },
    { what: 'bicycle', count: 1, where: 'against the wall', distance: 'near' },
  ] };
  assert.equal(checkShotPlan({ shots: [FERRY_SHOT], locations: [{ ...STEPS, inventory: { north: quay } }] }).some(f => f.kind === 'competing-vehicle'), false, 'a cart does not compete with the ferry');
  const boat = { vehicles: [{ what: 'long dark boat with a wooden rail', count: 1, where: 'moored at right', distance: 'mid' }] };
  assert.equal(checkShotPlan({ shots: [FERRY_SHOT], locations: [{ ...STEPS, inventory: { north: boat } }] }).find(f => f.kind === 'competing-vehicle')?.severity, 'warn', 'a boat of no named kind is still a boat, maybe this one');
  const boarding = { shotNumber: 2, location: 'harbour-station', plateView: 'north', characters: ['ANNA'], description: 'ANNA boards the night train at the platform.' };
  const platform = vehicles => ({ ...STEPS, slug: 'harbour-station', name: 'Harbour Station', inventory: { north: { vehicles } } });
  const tram = checkShotPlan({ shots: [boarding], locations: [platform([{ what: 'electric tram', count: 1, where: 'beside the platform', distance: 'near' }, { what: 'luggage cart', count: 2, where: 'on the platform', distance: 'near' }])] }).find(f => f.kind === 'competing-vehicle');
  assert.equal(tram?.severity, 'warn', 'a tram runs on rails like the train');
  assert.match(tram.message, /electric tram/);
  assert.doesNotMatch(tram.message, /luggage cart/);
  const bus = checkShotPlan({ shots: [boarding], locations: [platform([{ what: 'blue electric bus', count: 1, where: 'at the kerb', distance: 'near' }])] }).find(f => f.kind === 'competing-vehicle');
  assert.equal(bus?.severity, 'block');
});

test('the workshop passes a caller\'s plate inventory to the plan check', async () => {
  const series = { videoDefaults: {} };
  const draft = { locations: [{ ...STEPS, fixed: undefined }], characters: [], script: { shots: [FERRY_SHOT] } };
  const options = {
    fixedLocation: location => location.slug === STEPS.slug,
    plateInventory: location => (location.slug === STEPS.slug ? { north: LAUNCHES } : undefined),
  };
  const report = await reviewWorkshopPlan(null, series, draft, options);
  assert.ok(report.findings.some(f => f.kind === 'competing-vehicle' && f.noun === 'ferry'));
  const without = await reviewWorkshopPlan(null, series, draft, { fixedLocation: options.fixedLocation });
  assert.equal(without.findings.some(f => f.kind === 'competing-vehicle'), false);
});
