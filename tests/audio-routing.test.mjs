import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVideoModel } from '../dist/mini-drama/prompt-builder.js';
import { buildGenerationPlan, mustStayAsWanLipSync } from '../dist/mini-drama/generation-planner.js';
import { createSeries } from '../dist/series/manager.js';

function dialogueShot(number = 1) {
  return {
    shotNumber: number,
    type: 'dialogue',
    duration: '5s',
    videoModel: 'action',
    description: 'ARIA speaks to camera.',
    characters: ['ARIA'],
    dialogue: { character: 'ARIA', line: 'This line must stay exact.' },
    sfx: null,
    cameraMovement: 'static medium close-up',
    transition: 'CUT',
    motion: 'low',
    faceVisible: true,
  };
}

function seriesWith(strategy) {
  return createSeries('Routing', 'test', 'drama', 'studio', { audioStrategy: strategy });
}

function script(shots) {
  return { episode: 1, title: 'Routing', seriesName: 'Routing', totalDuration: '10s', status: 'approved', shots };
}

test('native dialogue remains on Seedance R2V with voice-reference capability', () => {
  const series = seriesWith('native');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(resolution.autoUseReferenceImages, true);
  assert.equal(mustStayAsWanLipSync(dialogueShot(), series.videoDefaults), false);
});

test('exact lip-sync explicitly routes a single speaker to Wan 2.7', () => {
  const series = seriesWith('lip-sync');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'wan-2-7-image-to-video');
  assert.equal(mustStayAsWanLipSync(dialogueShot(), series.videoDefaults), true);
});

test('native dialogue may remain grouped while exact lip-sync stays single', () => {
  const shots = [dialogueShot(1), dialogueShot(2)];
  const nativePlan = buildGenerationPlan(script(shots), seriesWith('native'));
  assert.equal(nativePlan.units.length, 1);
  assert.equal(nativePlan.units[0].unitType, 'kling-multishot');

  const exactPlan = buildGenerationPlan(script(shots), seriesWith('lip-sync'));
  assert.equal(exactPlan.units.length, 2);
  assert.ok(exactPlan.units.every(unit => unit.unitType === 'single'));
  assert.ok(exactPlan.units.every(unit => unit.useSeedanceKeyframe === true));
});
