// A dialogue line's approved recording (`dialogue.referenceAudio`): on a
// reference-audio model it goes as the speaker's @Audio clip, the words, voice
// and timing to re-perform, instead of the voice-donor clip that carries
// identity only. Covers singles and both montage grammars, and the generator's
// refusal to queue without a usable recording. No network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildVideoPrompt, buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';
import { resolveVoiceReferencePaths } from '../dist/mini-drama/video-generator.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MODEL = 'seedance-2-5-reference-to-video';
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dialogue-ref-audio-'));
  mkdirSync(join(dir, 'characters', 'vera'), { recursive: true });
  writeFileSync(join(dir, 'characters', 'vera', 'front.png'), PNG);
  writeFileSync(join(dir, 'characters', 'vera', 'three-quarter.png'), PNG);
  writeFileSync(join(dir, 'characters', 'vera', 'voice-reference.mp3'), Buffer.from('ID3'));
  const series = {
    name: 'Ref audio', slug: 'ref-audio', outputDir: dir, episodes: [], locations: [],
    characters: [{
      name: 'VERA', gender: 'female', age: '30s', description: 'a steward', fullDescription: 'VERA, a steward', wardrobe: 'a navy livery',
      voiceDescription: 'warm, clear', voiceReferencePath: 'characters/vera/voice-reference.mp3', locked: true, seed: 1,
    }],
    aesthetic: { style: 'film still', palette: 'cobalt', lighting: 'soft', lensCharacteristics: '35mm', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    videoDefaults: {
      actionModel: MODEL, atmosphereModel: MODEL, characterConsistencyModel: MODEL, montageMode: true,
      imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
    },
  };
  const shot = (n, fields = {}) => ({
    shotNumber: n, type: 'action', duration: '6s', videoModel: 'action', environment: 'DAY_EXTERIOR',
    description: `VERA in beat ${n}.`, characters: ['VERA'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', motion: 'high', ...fields,
  });
  return { dir, series, shot };
}

const recorded = { character: 'VERA', line: 'This is how credits work.', referenceAudio: 'vo/refs/shot-002.wav' };

test('a single with a recorded line binds @Audio1 as the line to re-perform, quoted exactly', () => {
  const { dir, series, shot } = fixture();
  try {
    const p = buildVideoPrompt(shot(2, { dialogue: recorded }), series);
    assert.equal(p.voiceReferenceSlots?.length, 1);
    assert.equal(p.voiceReferenceSlots[0].referenceAudio, 'vo/refs/shot-002.wav');
    assert.match(p.prompt, /@Audio1 is @Image1's line, already recorded: @Image1 speaks exactly these words/);
    assert.doesNotMatch(p.prompt, /only for voice identity/);
    assert.match(p.prompt, /: "This is how credits work\."/);
    assert.doesNotMatch(p.prompt, /conveys:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a recording the voice-donor binding is unchanged', () => {
  const { dir, series, shot } = fixture();
  try {
    const p = buildVideoPrompt(shot(2, { dialogue: { character: 'VERA', line: 'Hello.' } }), series);
    assert.equal(p.voiceReferenceSlots?.[0]?.referenceAudio, undefined);
    assert.match(p.prompt, /Use @Audio1 only for voice identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a montage binds the recording to its shot, in both grammars, and a narration-only shot gets none', () => {
  const { dir, series, shot } = fixture();
  try {
    const shots = [shot(1), shot(2, { dialogue: recorded })];
    const unit = {
      unitId: 'montage-s01-001-002', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'm.mp4', model: MODEL, duration: '12s',
      montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 6 }, { shotNumber: 2, startSec: 6, endSec: 12 }], decisionReasons: [],
    };
    for (const [montageGrammar, label] of [['shots', 'shot 2'], ['sequence', 'the beat at 0:06']]) {
      const p = buildMontagePrompt(shots, unit, { ...series, videoDefaults: { ...series.videoDefaults, montageGrammar } });
      assert.equal(p.voiceReferenceSlots?.length, 1, montageGrammar);
      assert.equal(p.voiceReferenceSlots[0].shotLabel, label, montageGrammar);
      assert.ok(p.prompt.includes(`@Audio1 is @Image1's line in ${label}, already recorded`), montageGrammar);
      assert.doesNotMatch(p.prompt, /only for @Image1's voice identity/, montageGrammar);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generator refuses to queue a recorded line it cannot send', { skip: !HAS_FFMPEG && 'needs ffmpeg and ffprobe' }, () => {
  const { dir, series } = fixture();
  try {
    mkdirSync(join(dir, 'vo', 'refs'), { recursive: true });
    const wav = (name, sec) => {
      const out = join(dir, 'vo', 'refs', name);
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(sec), '-c:a', 'pcm_s16le', out]);
      return `vo/refs/${name}`;
    };
    const prompt = referenceAudio => ({ voiceReferenceSlots: [{ characterName: 'VERA', audioIndex: 1, referenceAudio, shotLabel: 'shot 2' }] });

    assert.throws(() => resolveVoiceReferencePaths(series, prompt('vo/refs/missing.wav')), /recorded line for VERA in shot 2 is missing/);
    assert.throws(() => resolveVoiceReferencePaths(series, prompt(wav('short.wav', 1))), /reference audio runs 2-15 s/);
    assert.deepEqual(resolveVoiceReferencePaths(series, prompt(wav('ok.wav', 6))), [join(dir, 'vo', 'refs', 'ok.wav')]);

    const two = { voiceReferenceSlots: [
      { characterName: 'VERA', audioIndex: 1, referenceAudio: wav('a.wav', 9) },
      { characterName: 'VERA', audioIndex: 2, referenceAudio: wav('b.wav', 9) },
    ] };
    assert.throws(() => resolveVoiceReferencePaths(series, two), /over the 15 s per render/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
