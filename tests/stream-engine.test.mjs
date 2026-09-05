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
  STREAM_CHAIN_STEP_BACK_SEC,
  STREAM_CHAIN_FAILURES_BEFORE_RESET,
  STREAM_VIDEO_CHOICES,
  STREAM_DEFAULT_WRITER,
  buildStreamSystemPrompt,
  buildStreamUserPrompt,
} from '../dist/mini-drama/stream-engine.js';

// Per-beat cost of the default family at 15s (quote-derived, stream-choices.ts).
const BEAT = STREAM_VIDEO_CHOICES.find(v => v.id === 'minimax-h3-max-turbo').usdPer15s;
const budgetFor = n => n * BEAT + 1e-6;

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

let longFixture;
function realMp4Long() {
  if (longFixture) return longFixture;
  const dir = mkdtempSync(join(tmpdir(), 'stream-fixture-long-'));
  longFixture = join(dir, 'clip.mp4');
  // 5s test pattern: frames differ over time, so stepped-back frames differ.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=5:r=10', '-pix_fmt', 'yuv420p', longFixture]);
  return longFixture;
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
  // A budget of exactly 3 beats at the default family's quoted per-beat price.
  const { engine, calls } = makeEngine(dir, { budgetUsd: budgetFor(3) });
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
  assert.ok(Math.abs(st.spendUsd - 3 * BEAT) < 1e-6, 'spend counted per beat');
  assert.equal(st.model.writer, STREAM_DEFAULT_WRITER, 'the default writer is the fast bakeoff winner, not the project intelligence model');
  assert.equal(st.videoFamily, 'minimax-h3-max-turbo');
  assert.ok(existsSync(join(dir, 'episodes/episode-001/stream/stream-manifest.json')));
  assert.ok(existsSync(join(dir, 'episodes/episode-001/stream/beat-00002.json')));
});

test('the writer sees the story so far and recent beats; the prompt carries the beat and the sfx', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-writer-'));
  const { engine, calls, inputs } = makeEngine(dir, { budgetUsd: budgetFor(3), direction: 'laugh track after every joke' });
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
  const first = makeEngine(dir, { budgetUsd: budgetFor(2) });
  await first.engine.init();
  await first.engine.start();
  await waitForStop(first.engine);
  assert.equal(first.calls.length, 2);

  const second = makeEngine(dir, { budgetUsd: budgetFor(2) });
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
  const { engine, calls, inputs } = makeEngine(dir, { budgetUsd: budgetFor(2), openingBeat: opening });
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

test('prime renders the opening beat and then waits paused; start continues at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-prime-'));
  const { engine, calls, inputs } = makeEngine(dir, { budgetUsd: budgetFor(3) });
  await engine.init();
  const primed = await engine.prime();

  assert.equal(calls.length, 1, 'prime renders exactly one beat');
  assert.equal(calls[0].model, STREAM_MODEL_T2V);
  assert.equal(primed.beats.length, 1);
  assert.equal(primed.running, false, 'the stream is paused after priming');
  assert.equal(primed.status, 'idle');

  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'nothing else renders while paused');

  await engine.start();
  await waitForStop(engine);
  assert.equal(calls.length, 3, 'start renders the rest of the budget back to back');
  assert.equal(calls[1].model, STREAM_MODEL_I2V, 'the first started beat chains off the primed one');
  assert.equal(inputs[1].beatNumber, 2);

  // Priming again with beats on disk is a no-op.
  const again = await engine.prime();
  assert.equal(again.beats.length, 3);
  assert.equal(calls.length, 3);
});

test('a failed chained render keeps the written beat and steps back through the previous clip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-stepback-'));
  const fixture = realMp4Long();
  const calls = [];
  const inputs = [];
  let renderCount = 0;
  const flakyRender = async (_client, options) => {
    renderCount += 1;
    // Snapshot the start frame now: every retry overwrites the same path.
    calls.push({ model: options.prompt.model, outputPath: options.outputPath, frame: options.anchorImagePath ? readFileSync(options.anchorImagePath) : null });
    // Beat 2's first attempt dies "server-side"; the stepped-back retry succeeds.
    if (options.prompt.model === STREAM_MODEL_I2V && renderCount <= 2) throw new Error('An unknown error occurred');
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    execFileSync('cp', [fixture, options.outputPath]);
    return options.outputPath;
  };
  const series = makeSeries();
  series.outputDir = dir;
  const engine = new StreamEngine({
    client: {}, series, episode: 1, projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    // 3 render attempts (failed queues are billed too).
    log: () => {}, errorBackoffMs: 1, budgetUsd: budgetFor(3),
    render: flakyRender, author: scriptedAuthor(inputs),
  });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  // 1 t2v + 1 failed i2v + 1 successful i2v = 3 render calls, 2 beats on disk.
  assert.equal(calls.length, 3);
  assert.equal(engine.state().beats.length, 2, 'beat 2 landed on the second try');
  assert.equal(inputs.length, 2, 'the writer was NOT asked again for the retry — the text was kept');
  assert.equal(engine.state().lastError, undefined, 'a recovered stream carries no error');
  assert.equal(engine.state().beats[1].lane, 'i2v', 'a step-back that works is still a chained beat');

  // The retry used a different start frame (stepped back into beat 1).
  const frames = calls.slice(1).map(c => c.frame);
  assert.ok(frames.every(Boolean), 'every chained attempt had a start frame');
  assert.ok(!frames[0].equals(frames[1]), 'the retry stepped back to a different frame than the first attempt');
  assert.deepEqual(STREAM_CHAIN_STEP_BACK_SEC, [0, 0.5, 1.5, 3.0]);
});

