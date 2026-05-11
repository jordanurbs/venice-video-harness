#!/usr/bin/env node
// EXT-8 smoke test for src/mini-drama/shot-paths.ts.
// Run with `node tests/test-shot-paths.mjs` after `npm run build`.

import {
  shotKey,
  dialogueFileForShot,
  panelFileForShot,
  videoFileForShot,
  placeNarrationCues,
  findCollidingNarrationStarts,
} from '../dist/mini-drama/shot-paths.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  OK  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

// shotKey contract
eq(shotKey(3), '003', 'shotKey(3) -> "003"');
eq(shotKey('3b'), '003b', 'shotKey("3b") -> "003b"');
eq(shotKey('002c'), '002c', 'shotKey("002c") preserved');
eq(shotKey('intro'), 'intro', 'shotKey("intro") passes through');

// Path builders
eq(dialogueFileForShot('/tmp/dial', 3), '/tmp/dial/dialogue-shot-003.mp3', 'dialogueFileForShot numeric');
eq(dialogueFileForShot('/tmp/dial', '3b'), '/tmp/dial/dialogue-shot-003b.mp3', 'dialogueFileForShot suffixed');
eq(panelFileForShot('/tmp/p', 12), '/tmp/p/shot-012.png', 'panelFileForShot');
eq(videoFileForShot('/tmp/v', 12), '/tmp/v/shot-012.mp4', 'videoFileForShot');

// placeNarrationCues — fall-through warning
const dir = mkdtempSync(join(tmpdir(), 'ext8-test-'));
writeFileSync(join(dir, 'dialogue-shot-003.mp3'), 'fake');
writeFileSync(join(dir, 'dialogue-shot-003b.mp3'), 'fake');
const placementMap = {
  '003':  { startSec: 10, endSec: 15 },
  '003b': { startSec: 15, endSec: 20 },
  '003c': { startSec: 20, endSec: 25 },
};
const result = placeNarrationCues({
  cues: [
    { shotId: 3, label: 'NARR1' },
    { shotId: '3b', label: 'NARR2' },
    { shotId: '3c', label: 'NARR3' },  // no audio file -> warning
  ],
  placementMap,
  dialogueDir: dir,
});
eq(result.placements.length, 2, 'placeNarrationCues placed 2 cues');
eq(result.warnings.length, 1, 'placeNarrationCues warned about 1 missing file');
eq(result.warnings[0].includes('003c'), true, 'warning identifies the right key');

// Distinct startSec
const collisions = findCollidingNarrationStarts(result.placements);
eq(collisions.size, 0, 'no startSec collisions in placed cues');

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll EXT-8 assertions passed.');
