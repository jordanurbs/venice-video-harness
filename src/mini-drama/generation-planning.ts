// ---------------------------------------------------------------------------
// Generation planning (`plan-generations`): three passes of thinking about
// consistency before any money is spent.
//
//   1. Continuity ledger (free, deterministic): what must look the same across
//      each cut between shots, where a shot changes a state, and what has no
//      reference of its own.
//   2. Packaging (the project's intelligence model as a sub-agent): which shots
//      share a generation, the reason for every split, and notes that write a
//      state change into a shot. A deterministic validator checks the answer;
//      an answer that does not fit the script falls back to the rules planner,
//      with its problems recorded.
//   3. Reference audit (per unit): the references against the budget, the
//      plan check's findings, the quoted cost, what carries across a cut
//      between two generations, and which clips are already on disk.
//
// The result is a proposal until a person approves it
// (`generation-plan-approval.ts`).
//
// The packaging rules come from a 31-render continuity bakeoff (Seedance 2.5
// R2V, 720p): one generation kept what must carry across cuts (a recurring
// vehicle in 3 of 3 takes against 0 of 4 generated separately, the facing in
// 3 of 3 against 0 of 3), separate generations followed each shot's own
// action better (a departure departed in 3 of 3 separate takes, 1 of 3 inside
// one generation, where the first plate's state carried forward), and the
// cuts inside one generation landed where they were asked for.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EpisodeScript,
  GenerationPlan,
  GenerationUnit,
  SeriesState,
  ShotScript,
} from 'venice-video-harness/core/series/types.js';
import {
  MODELS_USING_IMAGE_TAGS,
  getMaxReferenceImages,
  isObjectCastMember,
  resolveMontageGrammar,
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
  resolveMontageModel,
  resolveMontageReferenceViews,
} from 'venice-video-harness/core/series/types.js';
import { faceCapableTwinId, getVideoModel } from 'venice-video-harness/core/venice/models.js';
import type { VideoQuoteRequest } from 'venice-video-harness/core/venice/types.js';
import { VeniceRequestError, type VeniceClient } from '../venice/client.js';
import { isAbortError } from '../venice/operation-context.js';
import { VideoRequestValidationError, quoteVideo } from '../venice/video.js';
import { getLocation } from '../series/manager.js';
import { buildGenerationPlan, buildGenerationPlanFromGroups, parseShotDuration, resolveUnitShots } from './generation-planner.js';
import { hashPackagingInputs, packagingInputs } from './generation-plan-approval.js';
import { montageBlockReason, type MontageBlockReason } from './montage.js';
import { checkShotPlan, describePlanFindings, objectVehicle, vehiclesIn } from './plan-check.js';
import { resolveVideoModel } from './prompt-builder.js';
import { buildMontageSlotPlan, buildReferenceSlotPlan, primaryReferencePath } from './reference-slots.js';
import { normalizeShotId, shotIdOf } from './shot-paths.js';
import { defaultRenderResolution, sendsAspectRatio, unitClipPaths } from './video-generator.js';
import { workshopPlanOptions } from './workshop.js';

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// ---- Pass 1: the continuity ledger ------------------------------------------

export interface LedgerEntity {
  name: string;
  kind: 'person' | 'object' | 'vehicle';
  /** Shot ids ("13b") it appears in, in script order. */
  shots: string[];
  /** A reference image on disk (cast), or false for a thing only the shot words name. */
  hasReference: boolean;
}

export interface LedgerJoin {
  /** The cut between shot `from` and shot `to` (shot ids). */
  from: string;
  to: string;
  continuity: 'continuous' | 'later' | 'new-scene' | 'unmarked';
  placeChange: boolean;
  /** What is on both sides of the cut and must look the same. */
  carries: string[];
  /** The words in the second shot that change a state an earlier plate shows ("pulls away"). */
  stateChange?: string;
}

export interface ContinuityLedger {
  entities: LedgerEntity[];
  joins: LedgerJoin[];
  risks: string[];
}

/** Verbs that change what an earlier plate shows (a moored boat, a shut door, a dark lamp). */
const STATE_CHANGE = /\b(?:pulls? away|pulling away|departs|departing|casts? off|casting off|sets? off|setting off|arrives|arriving|docks|docking|moors|mooring|ties up|tying up|opens|opening|closes|closing|shuts|shutting|unlocks|unlocking|lights up|lighting up|switch(?:es)? on|switching on|goes out|going out|lifts off|lifting off|takes off|taking off|starts? at once)\b/i;

function shotWords(shot: ShotScript): string {
  return [shot.description, shot.stagedOn, shot.blocking].filter(Boolean).join('. ');
}

function placeKey(series: SeriesState, tag: string | undefined): string | undefined {
  return tag ? getLocation(series, tag)?.slug ?? tag : undefined;
}

