#!/usr/bin/env node
// Smoke test for the spatial-consistency layer (rule 49):
//   - ShotScript.blocking lands in the panel prompt (BLOCKING:) and the video
//     prompt (Blocking:), with @ImageN name substitution on tag models
//   - Location.spatialAnchors lands in panel + video prompts as the
//     "Fixed layout (never rearrange)" clause
//   - the storyboard plate clause forbids mirroring/swapping; plateless
//     location shots get a geography-hold clause on the location slot
//   - the beat planner folds the shot's blocking into the plate description
//   - the workshop system prompt teaches spatialAnchors + blocking
//   - the Kling multi-shot builder restates blocking per shot
//
// Run with `node tests/test-spatial-consistency.mjs` after `npm run build`.
// No network / no generation budget — pure prompt assembly.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImagePrompt, buildVideoPrompt, buildMultiShotPrompt, buildKlingMultiShotPrompt } from '../dist/mini-drama/prompt-builder.js';
import { planStoryboardBeats } from '../dist/mini-drama/storyboard-reference-generator.js';
import { buildWorkshopSystemPrompt } from '../dist/mini-drama/workshop.js';
import { DEFAULT_MULTISHOT_MODEL, resolveMultiShotModel } from '../dist/series/types.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const dir = mkdtempSync(join(tmpdir(), 'venice-spatial-'));

// ── Fixtures on disk ───────────────────────────────────────────────────
for (const name of ['mara', 'jax']) {
  mkdirSync(join(dir, 'characters', name), { recursive: true });
  writeFileSync(join(dir, 'characters', name, 'front.png'), PNG);
}
mkdirSync(join(dir, 'locations', 'dive-bar'), { recursive: true });
writeFileSync(join(dir, 'locations', 'dive-bar', 'wide.png'), PNG);
mkdirSync(join(dir, 'storyboards'), { recursive: true });
writeFileSync(join(dir, 'storyboards', 'e01-beat-1-dive-bar.png'), PNG);

const ANCHORS = 'bar counter along the back wall; entrance door opposite it; neon window left of the door';
const BLOCKING = 'MARA at the bar counter, screen left, facing right toward the door; JAX in the doorway, background screen right, facing her.';

function char(name) {
  return {
    name, gender: 'female', age: '30s', description: 'a bartender',
    fullDescription: `${name}, bartender`, wardrobe: 'denim jacket',
    voiceDescription: 'low alto', locked: true, seed: 1,
  };
}

const series = {
  name: 'Spatial', slug: 'spatial', concept: 'c', genre: 'drama', setting: 's',
  projectType: 'film',
  aesthetic: {
    style: 'Cinematic photography', palette: 'warm amber palette',
    lighting: 'natural lighting', lensCharacteristics: 'shallow depth of field',
    filmStock: 'digital',
  },
  storyboardAspectRatio: '16:9',
  characters: [char('MARA'), char('JAX')],
  locations: [{
    name: 'Dive Bar', slug: 'dive-bar',
    description: 'a cramped neon-lit dive bar',
    lightingNotes: 'warm practicals, neon spill',
    spatialAnchors: ANCHORS,
    seed: 7,
  }],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-enhanced-reference-to-video',
    atmosphereModel: 'seedance-2-0-enhanced-reference-to-video',
    characterConsistencyModel: 'seedance-2-0-enhanced-reference-to-video',
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
    seedanceCompatibility: 'launder',
  },
  outputDir: dir,
  createdAt: '', updatedAt: '',
};

function shot(overrides = {}) {
  return {
    shotNumber: 1,
    type: 'dialogue',
    environment: 'NIGHT_INTERIOR',
    duration: '15s',
    videoModel: 'action',
    description: 'MARA polishes a glass as JAX enters. No background music, no sound effects, no soundtrack, dry recording.',
    characters: ['MARA', 'JAX'],
    location: 'dive-bar',
    blocking: BLOCKING,
    dialogue: null,
    sfx: null,
    cameraMovement: 'static',
    transition: 'CUT',
    ...overrides,
  };
}

// ── Panel prompt carries blocking ──────────────────────────────────────
console.log('buildImagePrompt:');
{
  const p = buildImagePrompt(shot(), series);
  ok('panel prompt carries BLOCKING clause', p.prompt.includes(`BLOCKING: ${BLOCKING}`));
  const noBlocking = buildImagePrompt(shot({ blocking: undefined }), series);
  ok('no BLOCKING clause when field absent', !noBlocking.prompt.includes('BLOCKING:'));
}

// ── Video prompt: blocking with @ImageN substitution + fixed layout ────
console.log('buildVideoPrompt (with storyboard plate):');
{
  const v = buildVideoPrompt(shot({ storyboardRef: 'e01-beat-1-dive-bar' }), series);
  ok('routes to @Image-tag model', v.modelResolution?.useImageTags === true);
  ok('video prompt carries a Blocking clause', /Blocking: /.test(v.prompt));
  ok('blocking substitutes character names with @ImageN', /Blocking: @Image\d+ at the bar counter/.test(v.prompt));
  ok('blocking does not leak raw character name', !/Blocking: MARA/.test(v.prompt));
  ok('location fixed layout injected', v.prompt.includes(`Fixed layout (never rearrange): ${ANCHORS}.`));
  ok('plate clause forbids mirroring/swapping', v.prompt.includes('do not mirror, swap, or rearrange who stands where'));
  const sbSlot = v.referenceSlots?.find(s => s.kind === 'storyboard');
  ok('storyboard plate is in the slot plan', Boolean(sbSlot));
}

