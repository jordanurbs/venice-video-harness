// Loop-preview engine + resolution-override coverage.
//
// The engine's render primitive is injectable, so the scheduler is exercised
// offline (no network, no generation budget). The resolution override on
// renderVideoFile is covered with a capture client whose queue call throws,
// so the built body is asserted without polling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LoopEngine,
  CREATE_MODEL_R2V,
  CREATE_MODEL_T2V,
  CREATE_MODEL_I2V,
  defaultLoopResolution,
} from '../dist/mini-drama/loop-engine.js';
import { renderVideoFile } from '../dist/mini-drama/video-generator.js';
import { getVideoModel, closestValidDuration } from '../dist/venice/models.js';

function makeSeries() {
  return {
    name: 'Loop Test', slug: 'loop-test', concept: 'x', genre: 'drama', setting: 'nowhere',
    outputDir: '', aesthetic: { style: 'grainy 16mm noir' }, characters: [], locations: [],
    episodes: [{ number: 1, title: 'One', status: 'approved' }],
    videoDefaults: {
      actionModel: 'seedance-2-0-enhanced-reference-to-video',
      atmosphereModel: 'seedance-2-0-enhanced-reference-to-video',
      characterConsistencyModel: 'seedance-2-0-enhanced-reference-to-video',
    },
  };
}

function makeShot(n) {
  return {
    shotNumber: n, type: 'action', duration: '6s', videoModel: 'atmosphere',
    description: `Shot ${n}: a figure crosses a rain-slick street.`, characters: [],
    dialogue: null, sfx: null, cameraMovement: 'slow dolly forward', transition: 'cut',
  };
}

function makeScript(shotCount) {
  return {
    episode: 1, title: 'One', seriesName: 'Loop Test', totalDuration: `${shotCount * 6}s`,
    status: 'approved', shots: Array.from({ length: shotCount }, (_, i) => makeShot(i + 1)),
  };
}

/** Records every call; writes a stub file, or copies a real mp4 fixture. */
function recordingRender(calls, fixture) {
  return async (_client, options) => {
    calls.push({
      model: options.prompt.model,
      resolution: options.resolution,
      duration: options.prompt.duration,
      outputPath: options.outputPath,
      anchor: options.anchorImagePath,
    });
    await mkdir(join(options.outputPath, '..'), { recursive: true });
    if (fixture) copyFileSync(fixture, options.outputPath);
    else writeFileSync(options.outputPath, 'stub');
    return options.outputPath;
  };
}

function makeEngine(dir, script, extra = {}, fixture) {
  const series = makeSeries();
  series.outputDir = dir;
  const calls = [];
  const engine = new LoopEngine({
    client: {}, series, script, episode: 1,
    projectDir: dir, episodeDir: join(dir, 'episodes', 'episode-001'),
    log: () => {}, render: recordingRender(calls, fixture),
    ...extra,
  });
  return { engine, calls };
}

async function waitForStop(engine, timeoutMs = 5000) {
  const start = Date.now();
  while (engine.status().running) {
    if (Date.now() - start > timeoutMs) throw new Error('engine did not stop in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('once mode renders one take per shot, in shot order, full length, then stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-once-'));
  const { engine, calls } = makeEngine(dir, makeScript(4), { once: true, chain: false });
  await engine.init();
  const status0 = engine.status();
  assert.equal(status0.mode, 'watch');
  assert.equal(status0.resolution, '480P', 'watch defaults to 480P');
  assert.equal(status0.duration, '15s', 'takes render the full 15s by default');
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 4, 'one take per shot');
  const order = calls.map(c => c.outputPath.match(/shot-(\d+)--take\d+/)[1]);
  assert.deepEqual(order, ['001', '002', '003', '004'], 'zero-take shots render in shot order');
  assert.ok(calls.every(c => c.model.includes('turbo')), 'watch mode uses the Turbo lane');
  assert.ok(calls.every(c => c.resolution === '480P'), 'watch renders at 480P');
  assert.ok(calls.every(c => c.duration === '15s'), 'every take is 15s');
});

test('create mode routes to the Max family (not Turbo) at 768P', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-create-'));
  const { engine, calls } = makeEngine(dir, makeScript(2), { mode: 'create', once: true, chain: false });
  await engine.init();
  const before = engine.status();
  assert.equal(before.mode, 'create');
  assert.equal(before.resolution, '768P', 'create defaults to 768P');
  assert.equal(before.model.r2v, CREATE_MODEL_R2V);
  assert.equal(defaultLoopResolution('create'), '768P');
  assert.equal(defaultLoopResolution('watch'), '480P');

  await engine.start();
  await waitForStop(engine);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(c.model.startsWith('minimax-h3-max-'), `Max family: ${c.model}`);
    assert.ok(!c.model.includes('turbo'), `not Turbo: ${c.model}`);
    assert.equal(c.resolution, '768P');
    assert.ok(c.model === CREATE_MODEL_T2V || c.model === CREATE_MODEL_I2V, 'no-ref shots use t2v/i2v');
  }
});

test('the loop regenerates continuously and only the budget stops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-budget-'));
  // 5s take = $0.06 (Turbo $0.012/s). Budget $0.15 allows 2 takes ($0.12), not a 3rd.
  const { engine, calls } = makeEngine(dir, makeScript(5), { duration: '5s', budgetUsd: 0.15, maxTakes: 10, chain: false });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 2, 'budget stops after 2 takes (not maxTakes / not a settle)');
  assert.ok(engine.status().spendUsd <= 0.15 + 1e-9, 'spend stays within budget');
  assert.equal(engine.status().running, false);
});

