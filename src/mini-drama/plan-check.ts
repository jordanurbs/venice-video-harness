// ---------------------------------------------------------------------------
// Shot plan check: does every shot stand on a location plate that shows what
// its action needs, and do the shots join up?
//
// The video model draws what the reference plate shows, not what the prompt
// asks. A beat staged on the nearest existing plate comes out as that plate: a
// boarding staged on a station platform whose plates show the ferry only as a
// shape at the far end boards the train beside the actors instead, and a
// crossing staged on another set's deck draws that set's boat, so the vessel
// changes between shots.
//
// This is the free, deterministic layer (words, no images). It reads the
// staging nouns in each shot (places, vehicles, the parts of a boat) and looks
// for them in the location's text, view by view when the location says what
// each plate shows ("View 1 (north): ..."). A caller can add a vision pass
// over the real plates on top of it (workshop.ts `readPlates`).
//
// Pure: plain data in, findings out.
// ---------------------------------------------------------------------------

import type { PlateView, ShotContinuity } from 'venice-video-harness/core/series/types.js';

export interface PlanLocation {
  slug: string;
  name: string;
  description: string;
  spatialAnchors?: string;
  /** The plates exist already and cannot be changed by this story (a shared library set). */
  fixed?: boolean;
  /** The location this one adjoins (a new place next to a fixed set). */
  near?: string;
}

export interface PlanShot {
  shotNumber: number;
  shotIdSuffix?: string;
  location?: string;
  description?: string;
  blocking?: string;
  stagedOn?: string;
  plateView?: PlateView;
  characters?: string[];
  continuity?: ShotContinuity;
}

export interface PlanCast {
  name: string;
  prop?: boolean;
  description?: string;
}

export type PlanFindingKind =
  | 'unknown-location'
  | 'no-plate-view'
  | 'not-in-plates'
  | 'description-only'
  | 'distant-in-plates'
  | 'vessel-changes'
  | 'recurring-vehicle'
  /** The vision plate check (a `readPlates` pass) found no view that carries the shot. */
  | 'plate-misfit';

export interface PlanFinding {
  /** Shot id ("2", "2b"); absent for a finding about the whole plan. */
  shot?: string;
  kind: PlanFindingKind;
  /** `block`: the shot will draw the wrong thing; re-plan before any spend. `warn`: look at it. */
  severity: 'block' | 'warn';
  location?: string;
  noun?: string;
  message: string;
}

const VIEWS: PlateView[] = ['north', 'east', 'south', 'west'];

// ---- Vocabulary ---------------------------------------------------------------

interface Term {
  key: string;
  /** The thing in a shot's words. */
  pattern: RegExp;
  /**
   * The thing in a location's words, when that reads looser than the shot's:
   * a place that mentions a dock in any form ("the Arrival Dock") has one,
   * while a shot that "docks" has not asked for one.
   */
  loose?: RegExp;
  vehicle?: boolean;
  water?: boolean;
  part?: boolean;
}

function term(key: string, words: string[], flags: Omit<Term, 'key' | 'pattern'> = {}): Term {
  const alternatives = words.map(word => word.replace(/\s+/g, '\\s+')).join('|');
  return { key, pattern: new RegExp(`\\b(?:${alternatives})(?:e?s)?\\b`, 'i'), ...flags };
}

/**
 * Words that are also verbs ("pigeons launch", "the ferry docks", "the
 * conversation stalls", "she trains her eyes on") count as the thing only
 * right after a word that introduces a noun.
 */
const NOUN_CUE = '(?:the|a|an|its|their|his|her|our|this|that|these|those|another|each|every|one|two|three|several)';

/** Vehicles by kind: synonyms share a key, so "liner" and "ship" are one thing and "ferry" another. */
const VEHICLES: Term[] = [
  term('ferry', ['ferry', 'ferrie']),
  term('gondola', ['gondola']),
  { key: 'launch', pattern: new RegExp(`\\b(?:${NOUN_CUE}|motor|police|harbou?r|navy|passing|waiting|moored|electric|wooden|private)\\s+launch(?:es)?\\b|\\bmotorboats?\\b|\\bwater[\\s-]+taxis?\\b`, 'i'), loose: /\b(?:launch|motorboat|water[\s-]+taxi)(?:e?s)?\b/i },
  term('ship', ['ship', 'liner', 'steamer']),
  term('vaporetto', ['vaporetto', 'vaporetti', 'waterbus', 'water bus']),
  term('barge', ['barge']),
  term('sandolo', ['sandolo', 'sandoli', 'skiff', 'rowboat', 'rowing boat']),
  term('sailboat', ['sailboat', 'sailing boat', 'yacht']),
].map(t => ({ ...t, vehicle: true, water: true }));

