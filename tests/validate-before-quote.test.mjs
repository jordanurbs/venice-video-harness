// Validate duration/resolution against the registry BEFORE the paid call.
//
// `queueVideo` used to snap an unsupported duration to the nearest valid one,
// and `buildModelParams` swapped an unsupported resolution for
// `resolutions[0]` -- both silently (a console.warn), both changing the price
// and the output the caller asked for. Now a mismatch throws
// `VideoRequestValidationError` carrying the valid list and a suggestion, with
// no HTTP call made. `snap: true` opts back into the old behaviour.
//
// Capture client; no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelParams, getVideoModel, validateVideoRequest } from '../packages/core/dist/venice/models.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { queueVideo, quoteVideo, VideoRequestValidationError } from '../dist/venice/video.js';

// A model with a stepped duration ladder (4s/6s/8s) and a resolution ladder.
const MODEL = 'veo3.1-fast-text-to-video';
const spec = getVideoModel(MODEL);
assert.ok(spec, `${MODEL} must be in the registry`);
assert.ok(spec.durations.length > 1 && spec.resolutions.length > 1, 'fixture model needs both ladders');

const validDuration = spec.durations[0];
const validResolution = spec.resolutions[0];
const badDuration = '7s';
assert.ok(!spec.durations.includes(badDuration), `fixture assumes ${MODEL} rejects ${badDuration}`);
const badResolution = '9999p';

function captureClient() {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      return { queue_id: 'q', model: body.model, quote: 1 };
    },
  };
}

test('validateVideoRequest: valid values produce no issues; unknown models pass through', () => {
  assert.deepEqual(validateVideoRequest(MODEL, { duration: validDuration, resolution: validResolution }), []);
  assert.deepEqual(validateVideoRequest('no-such-model', { duration: '99s', resolution: 'x' }), []);
});

test('validateVideoRequest: an invalid duration lists the valid ladder and suggests the closest', () => {
  const [issue, ...rest] = validateVideoRequest(MODEL, { duration: badDuration });
  assert.equal(rest.length, 0);
  assert.equal(issue.field, 'duration');
  assert.equal(issue.requested, badDuration);
  assert.deepEqual(issue.valid, spec.durations);
  assert.ok(spec.durations.includes(issue.suggestion), `suggestion ${issue.suggestion} must be valid`);
  assert.match(issue.message, /try \d+s/);
});

test('validateVideoRequest: an invalid resolution suggests the case-insensitive twin when one exists', () => {
  const twin = validResolution.toUpperCase() === validResolution
    ? validResolution.toLowerCase()
    : validResolution.toUpperCase();
  if (spec.resolutions.includes(twin)) return; // both spellings valid for this model; nothing to test
  const [issue] = validateVideoRequest(MODEL, { resolution: twin });
  assert.equal(issue.field, 'resolution');
  assert.equal(issue.suggestion, validResolution);
});

test('queueVideo throws VideoRequestValidationError before any HTTP call on an invalid duration', async () => {
  const client = captureClient();
  await assert.rejects(
    queueVideo(client, { model: MODEL, prompt: 'x', duration: badDuration }),
    (err) => {
      assert.ok(err instanceof VideoRequestValidationError);
      assert.ok(err instanceof VeniceRequestError, 'subclass of VeniceRequestError so existing catch sites keep working');
      assert.equal(err.issues.length, 1);
      assert.equal(err.issues[0].field, 'duration');
      assert.match(err.message, new RegExp(`valid: ${spec.durations.join(', ')}`));
      return true;
    },
  );
  assert.equal(client.calls.length, 0, 'no HTTP call may be made');
});

test('queueVideo throws before any HTTP call on an invalid resolution', async () => {
  const client = captureClient();
  await assert.rejects(
    queueVideo(client, { model: MODEL, prompt: 'x', duration: validDuration, resolution: badResolution }),
    (err) => err instanceof VideoRequestValidationError && err.issues[0].field === 'resolution',
  );
  assert.equal(client.calls.length, 0);
});

test('queueVideo reports both fields at once', async () => {
  const client = captureClient();
  await assert.rejects(
    queueVideo(client, { model: MODEL, prompt: 'x', duration: badDuration, resolution: badResolution }),
    (err) => err.issues.map(i => i.field).sort().join(',') === 'duration,resolution',
  );
  assert.equal(client.calls.length, 0);
});

test('queueVideo with snap:true keeps the old behaviour (closest duration, default resolution, warns)', async () => {
  const client = captureClient();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await queueVideo(client, { model: MODEL, prompt: 'x', duration: badDuration, resolution: badResolution, snap: true });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(client.calls.length, 1);
  const body = client.calls[0].body;
  assert.ok(spec.durations.includes(body.duration), `snapped duration ${body.duration} must be valid`);
  assert.equal(body.resolution, validResolution, 'snapped resolution is the model default');
  assert.equal(warnings.length, 2);
});

test('queueVideo with valid values sends them through unchanged', async () => {
  const client = captureClient();
  await queueVideo(client, { model: MODEL, prompt: 'x', duration: validDuration, resolution: validResolution });
  assert.equal(client.calls[0].body.duration, validDuration);
  assert.equal(client.calls[0].body.resolution, validResolution);
});

test('quoteVideo validates too: a quote for an unsupported value would be misleading', async () => {
  const client = captureClient();
  await assert.rejects(
    quoteVideo(client, { model: MODEL, duration: badDuration }),
    VideoRequestValidationError,
  );
  assert.equal(client.calls.length, 0);
  await quoteVideo(client, { model: MODEL, duration: validDuration });
  assert.equal(client.calls.length, 1);
});

test('buildModelParams no longer substitutes resolutions[0] for an invalid resolution', () => {
  const params = buildModelParams(MODEL, { resolution: badResolution });
  assert.equal(params.resolution, undefined, 'an invalid resolution must not be rewritten into the body');
  assert.equal(buildModelParams(MODEL, { resolution: validResolution }).resolution, validResolution);
});
