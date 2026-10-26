// ---------------------------------------------------------------------------
// Renders in flight under another packaging of the shots (rule 43).
//
// The pending-job registry keys a queued render by its output path, and a
// unit's master is named after its scene and its first and last shot, so the
// same shots packaged another way (the rules planner's units, or an approved
// generation plan's) queue under other names. A run with one packaging never
// re-attaches to a render queued with the other: it renders those shots again
// and bills them twice. generate-videos refuses that before the API key is
// read, and `status` says so (rule 45).
// ---------------------------------------------------------------------------

import { dirname, join, resolve } from 'node:path';
import type { GenerationPlan, ShotScript } from 'venice-video-harness/core/series/types.js';
import { isStale, type PendingJob } from '../venice/job-store.js';
import { resolveUnitShots } from './generation-planner.js';
import { shotIdOf, shotKey } from './shot-paths.js';

/**
 * Every output a render of this plan may queue, as absolute paths: the master
 * of each montage and multi-shot unit, and each single's own clip (an
 * insert's keyed with its suffix) and its keyframe pass.
 */
export function planQueueOutputs(sceneDir: string, plan: Pick<GenerationPlan, 'units'>, shots: ShotScript[]): Set<string> {
  const outputs = new Set<string>();
  const unitShots = resolveUnitShots(plan, shots);
  plan.units.forEach((unit, index) => {
    if (unit.unitType !== 'single') {
      outputs.add(resolve(join(sceneDir, unit.outputFile)));
      return;
    }
    for (const shot of unitShots[index]) {
      const clip = resolve(join(sceneDir, `shot-${shotKey(shotIdOf(shot))}.mp4`));
      outputs.add(clip);
      outputs.add(clip.replace(/\.mp4$/, '-r2v-keyframe.mp4'));
    }
  });
  return outputs;
}

/**
 * Video renders recorded in flight for this scene folder that a render of
 * `plan` would never collect. Jobs past the queue's lifetime are left out:
 * Venice no longer has them.
 */
export function inFlightOutsidePlan(
  jobs: PendingJob[],
  sceneDir: string,
  plan: Pick<GenerationPlan, 'units'>,
  shots: ShotScript[],
  now = Date.now(),
): PendingJob[] {
  const folder = resolve(sceneDir);
  const planned = planQueueOutputs(sceneDir, plan, shots);
  return jobs.filter(job => job.kind === 'video'
    && typeof job.outputPath === 'string'
    && !isStale(job, now)
    && dirname(resolve(job.outputPath)) === folder
    && !planned.has(resolve(job.outputPath)));
}