const LAND_VEHICLES: Term[] = [
  { key: 'train', pattern: new RegExp(`\\b(?:(?:${NOUN_CUE}|night|sleeper|passenger|freight|steam|electric|local|express|waiting|departing|arriving|stationary|empty|last|first|old)\\s+trains?|trains?\\s+(?:doors?|windows?|carriages?|cars?|tracks?|platforms?|stations?)|by\\s+train|carriages?|railcars?|locomotives?)\\b`, 'i'), loose: /\b(?:train|carriage|sleeper|railcar|locomotive)(?:e?s)?\b/i },
  term('tram', ['tram']),
  term('bus', ['bus']),
  term('cart', ['cart', 'wagon']),
  term('bicycle', ['bicycle', 'bike']),
].map(t => ({ ...t, vehicle: true }));

/** Parts of a boat: a shot that stands on one is aboard whatever vessel the plate shows. */
const VESSEL_PARTS: Term[] = [
  { key: 'deck', pattern: /\b(?:fore)?decks?\b(?!\s+of\s+cards)/i },
  { key: 'bow', pattern: /\b(?:the|at|from|over) bow\b(?!\s+ties?\b)|\bbow (?:rail|point|wave)\b/i },
  { key: 'stern', pattern: /\b(?:the|at|from|over) stern\b|\baft\b/i },
  term('gangway', ['gangway', 'gangplank']),
  term('wheelhouse', ['wheelhouse']),
  term('saloon', ['saloon']),
  term('hull', ['hull']),
  term('helm', ['helm', 'tiller']),
].map(t => ({ ...t, part: true }));

const PLACES: Term[] = [
  // Not a bare "landing" in a shot: that is also a stair landing, or a verb.
  { ...term('landing stage', ['landing stage', 'ferry landing', 'boat landing', 'landing pontoon', 'pontoon']), loose: /\b(?:landing|pontoon)s?\b/i },
  term('jetty', ['jetty', 'jettie', 'pier']),
  { key: 'dock', pattern: new RegExp(`\\b(?:${NOUN_CUE}|stone|wooden|floating|loading|dry)\\s+docks?\\b|\\bdockside\\b|\\bdockyards?\\b`, 'i'), loose: /\bdock(?:s|side|yards?)?\b/i },
  term('quay', ['quay', 'quayside']),
  term('platform', ['platform']),
  // A vehicle named for its terminus ("the terminus ferry") is a vehicle, not a station.
  { key: 'station', pattern: /\b(?:terminus(?!\s+(?:ferry|ferries|boat|launch|train|sleeper))|railway\s+station|train\s+station|station\s+building|station\s+platform)(?:e?s)?\b/i },
  term('bridge', ['bridge']),
  term('stairs', ['staircase', 'stairs', 'stairway', 'water steps', 'stone steps', 'marble steps']),
  term('balcony', ['balcony', 'balconie']),
  term('altana', ['altana', 'roof terrace', 'rooftop terrace']),
  term('courtyard', ['courtyard', 'cloister']),
  term('chapel', ['chapel', 'church']),
  { key: 'market', pattern: new RegExp(`\\bmarkets?\\b|\\b(?:${NOUN_CUE}|market|fish|fruit|vegetable|flower|food|wooden|covered)\\s+stalls?\\b`, 'i'), loose: /\b(?:market|stall)s?\b/i },
  term('counter', ['counter']),
  term('kitchen', ['kitchen']),
  term('garden', ['garden']),
  term('tunnel', ['tunnel']),
  term('corridor', ['corridor']),
  term('bedroom', ['bedroom']),
  term('office', ['office']),
  term('terrace', ['terrace']),
  term('furnace', ['furnace']),
  term('library', ['library', 'librarie', 'shelves', 'bookcase', 'bookshelf', 'bookshelve']),
  term('arcade', ['arcade', 'loggia']),
  term('slipway', ['slipway', 'boatyard', 'squero']),
  term('fondamenta', ['fondamenta']),
  term('wellhead', ['wellhead', 'well-head']),
  term('desk', ['desk']),
  term('bench', ['bench']),
  term('booth', ['booth']),
];

const STAGING_TERMS = [...VEHICLES, ...LAND_VEHICLES, ...VESSEL_PARTS, ...PLACES];

