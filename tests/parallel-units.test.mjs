// generate-videos renders up to `concurrency` units at once.
//
// Rendering one unit at a time left almost all of an episode's wall-clock time
// in Venice's queue. Units now overlap, with three constraints this file pins:
//
//   - A unit that starts from the previous clip's last frame
//     (`startFrameStrategy: 'previous-last-frame'`) waits for that clip and
//     sends its last frame, while units after it keep rendering.
//   - `concurrency: 1` is the old behavior: queue, deliver, queue, deliver.
//   - After a failure no further unit starts, and a unit already queued (billed)
//     is polled to completion before the error is rethrown.
//
// Plus two side effects of running units side by side: every line a unit
// prints carries its unit id, and two dialogue shots for one speaker share a
// single voice-reference generation instead of paying for it twice.
//
// Scripted client, no network calls, no generation budget. Timers fire at once.
// Needs ffmpeg (builds the stub mp4 the client "delivers").

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'parallel-units-config-'));

import { generateEpisodeVideos, ensureVoiceReferenceForShot } from '../dist/mini-drama/video-generator.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { hasLinePrefix, prefixLines } from '../dist/venice/line-prefix.js';

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const MP4 = (() => {
  const file = join(mkdtempSync(join(tmpdir(), 'parallel-units-mp4-')), 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1',
    '-pix_fmt', 'yuv420p', '-y', file]);
  return readFileSync(file);
})();

const series = (dir) => ({
  name: 'P', slug: 'p', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic', palette: 'warm', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters: [], locations: [], episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-image-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
  },
  outputDir: dir, createdAt: '', updatedAt: '',
});

const shot = (n) => ({
  shotNumber: n, type: 'action', duration: '5s', videoModel: 'action',
  environment: 'DAY_EXTERIOR', description: `marker-${n} crosses the square`, characters: [],
  cameraMovement: 'static', transition: 'DISSOLVE',
});

const unit = (n, startFrameStrategy = 'panel') => ({
  unitId: `unit-00${n}`, unitType: 'single', shotNumbers: [n], outputFile: `shot-00${n}.mp4`,
  model: 'action', duration: '5s', startFrameStrategy, endFrameStrategy: 'natural',
  decisionReasons: [], fallbackToSingles: false,
});

function scene(count) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-units-'));
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  for (let n = 1; n <= count; n++) {
    const panel = join(sceneDir, `shot-00${n}.png`);
    writeFileSync(panel, PNG);
    writeFileSync(panel.replace(/\.png$/, '.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', hasFace: false }));
  }
  return { dir, sceneDir };
}

/**
 * A client that queues instantly and delivers a shot's video once
 * `ready(shot, events, poll)` says so; until then every poll reports
 * PROCESSING. `events` is the ordered record of 'queue' and 'deliver' per
 * shot; `poll` counts this shot's retrieve calls from 1. Polls stay out of
 * `events`, so the order checks see queues and deliveries only.
 */
function scriptedClient({ ready = () => true, failQueue = () => false } = {}) {
  const events = [];
  const bodies = new Map();
  const jobs = new Map();
  const polls = new Map();
  return {
    events,
    bodies,
    async post(path, body) {
      if (path === '/api/v1/video/complete') return {};
      assert.equal(path, '/api/v1/video/queue', `unexpected POST ${path}`);
      const n = Number(/marker-(\d+)/.exec(body.prompt)?.[1]);
      assert.ok(n, 'every queue body names its shot');
      if (failQueue(n)) throw new VeniceRequestError(`queue refused shot ${n}`, 400, { error: 'bad request' });
      bodies.set(n, body);
      events.push({ type: 'queue', shot: n });
      const queueId = `q-${n}`;
      jobs.set(queueId, n);
      return { queue_id: queueId, model: body.model };
    },
    async postBinaryOrJson(path, body) {
      assert.equal(path, '/api/v1/video/retrieve');
      const n = jobs.get(body.queue_id);
      const poll = (polls.get(n) ?? 0) + 1;
      polls.set(n, poll);
      if (!ready(n, events, poll)) {
        return { contentType: 'application/json', value: { status: 'PROCESSING', execution_duration: 1000 } };
      }
      events.push({ type: 'deliver', shot: n });
      return { contentType: 'video/mp4', value: MP4 };
    },
  };
}