export function buildContinuityLedger(series: SeriesState, shots: ShotScript[]): ContinuityLedger {
  const cast = series.characters ?? [];
  const entities = new Map<string, LedgerEntity>();
  const presentAt: Array<Set<string>> = [];
  // What a cast object is decides whether it is a vehicle (a CAR KEY is not),
  // as in the montage prompt's count line.
  const vehicleOf = (member: SeriesState['characters'][number]) => (isObjectCastMember(member)
    ? objectVehicle(member.name, member.description || member.fullDescription)
    : undefined);
  // A vehicle the words name is the cast vehicle of that kind when the project has one.
  const castVehicleByKind = new Map<string, SeriesState['characters'][number]>();
  for (const member of cast) {
    const vehicle = vehicleOf(member);
    if (vehicle && !castVehicleByKind.has(vehicle.key)) castVehicleByKind.set(vehicle.key, member);
  }
  const enter = (key: string, make: () => LedgerEntity, id: string, here: Set<string>) => {
    if (!entities.has(key)) entities.set(key, make());
    const list = entities.get(key)!.shots;
    if (!list.includes(id)) list.push(id);
    here.add(key);
  };
  for (const shot of shots) {
    const id = shotIdOf(shot);
    const here = new Set<string>();
    for (const name of shot.characters ?? []) {
      const member = cast.find(c => c.name.toUpperCase() === name.toUpperCase());
      const kind: LedgerEntity['kind'] = !member || !isObjectCastMember(member) ? 'person' : vehicleOf(member) ? 'vehicle' : 'object';
      const label = member?.name ?? name;
      enter(label.toUpperCase(), () => ({ name: label, kind, shots: [], hasReference: Boolean(primaryReferencePath(series, label)) }), id, here);
    }
    // A vehicle only the words name is drawn fresh by every generation it is in.
    for (const kind of vehiclesIn(shotWords(shot))) {
      const member = castVehicleByKind.get(kind);
      if (member) {
        enter(member.name.toUpperCase(), () => ({ name: member.name, kind: 'vehicle', shots: [], hasReference: Boolean(primaryReferencePath(series, member.name)) }), id, here);
      } else {
        enter(`vehicle:${kind}`, () => ({ name: kind, kind: 'vehicle', shots: [], hasReference: false }), id, here);
      }
    }
    presentAt.push(here);
  }

  const joins: LedgerJoin[] = [];
  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1];
    const shot = shots[i];
    const carries = [...presentAt[i - 1]].filter(key => presentAt[i].has(key)).map(key => entities.get(key)!.name);
    const before = placeKey(series, prev.location);
    const after = placeKey(series, shot.location);
    const placeChange = Boolean(before && after && before !== after);
    const change = STATE_CHANGE.exec(shot.description ?? '')?.[0];
    joins.push({
      from: shotIdOf(prev),
      to: shotIdOf(shot),
      continuity: shot.continuity?.from ?? 'unmarked',
      placeChange,
      carries,
      ...(change && (carries.length || !placeChange) ? { stateChange: change.toLowerCase() } : {}),
    });
  }

  const risks: string[] = [];
  for (const entity of entities.values()) {
    if (entity.kind === 'vehicle' && !entity.hasReference && entity.shots.length > 1) {
      risks.push(`The ${entity.name} is in shots ${entity.shots.join(', ')} with no reference of its own: each generation draws its own ${entity.name}. Cast it as an object (prop) with a reference, or keep those shots in one generation.`);
    } else if (!entity.hasReference && entity.kind !== 'vehicle') {
      risks.push(`${entity.name} has no reference image on disk.`);
    }
  }
  for (const cut of joins) {
    if (cut.stateChange && cut.continuity === 'continuous') {
      risks.push(`Shot ${cut.to} changes a state ("${cut.stateChange}") that the plate of shot ${cut.from} may show the other way. Inside one generation the first plate's state carries forward: write the change into the shot, or split before it.`);
    }
  }
  return { entities: [...entities.values()], joins, risks };
}

// ---- Pass 2: packaging ------------------------------------------------------

/** A shot note is one line in a prompt: one or two sentences of plain action. */
export const SHOT_NOTE_MAX_CHARS = 300;

const ALONE: Record<MontageBlockReason, string> = {
  forced: 'forced single in the script (mustStaySingle)',
  insert: 'an insert that does not continue the action',
  'title-card': 'a title card',
  'lip-sync': 'exact lip-sync to supplied audio',
};

function aloneReason(shot: ShotScript, series: Pick<SeriesState, 'videoDefaults'>): string | null {
  const reason = montageBlockReason(shot, series.videoDefaults);
  return reason ? ALONE[reason] : null;
}

/** The answer the packaging agent is asked for. Everything in it is checked by `validatePackaging`. */
export interface PackagingProposal {
  units: Array<{ shots: Array<string | number>; reason?: string }>;
  splits?: Array<{ after: string | number; reason?: string }>;
  shotNotes?: Array<{ shot: string | number; note: string }>;
  notes?: string[];
}