test('when the chain keeps failing, the beat renders t2v as a soft reset instead of killing the stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-reset-'));
  const fixture = realMp4Long();
  const calls = [];
  const inputs = [];
  // Every i2v attempt dies (a face-filled start frame, anti-pattern 31). t2v works.
  const faceDeathRender = async (_client, options) => {
    calls.push({ model: options.prompt.model, prompt: options.prompt.prompt, anchor: options.anchorImagePath });
    if (options.prompt.model === STREAM_MODEL_I2V) throw new Error('An unknown error occurred');
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    execFileSync('cp', [fixture, options.outputPath]);
    return options.outputPath;
  };
  const series = makeSeries();
  series.outputDir = dir;
  const engine = new StreamEngine({
    client: {}, series, episode: 1, projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    // beat 1 t2v + 2 failed i2v + 1 t2v-reset = 4 billed renders.
    log: () => {}, errorBackoffMs: 1, budgetUsd: budgetFor(4),
    render: faceDeathRender, author: scriptedAuthor(inputs),
  });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(STREAM_CHAIN_FAILURES_BEFORE_RESET, 2);
  assert.deepEqual(calls.map(c => c.model), [STREAM_MODEL_T2V, STREAM_MODEL_I2V, STREAM_MODEL_I2V, STREAM_MODEL_T2V]);
  assert.equal(calls[3].anchor, undefined, 'the reset has no start frame');
  assert.match(calls[3].prompt, /same scene, same place, same people.*Summary 1\./, 'the reset restates the scene from the previous beat');

  const st = engine.state();
  assert.equal(st.beats.length, 2, 'the stream did not die and did not skip a beat');
  assert.deepEqual(st.beats.map(b => b.lane), ['t2v', 't2v-reset']);
  assert.equal(st.lastError, undefined);
  assert.equal(inputs.length, 2, 'the writer was not asked again for the reset');
});

test('the writer is told to end every beat wide, never on a human face', () => {
  const sys = buildStreamSystemPrompt(makeSeries());
  assert.match(sys, /Never end on a close-up of a human face/);
  assert.match(sys, /ENDS on a wide or medium-wide shot/);
});

test('configure switches the writer and the video family for the NEXT beat, and a resumed stream keeps them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-config-'));
  const calls = [];
  const inputs = [];
  const engine = new StreamEngine({
    client: {}, series: Object.assign(makeSeries(), { outputDir: dir }), episode: 1,
    projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    log: () => {}, errorBackoffMs: 1, budgetUsd: 100,
    render: recordingRender(calls, realMp4()), author: scriptedAuthor(inputs),
  });
  await engine.init();
  // Beat 1 on the defaults.
  await engine.prime();
  assert.equal(calls[0].model, 'minimax-h3-max-turbo-text-to-video');

  // Switch both. Family resolution snaps to the new family's draft tier.
  const st = await engine.configure({ writer: 'mistral-small-2603', videoFamily: 'wan-3-0' });
  assert.equal(st.model.writer, 'mistral-small-2603');
  assert.equal(st.videoFamily, 'wan-3-0');
  assert.equal(st.model.i2v, 'wan-3-0-image-to-video');
  assert.equal(st.resolution, '480p');

  // Unsupported resolution is refused; supported one is taken.
  assert.equal((await engine.configure({ resolution: '4K' })).resolution, '480p');
  assert.equal((await engine.configure({ resolution: '720p' })).resolution, '720p');

  // The next beat renders on the new family, chained off the old beat's frame.
  await engine.start({ budgetUsd: 100 });
  await new Promise(r => setTimeout(r, 300));
  await engine.stop();
  await waitForStop(engine);
  assert.ok(calls.length >= 2);
  assert.equal(calls[1].model, 'wan-3-0-image-to-video');
  assert.equal(calls[1].resolution, '720p');
  assert.ok(calls[1].anchor, 'family switch does not break the chain');

  // Resume: the manifest carries the models forward when the caller sets none.
  const resumed = new StreamEngine({
    client: {}, series: Object.assign(makeSeries(), { outputDir: dir }), episode: 1,
    projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    log: () => {}, errorBackoffMs: 1, render: recordingRender([], realMp4()), author: scriptedAuthor([]),
  });
  await resumed.init();
  assert.equal(resumed.state().model.writer, 'mistral-small-2603');
  assert.equal(resumed.state().videoFamily, 'wan-3-0');
  assert.equal(resumed.state().resolution, '720p');
  assert.ok(resumed.state().choices.writers.length > 3, 'choices ship in the manifest for the UI');
});
