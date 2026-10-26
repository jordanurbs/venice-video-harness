// ---------------------------------------------------------------------------
// Generation plan approval binding (`plan-generations --approve`).
//
// `plan-generations` writes its plan as a proposal
// (`generation-plan.proposed.json` and `.md`) that only it ever writes, so a
// render never overwrites it. A person approves the proposal; the approval is
// bound to what decided the packaging (`packagingInputs`): what the planner
// of the project's route reads (the shots' ids, order, length and place, what
// keeps a shot alone, a staging ref among it, and the route's own settings
// and fields), what the packaging agent reads, and the description of each
// shot a plan's note amends. A shot's view, dialogue, blocking, `stagedOn` and
// `endState` change its prompt line, not its packaging, so editing them keeps
// the approval.
//
// `generate-videos` renders an approved proposal only while those inputs hash
// the same and the planner still packages the shots exactly as approved. The
// plan it renders is rebuilt from the approved packaging with the run's
// settings, so models and frame strategies are current. When anything that
// decides the packaging changed, it refuses the run and says what changed
// (`--ignore-plan` renders by rules for one run instead), like the QA binding
// of rule 63. A proposal no one approved blocks it too, so a run never
// bypasses one without saying so.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EpisodeScript,
  GenerationPackagingInputs,
  GenerationPlan,
  GenerationPlanning,
  GenerationUnit,
  SeriesState,
} from 'venice-video-harness/core/series/types.js';
import {
  resolveMontageGrammar,
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
  resolveMontageMode,
  resolveMontageModel,
} from 'venice-video-harness/core/series/types.js';
import { buildGenerationPlan, buildGenerationPlanFromGroups, mustRenderAsExactLipSync, parseShotDuration } from './generation-planner.js';
import { shotIdOf } from './shot-paths.js';

export const PLAN_PROPOSAL_FILE = 'generation-plan.proposed.json';
export const PLAN_PROPOSAL_NOTES_FILE = 'generation-plan.proposed.md';

// ---- What decides the packaging ---------------------------------------------

