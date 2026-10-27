// A face-hidden person (`Character.faceHidden`): an unseen figure who is only
// ever a back, a reflection or a shape. Their sheets are drawn from behind and
// in shadow, with the face in the negative prompt, and their reference slot and
// montage identity line keep the face out of frame. No network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';
import { buildCharacterReferencePromptParts, buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';
import { isFaceHidden } from '../packages/core/dist/series/types.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const AESTHETIC = { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' };
const base = { gender: 'male', age: '50', description: '', voiceDescription: '', locked: true, seed: 1 };
const COAT = { ...base, name: 'THE GREY COAT', faceHidden: true, fullDescription: 'A tall man.', wardrobe: 'a seamless mid-grey coat and grey leather gloves' };
const NADIA = { ...base, gender: 'female', name: 'NADIA', fullDescription: 'A journalist.', wardrobe: 'a sand-coloured coat' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'face-hidden-'));
  for (const slug of ['the-grey-coat', 'nadia']) {
    mkdirSync(join(dir, 'characters', slug), { recursive: true });
    writeFileSync(join(dir, 'characters', slug, 'front.png'), PNG);
    writeFileSync(join(dir, 'characters', slug, 'three-quarter.png'), PNG);
  }
  const series = {
    name: 'Face test', slug: 'face-test', outputDir: dir, episodes: [], locations: [],
    characters: [COAT, NADIA], aesthetic: AESTHETIC, videoDefaults: { montageMode: true },
  };
  const shot = { shotNumber: 1, type: 'medium', duration: '5s', videoModel: 'action', description: 'THE GREY COAT follows NADIA across the bridge.', characters: ['THE GREY COAT', 'NADIA'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT' };
  return { dir, series, shot };
}

test('a face-hidden person gets sheets from behind and in shadow, with the face in the negative', () => {
  for (const angle of ['front', 'three-quarter', 'profile', 'full-body']) {
    const { positive, negativeAdditions } = buildCharacterReferencePromptParts(COAT, AESTHETIC, angle, { model: 'gpt-image-2' });
    assert.doesNotMatch(positive, /looking at camera|front portrait/, angle);
    assert.match(positive, /face not visible|no readable features/, angle);
    assert.ok(negativeAdditions.includes('face') && negativeAdditions.includes('looking at camera'), angle);
  }
  // The face guard holds even when the project turns negative additions off.
  const none = buildCharacterReferencePromptParts(COAT, AESTHETIC, 'front', { model: 'gpt-image-2', negativePromptStrategy: 'none' });
  assert.ok(none.negativeAdditions.includes('face'));
  // Everyone else keeps the portrait ladder and no face guard.
  const plain = buildCharacterReferencePromptParts(NADIA, AESTHETIC, 'front', { model: 'gpt-image-2' });
  assert.match(plain.positive, /front portrait, looking at camera/);
  assert.ok(!plain.negativeAdditions.includes('face'));
});

test('an object cast member is never face-hidden, whatever the flag says', () => {
  const prop = { ...base, name: 'THE TRAY', gender: 'other', prop: true, faceHidden: true, fullDescription: 'A steel tray.', wardrobe: 'n/a' };
  assert.equal(isFaceHidden(prop), false);
  assert.equal(isFaceHidden(COAT), true);
  assert.equal(isFaceHidden({ ...COAT, faceHidden: 'yes' }), false);
  const { positive } = buildCharacterReferencePromptParts(prop, AESTHETIC, 'front', { model: 'gpt-image-2' });
  assert.match(positive, /product photograph of a single object/);
});

test('the reference slot asks for build, hair and wardrobe, and keeps the face out of frame', () => {
  const { dir, series, shot } = fixture();
  try {
    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
    const coat = plan.slots.find(s => s.label === 'THE GREY COAT' && s.kind === 'character-primary');
    const coatAngle = plan.slots.find(s => s.label === 'THE GREY COAT' && s.kind === 'character-angle');
    const nadia = plan.slots.find(s => s.label === 'NADIA' && s.kind === 'character-primary');
    assert.match(coat.roleClause, /build, hair, and wardrobe/);
    assert.match(coat.roleClause, /face is never shown.*never a frontal view of the face/);
    assert.doesNotMatch(coat.roleClause, /face, hair/);
    assert.match(coatAngle.roleClause, /face never shown/);
    assert.match(nadia.roleClause, /face, hair, and wardrobe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the montage identity line keeps the face out of frame, in both grammars', () => {
  const { dir, series, shot } = fixture();
  const unit = { unitId: 'montage-s01-001-001', unitType: 'montage', shotNumbers: [1], outputFile: 'm.mp4', model: 'seedance-2-5-reference-to-video', duration: '5s', montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }], decisionReasons: [] };
  try {
    for (const montageGrammar of ['shots', 'sequence']) {
      const { prompt } = buildMontagePrompt([shot], unit, { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar } });
      assert.match(prompt, /THE GREY COAT's face is never shown/, montageGrammar);
      assert.doesNotMatch(prompt, /NADIA's face is never shown/, montageGrammar);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
