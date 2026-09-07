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
  exportStreamJson,
  exportStreamMarkdown,
  buildStreamSystemPrompt,
  buildStreamUserPrompt,
  makeScriptedAuthor,
  parseScriptedBeats,
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

async function waitUntil(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/** A one-shot gate: the render awaits `p` until `release()` is called. */
function makeGate() {
  let release;
  const p = new Promise(r => { release = r; });
  return { p, release: () => release() };
}

/** A render that holds the FIRST call until the gate opens, so the writer can be seen filling ahead. */
function gatedRender(gate) {
  let calls = 0;
  const render = async (_client, options) => {
    calls += 1;
    if (calls === 1) await gate.p;
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    execFileSync('cp', [realMp4(), options.outputPath]);
    return options.outputPath;
  };
  render.started = () => calls >= 1;
  return render;
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
  assert.equal(inputs.filter(i => i.beatNumber === 2).length, 1, 'beat 2 was authored exactly once — the retry reused the buffered text, it did not re-ask the writer');
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
  assert.equal(inputs.filter(i => i.beatNumber === 2).length, 1, 'beat 2 was authored exactly once — the t2v reset reused the buffered text, it did not re-ask the writer');
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

test('every beat records the exact video prompt; export renders it as JSON and Markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-export-'));
  const { engine, calls } = makeEngine(dir, { budgetUsd: budgetFor(2), direction: 'laugh track' });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  const st = engine.state();
  assert.equal(st.beats.length, 2);
  for (const [i, b] of st.beats.entries()) {
    assert.ok(b.render, `beat ${b.n} carries its render record`);
    assert.equal(b.render.model, calls[i].model);
    assert.equal(b.render.prompt, calls[i].prompt, 'the recorded prompt is byte-for-byte what was sent');
    assert.equal(b.render.duration, '15s');
  }
  assert.equal(st.beats[0].render.startFrame, undefined, 't2v has no start frame');
  assert.match(st.beats[1].render.startFrame, /beat-00002-start\.png$/, 'i2v records its project-relative start frame');

  // The sidecar on disk has it too.
  const sidecar = JSON.parse(readFileSync(join(dir, 'episodes/episode-001/stream/beat-00002.json'), 'utf-8'));
  assert.equal(sidecar.render.prompt, calls[1].prompt);

  const series = Object.assign(makeSeries(), { outputDir: dir });
  const json = JSON.parse(exportStreamJson(st, series));
  assert.equal(json.beats.length, 2);
  assert.equal(json.beats[1].render.prompt, calls[1].prompt);
  assert.equal(json.stream.writer, STREAM_DEFAULT_WRITER);
  assert.match(json.writerSystemPrompt, /STANDING DIRECTION.*laugh track/);

  const md = exportStreamMarkdown(st, series);
  assert.match(md, /^# Stream Test — Stream Prompts/);
  assert.match(md, /### Beat 1 — t2v/);
  assert.match(md, /### Beat 2 — i2v/);
  assert.ok(md.includes(calls[1].prompt), 'markdown carries the full prompt verbatim');
  assert.match(md, /\*\*Full video prompt\*\*/);
});

test('a resumed stream backfills render prompts from recipe sidecars written before the field existed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-backfill-'));
  const { engine } = makeEngine(dir, { budgetUsd: budgetFor(1) });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  // Simulate a pre-2.22.1 manifest: strip `render`, and write the recipe the
  // video generator would have written.
  const manifestPath = join(dir, 'episodes/episode-001/stream/stream-manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const original = m.beats[0].render.prompt;
  delete m.beats[0].render;
  writeFileSync(manifestPath, JSON.stringify(m));
  writeFileSync(join(dir, 'episodes/episode-001/stream/beat-00001.recipe.json'), JSON.stringify({
    asset: 'beat-00001.mp4',
    passes: [{ kind: 'video-generate', role: 'content', model: 'minimax-h3-max-turbo-text-to-video', prompt: original, resolution: '480P', duration: '15s' }],
  }));

  const resumed = makeEngine(dir, { budgetUsd: budgetFor(1) }).engine;
  await resumed.init();
  assert.equal(resumed.state().beats[0].render?.prompt, original);
  assert.equal(resumed.state().beats[0].render?.model, 'minimax-h3-max-turbo-text-to-video');
});

// ---- Pre-written beats (--beats-file) --------------------------------------

function scriptedBeat(n) {
  return {
    description: `Scripted beat ${n}: the robot refills the coffee.`,
    characters: ['WALT'],
    dialogue: { character: 'CRUMB', line: `Scripted line ${n}.`, delivery: 'deadpan' },
    sfx: 'studio audience laugh',
    cameraMovement: 'static wide',
    summary: `Scripted summary ${n}.`,
  };
}

