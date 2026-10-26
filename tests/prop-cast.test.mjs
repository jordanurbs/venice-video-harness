// Prop cast members (`Character.prop`): an object with a locked design (a red
// umbrella, a ledger) rides the character reference slots, but its role
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
  for (const slug of ['iris', 'green-ledger']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', slug, 'three-quarter.png'), PNG);
  }
  const base = { gender: 'female', age: '40', description: '', voiceDescription: '', locked: true, seed: 1 };
  const series = {
    name: 'Prop test', slug: 'prop-test', outputDir: dir, episodes: [], locations: [],
    characters: [
      { ...base, name: 'IRIS', fullDescription: 'A bookkeeper.', wardrobe: 'a mustard cardigan' },
      { ...base, name: 'GREEN LEDGER', gender: 'other', prop: true, baseTraits: 'object: a ledger', fullDescription: 'A cloth-bound green ledger.', wardrobe: 'n/a' },
    ],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    videoDefaults: { montageMode: true },
  };
  const shot = { shotNumber: 1, type: 'close-up', duration: '5s', videoModel: 'action', description: 'IRIS opens the GREEN LEDGER.', characters: ['IRIS', 'GREEN LEDGER'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' };
  return { dir, series, shot };
}

const unit = { unitId: 'montage-s01-001-001', unitType: 'montage', shotNumbers: [1], outputFile: 'm.mp4', model: 'seedance-2-5-reference-to-video', duration: '5s', montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }], decisionReasons: [] };

test('slot planner gives a prop the object clause and keeps the person clause for people', () => {
  const { dir, series, shot } = fixture();
  try {
    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
    const ledger = plan.slots.filter(s => s.label === 'GREEN LEDGER');
    const iris = plan.slots.find(s => s.label === 'IRIS' && s.kind === 'character-primary');
    assert.match(ledger.find(s => s.kind === 'character-primary').roleClause, /an object, not a person/);
    assert.match(ledger.find(s => s.kind === 'character-angle').roleClause, /same object/);
    assert.doesNotMatch(ledger.map(s => s.roleClause).join(' '), /face, hair/);
    assert.match(iris.roleClause, /face, hair, and wardrobe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an object cast member the workshop made (traits "inanimate object") is an object too, and THE names keep one article', () => {
  const { dir, series } = fixture();
  try {
    mkdirSync(join(dir, 'characters', 'the-rowboat'), { recursive: true });
    writeFileSync(join(dir, 'characters', 'the-rowboat', 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', 'the-rowboat', 'three-quarter.png'), PNG);
    series.characters.push({
      name: 'THE ROWBOAT', gender: 'other', age: 'n/a', description: 'a small blue rowboat with white oars', fullDescription: 'A pond rowboat.',
      wardrobe: 'n/a', voiceDescription: 'n/a (inanimate object)', locked: true, seed: 3,
      baseTraits: 'inanimate object, prop; a small blue rowboat with white oars; shown alone on a neutral background',
    });
    const shot = { shotNumber: 1, type: 'action', duration: '5s', videoModel: 'action', description: 'IRIS rows THE ROWBOAT across the pond.', characters: ['IRIS', 'THE ROWBOAT'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' };
    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
    const boat = plan.slots.filter(s => s.label === 'THE ROWBOAT');
    assert.match(boat.find(s => s.kind === 'character-primary').roleClause, /^is THE ROWBOAT — an object, not a person/);
    assert.match(boat.find(s => s.kind === 'character-angle').roleClause, /^is a second view of THE ROWBOAT — the same object/);

    const { prompt } = buildMontagePrompt([shot], unit, series);
    assert.match(prompt, /is THE ROWBOAT, an object, not a person.*Exactly one ROWBOAT in this scene, and no other boats/);
    assert.doesNotMatch(prompt, /the THE|THE ROWBOAT — wearing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('montage identity line names a prop as an object, not "wearing n/a", in both grammars', () => {
  const { dir, series, shot } = fixture();
  try {
    for (const montageGrammar of ['shots', 'sequence']) {
      const { prompt } = buildMontagePrompt([shot], unit, { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar } });
      assert.match(prompt, /is the GREEN LEDGER, an object, not a person/, montageGrammar);
      assert.doesNotMatch(prompt, /GREEN LEDGER — wearing/, montageGrammar);
      assert.match(prompt, /is IRIS — wearing a mustard cardigan/, montageGrammar);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
