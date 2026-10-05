// `/video/retrieve` poll loops must fail fast on a terminal status.
//
// Both loops (`pollVideoResult` in video.ts and `pollRenderedVideo` in
// video-generator.ts) special-cased only `PROCESSING`; a `FAILED` body was
// treated like "still running" and the shot surfaced as a timeout at the
// deadline (30 min on the mini-drama path), with the pending-job record still
// pointing at the dead queue id.
//
// Mocked client; no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyVideoRetrieveStatus,
  pollVideoResult,
  VideoGenerationFailedError,
} from '../dist/venice/video.js';

/** A client whose retrieve answers are scripted, one per poll. */
function scriptedClient(answers) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async postBinaryOrJson(path, body) {
      assert.equal(path, '/api/v1/video/retrieve');
      assert.equal(body.queue_id, 'q-1');
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (Buffer.isBuffer(answer)) return { contentType: 'video/mp4', value: answer };
      return { contentType: 'application/json', value: answer };
    },
    async post() { return {}; },
  };
}

const PROCESSING = { status: 'PROCESSING', average_execution_time: 1000, execution_duration: 10 };

test('classifyVideoRetrieveStatus: PROCESSING keeps polling', () => {
  assert.deepEqual(classifyVideoRetrieveStatus(PROCESSING), { kind: 'processing' });
  assert.deepEqual(classifyVideoRetrieveStatus({ status: 'processing' }), { kind: 'processing' });
});

test('classifyVideoRetrieveStatus: FAILED is terminal and carries the detail', () => {
  assert.deepEqual(
    classifyVideoRetrieveStatus({ status: 'FAILED', error: 'Content policy' }),
    { kind: 'failed', status: 'FAILED', detail: 'Content policy' },
  );
  assert.deepEqual(
    classifyVideoRetrieveStatus({ status: 'FAILED', error: { message: 'provider error', code: 'x' } }),
    { kind: 'failed', status: 'FAILED', detail: 'provider error' },
  );
  assert.deepEqual(
    classifyVideoRetrieveStatus({ status: 'ERROR', message: 'upstream died' }),
    { kind: 'failed', status: 'ERROR', detail: 'upstream died' },
  );
});

test('classifyVideoRetrieveStatus: an unknown or missing status is terminal, not a silent retry', () => {
  assert.equal(classifyVideoRetrieveStatus({ status: 'SOMETHING_NEW' }).kind, 'failed');
  assert.deepEqual(classifyVideoRetrieveStatus({}), { kind: 'failed', status: 'UNKNOWN', detail: undefined });
  assert.equal(classifyVideoRetrieveStatus(null).kind, 'failed');
});

test('pollVideoResult throws on the poll that reports FAILED, not at the deadline', async () => {
  const client = scriptedClient([
    PROCESSING,
    { status: 'FAILED', error: 'Content policy', average_execution_time: 0, execution_duration: 0 },
  ]);
  await assert.rejects(
    pollVideoResult(client, 'seedance-2-5-text-to-video', 'q-1', {
      pollIntervalMs: 1,
      maxPollAttempts: 50,
    }),
    (err) => {
      assert.ok(err instanceof VideoGenerationFailedError, `expected VideoGenerationFailedError, got ${err?.constructor?.name}`);
      assert.equal(err.status, 'FAILED');
      assert.equal(err.queueId, 'q-1');
      assert.equal(err.model, 'seedance-2-5-text-to-video');
      assert.match(err.message, /FAILED/);
      assert.match(err.message, /Content policy/);
      return true;
    },
  );
  assert.equal(client.calls, 2, 'must stop on poll 2, not run to maxPollAttempts');
});

test('pollVideoResult still returns the bytes when the job completes', async () => {
  const mp4 = Buffer.alloc(0);
  const client = scriptedClient([PROCESSING, PROCESSING, mp4]);
  const out = await pollVideoResult(client, 'seedance-2-5-text-to-video', 'q-1', {
    pollIntervalMs: 1,
    maxPollAttempts: 10,
    skipSilentRejectCheck: true,
  });
  assert.ok(Buffer.isBuffer(out));
  assert.equal(client.calls, 3);
});

test('pollVideoResult still times out when the job only ever reports PROCESSING', async () => {
  const client = scriptedClient([PROCESSING]);
  await assert.rejects(
    pollVideoResult(client, 'seedance-2-5-text-to-video', 'q-1', { pollIntervalMs: 1, maxPollAttempts: 3 }),
    /Timed out/,
  );
  assert.equal(client.calls, 3);
});
