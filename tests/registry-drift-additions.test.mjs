// Lanes added from the 2026-10-06 drift triage (see the "Drift triage
// additions" block in packages/core/src/venice/models.ts). Pins the decisions
// a later bulk sync could undo: privacy modes, what tier variants did NOT
// inherit, and what was deliberately left out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getVideoModel, isFacesOffModel } from '../packages/core/dist/venice/models.js';
import {
  MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_USING_IMAGE_TAGS,
} from '../packages/core/dist/series/types.js';

test('private-mode twins are registered as private', () => {
  for (const id of [
    'grok-imagine-text-to-video-private', 'grok-imagine-image-to-video-private',
    'grok-imagine-reference-to-video-private', 'grok-imagine-video-to-video-private',
    'grok-imagine-1-5-text-to-video-private', 'grok-imagine-1-5-image-to-video-private',
    'grok-imagine-1-5-reference-to-video-private',
    'seedance-2-5-us-text-to-video-private', 'seedance-2-5-us-image-to-video-private',
    'seedance-2-5-us-reference-to-video-private',
  ]) assert.equal(getVideoModel(id)?.privacy, 'private', id);
});

test('new -basic twins are faces-off and keep the face-capable base request shape', () => {
  for (const [id, base] of [
    ['seedance-2-5-reference-to-video-basic', 'seedance-2-5-reference-to-video'],
    ['seedance-2-0-fast-reference-to-video-basic', 'seedance-2-0-fast-reference-to-video'],
  ]) {
    const twin = getVideoModel(id), face = getVideoModel(base);
    assert.equal(twin?.facesOff, true, id);
    assert.equal(isFacesOffModel(id), true, id);
    for (const k of ['supportsReferenceImages', 'supportsElements', 'supportsEndImage', 'audioInput', 'supportsReferenceAudio']) {
      assert.equal(twin[k], face[k], `${id}.${k}`);
    }
    assert.ok(MODELS_USING_IMAGE_TAGS.has(id) === MODELS_USING_IMAGE_TAGS.has(base), `${id} pure-reference mode`);
  }
});

test('tier variants inherit the request shape but not lane-probed flags', () => {
  const pro = getVideoModel('wan-3-0-pro-reference-to-video');
  assert.equal(pro?.supportsReferenceImages, true);
  assert.ok(MODELS_SUPPORTING_REFERENCE_IMAGES.has('wan-3-0-pro-reference-to-video'));
  assert.notEqual(pro.lipSyncViaReferenceAudio, true, 'reference-audio lip-sync was probed on base R2V only');
  assert.ok(!MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO.has('wan-3-0-pro-reference-to-video'));
  for (const id of ['wan-3-0-pro-text-to-video', 'wan-3-0-prime-pro-reference-to-video']) {
    assert.ok(!getVideoModel(id).durations.includes('2s'), `${id}: 2s held back like base Wan 3.0`);
  }
});

test('lanes with an unknown request shape, or no registered face-capable twin, are left out', () => {
  for (const id of [
    'gemini-omni-flash-1-1-video-to-video', 'happyhorse-1-0-video-to-video',
    'kling-v3-pro-motion-control', 'kling-v3-standard-motion-control',
    'gemini-omni-flash-reference-to-video', 'gemini-omni-flash-1-1-reference-to-video',
    'seedance-2-0-mini-reference-to-video-basic', 'seedance-1-5-pro-text-to-video-basic',
  ]) assert.equal(getVideoModel(id), undefined, id);
});
