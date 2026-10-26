// Prop cast members (`Character.prop`): an object with a locked design (a
// watch, a coin, a cage) rides the character reference slots, but its role
// clause asks for shape, materials and marks, never "face, hair, and wardrobe".
// Covers the slot planner and the montage identity line in both grammars.
// No network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';
import { buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prop-cast-'));
  for (const slug of ['leo', 'brass-compass']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', slug, 'three-quarter.png'), PNG);
  }
  const base = { gender: 'male', age: '40', description: '', voiceDescription: '', locked: true, seed: 1 };
  const series = {
    name: 'Prop test', slug: 'prop-test', outputDir: dir, episodes: [], locations: [],
    characters: [
      { ...base, name: 'LEO', fullDescription: 'A steward.', wardrobe: 'navy livery' },
      { ...base, name: 'BRASS COMPASS', gender: 'other', prop: true, baseTraits: 'object: a pocket compass', fullDescription: 'A brass pocket compass.', wardrobe: 'n/a' },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    videoDefaults: { montageMode: true },
  };
  const shot = { shotNumber: 1, type: 'close-up', duration: '5s', videoModel: 'action', description: 'LEO raises the BRASS COMPASS.', characters: ['LEO', 'BRASS COMPASS'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' };
  return { dir, series, shot };
}

test('slot planner gives a prop the object clause and keeps the person clause for people', () => {
  const { dir, series, shot } = fixture();
  try {
    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
    const compass = plan.slots.filter(s => s.label === 'BRASS COMPASS');
    const leo = plan.slots.find(s => s.label === 'LEO' && s.kind === 'character-primary');
    assert.match(compass.find(s => s.kind === 'character-primary').roleClause, /an object, not a person/);
    assert.match(compass.find(s => s.kind === 'character-angle').roleClause, /same object/);
    assert.doesNotMatch(compass.map(s => s.roleClause).join(' '), /face, hair/);
    assert.match(leo.roleClause, /face, hair, and wardrobe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an object cast member the workshop made (traits "inanimate object") is an object too, and THE names keep one article', () => {
  const { dir, series } = fixture();
  try {
    mkdirSync(join(dir, 'characters', 'the-launch'), { recursive: true });
    writeFileSync(join(dir, 'characters', 'the-launch', 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', 'the-launch', 'three-quarter.png'), PNG);
    series.characters.push({
      name: 'THE LAUNCH', gender: 'other', age: 'n/a', description: 'a varnished wooden motor launch', fullDescription: 'A wooden launch.',
      wardrobe: 'n/a', voiceDescription: 'n/a (inanimate object)', locked: true, seed: 3,
      baseTraits: 'inanimate object, prop; a varnished wooden motor launch; shown alone on a neutral background',
    });
    const shot = { shotNumber: 1, type: 'action', duration: '5s', videoModel: 'action', description: 'LEO steps down into THE LAUNCH.', characters: ['LEO', 'THE LAUNCH'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' };
    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
    const launch = plan.slots.filter(s => s.label === 'THE LAUNCH');
    assert.match(launch.find(s => s.kind === 'character-primary').roleClause, /^is THE LAUNCH — an object, not a person/);
    assert.match(launch.find(s => s.kind === 'character-angle').roleClause, /^is a second view of THE LAUNCH — the same object/);

    const unit = { unitId: 'montage-s01-001-001', unitType: 'montage', shotNumbers: [1], outputFile: 'm.mp4', model: 'seedance-2-5-reference-to-video', duration: '5s', montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }], decisionReasons: [] };
    const { prompt } = buildMontagePrompt([shot], unit, series);
    assert.match(prompt, /is THE LAUNCH, an object, not a person.*Exactly one LAUNCH in this scene, and no other boats/);
    assert.doesNotMatch(prompt, /the THE|THE LAUNCH — wearing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('montage identity line names a prop as an object, not "wearing n/a", in both grammars', () => {
  const { dir, series, shot } = fixture();
  try {
    const unit = { unitId: 'montage-s01-001-001', unitType: 'montage', shotNumbers: [1], outputFile: 'm.mp4', model: 'seedance-2-5-reference-to-video', duration: '5s', montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }], decisionReasons: [] };
    for (const montageGrammar of ['shots', 'sequence']) {
      const { prompt } = buildMontagePrompt([shot], unit, { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar } });
      assert.match(prompt, /is the BRASS COMPASS, an object, not a person/, montageGrammar);
      assert.doesNotMatch(prompt, /BRASS COMPASS — wearing/, montageGrammar);
      assert.match(prompt, /is LEO — wearing navy livery/, montageGrammar);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
