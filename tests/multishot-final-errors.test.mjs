// A multi-shot unit must not retry an error that fails the same way every time.
//
// `renderMultiShotUnitUntilSuccess` retries a failed unit every 15 s with no
// cap. It already treated `VideoRefusalError` as final; two more errors repeat
// identically on every attempt:
//
//   VideoGenerationFailedError -> Venice reported the render FAILED. The
//                                 pending-job record is cleared, so each retry
//                                 re-queued (and re-billed) the same body.
//   FacesOffModelError         -> a `-basic` faces-off id was given a
//                                 face-bearing image (rule 62). Thrown before
//                                 the queue call, so not billed, but forever.
//
// Drives `generateEpisodeVideos` with one multi-shot unit and a scripted
// client. No network calls, no generation budget. Timers are made immediate;
// the 15 s retry sleep is detected instead of waited on, so the unfixed loop
// fails the test at once rather than hanging it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import { VideoGenerationFailedError } from '../dist/venice/video.js';
import { FacesOffModelError } from '../dist/venice/seedance-preflight.js';
import { findPendingJob } from '../dist/venice/job-store.js';

// renderVideoFile records a pending job in the config dir before polling.
// Read at call time, so setting it after the imports is enough.
process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'multishot-final-config-'));

/** MULTISHOT_RETRY_DELAY_MS in video-generator.ts. The poll interval (10 s) is below it. */
const RETRY_DELAY_MS = 15_000;

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

const series = () => ({
  name: 'S', slug: 's', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic', palette: 'warm', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters: [],
  locations: [],
  episodes: [],
  videoDefaults: {
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
  },
  outputDir: '/tmp/unused',
  createdAt: '', updatedAt: '',
});

const shot = (shotNumber) => ({
  shotNumber, type: 'action', duration: '5s', videoModel: 'action',
  environment: 'DAY_EXTERIOR', description: `beat ${shotNumber}`, characters: [],
  cameraMovement: 'static', transition: 'CUT',
});

const multiShotPlan = (model) => ({
  units: [{
    unitId: 'unit-001', unitType: 'multishot', shotNumbers: [1, 2], outputFile: 'unit-001.mp4',
    model, duration: '10s', startFrameStrategy: 'panel', endFrameStrategy: 'natural',
    decisionReasons: [], fallbackToSingles: false,
  }],
});

/** A scene dir with the first shot's panel on disk; the unit anchors on it. */
function sceneWithPanel(hasFace) {
  const dir = mkdtempSync(join(tmpdir(), 'multishot-final-'));
  const panel = join(dir, 'shot-001.png');
  writeFileSync(panel, PNG);
  writeFileSync(join(dir, 'shot-001.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', editModels: [], hasFace }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Queue answers succeed; every retrieve reports the render FAILED. */
function failedRenderClient() {
  const queued = [];
  return {
    queued,
    async post(path, body) {
      assert.equal(path, '/api/v1/video/queue', `unexpected POST ${path}`);
      queued.push(body);
      return { queue_id: `q-${queued.length}`, model: body.model };
    },
    async postBinaryOrJson(path) {
      assert.equal(path, '/api/v1/video/retrieve');
      return { contentType: 'application/json', value: { status: 'FAILED', error: 'Upstream render failed' } };
    },
  };
}

/**
 * Make every timer fire at once, except the multi-shot retry sleep: that one
 * never fires and resolves `retried` instead, parking the old loop.
 */
function immediateTimers() {
  const real = globalThis.setTimeout;
  let markRetried;
  const retried = new Promise(r => { markRetried = r; });
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= RETRY_DELAY_MS) {
      markRetried();
      return real(() => {}, 0);
    }
    return real(fn, 0, ...args);
  };
  return { retried, restore: () => { globalThis.setTimeout = real; } };
}

function quiet(fn) {
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = () => {};
  return fn().finally(() => { console.warn = w; console.error = e; console.log = l; });
}

/** Run the episode; settle with how it ended, or 'retried' if the unit was rescheduled. */
async function runEpisode(client, model, dir) {
  const timers = immediateTimers();
  try {
    return await quiet(() => Promise.race([
      generateEpisodeVideos(client, series(), [shot(1), shot(2)], dir, multiShotPlan(model))
        .then(() => ({ kind: 'resolved' }), err => ({ kind: 'threw', err })),
      timers.retried.then(() => ({ kind: 'retried' })),
    ]));
  } finally {
    timers.restore();
  }
}

test('a FAILED multi-shot render is final: one queue call, no re-queue', async () => {
  const { dir, cleanup } = sceneWithPanel(false);
  try {
    const client = failedRenderClient();
    const outcome = await runEpisode(client, 'seedance-2-5-reference-to-video', dir);
    assert.notEqual(outcome.kind, 'retried', 'the unit was rescheduled after a FAILED render (each retry re-queues and re-bills)');
    assert.equal(outcome.kind, 'threw');
    assert.ok(outcome.err instanceof VideoGenerationFailedError, `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
    assert.equal(outcome.err.status, 'FAILED');
    assert.equal(client.queued.length, 1, 'exactly one queue call');
    assert.equal(await findPendingJob(resolve(join(dir, 'unit-001.mp4'))), undefined, 'the dead job is not left for a re-attach');
  } finally {
    cleanup();
  }
});

test('a faces-off refusal on a multi-shot unit is final, and nothing is queued', async () => {
  const { dir, cleanup } = sceneWithPanel(true);
  try {
    const client = failedRenderClient();
    const outcome = await runEpisode(client, 'seedance-2-0-reference-to-video-basic', dir);
    assert.notEqual(outcome.kind, 'retried', 'the unit was rescheduled after a faces-off refusal (it fails the same way every time)');
    assert.equal(outcome.kind, 'threw');
    assert.ok(outcome.err instanceof FacesOffModelError, `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
    assert.equal(outcome.err.violation.faceCapableModel, 'seedance-2-0-reference-to-video');
    assert.equal(client.queued.length, 0, 'the preflight refuses before any queue call');
  } finally {
    cleanup();
  }
});