export function packagingPrompt(series: SeriesState, shots: ShotScript[], ledger: ContinuityLedger): { system: string; user: string } {
  const maxSec = resolveMontageMaxDurationSec(series.videoDefaults);
  const minSec = resolveMontageMinDurationSec(series.videoDefaults);
  const model = resolveMontageModel(series.videoDefaults);
  const system = [
    `You plan how a video's shots are packaged into generations on ${model}, a reference-to-video model. One generation renders one clip that can hold several shots joined by hard cuts; the clip is cut into the separate shots afterwards. Separate generations are drawn independently of each other.`,
    '',
    'What a continuity bakeoff measured (Seedance 2.5 reference-to-video, 31 renders, good references):',
    '- One generation keeps what must carry across cuts: the same vehicle (3 of 3 takes, against 0 of 4 when the shots were generated separately), the same facing (3 of 3 against 0 of 3), the same props and light.',
    '- Separate generations follow each shot\'s own action and plate more faithfully: a departure departed in 3 of 3 separate takes, but in only 1 of 3 inside one generation, where the first shot\'s plate (the vessel still moored) carried forward.',
    '- Cuts inside one generation land where they are asked for (25 of 25, within 0.55 s), so cutting afterwards is clean.',
    '- At 30 seconds across three places the late shots lost detail; units of about 22 seconds or less held up.',
    '',
    'Decide the units. Rules:',
    '1. Keep shots in one generation when something must carry across their cuts (a vehicle, a prop in hand, a person in changing light, which way someone faces) and they are one continuous run, even across a change of place.',
    '2. Split where nothing needs to carry: a new scene, a time skip with nothing shared.',
    `3. When a shot changes a state an earlier plate in the same unit shows (moored to under way, a door shut to open, a lamp off to on), either keep it in the unit and give a shotNote that writes the change into the shot, or split before it. When the vehicle or prop also has to carry across that cut, prefer the shotNote. A shotNote goes into the video prompt as part of the shot: one or two sentences of plain action for the video model (what moves, what is released, what the frame shows by the end), at most ${SHOT_NOTE_MAX_CHARS} characters, on one line. Never write commentary about plates, references, units or this plan in a shotNote, and never an @Image tag.`,
    '4. A shot listed as "alone" renders by itself, whatever unit it is in.',
    `5. Units are runs of consecutive shots in script order, every shot exactly once. Name every shot by its id exactly as given: "13b" is a shot inserted after 13, not shot 13. A unit lasts ${minSec} to ${maxSec} seconds; a single shot shorter than ${minSec} s renders alone.`,
    '6. A unit is re-rendered whole when any of its shots fails, so do not make a unit longer than the run needs.',
    'Give a reason for every unit and for every split. Return ONLY JSON: {"units":[{"shots":["1","2","3"],"reason":"..."}],"splits":[{"after":"3","reason":"..."}],"shotNotes":[{"shot":"2","note":"..."}],"notes":["..."]}',
  ].join('\n');
  const user = JSON.stringify({
    shots: shots.map(shot => {
      const alone = aloneReason(shot, series);
      return {
        id: shotIdOf(shot),
        seconds: parseShotDuration(shot.duration),
        type: shot.type,
        place: shot.location ? getLocation(series, shot.location)?.name ?? shot.location : null,
        ...(shot.plateView ? { view: shot.plateView } : {}),
        cast: shot.characters,
        action: (shot.description ?? '').slice(0, 400),
        ...(shot.continuity ? { continuity: shot.continuity } : {}),
        ...(shot.dialogue ? { speaks: shot.dialogue.character } : {}),
        ...(alone ? { alone } : {}),
      };
    }),
    joins: ledger.joins,
    risks: ledger.risks,
  }, null, 2);
  return { system, user };
}

/**
 * Ask the project's intelligence model (rule 46) to package the shots,
 * through `chatJson` (rule 47). The answer is untyped until
 * `validatePackaging` has read it.
 */
export async function proposePackaging(
  client: Pick<VeniceClient, 'chatJson'>,
  model: string,
  series: SeriesState,
  shots: ShotScript[],
  ledger: ContinuityLedger,
): Promise<unknown> {
  const { system, user } = packagingPrompt(series, shots, ledger);
  return client.chatJson<unknown>({
    model,
    systemPrompt: system,
    userPrompt: user,
    // A reasoning model spends most of the budget thinking (rule 47): with
    // 8000 tokens, a reasoning model returned nothing for a 33-shot film.
    maxTokens: 32_000,
    temperature: 0.2,
    label: 'generation planning',
  });
}

export interface ValidatedPackaging {
  /** The units as shot ids, as the script writes them, in script order. */
  groups: Array<{ shots: string[]; reason: string }>;
  /** By shot id: one line each, at most `SHOT_NOTE_MAX_CHARS`. */
  shotNotes: Record<string, string>;
  splits: Array<{ after: string; reason: string }>;
  /** The agent's own notes for a person. */
  agentNotes: string[];
  /** Structural problems: when any, the proposal is not used. */
  problems: string[];
  /** Things worth a person's look that do not invalidate the plan. */
  notes: string[];
}