test('pre-written beats render in order without calling the live writer; the writer takes over past them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-scripted-'));
  const { engine, calls, inputs } = makeEngine(dir, {
    budgetUsd: budgetFor(4),
    scriptedBeats: [scriptedBeat(1), scriptedBeat(2), scriptedBeat(3)],
  });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 4, 'four beats within the budget');
  assert.match(calls[0].prompt, /Scripted beat 1/, 'beat 1 came from the file');
  assert.match(calls[2].prompt, /Scripted beat 3/, 'beat 3 came from the file');
  assert.match(calls[3].prompt, /Beat 4: something happens/, 'beat 4 fell back to the live writer');
  assert.equal(inputs.length, 1, 'the writer was asked only once, past the scripted beats');
  assert.equal(inputs[0].beatNumber, 4);

  const st = engine.state();
  assert.deepEqual(st.beats.slice(0, 3).map(b => b.beat.summary), ['Scripted summary 1.', 'Scripted summary 2.', 'Scripted summary 3.']);
  assert.equal(st.beats[3].beat.summary, 'Summary 4.');
  assert.match(st.beats[0].render.prompt, /Scripted beat 1/, 'the scripted beat records its real render prompt');
});

test('a writer switch keeps the scripted lane and moves only the fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-scripted-switch-'));
  const { engine, calls, inputs } = makeEngine(dir, {
    budgetUsd: budgetFor(3),
    scriptedBeats: [scriptedBeat(1)],
  });
  await engine.init();
  await engine.configure({ writer: 'mistral-small-2603' });
  await engine.start();
  await waitForStop(engine);

  assert.match(calls[0].prompt, /Scripted beat 1/, 'the scripted beat is served even after a writer switch');
  assert.equal(inputs[0].beatNumber, 2, 'the fallback writer was not asked for beat 1');
  assert.equal(engine.state().beats[1].beat.summary, 'Summary 2.', 'the fallback took over past the file');
});

test('parseScriptedBeats accepts arrays, {beats}, and export.json entries; rejects junk', () => {
  const beat = scriptedBeat(1);
  assert.deepEqual(parseScriptedBeats([beat]).map(b => b.description), [beat.description]);
  assert.deepEqual(parseScriptedBeats({ beats: [beat] }).map(b => b.description), [beat.description]);
  assert.deepEqual(parseScriptedBeats({ beats: [{ n: 1, authored: beat }] }).map(b => b.description), [beat.description]);

  assert.throws(() => parseScriptedBeats({ nope: true }), /array of beats/);
  assert.throws(() => parseScriptedBeats([null]), /not an object/);
  assert.throws(() => parseScriptedBeats(['a string']), /not an object/);
});

test('makeScriptedAuthor falls through and logs past the last scripted beat', async () => {
  const lines = [];
  const fallback = async (input) => ({ description: `Live ${input.beatNumber}.`, characters: [], dialogue: null, sfx: null, cameraMovement: 'static', summary: `Live ${input.beatNumber}.` });
  const author = makeScriptedAuthor([scriptedBeat(1)], fallback, l => lines.push(l));
  assert.equal((await author({ beatNumber: 1, series: {}, storySoFar: '', recentBeats: [] })).description, 'Scripted beat 1: the robot refills the coffee.');
  assert.equal((await author({ beatNumber: 2, series: {}, storySoFar: '', recentBeats: [] })).description, 'Live 2.');
  assert.equal(lines.length, 1, 'the handover is logged once');
  assert.match(lines[0], /past the 1 pre-written beat/);
});

// ---- Look-ahead writer buffer ----------------------------------------------

test('the look-ahead writer authors beats into the buffer ahead of the render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-lookahead-'));
  const gate = makeGate();
  const render = gatedRender(gate);
  const { engine } = makeEngine(dir, { unbounded: true, lookahead: 5, render });
  await engine.init();
  await engine.start();

  // Beat 1 is held mid-render; the writer should fill the buffer to the depth.
  await waitUntil(() => engine.state().buffered === 5 && render.started());
  const mid = engine.state();
  assert.equal(mid.beats.length, 0, 'nothing has finished rendering yet');
  assert.equal(mid.buffered, 5, 'the writer authored 5 beats ahead while beat 1 renders');
  assert.equal(mid.lookahead, 5);
  assert.equal(mid.status, 'rendering');

  gate.release();
  await waitUntil(() => engine.state().beats.length >= 3);
  const drained = engine.state();
  assert.deepEqual(drained.beats.slice(0, 3).map(b => b.lane), ['t2v', 'i2v', 'i2v'], 'beat 1 is t2v, the buffered beats chain i2v');

  await engine.stop();
  await waitForStop(engine);
});

