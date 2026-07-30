#!/usr/bin/env node
// Tests for the @ImageN reference slot allocator (reference-slots.ts) and the
// storyboard beat planner (storyboard-reference-generator.ts).
//
// Covers the reference-first upgrade (2026-07-30):
//   - slot order: character primaries → storyboard plate → location angles →
//     second character angles
//   - per-model budget (9 on Seedance R2V, 4 legacy default)
//   - overflow policy: second character angles drop first, then trailing
//     location angles; storyboard plates are protected
//   - beat planner: multi-character same-location runs share one plate;
//     single-character shots get none; existing storyboardRef respected
//
// Run with `node tests/test-reference-slots.mjs` after `npm run build`.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';
import { planStoryboardBeats } from '../dist/mini-drama/storyboard-reference-generator.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const dir = mkdtempSync(join(tmpdir(), 'venice-refslots-'));

function touch(p) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, PNG);
}

// Characters: BOB and ALICE with front + three-quarter; ZED with front only.
for (const name of ['bob', 'alice']) {
  mkdirSync(join(dir, 'characters', name), { recursive: true });
  touch(join(dir, 'characters', name, 'front.png'));
  touch(join(dir, 'characters', name, 'three-quarter.png'));
}
mkdirSync(join(dir, 'characters', 'zed'), { recursive: true });
touch(join(dir, 'characters', 'zed', 'front.png'));

// Location: courtyard with all three angles.
mkdirSync(join(dir, 'locations', 'courtyard'), { recursive: true });
for (const f of ['wide.png', 'medium.png', 'detail.png']) {
  touch(join(dir, 'locations', 'courtyard', f));
}

// Storyboard plate.
mkdirSync(join(dir, 'storyboards'), { recursive: true });
touch(join(dir, 'storyboards', 'e01-beat-1-courtyard.png'));

function char(name) {
  return {
    name, gender: 'male', age: '30s', description: 'd', fullDescription: 'fd',
    wardrobe: 'w', voiceDescription: '', locked: true, seed: 1,
  };
}

const series = {
  name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: null,
  characters: [char('BOB'), char('ALICE'), char('ZED')],
  locations: [{ name: 'Courtyard', slug: 'courtyard', description: 'castle courtyard', seed: 1 }],
  episodes: [], videoDefaults: { actionModel: 'x', atmosphereModel: 'x' },
  outputDir: dir, createdAt: '', updatedAt: '',
};

const SEEDANCE = 'seedance-2-0-enhanced-reference-to-video';

// ── Full stack: 2 chars + storyboard + location, all fits in 9 ─────────────
{
  const shot = {
    shotNumber: 1, type: 'action', duration: '10s', videoModel: 'action',
    description: 'BOB and ALICE fight over the chalice.',
    characters: ['BOB', 'ALICE'], location: 'courtyard',
    storyboardRef: 'e01-beat-1-courtyard',
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
  };
  const plan = buildReferenceSlotPlan(series, shot, SEEDANCE);
  const kinds = plan.slots.map(s => s.kind);
  ok('full stack: 8 slots (2 primaries + plate + 3 location + 2 angles)', plan.slots.length === 8);
  ok('slots 1-2 are character primaries', kinds[0] === 'character-primary' && kinds[1] === 'character-primary');
  ok('slot 3 is the storyboard plate', kinds[2] === 'storyboard');
  ok('slots 4-6 are location angles', kinds[3] === 'location' && kinds[5] === 'location');
  ok('slots 7-8 are second character angles', kinds[6] === 'character-angle' && kinds[7] === 'character-angle');
  ok('BOB maps to @Image1', plan.characterSlotByName.get('BOB') === 1);
  ok('storyboard role clause mentions blocking', /blocking/.test(plan.slots[2].roleClause));
  ok('nothing dropped', plan.dropped.length === 0);
}

// ── Overflow: 3 chars + plate + 3 location angles + 3 second angles = 10 ───
{
  const shot = {
    shotNumber: 2, type: 'action', duration: '10s', videoModel: 'action',
    description: 'BOB, ALICE and ZED brawl.',
    characters: ['BOB', 'ALICE', 'ZED'], location: 'courtyard',
    storyboardRef: 'e01-beat-1-courtyard',
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
  };
  const plan = buildReferenceSlotPlan(series, shot, SEEDANCE);
  // 3 primaries + 1 plate + 3 location = 7, then 2 second angles (BOB, ALICE;
  // ZED has no second angle) = 9. Budget hit exactly; nothing dropped.
  ok('3-char overflow: 9 slots exactly', plan.slots.length === 9);
  ok('storyboard plate survives at slot 4', plan.slots[3].kind === 'storyboard');
  ok('all 3 location angles survive', plan.slots.filter(s => s.kind === 'location').length === 3);
}

// ── Legacy budget (4): char angles AND location extras drop, plate survives ─
{
  const shot = {
    shotNumber: 3, type: 'action', duration: '10s', videoModel: 'action',
    description: 'BOB and ALICE argue.',
    characters: ['BOB', 'ALICE'], location: 'courtyard',
    storyboardRef: 'e01-beat-1-courtyard',
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
  };
  const plan = buildReferenceSlotPlan(series, shot, 'grok-imagine-reference-to-video');
  ok('legacy budget: 4 slots', plan.slots.length === 4);
  ok('legacy budget: plate protected at slot 3', plan.slots[2].kind === 'storyboard');
  ok('legacy budget: slot 4 is a location angle', plan.slots[3].kind === 'location');
  ok('legacy budget: drops recorded', plan.dropped.length > 0);
  ok('legacy budget: character angles dropped', plan.dropped.some(d => d.includes('character-angle')));
}

// ── Beat planner ────────────────────────────────────────────────────────────
{
  const mk = (n, chars, location, extra = {}) => ({
    shotNumber: n, type: 'action', duration: '10s', videoModel: 'action',
    description: `shot ${n}`, characters: chars, location,
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
    ...extra,
  });
  const script = {
    episode: 1, title: 't', seriesName: 't', totalDuration: '60s',
    shots: [
      mk(1, [], 'courtyard'),                    // establishing — no beat
      mk(2, ['BOB', 'ALICE'], 'courtyard'),      // beat A starts
      mk(3, ['BOB', 'ALICE'], 'courtyard'),      // beat A
      mk(4, ['BOB'], 'courtyard'),               // single char — breaks beat
      mk(5, ['BOB', 'ZED'], 'throne-room'),      // beat B (new location)
      mk(6, ['BOB', 'ZED'], 'throne-room', { storyboardRef: 'hand-set' }), // respected
    ],
  };
  const refs = planStoryboardBeats(script);
  ok('planner: 2 beats planned', refs.length === 2);
  ok('beat A covers shots 2-3', JSON.stringify(refs[0].shotIds) === '[2,3]');
  ok('beat A slug is episode-prefixed', refs[0].slug.startsWith('e01-beat-2'));
  ok('beat A characters are BOB + ALICE', refs[0].characters.length === 2);
  ok('shots 2-3 got storyboardRef', script.shots[1].storyboardRef === refs[0].slug && script.shots[2].storyboardRef === refs[0].slug);
  ok('single-char shot 4 got NO storyboardRef', script.shots[3].storyboardRef === undefined);
  ok('hand-set storyboardRef respected on shot 6', script.shots[5].storyboardRef === 'hand-set');
}

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} reference-slot check(s) failed.`);
  process.exit(1);
}
console.log('\nAll reference-slot checks passed.');
