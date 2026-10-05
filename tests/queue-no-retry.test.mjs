// POST /video/queue must never be auto-retried.
//
// Venice can accept and bill a job before a 5xx (or a dropped connection)
// reaches the client. `VeniceClient.post` retries 429/5xx with back-off on every
// path, so a transient failure on the queue call could pay for the same shot
// twice. The fix adds `{ retry: false }` to `post` and the queue callers use it.
//
// Idempotent calls (quote, retrieve, complete) keep the retry behaviour.
//
// Stubs `globalThis.fetch`; no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { VeniceClient, VeniceRequestError } from '../dist/venice/client.js';
import { queueVideo, quoteVideo } from '../dist/venice/video.js';

const QUEUE_PATH = '/api/v1/video/queue';
const QUOTE_PATH = '/api/v1/video/quote';

/**
 * Install a fetch stub that answers every POST with `status` and a JSON body,
 * recording how many times each path was hit. Returns the hit counter and a
 * restore function.
 */
function stubFetch(status, body = { error: { message: `boom ${status}` } }) {
  const hits = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { hits, restore: () => { globalThis.fetch = original; } };
}

const QUIET = (() => {
  const original = console.warn;
  return {
    on: () => { console.warn = () => {}; },
    off: () => { console.warn = original; },
  };
})();

test('a 500 on /video/queue throws after exactly one attempt', async () => {
  const { hits, restore } = stubFetch(500);
  QUIET.on();
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(
      queueVideo(client, { model: 'seedance-2-5-text-to-video', prompt: 'x', duration: '5s' }),
      (err) => err instanceof VeniceRequestError && err.status === 500,
    );
    assert.equal(hits.get(QUEUE_PATH), 1, 'queue must not be retried');
  } finally {
    QUIET.off();
    restore();
  }
});

test('a 429 on /video/queue still surfaces as an error after one attempt', async () => {
  const { hits, restore } = stubFetch(429, { error: 'rate limited' });
  QUIET.on();
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(
      queueVideo(client, { model: 'seedance-2-5-text-to-video', prompt: 'x', duration: '5s' }),
      (err) => err instanceof VeniceRequestError && err.status === 429,
    );
    assert.equal(hits.get(QUEUE_PATH), 1, 'queue must not be retried on 429 either');
  } finally {
    QUIET.off();
    restore();
  }
});

test('a 500 on /video/quote is still retried (idempotent path keeps back-off)', async (t) => {
  // Shrink the back-off so the three attempts do not take ~3 s of wall time.
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const { hits, restore } = stubFetch(500);
  QUIET.on();
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(
      quoteVideo(client, { model: 'seedance-2-5-text-to-video', duration: '5s' }),
      (err) => err instanceof VeniceRequestError && err.status === 500,
    );
    assert.ok((hits.get(QUOTE_PATH) ?? 0) > 1, `quote should retry; saw ${hits.get(QUOTE_PATH)} attempt(s)`);
  } finally {
    QUIET.off();
    restore();
  }
});

test('post({ retry: false }) does not retry a network error either', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('fetch failed'); };
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(client.post('/api/v1/anything', {}, { retry: false }), /fetch failed/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