const queuedSoFar = (events) => events.filter(e => e.type === 'queue').map(e => e.shot);
const order = (events) => events.map(e => `${e.type[0]}${e.shot}`).join(' ');

/** Timers fire at once, so the 10 s poll interval costs nothing. */
async function withImmediateTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, _ms, ...args) => real(cb, 0, ...args);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}

/**
 * Swallow and record what units print (the lines written inside a unit's
 * prefix context). Anything else is passed through: the test runner reports
 * over this process's stdout.
 */
async function capturingUnitOutput(fn) {
  const original = process.stdout.write;
  const warn = console.warn; const error = console.error;
  const lines = [];
  process.stdout.write = function write(chunk, encoding, callback) {
    if (!hasLinePrefix()) return original.call(process.stdout, chunk, encoding, callback);
    lines.push(...String(chunk).split('\n').filter(Boolean));
    (typeof encoding === 'function' ? encoding : callback)?.();
    return true;
  };
  console.warn = console.error = () => {};
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    process.stdout.write = original;
    console.warn = warn; console.error = error;
  }
}

test('prefixLines marks the start of every line, across writes', () => {
  const state = { prefix: '[unit-002] ', atLineStart: true };
  assert.equal(prefixLines('Queueing video\n  Queue ID: q-2\n', state), '[unit-002] Queueing video\n[unit-002]   Queue ID: q-2\n');
  assert.equal(prefixLines('half a line', state), '[unit-002] half a line');
  assert.equal(prefixLines(' and the rest\n\n', state), ' and the rest\n\n');
  assert.equal(prefixLines('\rPolling', state), '\r[unit-002] Polling');
});

test('independent units are queued together, not one after another', async () => {
  const { dir, sceneDir } = scene(3);
  // Nothing is delivered until all three are queued (one-at-a-time rendering
  // never gets there and times out instead), and shot 1 is held until the
  // other two are in. Its first poll always reports PROCESSING: units finish
  // their setup in any order, so shot 1 can queue last and first poll after
  // shots 2 and 3 are delivered (one run in seven, measured under load),
  // which left the held-unit check below with no status line to find.
  const client = scriptedClient({
    ready: (n, events, poll) => queuedSoFar(events).length === 3
      && (n !== 1 || (poll > 1 && events.filter(e => e.type === 'deliver').length === 2)),
  });
  const plan = { units: [unit(1), unit(2), unit(3)] };

  const { result, lines } = await capturingUnitOutput(() => withImmediateTimers(() =>
    generateEpisodeVideos(client, series(dir), [shot(1), shot(2), shot(3)], sceneDir, plan, undefined, { concurrency: 3 })));

  assert.deepEqual(queuedSoFar(client.events).sort(), [1, 2, 3]);
  assert.ok(client.events.findIndex(e => e.type === 'deliver') > 2, `all three were queued before any delivery: ${order(client.events)}`);
  assert.deepEqual(result.videoPaths.map(p => p.split('/').pop()), ['shot-001.mp4', 'shot-002.mp4', 'shot-003.mp4'], 'paths come back in plan order');

  assert.ok(lines.length > 0, 'units printed something');
  assert.ok(lines.every(line => /^\[unit-00[123]\] /.test(line)), `every unit line names its unit:\n${lines.join('\n')}`);
  assert.ok(lines.some(line => /^\[unit-001\]\s+Polling\.\.\. PROCESSING/.test(line)), 'a held unit prints its poll status as a whole line');
});

test('a chained unit waits for the clip before it; the unit after it does not', async () => {
  const { dir, sceneDir } = scene(3);
  // Shot 1 is held until shot 3 is queued: shot 3 must not wait behind the chain.
  const client = scriptedClient({ ready: (n, events) => n !== 1 || queuedSoFar(events).includes(3) });
  const plan = { units: [unit(1), unit(2, 'previous-last-frame'), unit(3)] };

  await capturingUnitOutput(() => withImmediateTimers(() =>
    generateEpisodeVideos(client, series(dir), [shot(1), shot(2), shot(3)], sceneDir, plan, undefined, { concurrency: 3 })));

  const at = (type, n) => client.events.findIndex(e => e.type === type && e.shot === n);
  assert.ok(at('queue', 3) < at('deliver', 1), `shot 3 queued while shot 1 was still rendering: ${order(client.events)}`);
  assert.ok(at('queue', 2) > at('deliver', 1), `shot 2 queued only after shot 1 was delivered: ${order(client.events)}`);

  const lastFrame = readFileSync(join(sceneDir, 'shot-002-lastframe.png'));
  assert.equal(client.bodies.get(2).image_url, `data:image/png;base64,${lastFrame.toString('base64')}`,
    'the chained unit starts from the last frame of shot 1, not its own panel');
  assert.equal(client.bodies.get(3).image_url, `data:image/png;base64,${PNG.toString('base64')}`, 'an unchained unit starts from its panel');
});

