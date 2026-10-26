// Shot plan check: shots against what their location plates show, the vessel
// across a journey, the shot's own plate leading its references, and the
// workshop's normalisation of the plan fields. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkShotPlan, viewTexts } = await import('../dist/mini-drama/plan-check.js');
const { locationPlateOrder } = await import('../dist/mini-drama/reference-slots.js');
const { normalizeShotPlan, reviewWorkshopPlan } = await import('../dist/mini-drama/workshop.js');

// A station whose plates show the ferry only at the far end of the platform.
const STATION = {
  slug: 'harbour-station',
  name: 'Harbour Station',
  description: 'A railway station by the sea: one long stone platform with a sleeper train standing at it. At the platform\'s far end, a landing stage on the water, where an electric ferry waits with its gangway lowered.',
  spatialAnchors: 'View 1 (north): the train fills the RIGHT edge, receding; the platform runs straight away on the LEFT to the landing stage, the ferry and open water at its end, the town far across the bay. View 2 (east): side-on to the train, 2 m away: a carriage door stands open. View 3 (south): the platform runs straight away inland; the train on the LEFT. View 4 (west): a bare rail track, then the station building wall.',
  fixed: true,
};

const BAY_DECK = {
  slug: 'bay-deck',
  name: 'Bay Deck',
  description: 'The camera stands at the bow rail of a small passenger ship; the deck is pale teak.',
  spatialAnchors: 'View 1 (north): the bow rail crosses the bottom of the frame; open bay beyond. View 2 (east): open water. View 3 (south): looking aft along the ship: the deck and the wheelhouse. View 4 (west): channel buoys.',
  fixed: true,
};

const FERRY_LANDING = {
  slug: 'ferry-landing',
  name: 'Ferry Landing',
  description: 'A stone landing stage at the end of the station platform, with the electric ferry moored alongside and its gangway down.',
  spatialAnchors: 'View 1 (north): the ferry lies along the RIGHT half of the frame, side on, gangway down to the stage at centre, 3 m away. View 2 (east): along the ferry toward its bow. View 3 (south): back up the platform toward the train. View 4 (west): open water.',
  near: 'harbour-station',
};

const BOARDING = { shotNumber: 2, location: STATION.slug, description: 'At the landing stage, LEO hands ANNA onto the ferry gangway; ANNA steps aboard.', characters: ['LEO', 'ANNA'] };

test('a beat that boards a ferry the plates show only far off is blocked', () => {
  const findings = checkShotPlan({ shots: [BOARDING], locations: [STATION] });
  const ferry = findings.find(f => f.noun === 'ferry');
  assert.equal(ferry?.kind, 'distant-in-plates');
  assert.equal(ferry?.severity, 'block');
  assert.match(ferry.message, /new location/);
});

test('the same beat on a new place whose north view shows the ferry close passes', () => {
  const findings = checkShotPlan({ shots: [{ ...BOARDING, location: FERRY_LANDING.slug, plateView: 'north' }], locations: [STATION, FERRY_LANDING] });
  assert.deepEqual(findings.filter(f => f.severity === 'block'), []);
});

test('a thing no plate of a fixed set shows blocks; on a new place it only warns', () => {
  const shot = { shotNumber: 5, location: STATION.slug, description: 'She climbs the bell tower staircase.', characters: [] };
  assert.equal(checkShotPlan({ shots: [shot], locations: [STATION] })[0]?.severity, 'block');
  assert.equal(checkShotPlan({ shots: [shot], locations: [{ ...STATION, fixed: false }] })[0]?.severity, 'warn');
});

test('a beat a view shows close passes; a planned view that lacks it names the view that has it', () => {
  const shot = { shotNumber: 3, location: STATION.slug, plateView: 'north', description: 'ANNA steps down from the carriage door onto the platform.', characters: ['ANNA'] };
  assert.deepEqual(checkShotPlan({ shots: [shot], locations: [STATION] }).filter(f => f.severity === 'block'), []);
  const wrongView = checkShotPlan({ shots: [{ ...shot, plateView: 'west' }], locations: [STATION] }).find(f => f.noun === 'train');
  assert.match(wrongView?.message ?? '', /The north \/ east \/ south view shows it close: set plateView to north/);
});

