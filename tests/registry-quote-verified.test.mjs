// Registry values corrected against /video/quote on 2026-10-06 (see the dated
// comments in packages/core/src/venice/models.ts). Pinned so a later sync
// from GET /models alone can't quietly revert them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getVideoModel, closestValidDuration, listVideoModels } from '../packages/core/dist/venice/models.js';

const AUDIO_TOGGLE = [
  'kling-2.6-pro-image-to-video', 'kling-2.6-pro-text-to-video',
  'kling-o3-pro-image-to-video', 'kling-o3-pro-reference-to-video', 'kling-o3-pro-text-to-video',
  'kling-o3-standard-image-to-video', 'kling-o3-standard-reference-to-video', 'kling-o3-standard-text-to-video',
  'kling-v3-pro-image-to-video', 'kling-v3-pro-text-to-video',
  'kling-v3-standard-image-to-video', 'kling-v3-standard-text-to-video',
  'pixverse-v5.6-image-to-video', 'pixverse-v5.6-text-to-video', 'pixverse-v5.6-transition',
  'veo3.1-fast-image-to-video', 'veo3.1-fast-text-to-video', 'veo3.1-full-image-to-video', 'veo3.1-full-text-to-video',
];

test('lanes that price audio:false lower are audio-configurable, so audio:false is sent', () => {
  for (const id of AUDIO_TOGGLE) assert.equal(getVideoModel(id)?.audioConfigurable, true, id);
});

test('lanes that reject the audio field stay non-configurable', () => {
  for (const id of ['happyhorse-1-1-reference-to-video', 'minimax-h3-max-text-to-video', 'minimax-h3-max-multi-angle']) {
    assert.equal(getVideoModel(id)?.audioConfigurable, false, id);
  }
});

test('Seedance 2.0 renders every whole second from 4s to 15s', () => {
  for (const id of ['seedance-2-0-image-to-video', 'seedance-2-0-text-to-video', 'seedance-2-0-reference-to-video', 'seedance-2-0-enhanced-reference-to-video']) {
    assert.deepEqual(getVideoModel(id)?.durations, Array.from({ length: 12 }, (_, i) => `${i + 4}s`), id);
    assert.equal(closestValidDuration(id, 7), '7s', `${id}: a 7s shot no longer snaps to 8s`);
  }
});

test('ids Venice now routes to another model are offline and not offered', () => {
  const offered = new Set(listVideoModels().filter(m => !m.offline).map(m => m.id));
  for (const id of [
    'ltx-2-19b-distilled-image-to-video', 'ltx-2-19b-distilled-text-to-video',
    'ltx-2-19b-full-image-to-video', 'ltx-2-19b-full-text-to-video',
    'sora-2-image-to-video', 'sora-2-pro-image-to-video', 'sora-2-pro-text-to-video', 'sora-2-text-to-video',
  ]) {
    assert.equal(getVideoModel(id)?.offline, true, id);
    assert.ok(!offered.has(id), id);
  }
});
