// `/audio/queue` and `/audio/retrieve` get the same two guards video got in
// 2.26.x (queue-no-retry, poll-fail-fast). Audio jobs bill at queue time the
// same way, and `generateQueuedAudio` had the same loop shape: a non-PROCESSING
// JSON body fell through to the next sleep, so a FAILED job surfaced as a
// 10-minute timeout with the pending-job record pointing at a dead queue id.
//
// Stubbed fetch / scripted client; no network calls, no generation budget.
// Config-dir isolation is mandatory: `generateQueuedAudio` records a pending
// job on its way to the poll, and an empty VENICE_API_KEY is not isolation
// (hydrateEnvironmentFromUserConfig treats it as unset and loads the real key).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'audio-queue-config-'));

import { VeniceClient, VeniceRequestError } from '../dist/venice/client.js';
import { AudioGenerationFailedError, generateQueuedAudio } from '../dist/venice/audio.js';
import { findPendingJob } from '../dist/venice/job-store.js';

const QUEUE_PATH = '/api/v1/audio/queue';

function stubFetch(status, body = { error: { message: `boom ${status}` } }) {
  const hits = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { hits, restore: () => { globalThis.fetch = original; } };
}

const QUIET = (() => {
  const warn = console.warn; const log = console.log;
  return {
    on: () => { console.warn = () => {}; console.log = () => {}; },
    off: () => { console.warn = warn; console.log = log; },
  };
})();

const outPath = () => join(mkdtempSync(join(tmpdir(), 'audio-out-')), 'cue.mp3');

test('a 500 on /audio/queue throws after exactly one attempt', async () => {
  const { hits, restore } = stubFetch(500);
  QUIET.on();
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(
      generateQueuedAudio(client, { prompt: 'x', modelId: 'elevenlabs-music' }, outPath()),
      (err) => err instanceof VeniceRequestError && err.status === 500,
    );
    assert.equal(hits.get(QUEUE_PATH), 1, 'audio queue must not be retried');
  } finally {
    QUIET.off();
    restore();
  }
});

test('a 429 on /audio/queue is also a single attempt', async () => {
  const { hits, restore } = stubFetch(429);
  QUIET.on();
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(generateQueuedAudio(client, { prompt: 'x' }, outPath()), (err) => err instanceof VeniceRequestError && err.status === 429);
    assert.equal(hits.get(QUEUE_PATH), 1);
  } finally {
    QUIET.off();
    restore();
  }
});

/** A client whose queue answer is fixed and whose retrieve answers are scripted, one per poll. */
function scriptedClient(answers) {
  let polls = 0;
  return {
    get polls() { return polls; },
    async post(path) {
      if (path === QUEUE_PATH) return { model: 'elevenlabs-music', queue_id: 'aq-1', status: 'QUEUED' };
      return {};
    },
    async postBinaryOrJson(path, body) {
      assert.equal(path, '/api/v1/audio/retrieve');
      assert.equal(body.queue_id, 'aq-1');
      const answer = answers[Math.min(polls, answers.length - 1)];
      polls += 1;
      if (Buffer.isBuffer(answer)) return { contentType: 'audio/mpeg', value: answer };
      return { contentType: 'application/json', value: answer };
    },
  };
}

const PROCESSING = { status: 'PROCESSING', average_execution_time: 1000, execution_duration: 10 };

test('a FAILED retrieve body throws AudioGenerationFailedError on that poll and clears the pending job', async () => {
  const client = scriptedClient([PROCESSING, { status: 'FAILED', error: 'provider error' }, PROCESSING]);
  const out = outPath();
  QUIET.on();
  try {
    await assert.rejects(
      generateQueuedAudio(client, { prompt: 'x', pollIntervalMs: 1, maxPollAttempts: 50 }, out),
      (err) => {
        assert.ok(err instanceof AudioGenerationFailedError);
        assert.equal(err.status, 'FAILED');
        assert.equal(err.queueId, 'aq-1');
        assert.match(err.message, /provider error/);
        return true;
      },
    );
    assert.equal(client.polls, 2, 'fails on the poll that reported FAILED, not at the deadline');
    assert.equal(await findPendingJob(out), undefined, 'pending record is dropped so the next run queues fresh');
  } finally {
    QUIET.off();
  }
});

test('PROCESSING keeps polling until bytes arrive', async () => {
  const bytes = Buffer.from('ID3fake');
  const client = scriptedClient([PROCESSING, PROCESSING, bytes]);
  const out = outPath();
  QUIET.on();
  try {
    // `audio/mpeg` bytes into an `.mp3` path are written as-is (no ffmpeg transcode).
    const written = await generateQueuedAudio(client, { prompt: 'x', pollIntervalMs: 1, maxPollAttempts: 50 }, out);
    assert.equal(written, out);
    assert.equal(client.polls, 3);
  } finally {
    QUIET.off();
  }
});