test('the boat changes when a deck shot stands on a set that shows another ship', () => {
  const shots = [
    { shotNumber: 3, location: FERRY_LANDING.slug, description: 'Wide: the navy ferry pulls away from the landing stage.', characters: [] },
    { shotNumber: 4, location: BAY_DECK.slug, description: 'On the open deck at the bow rail, ANNA looks at the city.', characters: ['ANNA'] },
  ];
  const change = checkShotPlan({ shots, locations: [FERRY_LANDING, BAY_DECK] }).find(f => f.kind === 'vessel-changes');
  assert.equal(change?.severity, 'block');
  assert.equal(change?.shot, '4');
  const newScene = checkShotPlan({ shots: [shots[0], { ...shots[1], continuity: { from: 'new-scene' } }], locations: [FERRY_LANDING, BAY_DECK] });
  assert.equal(newScene.some(f => f.kind === 'vessel-changes'), false);
});

test('a vessel at two places with no reference of its own is flagged until it is cast', () => {
  const shots = [
    { shotNumber: 1, location: 'a', description: 'The ferry waits at the quay.', characters: [] },
    { shotNumber: 2, location: 'b', description: 'The ferry crosses the basin.', characters: [] },
  ];
  const locations = [
    { slug: 'a', name: 'Quay', description: 'A stone quay with the ferry moored.' },
    { slug: 'b', name: 'Basin', description: 'Open water where the ferry passes close by.' },
  ];
  assert.equal(checkShotPlan({ shots, locations }).some(f => f.kind === 'recurring-vehicle'), true);
  const cast = [{ name: 'THE FERRY', prop: true, description: 'a navy electric ferry' }];
  assert.equal(checkShotPlan({ shots, locations, cast }).some(f => f.kind === 'recurring-vehicle'), false);
});

// A fixed set that shows a square and a wellhead, and nothing to board.
const SQUARE = {
  slug: 'town-square',
  name: 'Town Square',
  description: 'A small square paved in grey stone with a carved marble wellhead at its centre.',
  spatialAnchors: 'View 1 (north): the wellhead at centre, 3 m away. View 2 (east): a row of house fronts. View 3 (south): a bridge over a narrow canal. View 4 (west): a church front.',
  fixed: true,
};

test('a verb that is also a boat, a dock or a stall is not the thing', () => {
  const shots = [
    { shotNumber: 1, location: SQUARE.slug, plateView: 'north', description: 'Pigeons launch from the wellhead as ANNA crosses the square.', characters: ['ANNA'] },
    { shotNumber: 2, location: SQUARE.slug, plateView: 'north', description: 'ANNA pauses by the wellhead; the conversation stalls.', characters: ['ANNA'] },
    { shotNumber: 3, location: SQUARE.slug, plateView: 'north', description: 'ANNA trains her eyes on the wellhead.', characters: ['ANNA'] },
  ];
  assert.deepEqual(checkShotPlan({ shots, locations: [SQUARE] }), []);
  // The nouns still count: a shot that boards the launch, at a market stall, needs them on the plate.
  const nouns = checkShotPlan({ shots: [{ shotNumber: 4, location: SQUARE.slug, plateView: 'north', description: 'ANNA boards the launch beside the fish stalls.', characters: ['ANNA'] }], locations: [SQUARE] });
  assert.equal(nouns.find(f => f.noun === 'launch')?.severity, 'block');
  assert.equal(nouns.find(f => f.noun === 'market')?.severity, 'warn');
});

test('a place that names the thing in any form has it ("Arrival Dock"), and "docks" asks for nothing', () => {
  const dock = { slug: 'arrival-dock', name: 'Arrival Dock', description: 'Wooden piles and a stone edge where boats tie up.', spatialAnchors: 'View 1 (north): the stone edge runs across the frame, 2 m away, with the moored ferry alongside it.', fixed: true };
  const findings = checkShotPlan({ shots: [{ shotNumber: 1, location: dock.slug, plateView: 'north', description: 'ANNA waits on the dock. The ferry docks at the stone edge.', characters: ['ANNA'] }], locations: [dock] });
  assert.equal(findings.some(f => f.kind === 'not-in-plates'), false);
  assert.equal(findings.some(f => f.severity === 'block'), false);
});

