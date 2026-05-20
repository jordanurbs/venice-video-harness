#!/usr/bin/env node
// Tests for filterVoices() British-voice detection (W2.13).
// Run with `node tests/test-voices-british.mjs` after `npm run build`.

import { listVoices, filterVoices } from '../dist/venice/voices.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const all = await listVoices('tts-kokoro');

// British male: should include bm_george, bm_daniel, bm_fable, bm_lewis.
{
  const matches = filterVoices(all, 'male', undefined, 'british');
  const ids = matches.map(v => v.voice_id).sort();
  ok('"british" + male returns at least bm_george', ids.includes('bm_george'));
  ok('"british" + male returns at least bm_daniel', ids.includes('bm_daniel'));
  ok('"british" + male excludes am_adam', !ids.includes('am_adam'));
}

// 'uk' alias works.
{
  const matches = filterVoices(all, 'male', undefined, 'uk');
  ok('"uk" alias finds bm_george', matches.some(v => v.voice_id === 'bm_george'));
}

// 'en-gb' alias works.
{
  const matches = filterVoices(all, 'female', undefined, 'en-gb');
  ok('"en-gb" finds bf_alice', matches.some(v => v.voice_id === 'bf_alice'));
}

// 'british english' (catalog exact) works.
{
  const matches = filterVoices(all, undefined, undefined, 'british english');
  ok('"british english" finds bm_george', matches.some(v => v.voice_id === 'bm_george'));
}

// 'american' / 'us' aliases isolate American voices.
{
  const us = filterVoices(all, 'male', undefined, 'us');
  ok('"us" + male returns am_adam', us.some(v => v.voice_id === 'am_adam'));
  ok('"us" + male excludes bm_george', !us.some(v => v.voice_id === 'bm_george'));
}

// 'english' returns both American and British.
{
  const en = filterVoices(all, 'male', undefined, 'english');
  ok('"english" returns both bm_george and am_adam',
    en.some(v => v.voice_id === 'bm_george') && en.some(v => v.voice_id === 'am_adam'));
}

// undefined language preserves legacy behaviour (English family).
{
  const def = filterVoices(all);
  ok('undefined language returns at least one English voice',
    def.some(v => v.voice_id === 'bm_george') && def.some(v => v.voice_id === 'am_adam'));
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
