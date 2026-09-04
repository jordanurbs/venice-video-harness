#!/usr/bin/env node
// Tests for assertShotDurationsValid() (W1.6).
// Run with `node tests/test-duration-preflight.mjs` after `npm run build`.

import { assertShotDurationsValid } from '../dist/mini-drama/video-generator.js';
import {
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
} from '../dist/series/types.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

function shot(number, duration) {
  return {
    shotNumber: number,
    type: 'establishing',
    duration,
    videoModel: 'atmosphere',
    description: '',
    characters: [],
    dialogue: null,
    sfx: null,
    cameraMovement: 'static',
    transition: 'CUT',
  };
}

function plan(units) {
  return { episode: 1, generatedAt: new Date().toISOString(), units };
}

// 16s on seedance-2-0-r2v (ceiling 15s) -> throw.
{
  let threw = false;
  let msg = '';
  try {
    assertShotDurationsValid(
      [shot(9, '16s')],
      plan([{
        unitId: 'u1', unitType: 'single', shotNumbers: [9],
        outputFile: 'shot-009.mp4',
        model: 'seedance-2-0-reference-to-video',
        duration: '16s',
        startFrameStrategy: 'panel',
        endFrameStrategy: 'natural',
        decisionReasons: [],
        fallbackToSingles: false,
      }]),
    );
  } catch (err) {
    threw = true;
    msg = String(err);
  }
  ok('16s on Seedance R2V throws', threw);
  ok('error names the offending shot', msg.includes('shot 9'));
  ok('error names the model', msg.includes('seedance-2-0-reference-to-video'));
  ok('error names the 15s ceiling', msg.includes('15s'));
}

// 8s on wan-2-7-reference-to-video (stepped: only 5s/10s allowed) -> throw.
{
  let threw = false;
  try {
    assertShotDurationsValid(
      [shot(1, '8s')],
      plan([{
        unitId: 'u1', unitType: 'single', shotNumbers: [1],
        outputFile: 'shot-001.mp4',
        model: 'wan-2-7-reference-to-video',
        duration: '8s',
        startFrameStrategy: 'panel',
        endFrameStrategy: 'natural',
        decisionReasons: [],
        fallbackToSingles: false,
      }]),
    );
  } catch {
    threw = true;
  }
  ok('8s on Wan 2.7 R2V (only 5s/10s allowed) throws', threw);
}

// 10s on seedance-2-0-image-to-video -> passes.
{
  let threw = false;
  try {
    assertShotDurationsValid(
      [shot(1, '10s')],
      plan([{
        unitId: 'u1', unitType: 'single', shotNumbers: [1],
        outputFile: 'shot-001.mp4',
        model: 'seedance-2-0-image-to-video',
        duration: '10s',
        startFrameStrategy: 'panel',
        endFrameStrategy: 'natural',
        decisionReasons: [],
        fallbackToSingles: false,
      }]),
    );
  } catch {
    threw = true;
  }
  ok('10s on Seedance i2v passes', !threw);
}

// Aggregates multiple violations into one error.
{
  let msg = '';
  try {
    assertShotDurationsValid(
      [shot(1, '16s'), shot(2, '20s')],
      plan([
        { unitId: 'u1', unitType: 'single', shotNumbers: [1], outputFile: 'shot-001.mp4',
          model: 'seedance-2-0-image-to-video', duration: '16s',
          startFrameStrategy: 'panel', endFrameStrategy: 'natural',
          decisionReasons: [], fallbackToSingles: false },
        { unitId: 'u2', unitType: 'single', shotNumbers: [2], outputFile: 'shot-002.mp4',
          model: 'seedance-2-0-image-to-video', duration: '20s',
          startFrameStrategy: 'panel', endFrameStrategy: 'natural',
          decisionReasons: [], fallbackToSingles: false },
      ]),
    );
  } catch (err) {
    msg = String(err);
  }
  ok('aggregates two violations into one error', msg.includes('2 shot(s)'));
  ok('reports shot 1', msg.includes('shot 1'));
  ok('reports shot 2', msg.includes('shot 2'));
}

// ---- Montage window is bounded by the montage MODEL, not a flat 30s -------
// Planning a 30s window against a 15s model wrote a plan that every unit of
// which then failed the preflight above. The window now derives from the
// model's own ladder, so the plan is valid before it is written.
{
  ok('default montage ceiling stays 30s (Seedance 2.5)',
    resolveMontageMaxDurationSec(undefined) === 30);
  ok('default montage floor stays 4s (Seedance 2.5 ladder)',
    resolveMontageMinDurationSec(undefined) === 4);

  const h3Max = { montageModel: 'minimax-h3-max-text-to-video' };
  ok('H3 Max montage ceiling is its own 15s',
    resolveMontageMaxDurationSec(h3Max) === 15);
  ok('H3 Max montage floor rises to its 5s ladder start',
    resolveMontageMinDurationSec(h3Max) === 5);
  ok('an over-ambitious montageMaxDurationSec is clamped to the model ceiling',
    resolveMontageMaxDurationSec({ ...h3Max, montageMaxDurationSec: 30 }) === 15);
  ok('a shorter explicit montageMaxDurationSec is still honored',
    resolveMontageMaxDurationSec({ ...h3Max, montageMaxDurationSec: 10 }) === 10);

  // Every montage unit the planner can emit must satisfy the preflight for the
  // model it names — the invariant the flat ceiling used to break.
  const ceiling = resolveMontageMaxDurationSec(h3Max);
  const floor = resolveMontageMinDurationSec(h3Max);
  let threw = false;
  try {
    assertShotDurationsValid(
      [shot(1, `${floor}s`), shot(2, `${ceiling}s`)],
      plan([
        { unitId: 'm1', unitType: 'montage', shotNumbers: [1],
          model: 'minimax-h3-max-text-to-video', duration: `${floor}s`,
          startFrameStrategy: 'panel', endFrameStrategy: 'natural',
          decisionReasons: [], fallbackToSingles: false,
          montageBeats: [{ startSec: 0, endSec: floor }] },
        { unitId: 'm2', unitType: 'montage', shotNumbers: [2],
          model: 'minimax-h3-max-text-to-video', duration: `${ceiling}s`,
          startFrameStrategy: 'panel', endFrameStrategy: 'natural',
          decisionReasons: [], fallbackToSingles: false,
          montageBeats: [{ startSec: 0, endSec: ceiling }] },
      ]),
    );
  } catch {
    threw = true;
  }
  ok('montage units at the derived floor and ceiling both pass preflight', !threw);
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