test('only what the action touches has to be on the plate; what it looks toward only warns', () => {
  const looking = checkShotPlan({ shots: [{ shotNumber: 1, location: STATION.slug, plateView: 'north', description: 'ANNA stands on the platform, looking toward the landing stage.', characters: ['ANNA'] }], locations: [STATION] });
  assert.equal(looking.find(f => f.noun === 'landing stage')?.severity, 'warn');
  const stepping = checkShotPlan({ shots: [{ shotNumber: 1, location: STATION.slug, plateView: 'north', description: 'ANNA steps onto the landing stage.', characters: ['ANNA'] }], locations: [STATION] });
  assert.equal(stepping.find(f => f.noun === 'landing stage')?.severity, 'block');
  // A vehicle the shot is about has to be there too, touched or not.
  const leaving = checkShotPlan({ shots: [{ shotNumber: 1, location: STATION.slug, plateView: 'north', description: 'Wide: the navy ferry pulls away into the bay.', characters: [] }], locations: [STATION] });
  assert.equal(leaving.find(f => f.noun === 'ferry')?.severity, 'block');
});

test('a leading "Far off," places the clause after it, and stops at its next clause', () => {
  const findings = checkShotPlan({ shots: [{ shotNumber: 1, location: SQUARE.slug, plateView: 'north', description: 'Far off, the ferry crosses the bay while ANNA leans on the wellhead.', characters: ['ANNA'] }], locations: [SQUARE] });
  assert.equal(findings.find(f => f.noun === 'ferry')?.severity, 'warn');
  assert.equal(findings.some(f => f.severity === 'block'), false);
  assert.equal(findings.some(f => f.noun === 'station'), false);
});

test('a boat seen from a later shot ashore is not the journey\'s boat', () => {
  const canal = { slug: 'canal-bend', name: 'Canal Bend', description: 'A fondamenta along a canal where gondolas pass.', spatialAnchors: 'View 1 (north): the fondamenta runs along the left, the canal on the right with a passing gondola 4 m away.', fixed: true };
  const deck = { shotNumber: 1, location: BAY_DECK.slug, description: 'On the open deck at the bow rail, ANNA looks at the city.', characters: ['ANNA'] };
  for (const description of ['Later, ANNA walks along the canal as a gondola passes.', 'A gondola passes ANNA on the fondamenta.']) {
    const findings = checkShotPlan({ shots: [deck, { shotNumber: 2, location: canal.slug, plateView: 'north', description, characters: ['ANNA'] }], locations: [BAY_DECK, canal] });
    assert.equal(findings.some(f => f.kind === 'vessel-changes'), false, description);
  }
});

test('the workshop knows the places the project already has, even when the draft does not restate them', async () => {
  const series = { videoDefaults: {}, locations: [{ ...SQUARE, fixed: undefined }] };
  const draft = { locations: [], characters: [], script: { shots: [{ shotNumber: 1, location: SQUARE.slug, description: 'ANNA leans on the wellhead.', characters: ['ANNA'] }] } };
  const report = await reviewWorkshopPlan(null, series, draft);
  assert.equal(report.findings.some(f => f.kind === 'unknown-location'), false);
});

test('an unknown location blocks', () => {
  const findings = checkShotPlan({ shots: [{ shotNumber: 9, location: 'nowhere', description: 'x' }], locations: [] });
  assert.equal(findings[0].kind, 'unknown-location');
});

test('view texts parse per compass view', () => {
  const views = viewTexts(STATION);
  assert.match(views.north, /^the train fills/);
  assert.match(views.east, /carriage door stands open/);
});


test('the shot\'s own view leads its location plates', () => {
  assert.equal(locationPlateOrder()[0], 'north.png');
  assert.equal(locationPlateOrder({ plateView: 'east', type: 'action' })[0], 'east.png');
  assert.equal(locationPlateOrder({ plateView: 'east', type: 'action' }).length, locationPlateOrder().length);
});

test('plan fields a model filled badly are dropped or repaired', () => {
  const shot = { plateView: 'North', stagedOn: '  ', continuity: 'she is on the gangway, facing right' };
  normalizeShotPlan(shot);
  assert.equal(shot.plateView, 'north');
  assert.equal('stagedOn' in shot, false);
  assert.deepEqual(shot.continuity, { endState: 'she is on the gangway, facing right' });
  const bad = { plateView: 'up', continuity: { from: 'sometime' } };
  normalizeShotPlan(bad);
  assert.equal('plateView' in bad, false);
  assert.equal('continuity' in bad, false);
});

