import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EpisodeScript,
  GenerationPlan,
  GenerationUnit,
  ShotScript,
} from '../series/types.js';
import { KLING_MULTISHOT_MODEL } from '../series/types.js';

const CHAIN_TRANSITIONS = new Set([
  'DISSOLVE', 'MATCH CUT', 'MORPH', 'WIPE', 'CROSSFADE', 'FADE',
]);

const END_FRAME_TRANSITIONS = new Set([
  'DISSOLVE', 'MATCH CUT', 'MORPH', 'WIPE', 'CROSSFADE',
]);

const ACTION_CONNECTORS = [' then ', ' suddenly ', ' while ', ' after ', ' before ', ' as '];

export function parseShotDuration(duration: string): number {
  const match = duration.match(/^(\d+)s$/);
  return match ? parseInt(match[1], 10) : 5;
}

function formatShotDuration(seconds: number): string {
  return `${Math.max(1, Math.round(seconds))}s`;
}

function padShotNumber(shotNumber: number): string {
  return String(shotNumber).padStart(3, '0');
}

function isTitleLikeInsert(shot: ShotScript): boolean {
  return shot.type === 'insert' || /title card/i.test(shot.description);
}

function isEstablishingShot(shot: ShotScript): boolean {
  return shot.type === 'establishing' || shot.characters.length === 0;
}

function isSceneBoundary(previous: ShotScript | undefined, current: ShotScript): boolean {
  if (!previous) return true;
  if (isEstablishingShot(current)) return true;
  if (current.characters.length === 0 && previous.characters.length > 0) return true;
  const prevChars = new Set(previous.characters.map(n => n.toUpperCase()));
  const currChars = new Set(current.characters.map(n => n.toUpperCase()));
  const overlap = [...currChars].some(c => prevChars.has(c));
  if (!overlap && currChars.size > 0 && prevChars.size > 0) return true;
  return false;
}

function isIdentitySensitive(shot: ShotScript): boolean {
  return shot.type === 'close-up' || shot.type === 'reaction';
}

function hasNewCharacters(previous: ShotScript | undefined, current: ShotScript): boolean {
  if (!previous) return false;
  const prev = new Set(previous.characters.map(name => name.toUpperCase()));
  return current.characters.some(name => !prev.has(name.toUpperCase()));
}

function hasSameCharacterCore(shots: ShotScript[]): boolean {
  const unique = new Set(
    shots.flatMap(shot => shot.characters.map(name => name.toUpperCase())),
  );
  return unique.size > 0 && unique.size <= 2;
}

function getActionDensityScore(shot: ShotScript): number {
  const lower = shot.description.toLowerCase();
  let score = 1;
  score += ACTION_CONNECTORS.reduce((count, token) => count + (lower.includes(token) ? 1 : 0), 0);
  score += (lower.match(/,/g) || []).length >= 3 ? 1 : 0;
  return score;
}

function isDialogueSequence(shots: ShotScript[]): boolean {
  const dialogueCount = shots.filter(shot => shot.dialogue).length;
  return dialogueCount >= 1
    && hasSameCharacterCore(shots)
    && shots.every(shot => !isTitleLikeInsert(shot));
}

function isShortActionChain(shots: ShotScript[]): boolean {
  if (shots.some(shot => shot.type !== 'action')) return false;
  if (!hasSameCharacterCore(shots)) return false;
  const density = shots.reduce((sum, shot) => sum + getActionDensityScore(shot), 0);
  return density <= shots.length * 2 + 1;
}

function chooseStartFrameStrategy(
  previousShot: ShotScript | undefined,
  firstShot: ShotScript,
): GenerationUnit['startFrameStrategy'] {
  if (!previousShot) return 'panel';
  if (firstShot.continuityPriority === 'identity') return 'panel';
  if (isSceneBoundary(previousShot, firstShot)) return 'panel';
  if (hasNewCharacters(previousShot, firstShot)) return 'panel';
  if (isIdentitySensitive(firstShot) && firstShot.continuityPriority !== 'continuity') return 'panel';
  return CHAIN_TRANSITIONS.has(previousShot.transition.toUpperCase())
    ? 'previous-last-frame'
    : 'panel';
}

function chooseEndFrameStrategy(
  lastShot: ShotScript,
  nextShot: ShotScript | undefined,
): GenerationUnit['endFrameStrategy'] {
  if (!nextShot) return 'natural';
  if (hasNewCharacters(lastShot, nextShot)) return 'natural';
  if (isTitleLikeInsert(nextShot)) return 'natural';
  return END_FRAME_TRANSITIONS.has(lastShot.transition.toUpperCase())
    ? 'next-panel-target'
    : 'natural';
}

