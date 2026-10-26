// ---------------------------------------------------------------------------
// Generation plan approval binding (`plan-generations --approve`).
//
// `plan-generations` writes its plan as a proposal
// (`generation-plan.proposed.json` and `.md`) that only it ever writes, so a
// render never overwrites it. A person approves the proposal; the approval is
// bound to what decided the packaging (`packagingInputs`): the shots' ids,
// order, length, type, place, view, cast and continuity, the flags that keep a
// shot alone, and the series settings of the montage lane. A shot's dialogue,
// blocking, `stagedOn` and `endState` change its prompt line, not its
// packaging, so editing them keeps the approval.
//
// `generate-videos` renders an approved proposal only while those inputs hash
// the same and the planner still packages the shots exactly as approved. The
// plan it renders is rebuilt from the approved packaging with the run's
// settings, so models and frame strategies are current. When anything that
// decides the packaging changed, it refuses the run and says what changed
// (`--ignore-plan` renders by rules for one run instead), like the QA binding
// of rule 63.
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

export function packagingInputs(
  script: Pick<EpisodeScript, 'shots'>,
  series: Pick<SeriesState, 'videoDefaults'>,
): GenerationPackagingInputs {
  const videoDefaults = series.videoDefaults;
  return {
    settings: {
      montage: resolveMontageMode(videoDefaults),
      grammar: resolveMontageGrammar(videoDefaults),
      montageModel: resolveMontageModel(videoDefaults),
      maxSec: resolveMontageMaxDurationSec(videoDefaults),
      minSec: resolveMontageMinDurationSec(videoDefaults),
    },
    shots: script.shots.map(shot => ({
      id: shotIdOf(shot),
      seconds: parseShotDuration(shot.duration),
      type: shot.type ?? '',
      location: shot.location ?? null,
      plateView: shot.plateView ?? null,
      characters: (shot.characters ?? []).map(name => name.toUpperCase()),
      from: shot.continuity?.from ?? null,
      mustStaySingle: shot.mustStaySingle === true,
      allowMultiShot: shot.allowMultiShot !== false,
      titleCard: /title card/i.test(shot.description ?? ''),
      lipSync: mustRenderAsExactLipSync(shot, videoDefaults),
    })),
  };
}

export function hashPackagingInputs(inputs: GenerationPackagingInputs): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16);
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
  if (was.grammar !== now.grammar) changes.push(`montage grammar: ${was.grammar} → ${now.grammar} (videoDefaults.montageGrammar)`);
  if (was.montageModel !== now.montageModel) changes.push(`montage model: ${was.montageModel} → ${now.montageModel} (videoDefaults.montageModel)`);
  if (was.maxSec !== now.maxSec) changes.push(`montage ceiling: ${was.maxSec} s → ${now.maxSec} s (videoDefaults.montageMaxDurationSec, or the montage model's own ceiling)`);
  if (was.minSec !== now.minSec) changes.push(`montage floor: ${was.minSec} s → ${now.minSec} s (the montage model's shortest duration)`);

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
    if (prior.seconds !== shot.seconds) changes.push(`${at} ${prior.seconds} s → ${shot.seconds} s`);
    if (prior.type !== shot.type) changes.push(`${at} type ${prior.type || 'none'} → ${shot.type || 'none'}`);
    if (prior.location !== shot.location) changes.push(`${at} location ${prior.location ?? 'none'} → ${shot.location ?? 'none'}`);
    if (prior.plateView !== shot.plateView) changes.push(`${at} plateView ${prior.plateView ?? 'none'} → ${shot.plateView ?? 'none'}`);
    if ((prior.characters ?? []).join(', ') !== shot.characters.join(', ')) {
      changes.push(`${at} cast ${(prior.characters ?? []).join(', ') || 'none'} → ${shot.characters.join(', ') || 'none'}`);
    }
    if (prior.from !== shot.from) changes.push(`${at} continuity ${prior.from ?? 'unmarked'} → ${shot.from ?? 'unmarked'}`);
    if (prior.mustStaySingle !== shot.mustStaySingle) changes.push(`${at} mustStaySingle ${prior.mustStaySingle} → ${shot.mustStaySingle}`);
    if (prior.allowMultiShot !== shot.allowMultiShot) changes.push(`${at} allowMultiShot ${prior.allowMultiShot} → ${shot.allowMultiShot}`);
    if (prior.titleCard !== shot.titleCard) changes.push(`${at} ${shot.titleCard ? 'now' : 'no longer'} a title card`);
    if (prior.lipSync !== shot.lipSync) {
      changes.push(shot.lipSync
        ? `${at} now renders as an exact lip-sync clip, on its own (audioStrategy "lip-sync", its dialogue, motion and faceVisible)`
        : `${at} no longer renders as an exact lip-sync clip`);
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
  const current = packagingInputs(script, series);
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