/** Keep whole sentences up to `max` characters; a first sentence longer than that is cut at a word. */
function capNote(text: string, max = SHOT_NOTE_MAX_CHARS): string {
  if (text.length <= max) return text;
  let kept = '';
  for (const sentence of text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) {
    const next = `${kept}${sentence}`;
    if (next.trim().length > max) break;
    kept = next;
  }
  if (kept.trim()) return kept.trim();
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[,;:]\s*$/, '')}…`;
}

/**
 * Check a packaging answer against the script and the montage lane. Ids are
 * shot ids (number and insert suffix: "13" and "13b" are two shots). Never
 * throws: any shape it cannot use is a problem, and a plan with problems is
 * not used.
 */
export function validatePackaging(
  proposal: unknown,
  series: Pick<SeriesState, 'videoDefaults'>,
  shots: ShotScript[],
): ValidatedPackaging {
  const problems: string[] = [];
  const notes: string[] = [];
  const result: ValidatedPackaging = { groups: [], shotNotes: {}, splits: [], agentNotes: [], problems, notes };
  const ids = shots.map(shotIdOf);
  const position = new Map<string, number>();
  const duplicated = new Set<string>();
  ids.forEach((id, i) => {
    const key = normalizeShotId(id) ?? id;
    if (position.has(key)) duplicated.add(id);
    else position.set(key, i);
  });
  if (duplicated.size) {
    problems.push(`the script has more than one shot with the id ${[...duplicated].join(', ')}, so a plan cannot name them apart`);
    return result;
  }
  const find = (value: unknown): number | undefined => {
    const key = normalizeShotId(value);
    return key === null ? undefined : position.get(key);
  };
  if (!isRecord(proposal)) {
    problems.push('the planner did not answer with a JSON object');
    return result;
  }
  if (!Array.isArray(proposal.units) || proposal.units.length === 0) {
    problems.push('the planner returned no units');
    return result;
  }

  // Units: runs of consecutive shots, in script order, every shot once.
  const units: Array<{ positions: number[]; reason: string }> = [];
  proposal.units.forEach((entry, u) => {
    // A bare list of shot ids is a unit without a reason.
    const unit: unknown = Array.isArray(entry) ? { shots: entry } : entry;
    if (!isRecord(unit) || !Array.isArray(unit.shots)) {
      problems.push(`unit ${u + 1} is not {"shots": [...], "reason": "..."}`);
      return;
    }
    const positions: number[] = [];
    const unknown: string[] = [];
    for (const value of unit.shots) {
      const at = find(value);
      if (at === undefined) unknown.push(String(value));
      else positions.push(at);
    }
    if (unknown.length) problems.push(`unit ${u + 1} names shots that are not in the script: ${unknown.join(', ')}`);
    if (positions.length === 0) {
      if (!unknown.length) problems.push(`unit ${u + 1} has no shots`);
      return;
    }
    units.push({ positions, reason: typeof unit.reason === 'string' ? oneLine(unit.reason) : '' });
  });
  const label = (positions: number[]) => positions.map(at => ids[at]).join(', ');
  const seen = new Map<number, number>();
  units.forEach((unit, u) => {
    for (const at of unit.positions) seen.set(at, (seen.get(at) ?? 0) + 1);
    if (unit.positions.some((at, i) => i > 0 && at !== unit.positions[i - 1] + 1)) {
      problems.push(`unit ${u + 1} (shots ${label(unit.positions)}) is not a run of consecutive shots`);
    }
    if (!unit.reason) notes.push(`unit ${u + 1} (shots ${label(unit.positions)}) gives no reason`);
  });
  for (let u = 1; u < units.length; u++) {
    const previous = units[u - 1].positions;
    if (units[u].positions[0] <= previous[previous.length - 1]) problems.push(`units ${u} and ${u + 1} are out of script order`);
  }
  const missing = ids.filter((_, at) => !seen.has(at));
  const twice = [...seen].filter(([, count]) => count > 1).map(([at]) => ids[at]);
  if (missing.length) problems.push(`shots not in any unit: ${missing.join(', ')}`);
  if (twice.length) problems.push(`shots in more than one unit: ${twice.join(', ')}`);

  // Splits: why each unit ends where it does.
  const splits: Array<{ after: string; reason: string }> = [];
  if (proposal.splits !== undefined && proposal.splits !== null) {
    if (!Array.isArray(proposal.splits)) {
      problems.push('"splits" is not a list of {"after": "<shot id>", "reason": "..."}');
    } else {
      proposal.splits.forEach((split, s) => {
        if (!isRecord(split)) {
          problems.push(`split ${s + 1} is not {"after": "<shot id>", "reason": "..."}`);
          return;
        }
        const at = find(split.after);
        if (at === undefined) {
          notes.push(`split ${s + 1} names shot ${String(split.after)}, which is not in the script; ignored`);
          return;
        }
        splits.push({ after: ids[at], reason: typeof split.reason === 'string' ? oneLine(split.reason) : '' });
      });
    }
  }

  // Shot notes: one line of plain action each, written into a prompt.
  const shotNotes: Record<string, string> = {};
  if (proposal.shotNotes !== undefined && proposal.shotNotes !== null) {
    if (!Array.isArray(proposal.shotNotes)) {
      problems.push('"shotNotes" is not a list of {"shot": "<shot id>", "note": "..."}');
    } else {
      proposal.shotNotes.forEach((entry, n) => {
        if (!isRecord(entry) || typeof entry.note !== 'string') {
          problems.push(`shot note ${n + 1} is not {"shot": "<shot id>", "note": "..."}`);
          return;
        }
        const at = find(entry.shot);
        if (at === undefined) {
          notes.push(`a shot note names shot ${String(entry.shot)}, which is not in the script; dropped`);
          return;
        }
        const id = ids[at];
        const text = oneLine(entry.note);
        if (!text) return;
        if (/@(?:image|audio|element)\d*/i.test(text)) {
          notes.push(`the note for shot ${id} cites a reference tag, which is numbered per generation; dropped`);
          return;
        }
        if (shotNotes[id]) {
          notes.push(`a second note for shot ${id} was dropped`);
          return;
        }
        const capped = capNote(text);
        if (capped !== text) notes.push(`the note for shot ${id} ran to ${text.length} characters; shortened to ${capped.length}`);
        shotNotes[id] = capped;
      });
    }
  }

  const agentNotes: string[] = [];
  if (proposal.notes !== undefined && proposal.notes !== null) {
    if (!Array.isArray(proposal.notes)) notes.push('the planner\'s "notes" is not a list; ignored');
    else for (const note of proposal.notes) if (typeof note === 'string' && oneLine(note)) agentNotes.push(oneLine(note));
  }

  if (problems.length === 0) {
    // What a person should look at in a plan that will be used.
    const maxSec = resolveMontageMaxDurationSec(series.videoDefaults);
    units.forEach((unit, u) => {
      const members = unit.positions.map(at => shots[at]);
      const total = members.reduce((sum, shot) => sum + parseShotDuration(shot.duration), 0);
      if (total > maxSec) notes.push(`unit ${u + 1} (shots ${label(unit.positions)}) lasts ${total} s, over the ${maxSec} s ceiling: it splits into windows`);
      if (members.length > 1) {
        for (const shot of members) {
          const alone = aloneReason(shot, series);
          if (alone) notes.push(`shot ${shotIdOf(shot)} renders alone (${alone}), outside unit ${u + 1}`);
        }
      }
      for (const shot of members.slice(1)) {
        if (shot.continuity?.from === 'new-scene') notes.push(`unit ${u + 1} carries on into shot ${shotIdOf(shot)}, which the script marks as a new scene`);
      }
    });
    const ends = units.slice(0, -1).map(unit => ids[unit.positions[unit.positions.length - 1]]);
    const kept: Array<{ after: string; reason: string }> = [];
    for (const split of splits) {
      if (!ends.includes(split.after)) notes.push(`the split after shot ${split.after} is not where the units split; ignored`);
      else if (kept.some(k => k.after === split.after)) notes.push(`a second reason for the split after shot ${split.after} was dropped`);
      else kept.push(split);
    }
    for (const end of ends) {
      const split = kept.find(k => k.after === end);
      if (!split || !split.reason) notes.push(`no reason given for the split after shot ${end}`);
    }
    result.splits = kept;
  }

  result.groups = units.map(unit => ({ shots: unit.positions.map(at => ids[at]), reason: unit.reason }));
  result.shotNotes = shotNotes;
  result.agentNotes = agentNotes;
  return result;
}

/**
 * Shot notes no prompt reads in this plan: only shot-list montage prompts
 * read notes, so a note is lost on a shot that renders alone (or in any unit
 * other than a montage), and on every shot under the SEQUENCE grammar.
 */
export function unusedShotNotes(
  plan: GenerationPlan,
  shots: ShotScript[],
  shotNotes: Record<string, string>,
  series: Pick<SeriesState, 'videoDefaults'>,
): string[] {
  const noted = Object.keys(shotNotes);
  if (noted.length === 0) return [];
  if (resolveMontageGrammar(series.videoDefaults) !== 'shots') {
    return [`no prompt reads the notes for shots ${noted.join(', ')}: only the shot-list montage grammar (videoDefaults.montageGrammar "shots") writes shot notes, and this project uses "sequence". Write those changes into the shots' descriptions instead.`];
  }
  const messages: string[] = [];
  const unitShots = resolveUnitShots(plan, shots);
  plan.units.forEach((unit, index) => {
    for (const shot of unitShots[index]) {
      const id = shotIdOf(shot);
      if (!shotNotes[id] || unit.shotNotes?.[id]) continue;
      messages.push(`the note for shot ${id} is not used: the shot renders ${unit.unitType === 'single' ? 'alone' : `in a ${unit.unitType} unit`}, and only a shot-list montage prompt reads notes. Write the change into its description instead.`);
    }
  });
  return messages;
}

