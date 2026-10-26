// VPS-backed models (the private Grok Imagine lanes) return a `download_url`
// from /video/queue, and /video/retrieve answers with JSON status only. The
// renderer used to treat that COMPLETED-without-bytes body as a failure, so
// every such render was paid for and then reported as failed.
//
// Fake client + stubbed fetch for the download; no Venice host is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderVideoFile } from '../dist/mini-drama/video-generator.js';
import { MAX_REFERENCE_IMAGES_BY_MODEL } from '../packages/core/dist/series/types.js';

const URL = 'https://private-share.example.test/v1/share/abc';
const MP4 = Buffer.from('fake-mp4-bytes');

async function withImmediateTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, _ms, ...args) => real(cb, 0, ...args);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}

test('a COMPLETED retrieve with a queue download_url fetches the file from it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-download-url-'));
  const outputPath = join(dir, 'shot-001.mp4');
  process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'venice-cfg-'));
  let polls = 0;
  const client = {
    async post(path, body) {
      if (path === '/api/v1/video/complete') return {};
      assert.equal(path, '/api/v1/video/queue');
      return { model: body.model, queue_id: 'q-1', download_url: URL };
    },
    async postBinaryOrJson(path) {
      assert.equal(path, '/api/v1/video/retrieve');
      polls += 1;
      return { contentType: 'application/json', value: { status: polls < 2 ? 'PROCESSING' : 'COMPLETED' } };
    },
  };
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    assert.equal(String(url), URL, 'only the download_url may be fetched');
    return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  try {
    const out = await withImmediateTimers(() => renderVideoFile(client, {
      prompt: { prompt: 'a man waves', model: 'grok-imagine-1-5-text-to-video-private', duration: '5s', audio: true },
      outputPath,
      aspectRatio: '16:9',
    }));
    assert.equal(out, outputPath);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(fetched, [URL]);
  assert.equal(polls, 2);
  assert.ok(existsSync(outputPath));
  assert.deepEqual(readFileSync(outputPath), MP4);
});

test('Grok Imagine 1.5 R2V reference budget is 7', () => {
  assert.equal(MAX_REFERENCE_IMAGES_BY_MODEL['grok-imagine-1-5-reference-to-video-private'], 7);
});