test('the workshop plan review runs the word checks with no client; fixed plates come from the caller', async () => {
  const series = { videoDefaults: {} };
  const draft = {
    locations: [{ ...STATION, fixed: undefined }],
    characters: [],
    script: { shots: [BOARDING] },
  };
  const fixed = await reviewWorkshopPlan(null, series, draft, { fixedLocation: location => location.slug === STATION.slug });
  assert.equal(fixed.findings.some(f => f.noun === 'ferry' && f.severity === 'block'), true);
  assert.equal(fixed.plateFit, undefined);
  // With no fixed locations (the default) every place is new: a missing thing only warns.
  const open = await reviewWorkshopPlan(null, series, draft);
  assert.equal(open.findings.some(f => f.severity === 'block'), false);
});

// ---- Review fixes (#77) ----------------------------------------------------

test('a shot finds its location by slug or name, in any case, as the pipeline does', () => {
  for (const location of ['Harbour Station', 'HARBOUR-STATION', 'harbour-station']) {
    const findings = checkShotPlan({ shots: [{ shotNumber: 1, location, plateView: 'north', description: 'ANNA walks along the platform.', characters: ['ANNA'] }], locations: [STATION] });
    assert.equal(findings.some(f => f.kind === 'unknown-location'), false, location);
  }
});

test('spatialAnchors that are not text do not crash the check', () => {
  const odd = { ...STATION, spatialAnchors: { north: 'the platform' } };
  assert.doesNotThrow(() => checkShotPlan({ shots: [BOARDING], locations: [odd] }));
});

test('an object cast member in the shot carries itself on a new place; a fixed place still has to stage it', () => {
  const cast = [{ name: 'THE FERRY', prop: true, description: 'an electric ferry with a lowered gangway' }];
  const quay = { slug: 'quay', name: 'Quay', description: 'A stone quay.' };
  const shot = { shotNumber: 1, location: 'quay', description: 'ANNA boards the ferry.', characters: ['ANNA', 'THE FERRY'] };
  assert.equal(checkShotPlan({ shots: [shot], locations: [quay], cast }).some(f => f.noun === 'ferry'), false);
  // Not listed in the shot, it is not carried.
  assert.equal(checkShotPlan({ shots: [{ ...shot, characters: ['ANNA'] }], locations: [quay], cast }).some(f => f.noun === 'ferry'), true);
  assert.equal(checkShotPlan({ shots: [{ ...shot, location: STATION.slug }], locations: [STATION], cast }).find(f => f.noun === 'ferry')?.severity, 'block');
});

test('a thing the action touches is close, whatever else the sentence puts far off', () => {
  const findings = checkShotPlan({ shots: [{ ...BOARDING, description: 'ANNA boards the ferry as the far shore fades.' }], locations: [STATION] });
  assert.equal(findings.find(f => f.noun === 'ferry')?.severity, 'block');
});

test('distance words reach only their own phrase in a plate description', () => {
  const pier = { slug: 'pier', name: 'Pier', description: 'A ferry pier.', spatialAnchors: 'View 1 (north): the ferry gangway in the foreground with the horizon behind.', fixed: true };
  const findings = checkShotPlan({ shots: [{ shotNumber: 1, location: 'pier', plateView: 'north', description: 'ANNA boards the ferry.', characters: ['ANNA'] }], locations: [pier] });
  assert.equal(findings.some(f => f.severity === 'block'), false);
});

test('a deck of cards, a bow tie or a part nobody stands on is not a boat part to block on', () => {
  const findings = checkShotPlan({ shots: [{ shotNumber: 1, location: SQUARE.slug, plateView: 'north', description: 'ANNA shuffles a deck of cards and straightens her bow tie by the wellhead.', characters: ['ANNA'] }], locations: [SQUARE] });
  assert.deepEqual(findings.filter(f => f.severity === 'block'), []);
  const stood = checkShotPlan({ shots: [{ shotNumber: 1, location: SQUARE.slug, plateView: 'north', description: 'ANNA stands on the deck by the wellhead.', characters: ['ANNA'] }], locations: [SQUARE] });
  assert.equal(stood.find(f => f.noun === 'deck')?.severity, 'block');
});