// ---- Pass 3: the reference audit --------------------------------------------

export interface UnitAudit {
  unitId: string;
  unitType: GenerationUnit['unitType'];
  /** Shot ids. */
  shots: string[];
  durationSec: number;
  /** The model the unit would render on (the quote's model). */
  model: string;
  places: string[];
  /** Reference images sent, against the model's budget (reference-tag models only). */
  references?: number;
  budget?: number;
  dropped: string[];
  findings: string[];
  /** Things that must carry into the next unit across a cut between generations. */
  carriesOut: string[];
  /** The unit's clips already on disk; a unit with all of them is skipped by generate-videos. */
  onDisk?: { clips: number; of: number; master: boolean };
  costUsd?: number;
}

/** A quote for one unit on one model, in USD; undefined when there is none. */
export type UnitQuote = (unit: GenerationUnit, model: string) => Promise<number | undefined>;

/** The model a unit renders on, and the references it would send (reference-tag models), as the prompt builders choose them. */
function unitModelAndSlots(series: SeriesState, unit: GenerationUnit, members: ShotScript[]): { model: string; slots?: { slots: unknown[]; dropped: string[] } } {
  const characters = Array.from(new Set(members.flatMap(shot => shot.characters ?? [])));
  if (unit.unitType === 'montage') {
    const model = characters.length ? faceCapableTwinId(unit.model) : unit.model;
    if (resolveMontageGrammar(series.videoDefaults) === 'shots') {
      return { model, slots: buildMontageSlotPlan(series, members, model, { views: resolveMontageReferenceViews(series.videoDefaults) }) };
    }
    return { model, slots: buildReferenceSlotPlan(series, { ...members[0], characters }, model, { characterNames: characters }) };
  }
  const model = (unit.unitType === 'single' ? resolveVideoModel(members[0], series).modelId : unit.model) || unit.model;
  if (!MODELS_USING_IMAGE_TAGS.has(model)) return { model };
  const names = characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase())?.name)
    .filter((name): name is string => Boolean(name));
  return { model, slots: buildReferenceSlotPlan(series, { ...members[0], characters }, model, { characterNames: names }) };
}

