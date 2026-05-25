#!/usr/bin/env node
// Tests for src/mini-drama/music-cues.ts gain handling (W1.1).
// Run with `node tests/test-music-cues-gain.mjs` after `npm run build`.

import { buildGainStopsExpr } from '../dist/mini-drama/music-cues.js';

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ': ' + detail : ''}`); }
}

// Cue covers shots 1-10, base gain -22 dB, with one stop at shot 7 dropping
// gain to -32 dB over a 2s ramp. PlacementMap maps shot numbers (zero-padded
// 3-digit strings) to timeline windows.
const placementMap = {
  '001': { startSec: 0,  endSec: 8 },
  '007': { startSec: 80, endSec: 95 },
  '010': { startSec: 110, endSec: 120 },
};
const cue = {
  spec: {
    startShot: 1, endShot: 10,
    prompt: 'whatever',
    gain: -22,
    gainStops: [{ atShot: 7, gainDb: -32, rampSec: 2 }],
  },
  audioPath: '/tmp/music.mp3',
  startSec: 0,
  endSec: 120,
};

const expr = buildGainStopsExpr(cue, placementMap);
ok('expression is non-null', expr !== null);
ok('expression mentions the ramp start (79.000)', expr.includes('79.000'), expr);
ok('expression mentions the ramp end (81.000)', expr.includes('81.000'), expr);

// linear gain at base -22 dB ≈ 0.079433; at -32 dB ≈ 0.025119
ok('expression includes the base linear gain', expr.includes('0.079433'), expr);
ok('expression includes the post-stop linear gain', expr.includes('0.025119'), expr);

// No stops -> returns null.
const noStops = buildGainStopsExpr(
  { spec: { startShot: 1, endShot: 10, prompt: 'x', gain: -22 }, audioPath: '/tmp/x', startSec: 0, endSec: 120 },
  placementMap,
);
ok('null when gainStops is undefined', noStops === null);

// Stop outside cue window -> skipped (no expression).
const badStop = buildGainStopsExpr(
  {
    spec: { startShot: 1, endShot: 5, prompt: 'x', gain: -22, gainStops: [{ atShot: 10, gainDb: -32 }] },
    audioPath: '/tmp/x',
    startSec: 0,
    endSec: 50,
  },
  placementMap,
);
ok('returns null when every stop is outside cue window', badStop === null);

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