/**
 * The action touches the thing: it has to be in the frame, near the camera.
 * A verb touches what follows it in its own clause ("hands her onto the
 * ferry gangway"), not everything the shot names: "stands on the platform,
 * looking toward the landing stage" touches the platform only.
 */
const CONTACT_VERB = /\b(?:boards?|boarding|aboard|on board|steps? (?:onto|into|off|down|up|aboard|from|out of)|climbs?|disembarks?|moors?|hands? \w+ (?:onto|into|up|down|aboard)|(?:sits?|kneels?) (?:on|at|in|beside|by)|leans? (?:on|against|over)|(?:walks?|runs?|hurries|wanders?|strolls?|moves?) (?:onto|into|across|along|up|down|through|over)|enters?|crosses|unties?|ties up|grips?|(?:stands?|waits?) (?:on|in|at|beside|by))\b/gi;
/**
 * A new clause, a look at something else, or a phrase that places the action
 * beside something ("boards the launch beside the fish stalls"): what follows
 * is no longer what the verb touches. Directions (onto, into, from, across)
 * do not break: "steps down from the carriage onto the platform".
 */
const CLAUSE_BREAK = /\b(?:as|while|whilst|and|but|then|where|when|before|after|until|which|who|whose|toward|towards|looking|watching|facing|past|beside|near|behind|opposite|beyond|under|beneath|below|above|next to|in front of)\b/i;
const CONTACT_WINDOW_WORDS = 8;
/** A vehicle at the head of its clause is what the clause is about ("Wide: the navy ferry pulls away"). */
const CLAUSE_HEAD = /^(?:[\w'-]+:\s*)?(?:(?:the|a|an|its|their|this|that|another|two|three|several)\s+)?(?:[\w'-]+\s+){0,2}$/i;

/** The text places the thing far off. */
const DISTANT = /\b(?:far|distant|distance|horizon|beyond|at its end|at the end|at the far end|only a shape|a soft shape|a shape|glimpsed|faint|tiny|small in|across the (?:lagoon|basin|bay))\b/i;
/**
 * A clause that is only a distance ("Far off, the ferry crosses"): it places
 * the clause after it, up to that clause's own next clause ("... while she
 * waits on the dock" is not far off).
 */
const DISTANCE_LEAD = /^(?:(?:and|then|while)\s+)?(?:far(?:\s+(?:off|away|out|behind|ahead))?|far across the \w+|in the (?:far )?distance|on the horizon|beyond|across the (?:lagoon|basin|bay|water))$/i;
const DISTANCE_LEAD_STOP = /\b(?:while|whilst|as|where|when|before|after|until)\b/i;
/**
 * Distance words reach only the phrase they sit in: "boards the ferry as the
 * far shore fades" does not put the ferry far off, nor does "the gangway in the
 * foreground with the horizon behind". A list keeps one phrase ("the ferry and
 * the open water at its end" puts both far off).
 */
const DISTANCE_PHRASE_BREAK = /\b(?:as|while|whilst|where|when|with|before|after|until)\b/i;
const RECEDES = /\b(?:runs? straight away|recedes?|receding)\b/i;
/** A measured distance a few metres off ("3 m beyond it") is close, whatever the wording. */
const NEAR_METRES = /\b(?:[0-9]|10)(?:\.\d+)?\s?m\b/i;

function sentences(text: string): string[] {
  return text.split(/[.;]\s*/).map(sentence => sentence.trim()).filter(Boolean);
}

function clauses(text: string): string[] {
  return sentences(text).flatMap(sentence => sentence.split(/,\s*/)).map(c => c.trim()).filter(Boolean);
}

/** The phrase of a clause around a position: from the last phrase break before it to the next one after it. */
function phraseAround(clause: string, at: number): { start: number; text: string } {
  const breaks = [...clause.matchAll(new RegExp(DISTANCE_PHRASE_BREAK.source, 'gi'))].map(m => m.index ?? 0);
  const start = Math.max(0, ...breaks.filter(index => index <= at));
  const end = Math.min(clause.length, ...breaks.filter(index => index > at));
  return { start, text: clause.slice(start, end) };
}