test('auto-refill keeps the buffer topped up as the renderer drains it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-refill-'));
  // The render is slower than the (instant) writer, so the buffer sits at depth.
  const slowRender = async (_client, options) => {
    await new Promise(r => setTimeout(r, 15));
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    execFileSync('cp', [realMp4(), options.outputPath]);
    return options.outputPath;
  };
  const { engine } = makeEngine(dir, { unbounded: true, lookahead: 3, render: slowRender });
  await engine.init();
  await engine.start();

  await waitUntil(() => engine.state().beats.length >= 3 && engine.state().buffered === 3);
  const st = engine.state();
  assert.equal(st.buffered, 3, 'the buffer is refilled to the target as the render drains it');
  assert.equal(st.autoRefill, true);

  await engine.stop();
  await waitForStop(engine);
});

test('auto-refill off fills the buffer once, then authors on demand as it drains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-fillonce-'));
  const gate = makeGate();
  const render = gatedRender(gate);
  const { engine } = makeEngine(dir, { budgetUsd: budgetFor(4), lookahead: 3, autoRefill: false, render });
  await engine.init();
  await engine.start();

  await waitUntil(() => engine.state().buffered === 3 && render.started());
  assert.equal(engine.state().autoRefill, false);

  gate.release();
  await waitForStop(engine);
  const st = engine.state();
  // 3 buffered + 1 authored inline after the buffer drained = the whole budget.
  assert.equal(st.beats.length, 4, 'the one-shot fill plus an inline-authored beat rendered');
  assert.equal(st.buffered, 0);
});

test('lookahead 0 is serial: the writer never runs ahead and the buffer stays empty at rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-serial-'));
  const { engine, inputs } = makeEngine(dir, { budgetUsd: budgetFor(3), lookahead: 0 });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  const st = engine.state();
  assert.equal(st.lookahead, 0);
  assert.equal(st.beats.length, 3);
  assert.equal(st.buffered, 0, 'the buffer is empty at rest');
  assert.equal(inputs.length, 3, 'each beat authored once, just before it rendered');
  assert.deepEqual(st.beats.map(b => b.lane), ['t2v', 'i2v', 'i2v']);
});

test('switching the writer drops the beats the old writer buffered so the new one takes over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-switch-drop-'));
  const gate = makeGate();
  const render = gatedRender(gate);
  // autoRefill off so the writer does not immediately refill after the drop —
  // that keeps the assertion deterministic.
  const { engine } = makeEngine(dir, { budgetUsd: budgetFor(20), lookahead: 5, autoRefill: false, render });
  await engine.init();
  await engine.start();

  await waitUntil(() => engine.state().buffered === 5 && render.started());
  const st = await engine.configure({ writer: 'mistral-small-2603' });
  assert.equal(st.model.writer, 'mistral-small-2603');
  assert.equal(st.buffered, 1, 'the beat on the wire is kept; the 4 queued behind it are dropped for the new writer');

  gate.release();
  await engine.stop();
  await waitForStop(engine);
});

test('a resumed stream restores the look-ahead buffer and renders it without re-authoring', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-resume-buffer-'));
  // Render beat 1 for real (serial), so a valid manifest + mp4 exist on disk.
  const first = makeEngine(dir, { budgetUsd: budgetFor(1), lookahead: 0 });
  await first.engine.init();
  await first.engine.start();
  await waitForStop(first.engine);

  // Inject two pre-authored beats into the manifest's buffer, as the look-ahead
  // writer would have left them when the stream was paused.
  const manifestPath = join(dir, 'episodes/episode-001/stream/stream-manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  assert.equal(m.beats.length, 1);
  m.pendingBeats = [
    { description: 'Buffered beat two.', characters: ['WALT'], dialogue: null, sfx: null, cameraMovement: 'static wide', summary: 'Buffered summary two.' },
    { description: 'Buffered beat three.', characters: ['WALT'], dialogue: null, sfx: null, cameraMovement: 'static wide', summary: 'Buffered summary three.' },
  ];
  writeFileSync(manifestPath, JSON.stringify(m));

  const second = makeEngine(dir, { budgetUsd: budgetFor(3) });
  await second.engine.init();
  assert.equal(second.engine.state().beats.length, 1, 'the prior beat loaded');
  assert.equal(second.engine.state().buffered, 2, 'the buffered beats were restored from the manifest');

  await second.engine.start();
  await waitForStop(second.engine);

  const st = second.engine.state();
  assert.equal(st.beats.length, 3, 'the two buffered beats rendered');
  assert.equal(st.beats[1].beat.summary, 'Buffered summary two.', 'rendered from the restored buffer, in order');
  assert.equal(st.beats[2].beat.summary, 'Buffered summary three.');
  assert.equal(second.inputs.length, 0, 'the restored beats rendered without ever calling the writer');
});
