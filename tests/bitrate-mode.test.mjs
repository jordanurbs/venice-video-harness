// bitrate_mode coverage: Seedance 2.5 renders must carry `bitrate_mode: "high"`
// by default (a large, free fidelity gain), the field must NOT leak onto models
// that reject it (e.g. the wan-3-0 fallback), and an explicit override must win.
//
// Covers the resolver (models.js) and the shared queue path (video.js
// queueVideo) with a capture client — no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBitrateMode, isSeedance25VideoModel } from '../dist/venice/models.js';
import { queueVideo } from '../dist/venice/video.js';

const SEEDANCE_25 = [
  'seedance-2-5-text-to-video',
  'seedance-2-5-image-to-video',
  'seedance-2-5-reference-to-video',
  // suffix spellings used by launch scripts
  'seedance-2-5-text-to-video-basic',
];

const NOT_SEEDANCE_25 = [
  'seedance-2-0-text-to-video',
  'seedance-2-0-enhanced-reference-to-video',
  'wan-3-0-enhanced-text-to-video',
  'veo3.1-fast-text-to-video',
  'kling-o3-pro-text-to-video',
];

test('resolveBitrateMode defaults every Seedance 2.5 variant to high', () => {
  for (const model of SEEDANCE_25) {
    assert.equal(isSeedance25VideoModel(model), true, `${model} should be Seedance 2.5`);
    assert.equal(resolveBitrateMode(model), 'high', `${model} should default to high`);
  }
});

test('resolveBitrateMode leaves non-Seedance-2.5 models undefined', () => {
  for (const model of NOT_SEEDANCE_25) {
    assert.equal(isSeedance25VideoModel(model), false, `${model} is not Seedance 2.5`);
    assert.equal(resolveBitrateMode(model), undefined, `${model} should get no bitrate_mode`);
  }
});

test('explicit bitrate override always wins', () => {
  assert.equal(resolveBitrateMode('seedance-2-5-text-to-video', 'standard'), 'standard');
  assert.equal(resolveBitrateMode('wan-3-0-text-to-video', 'high'), 'high');
});

function captureClient() {
  const state = {};
  return {
    state,
    client: {
      async post(_path, body) {
        state.body = JSON.parse(JSON.stringify(body));
        return { model: body.model, queue_id: 'test-queue-id' };
      },
    },
  };
}

test('queueVideo attaches bitrate_mode:high for Seedance 2.5', async () => {
  const { client, state } = captureClient();
  await queueVideo(client, {
    model: 'seedance-2-5-text-to-video',
    prompt: 'A cat walking through a sunny garden',
    duration: '10s',
  });
  assert.equal(state.body.bitrate_mode, 'high');
});

test('queueVideo omits bitrate_mode for models that reject it', async () => {
  const { client, state } = captureClient();
  await queueVideo(client, {
    model: 'wan-3-0-enhanced-text-to-video',
    prompt: 'A cat walking through a sunny garden',
    duration: '10s',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(state.body, 'bitrate_mode'), false);
});

test('queueVideo honors an explicit standard override on Seedance 2.5', async () => {
  const { client, state } = captureClient();
  await queueVideo(client, {
    model: 'seedance-2-5-text-to-video',
    prompt: 'A cat walking through a sunny garden',
    duration: '10s',
    bitrateMode: 'standard',
  });
  assert.equal(state.body.bitrate_mode, 'standard');
});