/** Where a thing appears in a text: nowhere, only far off, or close. */
function presence(text: string, pattern: RegExp): 'absent' | 'distant' | 'close' {
  let seen = false;
  for (const sentence of sentences(text)) {
    let farLead = false;
    for (const raw of sentence.split(/,\s*/)) {
      const clause = raw.trim();
      if (!clause) continue;
      if (DISTANCE_LEAD.test(clause)) { farLead = true; continue; }
      const match = pattern.exec(clause);
      if (match) {
        seen = true;
        const phrase = phraseAround(clause, match.index);
        const recedes = RECEDES.test(clause.slice(phrase.start, match.index));
        const placedFar = farLead && match.index < (DISTANCE_LEAD_STOP.exec(clause)?.index ?? clause.length);
        if (NEAR_METRES.test(clause) || (!placedFar && !DISTANT.test(phrase.text) && !recedes)) return 'close';
      }
      farLead = false;
    }
  }
  return seen ? 'distant' : 'absent';
}

/** The thing in a shot's words. */
function hasTerm(text: string, t: Term): boolean {
  return t.pattern.test(text);
}

/** How a location's (or a cast member's) words name the thing. */
function placePattern(t: Term): RegExp {
  return t.loose ?? t.pattern;
}

/** The action touches the thing: a contact verb's object, or (for a boat) aboard it by one of its parts. */
function contactedIn(text: string, t: Term): boolean {
  for (const clause of clauses(text)) {
    for (const verb of clause.matchAll(CONTACT_VERB)) {
      let rest = clause.slice((verb.index ?? 0) + verb[0].length);
      const stop = CLAUSE_BREAK.exec(rest);
      if (stop) rest = rest.slice(0, stop.index);
      rest = rest.trim().split(/\s+/).slice(0, CONTACT_WINDOW_WORDS).join(' ');
      if (rest && t.pattern.test(rest)) return true;
    }
    // "On the deck of the ferry": standing on a boat's part puts the shot aboard the boat the clause names.
    if (t.water && VESSEL_PARTS.some(part => hasTerm(clause, part)) && hasTerm(clause, t)) return true;
  }
  return false;
}

/** The words before a boat part place the shot on or at it ("on the open deck", "at the bow rail"). */
const PLACED_ON = /\b(?:on|onto|at|in|into|aboard|across|along|from|off|over)\s+(?:(?:the|her|his|its|their|a|an)\s+)?(?:[\w'-]+\s+){0,2}$/i;

function standsOn(text: string, t: Term): boolean {
  return clauses(text).some(clause => {
    const match = t.pattern.exec(clause);
    return Boolean(match) && PLACED_ON.test(clause.slice(0, match!.index));
  });
}

/** A vehicle the shot is about: named at the head of a clause, as what moves or waits. */
function featuredIn(text: string, t: Term): boolean {
  if (!t.vehicle) return false;
  return clauses(text).some(clause => {
    const match = t.pattern.exec(clause);
    return Boolean(match) && CLAUSE_HEAD.test(clause.slice(0, match!.index));
  });
}

function shotText(shot: PlanShot): string {
  return [shot.description, shot.stagedOn, shot.blocking].filter(Boolean).join('. ');
}

function shotId(shot: PlanShot): string {
  return `${shot.shotNumber}${shot.shotIdSuffix ?? ''}`;
}

/** The view texts of a location: what each plate shows. Empty when the location does not say. */
export function viewTexts(location: PlanLocation): Partial<Record<PlateView, string>> {
  const out: Partial<Record<PlateView, string>> = {};
  const anchors = typeof location.spatialAnchors === 'string' ? location.spatialAnchors : '';
  const marks = [...anchors.matchAll(/View\s*\d+\s*\((north|east|south|west)\)\s*:\s*/gi)];
  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : anchors.length;
    out[mark[1].toLowerCase() as PlateView] = anchors.slice(start, end).trim();
  });
  return out;
}

/** Water vessels a text names (by kind). */
function vesselsIn(text: string, how: 'shot' | 'place' = 'shot'): Set<string> {
  return new Set(VEHICLES.filter(t => (how === 'place' ? placePattern(t) : t.pattern).test(text)).map(t => t.key));
}

// ---- The check ---------------------------------------------------------------

export interface PlanCheckInput {
  shots: PlanShot[];
  locations: PlanLocation[];
  cast?: PlanCast[];
  /** Ask every shot on a set with per-view plates to name its plateView. */
  requirePlateView?: boolean;
}

