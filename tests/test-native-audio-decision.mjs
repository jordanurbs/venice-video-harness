#!/usr/bin/env node
// Tests for buildVideoPrompt's audio decision (W1.2).
// Verifies NARRATOR shots get audio: false, suppressModelNarration gates all
// dialogue, and per-shot nativeAudio overrides win.
// Run with `node tests/test-native-audio-decision.mjs` after `npm run build`.

import { buildVideoPrompt } from '../dist/mini-drama/prompt-builder.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

const aesthetic = {
  style: 'cinematic nature documentary, photorealistic',
  palette: 'mossy greens, slate blues',
  lighting: 'soft overcast',
};
const series = {
  name: 'test', slug: 'test', concept: '', genre: '', setting: '',
  aesthetic, characters: [
    { name: 'NARRATOR', gender: 'male', age: '50s', description: '', fullDescription: '', wardrobe: '',
      voiceDescription: '', locked: true, seed: 1 },
    { name: 'FOUNDER', gender: 'male', age: '40s', description: '', fullDescription: '', wardrobe: '',
      voiceDescription: '', locked: true, seed: 2 },
  ],
  episodes: [],
  videoDefaults: { actionModel: 'seedance-2-0-image-to-video', atmosphereModel: 'seedance-2-0-image-to-video' },
  outputDir: '/tmp', createdAt: '', updatedAt: '',
};

function makeShot(overrides = {}) {
  return {
    shotNumber: 1,
    type: 'establishing',
    duration: '8s',
    videoModel: 'atmosphere',
    description: 'wide shot of a cul-de-sac',
    characters: [],
    dialogue: null,
    sfx: null,
    cameraMovement: 'static',
    transition: 'CUT',
    ...overrides,
  };
}

// Narrator shot -> audio stays TRUE (ambient + SFX wanted; the VO line never
// reaches the prompt, so there is no competing narrator to suppress — see the
// audio-decision comment in buildVideoPrompt). Muting requires
// suppressModelNarration or nativeAudio:'mute'.
{
  const shot = makeShot({
    dialogue: { character: 'NARRATOR', line: 'Here, in suburban Bellevue...', delivery: '' },
  });
  const p = buildVideoPrompt(shot, series);
  ok('NARRATOR shot: audio=true (ambient kept; VO line withheld from prompt)', p.audio === true);
  ok('NARRATOR shot: prompt withholds the VO line', !p.prompt.includes('suburban Bellevue'));
  ok('NARRATOR shot: prompt declares no spoken words', /No narration, no voice-over/.test(p.prompt));
}

// On-camera dialogue -> audio defaults to true (model is expected to lip-sync).
{
  const shot = makeShot({
    characters: ['FOUNDER'],
    dialogue: { character: 'FOUNDER', line: 'I did the math', delivery: '' },
  });
  const p = buildVideoPrompt(shot, series);
  ok('On-camera FOUNDER dialogue: audio=true', p.audio === true);
}

// episodeAudioMix.suppressModelNarration -> every dialogue shot audio=false.
{
  const shot = makeShot({
    characters: ['FOUNDER'],
    dialogue: { character: 'FOUNDER', line: 'I did the math', delivery: '' },
  });
  const p = buildVideoPrompt(shot, series, undefined, { suppressModelNarration: true });
  ok('suppressModelNarration silences FOUNDER dialogue', p.audio === false);
}

// Per-shot nativeAudio: 'mute' wins.
{
  const shot = makeShot({
    characters: ['FOUNDER'],
    dialogue: { character: 'FOUNDER', line: 'I did the math', delivery: '' },
    nativeAudio: 'mute',
  });
  const p = buildVideoPrompt(shot, series);
  ok('nativeAudio=mute forces audio=false', p.audio === false);
}

// Per-shot nativeAudio: 'keep' overrides the NARRATOR auto-mute.
{
  const shot = makeShot({
    dialogue: { character: 'NARRATOR', line: 'voiceover', delivery: '' },
    nativeAudio: 'keep',
  });
  const p = buildVideoPrompt(shot, series);
  ok('nativeAudio=keep beats NARRATOR auto-mute', p.audio === true);
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
