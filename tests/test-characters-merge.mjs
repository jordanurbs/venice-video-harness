#!/usr/bin/env node
// Tests for saveSeries() rebuilding characters[] from disk (W2.3).
// Builds a fixture series directory with two character.json files, loads
// the series, simulates the bug (in-memory characters[] cleared), saves,
// and asserts the on-disk characters[] is back.
// Run with `node tests/test-characters-merge.mjs` after `npm run build`.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeries, saveSeries, loadCharactersFromDisk } from '../dist/series/manager.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'series-merge-test-'));
mkdirSync(join(dir, 'characters', 'founder'), { recursive: true });
mkdirSync(join(dir, 'characters', 'legislator'), { recursive: true });

const founder = {
  name: 'FOUNDER',
  gender: 'male',
  age: 'early 40s',
  description: 'tech founder',
  fullDescription: 'FOUNDER, 40s, tech founder',
  wardrobe: 'patagonia fleece',
  voiceDescription: 'measured',
  locked: true,
  seed: 1,
};
const legislator = {
  name: 'LEGISLATOR',
  gender: 'female',
  age: '52',
  description: 'state senator',
  fullDescription: 'LEGISLATOR, 52, state senator',
  wardrobe: 'slate-blue blazer',
  voiceDescription: 'measured TV-friendly',
  locked: true,
  seed: 2,
};
writeFileSync(
  join(dir, 'characters', 'founder', 'character.json'),
  JSON.stringify(founder, null, 2),
);
writeFileSync(
  join(dir, 'characters', 'legislator', 'character.json'),
  JSON.stringify(legislator, null, 2),
);

const initialSeries = {
  name: 'test',
  slug: 'test',
  concept: 'x',
  genre: 'drama',
  setting: '',
  aesthetic: null,
  characters: [],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-image-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
  },
  outputDir: dir,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
writeFileSync(join(dir, 'series.json'), JSON.stringify(initialSeries, null, 2));

// Reproduce the bug: load series, clobber characters[] in memory, save.
const series = await loadSeries(dir);
ok('series loaded', series !== null);
series.characters = []; // simulate buggy command clearing it
await saveSeries(series);

const onDisk = JSON.parse(readFileSync(join(dir, 'series.json'), 'utf-8'));
ok('saveSeries restored characters[] from disk', onDisk.characters.length === 2);
const names = onDisk.characters.map(c => c.name).sort();
ok('FOUNDER restored', names.includes('FOUNDER'));
ok('LEGISLATOR restored', names.includes('LEGISLATOR'));

// loadCharactersFromDisk should also work directly.
const disk = await loadCharactersFromDisk(dir);
ok('loadCharactersFromDisk reads both', disk.length === 2);

// Clean up.
rmSync(dir, { recursive: true, force: true });

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