function staging(shot: PlanShot, loc: PlanLocation, props: PlanCast[]): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const text = shotText(shot);
  const views = viewTexts(loc);
  const hasViews = VIEWS.some(view => views[view]);
  const where = `${loc.slug}${shot.plateView ? ` (${shot.plateView})` : ''}`;
  const fix = loc.fixed
    ? 'Stage it on a new location whose plates show it (give it "near" when it adjoins this one), or on another view that shows it.'
    : 'Write it into the location description and the view that carries the shot, so the plates show it.';

  for (const t of STAGING_TERMS) {
    const inShot = presence(text, t.pattern);
    if (inShot === 'absent') continue;
    // Only what the action touches, a boat part it stands on, or a vehicle
    // the shot is about has to be on the plate; a thing merely named (looked
    // at, passing, in a simile) is a warning. A thing the action touches is
    // close, whatever else the sentence says is far.
    const touched = contactedIn(text, t);
    const shotFarOff = inShot === 'distant' && !touched;
    const severe = touched || (Boolean(t.part) && standsOn(text, t)) || featuredIn(text, t);
    const locationText = `${loc.name}. ${loc.description}. ${typeof loc.spatialAnchors === 'string' ? loc.spatialAnchors : ''}`;
    // An object cast member in the shot carries itself (its own reference), and
    // stays out of a new location's text (OBJECT CAST STAYS OUT OF LOCATIONS).
    // A fixed location's plates still have to stage it.
    const castProp = props.some(prop => (shot.characters ?? []).some(name => name.toUpperCase() === prop.name.toUpperCase())
      && placePattern(t).test(`${prop.name} ${prop.description ?? ''}`));
    if (castProp && !loc.fixed) continue;
    if (!placePattern(t).test(locationText)) {
      findings.push({
        shot: shotId(shot), kind: 'not-in-plates', location: loc.slug, noun: t.key,
        severity: loc.fixed && !shotFarOff && severe ? 'block' : 'warn',
        message: `Shot ${shotId(shot)} ${severe ? 'needs' : 'names'} ${t.part ? 'a boat\'s ' : ''}${t.key}; ${loc.fixed ? 'no plate of' : 'the description of'} ${loc.slug} ${loc.fixed ? 'shows one' : 'does not mention one'}. ${fix}`,
      });
      continue;
    }
    if (!loc.fixed || !hasViews || shotFarOff) continue;
    const candidates = shot.plateView && views[shot.plateView] ? [shot.plateView] : VIEWS.filter(view => views[view]);
    const states = candidates.map(view => ({ view, state: presence(views[view]!, placePattern(t)) }));
    if (states.some(s => s.state === 'close')) continue;
    const elsewhere = shot.plateView
      ? VIEWS.filter(view => view !== shot.plateView && views[view] && presence(views[view]!, placePattern(t)) === 'close')
      : [];
    const better = elsewhere.length ? ` The ${elsewhere.join(' / ')} view shows it close: set plateView to ${elsewhere[0]}, or stage it on a new location.` : ` ${fix}`;
    if (states.some(s => s.state === 'distant')) {
      findings.push({
        shot: shotId(shot), kind: 'distant-in-plates', location: loc.slug, noun: t.key, severity: severe ? 'block' : 'warn',
        message: `Shot ${shotId(shot)} ${touched ? 'acts on' : 'shows'} the ${t.key}, but ${where} shows it only far off; the model will draw it far off.${better}`,
      });
    } else {
      // The hero plate is made from the whole description, so the thing may
      // well be in it: weak evidence, a warning (the vision pass can still
      // find the shot does not fit).
      findings.push({
        shot: shotId(shot), kind: 'description-only', location: loc.slug, noun: t.key, severity: 'warn',
        message: `Shot ${shotId(shot)} needs the ${t.key}; ${loc.slug} mentions it in its description, but no ${shot.plateView ? `${shot.plateView} ` : ''}view shows it.${better}`,
      });
    }
  }
  return findings;
}

/** Find a location the way the pipeline does (series/manager getLocation): by slug or name, in any case. */
function locationFinder(locations: PlanLocation[]): (key?: string) => PlanLocation | undefined {
  const byKey = new Map<string, PlanLocation>();
  for (const loc of locations) if (typeof loc.name === 'string' && loc.name) byKey.set(loc.name.toLowerCase(), loc);
  for (const loc of locations) if (typeof loc.slug === 'string' && loc.slug) byKey.set(loc.slug.toLowerCase(), loc);
  return key => (key ? byKey.get(String(key).toLowerCase()) : undefined);
}

