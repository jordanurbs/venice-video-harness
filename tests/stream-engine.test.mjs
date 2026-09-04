// Stream engine coverage: the infinite live-authored story.
//
// Both primitives (writer and renderer) are injectable, so the chain is
// exercised offline: no network, no spend. A real mp4 fixture is used where a
// last frame must actually be extracted (ffmpeg on PATH).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  StreamEngine,
  STREAM_MODEL_T2V,
  STREAM_MODEL_I2V,
  buildStreamSystemPrompt,
  buildStreamUserPrompt,
} from '../dist/mini-drama/stream-engine.js';

function makeSeries() {
  return {
    name: 'Stream Test', slug: 'stream-test', concept: 'a baker and a robot', genre: 'comedy', setting: 'a bakery',
    outputDir: '', aesthetic: { style: '90s sitcom', palette: 'pastel', lighting: 'flat' },
    characters: [{ name: 'WALT', description: 'a baker', wardrobe: 'apron' }, { name: 'CRUMB', description: 'a robot' }],
    locations: [], episodes: [{ number: 1, title: 'One', status: 'approved' }],
    videoDefaults: {
      actionModel: 'seedance-2-0-enhanced-reference-to-video',
      atmosphereModel: 'seedance-2-0-enhanced-reference-to-video',
      characterConsistencyModel: 'seedance-2-0-enhanced-reference-to-video',
    },
  };
}

/** A writer that returns a numbered beat and records what it was given. */
function scriptedAuthor(inputs) {
  return async (input) => {
    inputs.push(input);
    return {
      description: `Beat ${input.beatNumber}: something happens.`,
      characters: ['walt'],
      dialogue: { character: 'crumb', line: `Line ${input.beatNumber}.` },
      sfx: 'laugh track',
      cameraMovement: 'static',
      summary: `Summary ${input.beatNumber}.`,
    };
  };
}

function recordingRender(calls, fixture) {
  return async (_client, options) => {
    calls.push({
      model: options.prompt.model,
      prompt: options.prompt.prompt,
      outputPath: options.outputPath,
      anchor: options.anchorImagePath,
      resolution: options.resolution,
    });
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    if (fixture) execFileSync('cp', [fixture, options.outputPath]);
    else writeFileSync(options.outputPath, 'stub');
    return options.outputPath;
  };
}

let fixture;
function realMp4() {
  if (fixture) return fixture;
  const dir = mkdtempSync(join(tmpdir(), 'stream-fixture-'));
  fixture = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-pix_fmt', 'yuv420p', fixture]);
  return fixture;
}

function makeEngine(dir, extra = {}, useFixture = true) {
  const series = makeSeries();
  series.outputDir = dir;
  const calls = [];
  const inputs = [];
  const engine = new StreamEngine({
    client: {}, series, episode: 1,
    projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    log: () => {}, errorBackoffMs: 1,
    render: recordingRender(calls, useFixture ? realMp4() : undefined),
    author: scriptedAuthor(inputs),
    ...extra,
  });
  return { engine, calls, inputs };
}

async function waitForStop(engine, timeoutMs = 10000) {
  const start = Date.now();
  while (engine.state().running) {
    if (Date.now() - start > timeoutMs) throw new Error('engine did not stop in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('beat 1 is t2v, every later beat is i2v off the previous last frame, in order, never repeating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-chain-'));
  // 15s Turbo @ $0.012/s = $0.18/beat; $0.60 buys exactly 3 beats.
  const { engine, calls } = makeEngine(dir, { budgetUsd: 0.6 });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 3, 'three beats within the budget');
  assert.equal(calls[0].model, STREAM_MODEL_T2V, 'opening beat is t2v');
  assert.equal(calls[0].anchor, undefined, 'opening beat has no start frame');
  for (const c of calls.slice(1)) {
    assert.equal(c.model, STREAM_MODEL_I2V, 'later beats are i2v');
    assert.ok(c.anchor && existsSync(c.anchor), 'later beats have an extracted start frame on disk');
  }
  const names = calls.map(c => c.outputPath.match(/beat-(\d+)\.mp4$/)[1]);
  assert.deepEqual(names, ['00001', '00002', '00003'], 'beats are numbered forward; none repeats');

  const st = engine.state();
  assert.equal(st.beats.length, 3);
  assert.deepEqual(st.beats.map(b => b.lane), ['t2v', 'i2v', 'i2v']);
  assert.ok(Math.abs(st.spendUsd - 0.54) < 1e-6, 'spend counted per beat');
  assert.ok(existsSync(join(dir, 'episodes/episode-001/stream/stream-manifest.json')));
  assert.ok(existsSync(join(dir, 'episodes/episode-001/stream/beat-00002.json')));
});