console.log('buildVideoPrompt (no plate, location refs only):');
{
  const v = buildVideoPrompt(shot(), series);
  const locSlot = v.referenceSlots?.find(s => s.kind === 'location');
  ok('location slot present', Boolean(locSlot));
  ok('plateless shot gets a geography-hold clause', v.prompt.includes(`Keep the geography of @Image${locSlot?.imageIndex} fixed`));
}

// ── Multi-shot: Seedance R2V is the default lane ───────────────────────
console.log('buildMultiShotPrompt (Seedance R2V default):');
{
  ok('DEFAULT_MULTISHOT_MODEL is Seedance R2V Enhanced', DEFAULT_MULTISHOT_MODEL === 'seedance-2-0-enhanced-reference-to-video');
  ok('resolveMultiShotModel defaults to Seedance', resolveMultiShotModel(series.videoDefaults) === DEFAULT_MULTISHOT_MODEL);
  ok('explicit override wins', resolveMultiShotModel({ multiShotModel: 'kling-o3-pro-image-to-video' }) === 'kling-o3-pro-image-to-video');

  const shots = [shot({ storyboardRef: 'e01-beat-1-dive-bar' }), shot({ shotNumber: 2, storyboardRef: 'e01-beat-1-dive-bar', description: 'JAX sits at the counter beside MARA. No background music, no sound effects, no soundtrack, dry recording.' })];
  const unit = { unitType: 'multishot', shotNumbers: [1, 2], duration: '10s', model: DEFAULT_MULTISHOT_MODEL };
  const m = buildMultiShotPrompt(shots, unit, series);
  ok('multi-shot renders on the Seedance R2V model', m.model === DEFAULT_MULTISHOT_MODEL);
  ok('uses Lens switch separators (rule 21)', m.prompt.includes('Lens switch.'));
  ok('carries a reference slot plan', (m.referenceSlots?.length ?? 0) > 0);
  ok('slot plan includes the blocking plate', m.referenceSlots.some(s => s.kind === 'storyboard'));
  ok('slot plan includes location angles', m.referenceSlots.some(s => s.kind === 'location'));
  const blockingCount = (m.prompt.match(/Blocking: /g) ?? []).length;
  ok('each beat restates blocking', blockingCount === 2);
  ok('blocking substitutes @ImageN on the R2V lane', /Blocking: @Image\d+ at the bar counter/.test(m.prompt));
  ok('identity declarations up front', /@Image\d+ is MARA — wearing/.test(m.prompt));
  ok('geometry pinned to the plate, no mirroring', m.prompt.includes('do not mirror, swap, or rearrange who stands where'));
}

// ── Legacy Kling multi-shot lane (explicit override only) ──────────────
console.log('buildMultiShotPrompt (explicit Kling override):');
{
  const klingDefaults = { ...series.videoDefaults, multiShotModel: 'kling-o3-pro-image-to-video' };
  const klingSeries = { ...series, videoDefaults: klingDefaults };
  const shots = [shot(), shot({ shotNumber: 2, description: 'JAX sits at the counter beside MARA. No background music, no sound effects, no soundtrack, dry recording.' })];
  const unit = { unitType: 'multishot', shotNumbers: [1, 2], duration: '10s', model: 'kling-o3-pro-image-to-video' };
  const m = buildMultiShotPrompt(shots, unit, klingSeries);
  ok('override routes to the Kling format', m.model === 'kling-o3-pro-image-to-video');
  ok('Kling format uses Immediately separators', m.prompt.includes('Immediately, cut to:'));
  const blockingCount = (m.prompt.match(/Blocking: /g) ?? []).length;
  ok('each shot block restates blocking', blockingCount === 2);
  // kling-o3-pro-image-to-video has NO elements support (anti-pattern 1), so
  // the legacy builder keeps raw character names in the blocking clause.
  ok('legacy blocking keeps raw names on a no-elements model', /Blocking: MARA at the bar counter/.test(m.prompt));
  // Direct legacy entrypoint still works for external importers.
  const legacy = buildKlingMultiShotPrompt(shots, unit, klingSeries);
  ok('buildKlingMultiShotPrompt still callable', legacy.model === 'kling-o3-pro-image-to-video');
}

// ── Beat planner folds blocking into the plate description ─────────────
console.log('planStoryboardBeats:');
{
  const script = {
    episode: 1, title: 't', seriesName: 'Spatial', totalDuration: '30s',
    shots: [shot({ storyboardRef: undefined }), shot({ shotNumber: 2, storyboardRef: undefined })],
  };
  const refs = planStoryboardBeats(script);
  ok('one plate planned for the beat', refs.length === 1);
  ok('plate description includes the authored blocking', refs[0].description.includes(BLOCKING));
}

// ── Workshop system prompt teaches the spatial contract ────────────────
console.log('buildWorkshopSystemPrompt:');
{
  const sp = buildWorkshopSystemPrompt(series);
  ok('mentions spatialAnchors', sp.includes('spatialAnchors'));
  ok('mentions blocking field', sp.includes('"blocking"'));
  ok('mentions the 180-degree rule', sp.includes('180-degree rule'));
}

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll spatial-consistency checks passed.');