export function checkShotPlan(input: PlanCheckInput): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const findLocation = locationFinder(input.locations);
  const props = (input.cast ?? []).filter(member => member.prop);

  // Per shot: the place exists, names its view, and its plates show what the action needs.
  for (const shot of input.shots) {
    if (!shot.location) continue;
    const loc = findLocation(shot.location);
    if (!loc) {
      findings.push({ shot: shotId(shot), kind: 'unknown-location', severity: 'block', location: shot.location, message: `Shot ${shotId(shot)} names location "${shot.location}", which is not in the plan.` });
      continue;
    }
    const views = viewTexts(loc);
    if (input.requirePlateView && loc.fixed && !shot.plateView && VIEWS.some(view => views[view])) {
      findings.push({ shot: shotId(shot), kind: 'no-plate-view', severity: 'warn', location: loc.slug, message: `Shot ${shotId(shot)} does not say which view of ${loc.slug} it is staged on (plateView); the north plate leads by default.` });
    }
    findings.push(...staging(shot, loc, props));
  }

  // The vessel of the journey: the one a shot boards or stands aboard, or the
  // one a clause is about ("the navy ferry pulls away"); when the shot only
  // names a deck, a bow, a gangway, whatever vessel its location's plates
  // show. A vessel merely named (a gondola passing the quay) is not the
  // journey's.
  let last: { shot: PlanShot; place?: string; vessels: Set<string>; inferred: boolean } | null = null;
  const vesselShots = new Map<string, Set<string>>();
  for (const shot of input.shots) {
    if (shot.continuity?.from === 'new-scene') last = null;
    const text = shotText(shot);
    const loc = findLocation(shot.location);
    const place = loc?.slug ?? shot.location;
    for (const vessel of vesselsIn(text)) {
      if (!vesselShots.has(vessel)) vesselShots.set(vessel, new Set());
      if (place) vesselShots.get(vessel)!.add(place);
    }
    const boarded = VEHICLES.filter(t => contactedIn(text, t)).map(t => t.key);
    let vessels = new Set([...boarded, ...VEHICLES.filter(t => featuredIn(text, t)).map(t => t.key)]);
    let aboard = boarded.length > 0;
    let inferred = false;
    if (vessels.size === 0 && loc && (VESSEL_PARTS.some(t => hasTerm(text, t)) || /\b(?:aboard|on board)\b/i.test(text))) {
      const views = viewTexts(loc);
      const shown = shot.plateView && views[shot.plateView] ? `${views[shot.plateView]}. ${loc.description}` : `${loc.description}. ${typeof loc.spatialAnchors === 'string' ? loc.spatialAnchors : ''}`;
      vessels = vesselsIn(shown, 'place');
      inferred = vessels.size > 0;
      aboard = inferred;
    }
    if (vessels.size === 0) {
      // Off the water at another place: the journey is over.
      if (last && place && place !== last.place) last = null;
      continue;
    }
    // Ashore at another place, and not carried straight on from the shot
    // before: a boat seen from there is not the journey's boat.
    if (last && !aboard && place !== last.place && shot.continuity?.from !== 'continuous') last = null;
    if (last && (inferred || last.inferred) && ![...vessels].some(v => last!.vessels.has(v))) {
      findings.push({
        shot: shotId(shot), kind: 'vessel-changes', severity: loc?.fixed ? 'block' : 'warn', location: shot.location,
        message: `The boat changes at shot ${shotId(shot)}: shot ${shotId(last.shot)} is ${last.inferred ? `aboard the ${[...last.vessels].join('/')} its plates show` : `on the ${[...last.vessels].join('/')}`}, shot ${shotId(shot)} ${inferred ? `stands on ${shot.location}, whose plates show a ${[...vessels].join('/')}` : `names a ${[...vessels].join('/')}`}. Give the journey one vessel: a location of its own (its deck, its landing) and an object reference for the vessel itself.`,
      });
    }
    last = { shot, place, vessels, inferred };
  }

  // A vessel seen at two or more places is drawn fresh at each unless it has its own reference.
  for (const [vessel, locations] of vesselShots) {
    if (locations.size < 2) continue;
    const term = VEHICLES.find(t => t.key === vessel)!;
    const cast = props.some(prop => placePattern(term).test(`${prop.name} ${prop.description ?? ''}`));
    if (cast) continue;
    findings.push({
      kind: 'recurring-vehicle', severity: 'warn', noun: vessel,
      message: `The ${vessel} appears at ${[...locations].join(', ')} with no reference of its own; each place will draw a different one. Cast it as an object (prop) and list it in every shot that shows it, so each one carries its reference.`,
    });
  }
  return findings;
}

export function describePlanFindings(findings: PlanFinding[]): string[] {
  return findings.map(finding => `${finding.severity === 'block' ? '✗' : '⚠'} ${finding.message}`);
}
