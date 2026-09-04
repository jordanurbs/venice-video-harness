#!/usr/bin/env node
// Tests for the upfront-questionnaire fields on createSeries (W3 follow-up).
// Run with `node tests/test-questionnaire.mjs` after `npm run build`.

import { createSeries } from '../dist/series/manager.js';
import { resolveVideoFamilyDefaults } from '../dist/series/types.js';
import { getVideoModel } from '../dist/venice/models.js';

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ': ' + detail : ''}`); }
}

// Default (no options) → Seedance defaults, no strategy fields set.
{
  const s = createSeries('Default Series', 'concept', 'drama', 'somewhere');
  ok('default actionModel is Seedance 2.5 R2V', s.videoDefaults.actionModel === 'seedance-2-5-reference-to-video');
  ok('default characterConsistencyModel is Seedance 2.5 R2V', s.videoDefaults.characterConsistencyModel === 'seedance-2-5-reference-to-video');
  ok('audioStrategy unset by default', s.videoDefaults.audioStrategy === undefined);
  ok('videoFamilyPreference unset by default', s.videoDefaults.videoFamilyPreference === undefined);
}

// Family 'happyhorse' → HappyHorse 1.1 i2v + R2V (upgraded from 1.0, 2026-07).
{
  const s = createSeries('HH Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'happyhorse',
  });
  ok('happyhorse actionModel', s.videoDefaults.actionModel === 'happyhorse-1-1-image-to-video');
  ok('happyhorse characterConsistencyModel', s.videoDefaults.characterConsistencyModel === 'happyhorse-1-1-reference-to-video');
  ok('happyhorse lipSyncModel stays Wan 2.7', s.videoDefaults.lipSyncModel === 'wan-2-7-image-to-video');
  ok('videoFamilyPreference persisted', s.videoDefaults.videoFamilyPreference === 'happyhorse');
}

// Family 'minimax-h3' → H3 i2v for action/atmosphere + H3 R2V for identity.
{
  const s = createSeries('H3 Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'minimax-h3',
  });
  ok('minimax-h3 actionModel', s.videoDefaults.actionModel === 'minimax-h3-image-to-video');
  ok('minimax-h3 atmosphereModel', s.videoDefaults.atmosphereModel === 'minimax-h3-image-to-video');
  ok('minimax-h3 characterConsistencyModel', s.videoDefaults.characterConsistencyModel === 'minimax-h3-reference-to-video');
  // H3 R2V is the one H3 lane with audio_input, so lip-sync stays in-family.
  ok('minimax-h3 lipSyncModel stays in-family', s.videoDefaults.lipSyncModel === 'minimax-h3-reference-to-video');
  ok('videoFamilyPreference persisted', s.videoDefaults.videoFamilyPreference === 'minimax-h3');
}

// Family 'minimax-h3-max' → H3 Max i2v + H3 Max R2V. Must NOT resolve to the
// base H3 ids: same name, different resolution ladder and prompt style.
{
  const s = createSeries('H3 Max Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'minimax-h3-max',
  });
  ok('minimax-h3-max actionModel', s.videoDefaults.actionModel === 'minimax-h3-max-image-to-video');
  ok('minimax-h3-max atmosphereModel', s.videoDefaults.atmosphereModel === 'minimax-h3-max-image-to-video');
  ok('minimax-h3-max characterConsistencyModel', s.videoDefaults.characterConsistencyModel === 'minimax-h3-max-reference-to-video');
  ok('minimax-h3-max lipSyncModel stays in-family', s.videoDefaults.lipSyncModel === 'minimax-h3-max-reference-to-video');
  ok('videoFamilyPreference persisted', s.videoDefaults.videoFamilyPreference === 'minimax-h3-max');
}

// Family 'minimax-h3-max-turbo' → Turbo carries action/atmosphere, but Turbo
// ships no R2V lane, so identity crosses to the non-turbo H3 Max R2V.
{
  const s = createSeries('H3 Max Turbo Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'minimax-h3-max-turbo',
  });
  ok('turbo actionModel', s.videoDefaults.actionModel === 'minimax-h3-max-turbo-image-to-video');
  ok('turbo atmosphereModel', s.videoDefaults.atmosphereModel === 'minimax-h3-max-turbo-image-to-video');
  ok('turbo identity crosses to H3 Max R2V', s.videoDefaults.characterConsistencyModel === 'minimax-h3-max-reference-to-video');
  ok('turbo lipSyncModel is the H3 Max R2V lane', s.videoDefaults.lipSyncModel === 'minimax-h3-max-reference-to-video');
}

// Family 'wan-3-0' → Wan 3.0 i2v + R2V. No audio input anywhere in the
// family, so exact lip-sync falls back to Wan 2.7.
{
  const s = createSeries('Wan3 Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'wan-3-0',
  });
  ok('wan-3-0 actionModel', s.videoDefaults.actionModel === 'wan-3-0-image-to-video');
  ok('wan-3-0 characterConsistencyModel', s.videoDefaults.characterConsistencyModel === 'wan-3-0-reference-to-video');
  ok('wan-3-0 lipSyncModel falls back to Wan 2.7', s.videoDefaults.lipSyncModel === 'wan-2-7-image-to-video');
}

// Family 'grok-imagine' → Grok i2v + Grok R2V (Grok now ships R2V).
{
  const s = createSeries('Grok Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'grok-imagine',
  });
  ok('grok actionModel', s.videoDefaults.actionModel === 'grok-imagine-image-to-video');
  ok('grok characterConsistencyModel stays in-family (grok-imagine R2V)',
    s.videoDefaults.characterConsistencyModel === 'grok-imagine-reference-to-video');
}

// Family 'kling-o3' → Kling everywhere.
{
  const s = createSeries('Kling Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'kling-o3',
  });
  ok('kling actionModel', s.videoDefaults.actionModel === 'kling-o3-standard-image-to-video');
  ok('kling characterConsistencyModel', s.videoDefaults.characterConsistencyModel === 'kling-o3-standard-reference-to-video');
}

// Family 'auto' → same as default but the field is persisted.
{
  const s = createSeries('Auto Series', 'concept', 'drama', 'somewhere', {
    videoFamilyPreference: 'auto',
  });
  ok('auto family keeps Seedance defaults', s.videoDefaults.actionModel === 'seedance-2-5-reference-to-video');
  ok('auto videoFamilyPreference persisted', s.videoDefaults.videoFamilyPreference === 'auto');
}

// Audio strategies persist verbatim.
for (const strategy of ['native', 'lip-sync', 'narrator-vo']) {
  const s = createSeries(`Audio ${strategy}`, 'concept', 'drama', 'somewhere', { audioStrategy: strategy });
  ok(`audioStrategy "${strategy}" persisted`, s.videoDefaults.audioStrategy === strategy);
}

// Combined: lip-sync + happyhorse → Wan 2.7 stays on lip-sync, HappyHorse on R2V.
{
  const s = createSeries('Combo', 'concept', 'drama', 'somewhere', {
    audioStrategy: 'lip-sync',
    videoFamilyPreference: 'happyhorse',
  });
  ok('combo audioStrategy', s.videoDefaults.audioStrategy === 'lip-sync');
  ok('combo videoFamily', s.videoDefaults.videoFamilyPreference === 'happyhorse');
  ok('combo lipSyncModel still Wan 2.7', s.videoDefaults.lipSyncModel === 'wan-2-7-image-to-video');
  ok('combo characterConsistencyModel is HappyHorse R2V', s.videoDefaults.characterConsistencyModel === 'happyhorse-1-1-reference-to-video');
}

// Render route → montageMode toggle (upfront questionnaire).
{
  const montage = createSeries('Montage Route', 'concept', 'drama', 'somewhere', { montageMode: true });
  ok('montage route persists montageMode:true', montage.videoDefaults.montageMode === true);
  const standard = createSeries('Standard Route', 'concept', 'drama', 'somewhere', { montageMode: false });
  ok('standard route persists montageMode:false', standard.videoDefaults.montageMode === false);
  const unset = createSeries('Unset Route', 'concept', 'drama', 'somewhere');
  ok('no route leaves montageMode unset (harness montage-first default)', unset.videoDefaults.montageMode === undefined);
}

// resolveVideoFamilyDefaults: each family returns a complete triplet.
for (const family of ['auto', 'seedance', 'wan-3-0', 'happyhorse', 'minimax-h3', 'minimax-h3-max', 'minimax-h3-max-turbo', 'grok-imagine', 'kling-o3']) {
  const d = resolveVideoFamilyDefaults(family);
  ok(`resolveVideoFamilyDefaults(${family}).actionModel`, typeof d.actionModel === 'string' && d.actionModel.length > 0);
  ok(`resolveVideoFamilyDefaults(${family}).characterConsistencyModel`, typeof d.characterConsistencyModel === 'string');
  // Every routed id must exist in the registry — a family pointing at a
  // hallucinated slug only surfaces as a 404 mid-render.
  for (const id of [d.actionModel, d.atmosphereModel, d.characterConsistencyModel]) {
    ok(`resolveVideoFamilyDefaults(${family}) routes to a real model: ${id}`, getVideoModel(id) !== undefined);
  }
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