export async function auditPlan(
  series: SeriesState,
  shots: ShotScript[],
  plan: GenerationPlan,
  ledger: ContinuityLedger,
  options: { quote?: UnitQuote; sceneDir?: string } = {},
): Promise<UnitAudit[]> {
  const unitShots = resolveUnitShots(plan, shots);
  const planOptions = workshopPlanOptions(series);
  const locations = (series.locations ?? []).map(location => ({
    slug: String(location.slug ?? ''),
    name: String(location.name ?? ''),
    description: String(location.description ?? ''),
    spatialAnchors: location.spatialAnchors,
    fixed: planOptions.fixedLocation?.(location) ?? false,
    near: location.near,
  }));
  const cast = (series.characters ?? []).map(member => ({ name: member.name, prop: isObjectCastMember(member), description: member.description }));
  const audits: UnitAudit[] = [];
  for (const [index, unit] of plan.units.entries()) {
    const members = unitShots[index] ?? [];
    const base = { unitId: unit.unitId, unitType: unit.unitType, durationSec: parseShotDuration(unit.duration) };
    if (members.length === 0) {
      audits.push({ ...base, shots: [], model: unit.model, places: [], dropped: [], findings: ['no shot in the script matches this unit'], carriesOut: [] });
      continue;
    }
    // The audit runs after the paid planning call: a unit it cannot read is
    // reported, never fatal.
    let model = unit.model;
    let slots: { slots: unknown[]; dropped: string[] } | undefined;
    let findings: string[] = [];
    try {
      ({ model, slots } = unitModelAndSlots(series, unit, members));
      findings = describePlanFindings(checkShotPlan({ shots: members, locations, cast }).filter(finding => finding.kind !== 'no-plate-view'));
    } catch (err) {
      findings = [`the audit could not read this unit: ${firstLine(err)}`];
    }
    const last = shotIdOf(members[members.length - 1]);
    const cut = ledger.joins.find(item => item.from === last);
    let onDisk: UnitAudit['onDisk'];
    if (options.sceneDir) {
      const clips = unitClipPaths(options.sceneDir, unit, members).filter(path => existsSync(path)).length;
      onDisk = { clips, of: members.length, master: unit.unitType !== 'single' && existsSync(join(options.sceneDir, unit.outputFile)) };
    }
    let costUsd: number | undefined;
    if (options.quote && getVideoModel(model)) {
      costUsd = await options.quote(unit, model).catch((err: unknown) => {
        if (isAbortError(err)) throw err;
        return undefined;
      });
    }
    audits.push({
      ...base,
      shots: members.map(shotIdOf),
      model,
      places: members
        .map(shot => (shot.location ? getLocation(series, shot.location)?.name ?? shot.location : ''))
        .filter((name, i, all) => name && all[i - 1] !== name),
      ...(slots ? { references: slots.slots.length, budget: getMaxReferenceImages(model) } : {}),
      dropped: slots?.dropped ?? [],
      findings,
      carriesOut: cut && cut.carries.length && cut.continuity !== 'new-scene' ? cut.carries.map(name => `${name} into shot ${cut.to}`) : [],
      ...(onDisk ? { onDisk } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }
  return audits;
}

/**
 * Quotes from `POST /video/quote` (free), for the request `renderVideoFile`
 * would send: the unit's model and duration, the family's resolution, the
 * aspect ratio when the model takes one. Identical requests are asked once. A
 * request the endpoint rejects costs only that unit its quote; no network, a
 * bad key or a service error stops quoting for the rest of the plan
 * (`stopped` says why), so an offline run does not wait on every unit.
 */
export function unitQuoter(
  client: Pick<VeniceClient, 'post'>,
  series: Pick<SeriesState, 'storyboardAspectRatio'>,
): { quote: UnitQuote; readonly stopped: string | undefined } {
  const asked = new Map<string, Promise<number | undefined>>();
  let stopped: string | undefined;
  const quote: UnitQuote = async (unit, model) => {
    if (stopped) return undefined;
    const request: VideoQuoteRequest = { model, duration: unit.duration };
    const resolution = defaultRenderResolution(model);
    if (resolution) request.resolution = resolution;
    if (sendsAspectRatio(model)) request.aspect_ratio = series.storyboardAspectRatio ?? '16:9';
    if (getVideoModel(model)?.audioConfigurable !== false) request.audio = true;
    const key = JSON.stringify(request);
    if (!asked.has(key)) {
      asked.set(key, (async () => {
        if (stopped) return undefined;
        try {
          const answer = await quoteVideo(client as VeniceClient, request);
          return typeof answer?.quote === 'number' ? answer.quote : undefined;
        } catch (err) {
          if (isAbortError(err)) throw err;
          const rejected = err instanceof VideoRequestValidationError
            || (err instanceof VeniceRequestError && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status));
          if (!rejected) stopped ??= firstLine(err);
          return undefined;
        }
      })());
    }
    return asked.get(key)!;
  };
  return { quote, get stopped() { return stopped; } };
}

// ---- The whole pass ---------------------------------------------------------

export interface PlanGenerationsOptions {
  /** The intelligence model for the packaging agent: the project's (rule 46), or an explicit `--model`. */
  model?: string;
  /** False: plan by rules only, no model call. */
  agent?: boolean;
  quote?: UnitQuote;
  /** The episode's scene directory: report each unit's clips already on disk. */
  sceneDir?: string;
}

export interface PlanGenerationsResult {
  /** The proposal: the plan with `planning` set. */
  plan: GenerationPlan;
  ledger: ContinuityLedger;
  audits: UnitAudit[];
  /** The agent's answer as it came back, when it was asked. */
  answer?: unknown;
}

export async function planGenerations(
  client: Pick<VeniceClient, 'chatJson'> | null,
  series: SeriesState,
  script: EpisodeScript,
  options: PlanGenerationsOptions = {},
): Promise<PlanGenerationsResult> {
  const shots = script.shots;
  const ledger = buildContinuityLedger(series, shots);
  const inputs = packagingInputs(script, series);
  const problems: string[] = [];
  const notes: string[] = [];
  let answer: unknown;
  let validated: ValidatedPackaging | undefined;

  if (options.agent !== false) {
    if (!client || !options.model) {
      notes.push('The packaging agent was not asked (no Venice client or no intelligence model): this plan is by rules.');
    } else if (!inputs.settings.montage) {
      notes.push('Montage mode is off (the standard route): the packaging agent plans montage units, so this plan is by rules and the agent was not asked.');
    } else if (inputs.settings.grammar !== 'shots') {
      notes.push('The montage grammar is "sequence" (one place per generation): the packaging agent plans shot-list montages, so this plan is by rules and the agent was not asked.');
    } else {
      try {
        answer = await proposePackaging(client, options.model, series, shots, ledger);
        validated = validatePackaging(answer, series, shots);
        problems.push(...validated.problems);
      } catch (err) {
        if (isAbortError(err)) throw err;
        problems.push(`the planner failed: ${firstLine(err)}`);
      }
    }
  }

  let plan: GenerationPlan | undefined;
  if (validated && problems.length === 0) {
    try {
      plan = buildGenerationPlanFromGroups(script, series, { groups: validated.groups, shotNotes: validated.shotNotes });
    } catch (err) {
      problems.push(`the planner's units could not be built: ${firstLine(err)}`);
    }
  }
  const byAgent = Boolean(plan);
  plan ??= buildGenerationPlan(script, series);
  const shotNotes = byAgent && validated && Object.keys(validated.shotNotes).length ? validated.shotNotes : undefined;

  plan.planning = {
    by: byAgent ? 'agent' : 'rules',
    ...(byAgent ? { model: options.model } : {}),
    packagingHash: hashPackagingInputs(inputs),
    inputs,
    ...(byAgent && validated ? { groups: validated.groups } : {}),
    ...(shotNotes ? { shotNotes } : {}),
    createdAt: new Date().toISOString(),
    ...(byAgent && validated?.splits.length ? { splits: validated.splits } : {}),
    notes: [
      ...notes,
      ...(byAgent && validated ? validated.notes : []),
      ...(shotNotes ? unusedShotNotes(plan, shots, shotNotes, series) : []),
      ...(byAgent && validated ? validated.agentNotes : []),
      ...ledger.risks,
    ],
    ...(problems.length ? { problems } : {}),
  };
  const audits = await auditPlan(series, shots, plan, ledger, { quote: options.quote, sceneDir: options.sceneDir });
  return { plan, ledger, audits, ...(answer !== undefined ? { answer } : {}) };
}

/** What `plan-generations` saves: the plan with `planning`, its audit, and the agent's answer as it came back. */
export interface GenerationPlanProposal extends GenerationPlan {
  audits?: UnitAudit[];
  agentAnswer?: unknown;
}

export function toProposal(result: PlanGenerationsResult): GenerationPlanProposal {
  return { ...result.plan, audits: result.audits, ...(result.answer !== undefined ? { agentAnswer: result.answer } : {}) };
}

/** The audit saved with a proposal (empty for a hand-made or older file). */
export function proposalAudits(saved: GenerationPlan): UnitAudit[] {
  const audits = (saved as GenerationPlanProposal).audits;
  return Array.isArray(audits) ? audits : [];
}

// ---- What a person reads ----------------------------------------------------

/**
 * The plan as a person reads it (the CLI and `generation-plan.proposed.md`).
 * With `project` and `episode`, suggested commands can be pasted as they are.
 */
export function describeGenerationPlan(
  result: Pick<PlanGenerationsResult, 'plan' | 'audits'>,
  context: { project?: string; episode?: number } = {},
): string[] {
  const { plan, audits } = result;
  const planning = plan.planning;
  const ref = `${context.project ? `-p ${context.project} ` : ''}-e ${context.episode ?? '<n>'}`;
  const lines: string[] = [];
  const by = planning?.by === 'agent' ? `the packaging agent (${planning.model})` : 'rules';
  const approval = planning?.approved
    ? `approved by ${planning.approvedBy ?? 'a person'}${planning.approvedAt ? ` (${planning.approvedAt})` : ''}`
    : 'not approved yet';
  lines.push(`Generation plan: ${plan.units.length} unit(s), planned by ${by}, ${approval}.`);
  for (const problem of planning?.problems ?? []) lines.push(`  ✗ ${problem}${planning?.by === 'rules' ? ' (planned by rules instead)' : ''}`);
  let quoted = 0;
  let quotedSkipped = 0;
  plan.units.forEach((unit, index) => {
    const audit = audits[index]?.unitId === unit.unitId ? audits[index] : undefined;
    const skipped = Boolean(audit?.onDisk && audit.onDisk.of > 0 && audit.onDisk.clips === audit.onDisk.of);
    if (audit?.costUsd !== undefined) {
      quoted += audit.costUsd;
      if (skipped) quotedSkipped += audit.costUsd;
    }
    const parts = [
      `shots ${(audit?.shots ?? unit.shotNumbers.map(String)).join(', ')}`,
      unit.duration,
      ...(audit?.places.length ? [audit.places.join(' → ')] : []),
      ...(audit?.references !== undefined ? [`${audit.references}/${audit.budget} refs`] : []),
      ...(audit?.costUsd !== undefined ? [`$${audit.costUsd.toFixed(2)}`] : []),
    ];
    lines.push(`  ${unit.unitId} (${unit.unitType}${audit ? `, ${audit.model}` : ''}): ${parts.join(', ')}`);
    const reason = unit.decisionReasons.find(r => r.startsWith('planner: ')) ?? unit.decisionReasons[0];
    if (reason) lines.push(`      why: ${reason.replace(/^planner: /, '')}`);
    for (const [shot, note] of Object.entries(unit.shotNotes ?? {})) lines.push(`      shot ${shot} note: ${note}`);
    for (const item of audit?.carriesOut ?? []) lines.push(`      ⚠ carries across a cut between generations: ${item}`);
    for (const finding of audit?.findings ?? []) lines.push(`      ${finding}`);
    for (const drop of audit?.dropped ?? []) lines.push(`      reference dropped: ${drop}`);
    if (audit?.onDisk && audit.onDisk.clips > 0) {
      // --retake takes shot numbers; a number covers its suffixed inserts.
      const retake = `generate-videos ${ref} --retake ${[...new Set(unit.shotNumbers)].join(',')}`;
      if (skipped && (unit.unitType === 'single' || audit.onDisk.master)) {
        lines.push('      on disk: rendered; generate-videos skips it and bills nothing');
      } else if (skipped) {
        lines.push(`      on disk: every clip, but no ${unit.outputFile}: generate-videos keeps the cuts and bills nothing, and qa-videos checks the unit from its clips. To render shots ${audit.shots.join(', ')} again as one generation: ${retake}`);
      } else {
        lines.push(`      on disk: ${audit.onDisk.clips} of ${audit.onDisk.of} clips: the unit renders whole, and those clips are archived (-vN) and cut again`);
      }
    }
  });
  for (const split of planning?.splits ?? []) lines.push(`  split after shot ${split.after}: ${split.reason || '(no reason given)'}`);
  for (const note of planning?.notes ?? []) lines.push(`  note: ${note}`);
  if (quoted > 0) {
    lines.push(`  Quoted: $${(quoted - quotedSkipped).toFixed(2)} for the units that would render${quotedSkipped > 0 ? ` ($${quotedSkipped.toFixed(2)} more for units already on disk, if re-taken)` : ''}.`);
  }
  return lines;
}

/** `generation-plan.proposed.md`. */
export function planMarkdown(episode: number, lines: string[]): string {
  return `# Generation plan, episode ${episode}\n\n${lines.map(line => (line.startsWith('      ') ? `  - ${line.trim()}` : line.startsWith('  ') ? `- ${line.trim()}` : line)).join('\n')}\n`;
}
