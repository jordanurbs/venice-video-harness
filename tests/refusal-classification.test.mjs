// Refusal classification for POST /video/queue.
//
// Two kinds of "no" that read alike and need opposite handling:
//
//   provider_content_policy  -> the body says whether credits were refunded
//                               and may name a recommended_model. A refunded
//                               refusal gets exactly one retry (the filter is
//                               not deterministic); an unrefunded one or a
//                               second refusal is final.
//   face screening (422)     -> on a face-capable Seedance id with images in
//                               the request, a 422 "content policy" with no
//                               structured body means Venice's pre-queue face
//                               screening refused an IMAGE. Nothing queued or
//                               charged; the same images fail every time;
//                               the prompt was never judged. Live tests
//                               2026-10-01: one image refused 5x under 3
//                               prompts and as a crop of the face alone.
//
// Pure classifier tests against captured bodies, then the render path with a
// scripted client (no network, no generation budget).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyVideoQueueRefusal,
  parseProviderRefusal,
  requestHasImageInput,
  FACE_SCREENING_MESSAGE,
} from '../dist/venice/refusal.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { runInOperation, OperationAbortedError } from '../dist/venice/operation-context.js';
import { renderVideoFile, VideoRefusalError } from '../dist/mini-drama/video-generator.js';

// Isolate the pending-job store: renderVideoFile records a pending job in the
// config dir on its way to the queue call, and without this a test run leaves
// phantom rows in the operator's real pending-jobs.json. Read at call time.
process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refusal-config-'));

// ---- Captured bodies --------------------------------------------------------

const REFUNDED = {
  error: {
    type: 'provider_content_policy',
    message: 'Your prompt violates the content policy',
    credits_refunded: true,
    recommended_model: 'wan-3-0-reference-to-video',
  },
};
const UNREFUNDED = {
  error: { type: 'provider_content_policy', message: 'Content rejected by provider', credits_refunded: false },
};
// What the face-screening 422 actually looks like: a plain message, no type.
const FACE_422 = { error: 'Your prompt violates the content policy' };
const VALIDATION_400 = { issues: [{ message: 'duration: Invalid enum value' }] };

const R2V = 'seedance-2-5-reference-to-video';
const R2V_BASIC = 'seedance-2-5-reference-to-video-basic';
const WITH_REFS = { model: R2V, prompt: 'p', reference_image_urls: ['data:image/png;base64,AAAA'] };
const TEXT_ONLY = { model: 'seedance-2-5-text-to-video', prompt: 'p' };

// ---- parseProviderRefusal ---------------------------------------------------

test('parseProviderRefusal reads credits_refunded and recommended_model', () => {
  assert.deepEqual(parseProviderRefusal(REFUNDED), {
    creditsRefunded: true,
    recommendedModel: 'wan-3-0-reference-to-video',
    message: 'Your prompt violates the content policy',
  });
  assert.deepEqual(parseProviderRefusal(UNREFUNDED), {
    creditsRefunded: false,
    message: 'Content rejected by provider',
  });
  assert.equal(parseProviderRefusal(FACE_422), undefined);
  assert.equal(parseProviderRefusal(VALIDATION_400), undefined);
  assert.equal(parseProviderRefusal(null), undefined);
  assert.equal(parseProviderRefusal({ error: { type: 'other' } }), undefined);
});

test('requestHasImageInput sees every image/video input key, including elements', () => {
  assert.equal(requestHasImageInput(TEXT_ONLY), false);
  assert.equal(requestHasImageInput(WITH_REFS), true);
  assert.equal(requestHasImageInput({ image_url: 'data:' }), true);
  assert.equal(requestHasImageInput({ reference_image_urls: [] }), false);
  assert.equal(requestHasImageInput({ elements: [{ frontal_image_url: 'data:' }] }), true);
  assert.equal(requestHasImageInput({ elements: [{}] }), false);
});

// ---- classifyVideoQueueRefusal ----------------------------------------------

