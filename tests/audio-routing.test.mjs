import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVideoModel } from '../dist/mini-drama/prompt-builder.js';
import { buildGenerationPlan, mustRenderAsExactLipSync } from '../dist/mini-drama/generation-planner.js';
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

function seriesWith(strategy, videoFamilyPreference) {
  return createSeries('Routing', 'test', 'drama', 'studio', {
    audioStrategy: strategy,
    ...(videoFamilyPreference ? { videoFamilyPreference } : {}),
  });
}

function script(shots) {
  return { episode: 1, title: 'Routing', seriesName: 'Routing', totalDuration: '10s', status: 'approved', shots };
}

test('native dialogue remains on Seedance R2V with voice-reference capability', () => {
  const series = seriesWith('native');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(resolution.autoUseReferenceImages, true);
  assert.equal(mustRenderAsExactLipSync(dialogueShot(), series.videoDefaults), false);
});

// Seedance R2V takes a top-level audio_url, so exact lip-sync has no reason to
// leave the family: the reference stack keeps anchoring identity.
test('exact lip-sync stays in-family when the family has an audio-driven lane', () => {
  const series = seriesWith('lip-sync');
  assert.equal(series.videoDefaults.lipSyncModel, 'seedance-2-0-enhanced-reference-to-video');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(resolution.autoUseReferenceImages, true);
  assert.equal(mustRenderAsExactLipSync(dialogueShot(), series.videoDefaults), true);
});

test('exact lip-sync falls back to Wan 2.7 when the family has no audio-driven lane', () => {
  const series = seriesWith('lip-sync', 'kling-o3');
  assert.equal(series.videoDefaults.lipSyncModel, 'wan-2-7-image-to-video');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'wan-2-7-image-to-video');
  assert.equal(resolution.autoUseReferenceImages, false);
  assert.equal(mustRenderAsExactLipSync(dialogueShot(), series.videoDefaults), true);
});

test('narrator-vo never routes a dialogue shot away from the family R2V', () => {
  const series = seriesWith('narrator-vo');
  const resolution = resolveVideoModel(dialogueShot(), series);
  assert.equal(resolution.modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(mustRenderAsExactLipSync(dialogueShot(), series.videoDefaults), false);
});

// Every series is created with a default lipSyncModel, so an unset strategy
// must read as native rather than as an invitation to route to the lip-sync
// lane.
test('an unset audio strategy behaves as native despite the default lipSyncModel', () => {
  const series = createSeries('Routing', 'test', 'drama', 'studio');
  assert.equal(series.videoDefaults.audioStrategy, undefined);
  assert.equal(series.videoDefaults.lipSyncModel, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(resolveVideoModel(dialogueShot(), series).modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(mustRenderAsExactLipSync(dialogueShot(), series.videoDefaults), false);
});

test('high-motion dialogue stays on R2V even under exact lip-sync', () => {
  const series = seriesWith('lip-sync');
  const shot = { ...dialogueShot(), motion: 'high' };
  assert.equal(resolveVideoModel(shot, series).modelId, 'seedance-2-0-enhanced-reference-to-video');
  assert.equal(mustRenderAsExactLipSync(shot, series.videoDefaults), false);
});

test('native dialogue may remain grouped while exact lip-sync stays single', () => {
  const shots = [dialogueShot(1), dialogueShot(2)];

  // Montage-first (this branch's default): consecutive native-dialogue beats
  // group into ONE single-pass Seedance 2.5 montage unit.
  const nativePlan = buildGenerationPlan(script(shots), seriesWith('native'));
  assert.equal(nativePlan.units.length, 1);
  assert.equal(nativePlan.units[0].unitType, 'montage');
  assert.equal(nativePlan.units[0].model, 'seedance-2-5-reference-to-video');
  assert.ok(Array.isArray(nativePlan.units[0].montageBeats));

  // Legacy lane (montageMode: false) still groups as a 15s multi-shot on the
  // reference-first Seedance 2.0 lane — never the referenceless Kling i2v.
  const legacySeries = seriesWith('native');
  legacySeries.videoDefaults.montageMode = false;
  const legacyPlan = buildGenerationPlan(script(shots), legacySeries);
  assert.equal(legacyPlan.units.length, 1);
  assert.equal(legacyPlan.units[0].unitType, 'multishot');
  assert.equal(legacyPlan.units[0].model, 'seedance-2-0-enhanced-reference-to-video');

  // Exact lip-sync stays single on BOTH lanes — bundling drops the lip-sync.
  const exactPlan = buildGenerationPlan(script(shots), seriesWith('lip-sync'));
  assert.equal(exactPlan.units.length, 2);
  assert.ok(exactPlan.units.every(unit => unit.unitType === 'single'));
});

// The keyframe pre-pass exists to give a keyframe-only model an identity
// anchor. A reference-capable lip-sync model already has one, so paying for a
// second render would be waste.
test('the Seedance keyframe pre-pass runs only for keyframe-only lip-sync models', () => {
  const shots = [dialogueShot(1), dialogueShot(2)];

  const inFamily = buildGenerationPlan(script(shots), seriesWith('lip-sync'));
  assert.ok(inFamily.units.every(unit => unit.useSeedanceKeyframe === undefined));

  const viaWan = buildGenerationPlan(script(shots), seriesWith('lip-sync', 'kling-o3'));
  assert.ok(viaWan.units.every(unit => unit.useSeedanceKeyframe === true));
});