test('concurrency 1 renders one unit at a time, in plan order', async () => {
  const { dir, sceneDir } = scene(3);
  const client = scriptedClient();
  const plan = { units: [unit(1), unit(2), unit(3)] };

  const { result } = await capturingUnitOutput(() => withImmediateTimers(() =>
    generateEpisodeVideos(client, series(dir), [shot(1), shot(2), shot(3)], sceneDir, plan, undefined, { concurrency: 1 })));

  assert.equal(order(client.events), 'q1 d1 q2 d2 q3 d3');
  assert.equal(result.videoPaths.length, 3);
});

test('a failure starts nothing new, and a unit already queued is still collected', async () => {
  const { dir, sceneDir } = scene(3);
  const client = scriptedClient({ failQueue: n => n === 1 });
  const plan = { units: [unit(1), unit(2), unit(3)] };

  const { result: outcome } = await capturingUnitOutput(() => withImmediateTimers(() =>
    generateEpisodeVideos(client, series(dir), [shot(1), shot(2), shot(3)], sceneDir, plan, undefined, { concurrency: 2 })
      .then(() => ({ kind: 'resolved' }), err => ({ kind: 'threw', err }))));

  assert.equal(outcome.kind, 'threw');
  assert.ok(outcome.err instanceof VeniceRequestError, `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
  assert.match(outcome.err.message, /shot 1/);
  assert.ok(client.events.some(e => e.type === 'deliver' && e.shot === 2), 'shot 2 was already queued (billed), so it was polled to completion');
  assert.ok(!queuedSoFar(client.events).includes(3), 'shot 3 never started');
});

test('concurrency must be a whole number of at least 1, checked before anything is queued', async () => {
  const { dir, sceneDir } = scene(1);
  const client = scriptedClient();
  for (const concurrency of [0, -2, 1.5, Number.NaN]) {
    await assert.rejects(
      generateEpisodeVideos(client, series(dir), [shot(1)], sceneDir, { units: [unit(1)] }, undefined, { concurrency }),
      /whole number of at least 1/,
    );
  }
  assert.equal(client.events.length, 0);
});

test('two concurrent dialogue shots for one speaker generate one voice reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-units-voice-'));
  for (const f of ['front.png', 'three-quarter.png']) {
    mkdirSync(join(dir, 'characters', 'aria'), { recursive: true });
    writeFileSync(join(dir, 'characters', 'aria', f), PNG);
  }
  const s = {
    ...series(dir),
    characters: [{
      name: 'ARIA', gender: 'female', age: 'mid 20s', description: 'inventor', fullDescription: 'ARIA, inventor',
      wardrobe: 'jacket', voiceDescription: 'bright, warm', locked: true, seed: 42,
    }],
    videoDefaults: {
      ...series(dir).videoDefaults,
      actionModel: 'seedance-2-0-reference-to-video',
      characterConsistencyModel: 'seedance-2-0-reference-to-video',
    },
  };
  const dialogueShot = (n) => ({
    ...shot(n), type: 'dialogue', characters: ['ARIA'], motion: 'high', useReferenceImages: true,
    dialogue: { character: 'ARIA', line: `Line ${n}.`, delivery: 'warm' },
  });

  let audioQueues = 0;
  const client = {
    async post(path) {
      assert.equal(path, '/api/v1/audio/queue', `unexpected POST ${path}`);
      audioQueues += 1;
      throw new Error('stop after the queue call');
    },
  };

  const warn = console.warn; const log = console.log;
  console.warn = console.log = () => {};
  try {
    await Promise.all([
      ensureVoiceReferenceForShot(client, s, dialogueShot(1), undefined),
      ensureVoiceReferenceForShot(client, s, dialogueShot(2), undefined),
    ]);
  } finally {
    console.warn = warn; console.log = log;
  }
  assert.equal(audioQueues, 1, 'the second shot waited on the first generation instead of queueing its own');
});