test('a refunded provider refusal is retryable exactly once', () => {
  const first = classifyVideoQueueRefusal({ status: 422, message: 'x', body: REFUNDED, model: R2V, requestBody: WITH_REFS, priorRefusals: 0 });
  assert.equal(first.kind, 'provider-content-policy');
  assert.equal(first.retryable, true);
  assert.match(first.message, /refunded; retrying once/);

  const second = classifyVideoQueueRefusal({ status: 422, message: 'x', body: REFUNDED, model: R2V, requestBody: WITH_REFS, priorRefusals: 1 });
  assert.equal(second.retryable, false);
  assert.match(second.message, /Refused again/);
  assert.match(second.message, /recommends wan-3-0-reference-to-video/);
  assert.equal(second.refusal.recommendedModel, 'wan-3-0-reference-to-video');
});

test('an unrefunded provider refusal is never retried', () => {
  const r = classifyVideoQueueRefusal({ status: 422, message: 'x', body: UNREFUNDED, model: R2V, requestBody: WITH_REFS, priorRefusals: 0 });
  assert.equal(r.kind, 'provider-content-policy');
  assert.equal(r.retryable, false);
  assert.match(r.message, /NOT refunded/);
});

test('a 422 content-policy on a face-capable Seedance id with images is a face-screening refusal', () => {
  const r = classifyVideoQueueRefusal({ status: 422, message: 'Your prompt violates the content policy', body: FACE_422, model: R2V, requestBody: WITH_REFS });
  assert.equal(r.kind, 'face-screening');
  assert.equal(r.retryable, false);
  assert.equal(r.message, FACE_SCREENING_MESSAGE);
  assert.match(r.message, /not the prompt/);
  assert.match(r.message, /Nothing was queued or charged/);
});

test('the same 422 is NOT face screening without images, on a -basic twin, on another family, or on another status', () => {
  const base = { status: 422, message: 'Your prompt violates the content policy', body: FACE_422 };
  assert.equal(classifyVideoQueueRefusal({ ...base, model: 'seedance-2-5-text-to-video', requestBody: TEXT_ONLY }), undefined, 'no image to screen');
  assert.equal(classifyVideoQueueRefusal({ ...base, model: R2V_BASIC, requestBody: { ...WITH_REFS, model: R2V_BASIC } }), undefined, 'faces-off twin has no screening');
  assert.equal(classifyVideoQueueRefusal({ ...base, model: 'kling-o3-pro-reference-to-video', requestBody: { ...WITH_REFS, model: 'kling' } }), undefined, 'other family');
  assert.equal(classifyVideoQueueRefusal({ ...base, status: 400, model: R2V, requestBody: WITH_REFS }), undefined, 'a 400 is validation');
  assert.equal(classifyVideoQueueRefusal({ status: 400, message: 'duration: Invalid', body: VALIDATION_400, model: R2V, requestBody: WITH_REFS }), undefined);
  assert.equal(classifyVideoQueueRefusal({ status: 500, message: 'boom', body: {}, model: R2V, requestBody: WITH_REFS }), undefined);
});

// ---- render path ------------------------------------------------------------

/**
 * A client whose /video/queue answers are scripted; records every body it saw.
 * On a successful queue answer it aborts the operation, so the render exits at
 * the first poll sleep with OperationAbortedError instead of waiting 10 s.
 */
function scriptedQueue(answers, controller) {
  const bodies = [];
  let i = 0;
  return {
    bodies,
    async post(path, body) {
      assert.equal(path, '/api/v1/video/queue');
      bodies.push(body);
      const a = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (a instanceof Error) throw a;
      controller?.abort();
      return a;
    },
    async postBinaryOrJson() { throw new Error('poll must not be reached'); },
  };
}

const err = (status, body, message) => new VeniceRequestError(message ?? 'Your prompt violates the content policy', status, body);