function buildSingleUnit(
  shot: ShotScript,
  previousShot: ShotScript | undefined,
  nextShot: ShotScript | undefined,
): GenerationUnit {
  const reasons = ['standalone render'];
  if (shot.mustStaySingle) reasons.push('forced single via script override');
  if (isTitleLikeInsert(shot)) reasons.push('insert or title card');
  if (isIdentitySensitive(shot)) reasons.push('identity-sensitive framing');

  return {
    unitId: `unit-${padShotNumber(shot.shotNumber)}`,
    unitType: 'single',
    shotNumbers: [shot.shotNumber],
    outputFile: `shot-${padShotNumber(shot.shotNumber)}.mp4`,
    model: shot.videoModel,
    duration: shot.duration,
    startFrameStrategy: chooseStartFrameStrategy(previousShot, shot),
    endFrameStrategy: chooseEndFrameStrategy(shot, nextShot),
    decisionReasons: reasons,
    fallbackToSingles: false,
  };
}

function canUseMultiShotWindow(window: ShotScript[]): { ok: boolean; reasons: string[] } {
  if (window.length < 2) return { ok: false, reasons: ['window too short'] };
  if (window.some(shot => shot.mustStaySingle || shot.allowMultiShot === false)) {
    return { ok: false, reasons: ['script override blocks grouping'] };
  }
  if (window.some(isTitleLikeInsert)) {
    return { ok: false, reasons: ['insert or title shot in window'] };
  }
  if (isEstablishingShot(window[0])) {
    return { ok: false, reasons: ['window starts with establishing/empty shot -- keep separate'] };
  }
  if (window.some(isEstablishingShot)) {
    return { ok: false, reasons: ['establishing/empty shot mixed into dialogue/action window'] };
  }

  const totalDuration = window.reduce((sum, shot) => sum + parseShotDuration(shot.duration), 0);
  if (totalDuration > 15) {
    return { ok: false, reasons: ['window exceeds 15 second Kling limit'] };
  }

  if (isDialogueSequence(window)) {
    return { ok: true, reasons: ['dialogue exchange fits Kling multi-shot'] };
  }

  if (isShortActionChain(window)) {
    return { ok: true, reasons: ['short action chain fits Kling multi-shot'] };
  }

  const hasMatchLikeTransition = window.some(shot =>
    ['MATCH CUT', 'DISSOLVE', 'CROSSFADE'].includes(shot.transition.toUpperCase()),
  );
  if (hasMatchLikeTransition && hasSameCharacterCore(window)) {
    return { ok: true, reasons: ['match-like transition chain fits Kling multi-shot'] };
  }

  return { ok: false, reasons: ['window does not match supported multi-shot patterns'] };
}

function selectMultiShotWindow(shots: ShotScript[], startIdx: number): { length: number; reasons: string[] } | null {
  const maxWindow = Math.min(3, shots.length - startIdx);

  for (let length = maxWindow; length >= 2; length--) {
    const window = shots.slice(startIdx, startIdx + length);
    const verdict = canUseMultiShotWindow(window);
    if (verdict.ok) {
      return { length, reasons: verdict.reasons };
    }
  }

  return null;
}

function buildMultiShotUnit(
  shots: ShotScript[],
  previousShot: ShotScript | undefined,
  nextShot: ShotScript | undefined,
  reasons: string[],
): GenerationUnit {
  const first = shots[0];
  const last = shots[shots.length - 1];
  const durationSec = shots.reduce((sum, shot) => sum + parseShotDuration(shot.duration), 0);
  const unitId = `unit-${padShotNumber(first.shotNumber)}-${padShotNumber(last.shotNumber)}`;

  return {
    unitId,
    unitType: 'kling-multishot',
    shotNumbers: shots.map(shot => shot.shotNumber),
    outputFile: `${unitId}.mp4`,
    model: KLING_MULTISHOT_MODEL,
    duration: formatShotDuration(durationSec),
    startFrameStrategy: chooseStartFrameStrategy(previousShot, first),
    endFrameStrategy: chooseEndFrameStrategy(last, nextShot),
    decisionReasons: reasons,
    fallbackToSingles: false,
  };
}

export function buildGenerationPlan(script: EpisodeScript): GenerationPlan {
  const units: GenerationUnit[] = [];
  let index = 0;

  while (index < script.shots.length) {
    const previousShot = index > 0 ? script.shots[index - 1] : undefined;
    const currentShot = script.shots[index];
    const multiWindow = selectMultiShotWindow(script.shots, index);

    if (multiWindow) {
      const window = script.shots.slice(index, index + multiWindow.length);
      const nextShot = script.shots[index + multiWindow.length];
      units.push(buildMultiShotUnit(window, previousShot, nextShot, multiWindow.reasons));
      index += multiWindow.length;
      continue;
    }

    const nextShot = script.shots[index + 1];
    units.push(buildSingleUnit(currentShot, previousShot, nextShot));
    index += 1;
  }

  return {
    episode: script.episode,
    generatedAt: new Date().toISOString(),
    units,
  };
}

export async function saveGenerationPlan(episodeDir: string, plan: GenerationPlan): Promise<string> {
  const planPath = join(episodeDir, 'generation-plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  return planPath;
}

export async function loadGenerationPlan(episodeDir: string): Promise<GenerationPlan | null> {
  const planPath = join(episodeDir, 'generation-plan.json');
  if (!existsSync(planPath)) return null;
  const raw = await readFile(planPath, 'utf-8');
  return JSON.parse(raw) as GenerationPlan;
}