test('max-takes is a ring buffer: old takes are pruned and their files deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-ring-'));
  // 1 shot, 5s ($0.06/take), budget $0.26 -> 4 takes; keep only 2 candidates.
  const { engine, calls } = makeEngine(dir, makeScript(1), { duration: '5s', budgetUsd: 0.26, maxTakes: 2, chain: false });
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 4, 'rendered 4 takes within budget');
  const shot = engine.status().shots[0];
  assert.equal(shot.takes.length, 2, 'only maxTakes candidates are kept');
  const loopDir = join(dir, 'episodes', 'episode-001', 'loop');
  const mp4s = readdirSync(loopDir).filter(f => f.endsWith('.mp4'));
  assert.equal(mp4s.length, 2, 'pruned take files were deleted from disk');
});

test('pinned shots are frozen and keep their current take', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-pin-'));
  const { engine } = makeEngine(dir, makeScript(2), { once: true, chain: false });
  await engine.init();
  await engine.start();
  await waitForStop(engine);
  const before = engine.status().shots.find(s => s.shotNumber === 1);
  await engine.pin(1);
  const after = engine.status().shots.find(s => s.shotNumber === 1);
  assert.equal(after.pinned, true);
  assert.equal(after.currentTake, before.currentTake, 'pin freezes the current take');
});

test('chaining: shot 1 renders t2v, later shots render i2v off the previous last frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-chain-'));
  // A real 1s mp4 so the engine can extract a last frame to chain from.
  const fixture = join(dir, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
    '-pix_fmt', 'yuv420p', fixture,
  ], { stdio: 'ignore' });

  const { engine, calls } = makeEngine(dir, makeScript(3), { once: true, chain: true }, fixture);
  await engine.init();
  await engine.start();
  await waitForStop(engine);

  assert.equal(calls.length, 3);
  const byShot = Object.fromEntries(calls.map(c => [c.outputPath.match(/shot-(\d+)/)[1], c]));
  assert.ok(byShot['001'].model.endsWith('text-to-video'), 'shot 1 is t2v (no predecessor)');
  assert.ok(!byShot['001'].anchor, 'shot 1 has no start frame');
  for (const key of ['002', '003']) {
    assert.ok(byShot[key].model.endsWith('image-to-video'), `shot ${key} chains via i2v`);
    assert.ok(byShot[key].anchor && byShot[key].anchor.endsWith('-chain.png'), `shot ${key} anchors on the previous last frame`);
  }
});

test('chain defaults to the mode: watch chains, create does not', async () => {
  const dirW = mkdtempSync(join(tmpdir(), 'loop-chdef-w-'));
  const { engine: w } = makeEngine(dirW, makeScript(1), { mode: 'watch' });
  await w.init();
  assert.equal(w.status().chain, true, 'watch chains by default');

  const dirC = mkdtempSync(join(tmpdir(), 'loop-chdef-c-'));
  const { engine: c } = makeEngine(dirC, makeScript(1), { mode: 'create' });
  await c.init();
  assert.equal(c.status().chain, false, 'create does not chain by default (keeps per-shot R2V)');
});

test('watch mode never uses a panel or R2V — the first shot is always t2v', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-watch-t2v-'));
  // Put a panel on disk for shot 1; watch mode must still render it t2v.
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  await mkdir(sceneDir, { recursive: true });
  writeFileSync(join(sceneDir, 'shot-001.png'), 'panel');
  const { engine, calls } = makeEngine(dir, makeScript(1), { mode: 'watch', once: true, chain: true });
  await engine.init();
  await engine.start();
  await waitForStop(engine);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].model.endsWith('turbo-text-to-video'), 'first shot is Turbo t2v, not i2v-off-panel');
  assert.ok(!calls[0].anchor, 'no start frame');
});

test('registry: Turbo + Max lanes exist and expose the 480P / 768P tiers', () => {
  for (const id of [
    'minimax-h3-max-turbo-text-to-video',
    'minimax-h3-max-turbo-image-to-video',
    CREATE_MODEL_R2V, CREATE_MODEL_I2V, CREATE_MODEL_T2V,
  ]) {
    const spec = getVideoModel(id);
    assert.ok(spec, `${id} is in the registry`);
    assert.ok(spec.resolutions.includes('480P'), `${id} lists 480P`);
    assert.ok(spec.resolutions.includes('768P'), `${id} lists 768P`);
  }
  assert.equal(getVideoModel('minimax-h3-max-turbo-reference-to-video'), undefined, 'Turbo has no R2V lane');
  assert.equal(closestValidDuration('minimax-h3-max-turbo-text-to-video', 15), '15s');
});

test('renderVideoFile honors a 480P override for Turbo, and ignores an invalid one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-res-'));
  const capture = {};
  const client = {
    async post(_path, body) { capture.body = JSON.parse(JSON.stringify(body)); throw new Error('captured'); },
  };
  const base = {
    prompt: { prompt: 'a lean turbo prompt', model: 'minimax-h3-max-turbo-text-to-video', duration: '15s', audio: true },
    forceRequeue: true,
  };
  await assert.rejects(renderVideoFile(client, { ...base, outputPath: join(dir, 'a', 'shot.mp4'), resolution: '480P' }));
  assert.equal(capture.body.resolution, '480P');
  await assert.rejects(renderVideoFile(client, { ...base, outputPath: join(dir, 'b', 'shot.mp4'), resolution: '2K' }));
  assert.equal(capture.body.resolution, '768P');
  await assert.rejects(renderVideoFile(client, { ...base, outputPath: join(dir, 'c', 'shot.mp4') }));
  assert.equal(capture.body.resolution, '768P');
  assert.ok(existsSync(dir));
});