/** Run a render inside an abortable operation; `QUEUED` means the queue call succeeded and polling was cut short. */
function render(client, controller, opts) {
  return runInOperation({ signal: controller.signal }, () => quiet(() => renderVideoFile(client, opts)));
}
const QUEUED = (e) => e instanceof OperationAbortedError;

function renderOpts(dir, model = R2V) {
  return {
    prompt: { prompt: 'p', model, duration: '5s', audio: true },
    outputPath: join(dir, 'out.mp4'),
    forceRequeue: true,
    characters: [],
  };
}

function quiet(fn) {
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = () => {};
  return fn().finally(() => { console.warn = w; console.error = e; console.log = l; });
}

test('renderVideoFile retries a refunded provider refusal once, then succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const controller = new AbortController();
    const client = scriptedQueue([err(422, REFUNDED), { queue_id: 'q-1', model: R2V }], controller);
    await assert.rejects(render(client, controller, renderOpts(dir)), QUEUED);
    assert.equal(client.bodies.length, 2, 'one retry after the refunded refusal');
    assert.deepEqual(client.bodies[0], client.bodies[1], 'the retry sends the identical body');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderVideoFile stops after a second refusal and surfaces recommended_model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const client = scriptedQueue([err(422, REFUNDED)]);
    await assert.rejects(
      quiet(() => renderVideoFile(client, renderOpts(dir))),
      (e) => {
        assert.ok(e instanceof VideoRefusalError, `got ${e?.constructor?.name}: ${e?.message}`);
        assert.ok(e instanceof VeniceRequestError, 'subclass so existing catch sites keep working');
        assert.equal(e.refusal.kind, 'provider-content-policy');
        assert.equal(e.refusal.refusal.recommendedModel, 'wan-3-0-reference-to-video');
        assert.match(e.message, /recommends wan-3-0-reference-to-video/);
        return true;
      },
    );
    assert.equal(client.bodies.length, 2, 'exactly one retry, never a third');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderVideoFile does not retry an unrefunded refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const client = scriptedQueue([err(422, UNREFUNDED)]);
    await assert.rejects(quiet(() => renderVideoFile(client, renderOpts(dir))), VideoRefusalError);
    assert.equal(client.bodies.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderVideoFile reports a face-screening 422 as an image problem, not a prompt problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const client = scriptedQueue([err(422, FACE_422)]);
    await assert.rejects(
      quiet(() => renderVideoFile(client, {
        ...renderOpts(dir),
        // A reference image: use a data URL so no sidecar read is attempted.
        prompt: { prompt: 'p', model: R2V, duration: '5s', audio: true, referenceImageUrls: ['data:image/png;base64,AAAA'] },
        referenceImagePaths: ['data:image/png;base64,AAAA'],
      })),
      (e) => e instanceof VideoRefusalError && e.refusal.kind === 'face-screening' && /not the prompt/.test(e.message),
    );
    assert.equal(client.bodies.length, 1, 'face screening is never retried');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderVideoFile still performs the 409 needs_consent handshake, then classifies what follows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const consent = err(409, { error: { code: 'needs_consent', policy_text: '...' } }, 'consent');
    const controller = new AbortController();
    const client = scriptedQueue([consent, { queue_id: 'q-1', model: R2V }], controller);
    await assert.rejects(render(client, controller, renderOpts(dir)), QUEUED);
    assert.equal(client.bodies.length, 2);
    assert.equal(client.bodies[0].consents, undefined);
    assert.deepEqual(client.bodies[1].consents, {
      seedance: { confirmed_terms_and_privacy: true, confirmed_legal_right: true, confirmed_screening_acknowledged: true },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain 400 validation error passes through unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-'));
  try {
    const client = scriptedQueue([err(400, VALIDATION_400, 'duration: Invalid enum value')]);
    await assert.rejects(
      quiet(() => renderVideoFile(client, renderOpts(dir))),
      (e) => e instanceof VeniceRequestError && !(e instanceof VideoRefusalError) && e.status === 400,
    );
    assert.equal(client.bodies.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