const sha16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * What decides the packaging, read the way the project's route reads it:
 *   - every route: each shot's id, length and place, and what renders a shot
 *     alone (an insert, a title card, `mustStaySingle`, a staging ref, exact
 *     lip-sync);
 *   - the montage route: its grammar, model, ceiling and floor; with the
 *     shot-list grammar also each shot's `continuity.from` and cast, which
 *     the grouping and the packaging agent read;
 *   - the standard route: each shot's cast (multi-shot windows need it to
 *     overlap), an establishing shot and `allowMultiShot`.
 * With `shotNotes` (an agent plan's), the description of each noted shot: the
 * note amends it, so rewriting the shot stales the plan.
 */
export function packagingInputs(
  script: Pick<EpisodeScript, 'shots'>,
  series: Pick<SeriesState, 'videoDefaults'>,
  shotNotes?: Record<string, string>,
): GenerationPackagingInputs {
  const videoDefaults = series.videoDefaults;
  const montage = resolveMontageMode(videoDefaults);
  const grammar = montage ? resolveMontageGrammar(videoDefaults) : undefined;
  const shotList = grammar === 'shots';
  return {
    settings: montage
      ? {
        montage,
        grammar,
        montageModel: resolveMontageModel(videoDefaults),
        maxSec: resolveMontageMaxDurationSec(videoDefaults),
        minSec: resolveMontageMinDurationSec(videoDefaults),
      }
      : { montage },
    shots: script.shots.map(shot => {
      const id = shotIdOf(shot);
      return {
        id,
        seconds: parseShotDuration(shot.duration),
        location: shot.location ?? null,
        insert: shot.type === 'insert',
        ...(montage ? {} : { establishing: shot.type === 'establishing' }),
        ...(!montage || shotList ? { characters: [...new Set((shot.characters ?? []).map(name => name.toUpperCase()))].sort() } : {}),
        ...(shotList ? { from: shot.continuity?.from ?? null } : {}),
        // A staged shot renders alone whatever its mustStaySingle says.
        mustStaySingle: shot.mustStaySingle === true || Boolean(shot.stagingRef),
        ...(montage ? {} : { allowMultiShot: shot.allowMultiShot !== false }),
        staged: shot.stagingRef?.use ?? null,
        titleCard: /title card/i.test(shot.description ?? ''),
        lipSync: mustRenderAsExactLipSync(shot, videoDefaults),
        ...(shotNotes?.[id] ? { description: sha16((shot.description ?? '').replace(/\s+/g, ' ').trim()) } : {}),
      };
    }),
  };
}

export function hashPackagingInputs(inputs: GenerationPackagingInputs): string {
  return sha16(JSON.stringify(inputs));
}

const onOff = (value: boolean): string => (value ? 'on' : 'off');

/** What changed between the inputs a plan was made from and today's, one line each. */
export function describePackagingChanges(
  before: GenerationPackagingInputs | undefined,
  after: GenerationPackagingInputs,
): string[] {
  if (!before?.settings || !Array.isArray(before.shots)) {
    return ['the plan does not record what decided its packaging'];
  }
  const changes: string[] = [];
  const was = before.settings;
  const now = after.settings;
  if (was.montage !== now.montage) changes.push(`montage mode: ${onOff(was.montage)} → ${onOff(now.montage)} (videoDefaults.montageMode, or --no-montage for one run)`);
  // The montage settings are compared on the montage route only.
  const both = (key: keyof GenerationPackagingInputs['settings']): boolean => key in was && key in now;
  if (both('grammar') && was.grammar !== now.grammar) changes.push(`montage grammar: ${was.grammar} → ${now.grammar} (videoDefaults.montageGrammar)`);
  if (both('montageModel') && was.montageModel !== now.montageModel) changes.push(`montage model: ${was.montageModel} → ${now.montageModel} (videoDefaults.montageModel)`);
  if (both('maxSec') && was.maxSec !== now.maxSec) changes.push(`montage ceiling: ${was.maxSec} s → ${now.maxSec} s (videoDefaults.montageMaxDurationSec, or the montage model's own ceiling)`);
  if (both('minSec') && was.minSec !== now.minSec) changes.push(`montage floor: ${was.minSec} s → ${now.minSec} s (the montage model's shortest duration)`);

  const idsBefore = before.shots.map(shot => shot.id);
  const idsAfter = after.shots.map(shot => shot.id);
  for (const id of idsAfter.filter(id => !idsBefore.includes(id))) changes.push(`shot ${id} is new`);
  for (const id of idsBefore.filter(id => !idsAfter.includes(id))) changes.push(`shot ${id} is gone`);
  const keptBefore = idsBefore.filter(id => idsAfter.includes(id));
  const keptAfter = idsAfter.filter(id => idsBefore.includes(id));
  if (keptBefore.join('|') !== keptAfter.join('|')) changes.push('the shots are in a different order');

  const old = new Map(before.shots.map(shot => [shot.id, shot]));
  for (const shot of after.shots) {
    const prior = old.get(shot.id);
    if (!prior) continue;
    const at = `shot ${shot.id}:`;
    // A field is compared when both sides read it (the route decides which do).
    const has = (key: keyof typeof shot): boolean => key in prior && key in shot;
    if (prior.seconds !== shot.seconds) changes.push(`${at} ${prior.seconds} s → ${shot.seconds} s`);
    if (prior.location !== shot.location) changes.push(`${at} location ${prior.location ?? 'none'} → ${shot.location ?? 'none'}`);
    if (has('insert') && prior.insert !== shot.insert) changes.push(`${at} ${shot.insert ? 'now' : 'no longer'} an insert`);
    if (has('establishing') && prior.establishing !== shot.establishing) changes.push(`${at} ${shot.establishing ? 'now' : 'no longer'} an establishing shot`);
    if (has('characters') && (prior.characters ?? []).join(', ') !== (shot.characters ?? []).join(', ')) {
      changes.push(`${at} cast ${(prior.characters ?? []).join(', ') || 'none'} → ${(shot.characters ?? []).join(', ') || 'none'}`);
    }
    if (has('from') && prior.from !== shot.from) changes.push(`${at} continuity ${prior.from ?? 'unmarked'} → ${shot.from ?? 'unmarked'}`);
    const pickChanged = has('staged') && prior.staged !== shot.staged;
    if (pickChanged) {
      changes.push(shot.staged
        ? `${at} ${prior.staged ? `staging ref now used as a ${shot.staged}` : `staging ref picked (${shot.staged}, stage-ref): it renders alone`}`
        : `${at} staging ref cleared`);
    }
    // A pick sets mustStaySingle and a clear restores it: said once, above.
    if (prior.mustStaySingle !== shot.mustStaySingle && !pickChanged) changes.push(`${at} mustStaySingle ${prior.mustStaySingle} → ${shot.mustStaySingle}`);
    if (has('allowMultiShot') && prior.allowMultiShot !== shot.allowMultiShot) changes.push(`${at} allowMultiShot ${prior.allowMultiShot} → ${shot.allowMultiShot}`);
    if (prior.titleCard !== shot.titleCard) changes.push(`${at} ${shot.titleCard ? 'now' : 'no longer'} a title card`);
    if (prior.lipSync !== shot.lipSync) {
      changes.push(shot.lipSync
        ? `${at} now renders as an exact lip-sync clip, on its own (audioStrategy "lip-sync", its dialogue, motion and faceVisible)`
        : `${at} no longer renders as an exact lip-sync clip`);
    }
    if (has('description') && prior.description !== shot.description) {
      changes.push(`${at} description rewritten, and the plan's shot note for it was written for the old one`);
    }
  }
  return changes;
}

// ---- The approval check -------------------------------------------------------

export type PlanApproval =
  /** No proposal: generate-videos plans by rules, as it always did. */
  | { status: 'none' }
  /** A proposal no one approved. `changes`: what moved since it was made. */
  | { status: 'unapproved'; proposal: GenerationPlan; changes: string[] }
  /** An approved proposal that no longer applies. */
  | { status: 'stale'; proposal: GenerationPlan; changes: string[] }
  /** An approved proposal that applies: `plan` is it, rebuilt with the run's settings. */
  | { status: 'approved'; proposal: GenerationPlan; plan: GenerationPlan };

/** Rebuild a proposal's packaging with the run's settings: agent plans from their groups, rules plans by rules. */
export function rebuildPlannedPlan(
  planning: GenerationPlanning,
  script: EpisodeScript,
  series: Pick<SeriesState, 'videoDefaults'>,
): GenerationPlan {
  if (planning.by === 'agent') {
    return buildGenerationPlanFromGroups(script, series, { groups: planning.groups ?? [], shotNotes: planning.shotNotes });
  }
  return buildGenerationPlan(script, series);
}

function unitLabel(unit: Pick<GenerationUnit, 'unitId' | 'unitType' | 'shotNumbers'>): string {
  return `${unit.unitId} (${unit.unitType}, shots ${unit.shotNumbers.join(', ')})`;
}

/** The first unit where two plans package the shots differently, or null when they agree. */
export function packagingDifference(approved: GenerationUnit[], rebuilt: GenerationUnit[]): string | null {
  const count = Math.max(approved.length, rebuilt.length);
  for (let i = 0; i < count; i++) {
    const a = approved[i];
    const b = rebuilt[i];
    if (a && b && a.unitId === b.unitId && a.unitType === b.unitType && a.shotNumbers.join(',') === b.shotNumbers.join(',')) continue;
    return `the planner now packages the shots differently: ${a ? unitLabel(a) : 'no unit'} was approved, ${b ? unitLabel(b) : 'no unit'} would render`;
  }
  return null;
}

/**
 * Does the saved proposal apply to this script with these settings? An
 * approved one applies only while what decides its packaging hashes the same
 * and the planner still builds exactly the approved units from it.
 */
export function checkPlanApproval(
  saved: GenerationPlan | null | undefined,
  script: EpisodeScript,
  series: Pick<SeriesState, 'videoDefaults'>,
): PlanApproval {
  const planning = saved?.planning;
  if (!saved || !planning) return { status: 'none' };
  const current = packagingInputs(script, series, planning.shotNotes);
  const unchanged = planning.packagingHash === hashPackagingInputs(current);
  const changes = unchanged ? [] : describePackagingChanges(planning.inputs, current);
  if (!unchanged && changes.length === 0) changes.push('what decides the packaging changed since the plan was made');
  let plan: GenerationPlan | undefined;
  if (changes.length === 0) {
    try {
      plan = rebuildPlannedPlan(planning, script, series);
      const difference = packagingDifference(Array.isArray(saved.units) ? saved.units : [], plan.units);
      if (difference) changes.push(difference);
    } catch (err) {
      changes.push(`the plan cannot be rebuilt: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  if (!planning.approved) return { status: 'unapproved', proposal: saved, changes };
  if (changes.length > 0 || !plan) return { status: 'stale', proposal: saved, changes };
  plan.planning = planning;
  return { status: 'approved', proposal: saved, plan };
}

/**
 * What an edit to the script made outside `plan-generations` (a `stage-ref`
 * pick or clear) did to the episode's plan proposal: lines for a person when
 * the edit made an approved plan stale or valid again (or a waiting proposal
 * out of date or current again), and the command generate-videos needs next.
 * `ref` is the `-p … -e …` part of a command.
 */
export function describePlanAfterEdit(before: PlanApproval, after: PlanApproval, ref: string): { lines: string[]; next: string } {
  const by = (approval: PlanApproval) => ('proposal' in approval ? approval.proposal.planning?.approvedBy ?? 'a person' : 'a person');
  const planAgain = `plan-generations ${ref}`;
  const lines: string[] = [];
  if (before.status === 'approved' && after.status === 'stale') {
    lines.push(`This makes the generation plan approved by ${by(after)} out of date (${after.changes.join('; ')}). generate-videos refuses to run until the episode is planned again and the new plan approved (--ignore-plan renders by rules for one run).`);
  } else if (before.status === 'stale' && after.status === 'approved') {
    lines.push(`The generation plan approved by ${by(after)} applies again: generate-videos renders it.`);
  } else if (before.status === 'unapproved' && after.status === 'unapproved') {
    if (before.changes.length === 0 && after.changes.length > 0) {
      lines.push(`This makes the generation plan proposal waiting for approval out of date (${after.changes.join('; ')}): plan again before approving it.`);
    } else if (before.changes.length > 0 && after.changes.length === 0) {
      lines.push('The generation plan proposal waiting for approval matches the script again: approve it to render it.');
    }
  }
  if (after.status === 'stale' || (after.status === 'unapproved' && after.changes.length > 0)) return { lines, next: planAgain };
  if (after.status === 'unapproved') return { lines, next: `${planAgain} --approve "<your name>"` };
  return { lines, next: `generate-videos ${ref}` };
}

// ---- The proposal on disk ------------------------------------------------------

export function planProposalPath(episodeDir: string): string {
  return join(episodeDir, PLAN_PROPOSAL_FILE);
}

export function planProposalNotesPath(episodeDir: string): string {
  return join(episodeDir, PLAN_PROPOSAL_NOTES_FILE);
}

function parseProposal(raw: string, path: string): GenerationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} could not be parsed (${(err as Error).message.split('\n')[0]})`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as GenerationPlan).units)) {
    throw new Error(`${path} is not a generation plan`);
  }
  return parsed as GenerationPlan;
}

/** The episode's plan proposal, or null when there is none. Throws when the file cannot be read as a plan. */
export async function loadPlanProposal(episodeDir: string): Promise<GenerationPlan | null> {
  const path = planProposalPath(episodeDir);
  if (!existsSync(path)) return null;
  return parseProposal(await readFile(path, 'utf-8'), path);
}

/** `loadPlanProposal` for synchronous callers (the status reporter). */
export function loadPlanProposalSync(episodeDir: string): GenerationPlan | null {
  const path = planProposalPath(episodeDir);
  if (!existsSync(path)) return null;
  return parseProposal(readFileSync(path, 'utf-8'), path);
}

/**
 * Move the current proposal aside (`generation-plan.proposed-vN.json`) before
 * a new one replaces it: the model call that made it was paid for. Returns
 * the archive path, or null when there was nothing to archive.
 */
export async function archivePlanProposal(episodeDir: string): Promise<string | null> {
  const path = planProposalPath(episodeDir);
  if (!existsSync(path)) return null;
  let version = 1;
  let target = join(episodeDir, `generation-plan.proposed-v${version}.json`);
  while (existsSync(target)) {
    version += 1;
    target = join(episodeDir, `generation-plan.proposed-v${version}.json`);
  }
  await rename(path, target);
  return target;
}

/**
 * Write the proposal and its notes for a person (`generation-plan.proposed.json`
 * / `.md`). The JSON is the plan with `planning`, plus anything the planner
 * keeps beside it (the per-unit audit, the agent's answer).
 */
export async function savePlanProposal(
  episodeDir: string,
  proposal: GenerationPlan,
  markdown: string,
): Promise<{ json: string; md: string }> {
  const json = planProposalPath(episodeDir);
  const md = planProposalNotesPath(episodeDir);
  await writeFile(json, JSON.stringify(proposal, null, 2), 'utf-8');
  await writeFile(md, markdown, 'utf-8');
  return { json, md };
}
