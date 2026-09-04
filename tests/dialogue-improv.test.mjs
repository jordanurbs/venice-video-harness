// MiniMax H3 Max (simple-prompt) dialogue improvisation.
//
// Simple-prompt models should be given the scripted line as INTENT and invited
// to improvise ("conveys:"), while directorial models (Seedance, Wan, Kling)
// keep the exact quote. Exact-lip-sync always keeps the exact line because the
// audio drives the words.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVideoPrompt } from '../dist/mini-drama/prompt-builder.js';

function seriesFor(model, audioStrategy) {
  return {
    name: 'Improv Test', slug: 'improv-test', concept: 'x', genre: 'drama', setting: 's',
    outputDir: '', aesthetic: { style: 'grainy 16mm noir', palette: 'amber and teal', lighting: 'low-key' },
    characters: [], locations: [],
    episodes: [{ number: 1, title: 'One', status: 'approved' }],
    videoDefaults: {
      actionModel: model,
      atmosphereModel: model,
      characterConsistencyModel: model,
      ...(audioStrategy ? { audioStrategy } : {}),
    },
  };
}

// No characters keeps the shot on the atmosphere lane (no reference-slot
// machinery), but the dialogue block still runs for a named speaker.
const shot = {
  shotNumber: 1, type: 'dialogue', duration: '6s', videoModel: 'atmosphere',
  description: 'A figure lingers at the door.', characters: [],
  dialogue: { character: 'BOB', line: 'We have to leave now.', delivery: 'urgent whisper' },
  sfx: null, cameraMovement: 'static', transition: 'cut',
};

const TURBO = 'minimax-h3-max-turbo-text-to-video';
const MAX = 'minimax-h3-max-text-to-video';
const SEEDANCE = 'seedance-2-0-enhanced-reference-to-video';

test('MiniMax H3 Max (Turbo) gets the line as improvisable intent', () => {
  const p = buildVideoPrompt(shot, seriesFor(TURBO)).prompt;
  assert.ok(p.includes('conveys: "We have to leave now."'), 'line rendered as intent');
  assert.ok(p.includes('Improvise the spoken dialogue'), 'improv note present');
  assert.ok(!p.includes(']: "We have to leave now."'), 'not an exact directorial quote');
});

test('MiniMax H3 Max (non-Turbo) also improvises', () => {
  const p = buildVideoPrompt(shot, seriesFor(MAX)).prompt;
  assert.ok(p.includes('conveys: "We have to leave now."'));
  assert.ok(p.includes('Improvise the spoken dialogue'));
});

test('Seedance keeps the exact scripted line, no improv note', () => {
  const p = buildVideoPrompt(shot, seriesFor(SEEDANCE)).prompt;
  assert.ok(p.includes(': "We have to leave now."'), 'exact line quoted');
  assert.ok(!p.includes('conveys:'), 'no improv framing for directorial models');
  assert.ok(!p.includes('Improvise the spoken dialogue'), 'no improv note');
});

test('exact-lip-sync keeps the exact line even on a simple-prompt model', () => {
  const p = buildVideoPrompt(shot, seriesFor(MAX, 'lip-sync')).prompt;
  assert.ok(!p.includes('conveys:'), 'lip-sync means the audio drives the exact words');
  assert.ok(!p.includes('Improvise the spoken dialogue'));
});