test('the writer sees the story so far and recent beats; the prompt carries the beat and the sfx', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-writer-'));
  const { engine, calls, inputs } = makeEngine(dir, { budgetUsd: 0.6, direction: 'laugh track after every joke' });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(inputs.length, 3);
  assert.equal(inputs[0].storySoFar, '', 'opening beat has no memory');
  assert.equal(inputs[0].recentBeats.length, 0);
  assert.match(inputs[2].storySoFar, /1\. Summary 1\.\n2\. Summary 2\./, 'story-so-far accumulates one line per beat');
  assert.equal(inputs[2].recentBeats.length, 2);
  assert.equal(inputs[2].direction, 'laugh track after every joke');

  assert.match(calls[1].prompt, /Beat 2: something happens/, 'video prompt carries the authored description');
  assert.match(calls[1].prompt, /laugh track/i, 'video prompt carries the sfx');
  assert.match(calls[1].prompt, /Line 2/, 'video prompt carries the dialogue intent');

  const story = readFileSync(join(dir, 'episodes/episode-001/stream/story-so-far.md'), 'utf-8');
  assert.equal(story, '1. Summary 1.\n2. Summary 2.\n3. Summary 3.\n');

  // Character names are normalized to the locked cast's spelling.
  const st = engine.state();
  assert.deepEqual(st.beats[0].beat.characters, ['WALT', 'CRUMB']);
  assert.equal(st.beats[0].beat.dialogue.character, 'CRUMB');
});

test('resume continues from the last beat on disk and chains off it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-resume-'));
  const first = makeEngine(dir, { budgetUsd: 0.36 });
  await first.engine.init();
  await first.engine.start();
  await waitForStop(first.engine);
  assert.equal(first.calls.length, 2);

  const second = makeEngine(dir, { budgetUsd: 0.36 });
  await second.engine.init();
  assert.equal(second.engine.state().beats.length, 2, 'prior beats are loaded');
  await second.engine.start(); // budget was reached -> start grants one more budget
  await waitForStop(second.engine);

  assert.equal(second.calls.length, 2, 'two more beats');
  assert.equal(second.calls[0].model, STREAM_MODEL_I2V, 'resumed beat chains, it does not restart with t2v');
  assert.match(second.calls[0].outputPath, /beat-00003\.mp4$/);
  assert.equal(second.inputs[0].beatNumber, 3);
  assert.equal(second.inputs[0].recentBeats.length, 2, 'the writer sees the beats from the prior run');
});

test('stops after three consecutive failures and never skips a beat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-fail-'));
  let attempts = 0;
  const failingRender = async () => { attempts += 1; throw new Error('boom'); };
  const { engine } = makeEngine(dir, { budgetUsd: 100, render: failingRender });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(attempts, 3);
  const st = engine.state();
  assert.equal(st.beats.length, 0, 'no beat was recorded');
  assert.equal(st.status, 'idle');
  assert.match(st.lastError, /render: boom/);
});

test('an opening beat is used verbatim for beat 1 and the writer starts at beat 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-open-'));
  const opening = {
    description: 'Cold open. Walt flips the sign to OPEN.', characters: ['WALT'], dialogue: null,
    sfx: 'applause', cameraMovement: 'static wide', summary: 'The bakery opens.',
  };
  const { engine, calls, inputs } = makeEngine(dir, { budgetUsd: 0.36, openingBeat: opening });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /flips the sign to OPEN/);
  assert.equal(inputs.length, 1, 'the writer was asked once');
  assert.equal(inputs[0].beatNumber, 2);
  assert.equal(inputs[0].recentBeats[0].beat.summary, 'The bakery opens.');
});

test('prompts name the cast, the standing direction, and the continuity rule', () => {
  const series = makeSeries();
  const sys = buildStreamSystemPrompt(series, 'laugh track');
  assert.match(sys, /WALT/);
  assert.match(sys, /CRUMB/);
  assert.match(sys, /STANDING DIRECTION.*laugh track/);
  assert.match(sys, /begins EXACTLY where the previous beat ended/);
  const user = buildStreamUserPrompt({ series, beatNumber: 1, storySoFar: '', recentBeats: [] });
  assert.match(user, /opening beat/);
  assert.match(user, /Write beat 1\./);
});
