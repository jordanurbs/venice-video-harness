// Seedance 2.5 draft mode: renders go out as 480p drafts by default, and
// upgrade-drafts turns an approved draft into the same take at 1080p.
//
// Stubs `globalThis.fetch`; no network calls, no generation budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the pending-job registry out of the operator's real config.
process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'draft-config-'));

const { supportsSeedanceDraft, resolveSeedanceDraft } = await import('../packages/core/dist/venice/models.js');
const { VeniceClient } = await import('../dist/venice/client.js');
const { queueVideo } = await import('../dist/venice/video.js');
const { appendRecipePass, readShotRecipe } = await import('../dist/venice/recipe.js');
const { draftUpgradeBody, readDraftTake, upgradeDraftTake, draftExpired } = await import('../dist/mini-drama/draft-upgrade.js');

const DRAFT_ID = '01a1caca-4852-7e75-aa7f-42a885c6d255';

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    return handler(path, body);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('draft mode covers every Seedance 2.5 lane except the US private ones, and no 2.0 lane', () => {
  for (const id of [
    'seedance-2-5-text-to-video-basic', 'seedance-2-5-image-to-video', 'seedance-2-5-reference-to-video',
    'seedance-2-5-enhanced-reference-to-video', 'seedance-2-5-edit-video-basic',
  ]) assert.equal(supportsSeedanceDraft(id), true, id);
  for (const id of [
    'seedance-2-5-us-reference-to-video-private', 'seedance-2-0-reference-to-video', 'seedance-2-0-fast-text-to-video-basic',
    'wan-3-0-reference-to-video', 'kling-o3-pro-image-to-video',
  ]) assert.equal(supportsSeedanceDraft(id), false, id);
});

test('drafts are the default; an explicit false or VENICE_SEEDANCE_DRAFT=0 turns them off', () => {
  assert.equal(resolveSeedanceDraft('seedance-2-5-reference-to-video'), true);
  assert.equal(resolveSeedanceDraft('seedance-2-5-reference-to-video', false), false);
  assert.equal(resolveSeedanceDraft('seedance-2-5-reference-to-video', undefined, '0'), false);
  assert.equal(resolveSeedanceDraft('seedance-2-5-reference-to-video', undefined, 'off'), false);
  assert.equal(resolveSeedanceDraft('seedance-2-5-reference-to-video', true, '0'), true);
  assert.equal(resolveSeedanceDraft('seedance-2-0-reference-to-video', true), false);
});

test('queueVideo sends a Seedance 2.5 take as a 480p draft whatever resolution was asked', async () => {
  const { calls, restore } = stubFetch(() => json({ model: 'seedance-2-5-text-to-video-basic', queue_id: DRAFT_ID, is_draft: true }));
  try {
    const client = new VeniceClient('test-key');
    await queueVideo(client, { model: 'seedance-2-5-text-to-video-basic', prompt: 'x', duration: '5s', aspectRatio: '16:9', resolution: '1080p' });
    await queueVideo(client, { model: 'seedance-2-5-text-to-video-basic', prompt: 'x', duration: '5s', aspectRatio: '16:9', resolution: '1080p', draft: false });
    await queueVideo(client, { model: 'seedance-2-0-text-to-video-basic', prompt: 'x', duration: '5s', aspectRatio: '16:9', resolution: '1080p' });
  } finally {
    restore();
  }
  const [draft, final, older] = calls.map(c => c.body);
  assert.equal(draft.draft, true);
  assert.equal(draft.resolution, '480p');
  assert.equal(final.draft, undefined);
  assert.equal(final.resolution, '1080p');
  assert.equal(older.draft, undefined);
  assert.equal(older.resolution, '1080p');
});

async function draftOnDisk(model, aspectRatio = '16:9') {
  const dir = mkdtempSync(join(tmpdir(), 'draft-take-'));
  const path = join(dir, 'shot-001.mp4');
  writeFileSync(path, Buffer.alloc(200_000, 1));
  await appendRecipePass(path, {
    kind: 'video-generate', role: 'identity', model, label: 'video render', prompt: 'a paper boat drifts',
    duration: '4s', aspectRatio, resolution: '480p',
    extra: { audio: true, bitrateMode: 'high', draft: { taskId: DRAFT_ID, expiresAt: '2999-01-01T00:00:00.000Z' } },
  });
  return path;
}

test('the upgrade request resends duration and aspect ratio, never media, and drops the ratio on image-to-video', async () => {
  const r2v = await readDraftTake(await draftOnDisk('seedance-2-5-reference-to-video'));
  assert.deepEqual(draftUpgradeBody(r2v), {
    model: 'seedance-2-5-reference-to-video', prompt: 'a paper boat drifts', draft_task_id: DRAFT_ID,
    duration: '4s', resolution: '1080p', aspect_ratio: '16:9', bitrate_mode: 'high',
  });
  const i2v = await readDraftTake(await draftOnDisk('seedance-2-5-image-to-video'));
  assert.equal(draftUpgradeBody(i2v).aspect_ratio, undefined);
  assert.equal(draftExpired({ ...r2v, draft: { ...r2v.draft, expiresAt: '2000-01-01T00:00:00.000Z' } }), true);
});

test('upgradeDraftTake puts the 1080p take at the draft\'s path, archives the draft, and is not a draft afterwards', async () => {
  const path = await draftOnDisk('seedance-2-5-text-to-video-basic');
  const take = await readDraftTake(path);
  const hd = Buffer.alloc(300_000, 7);
  const { calls, restore } = stubFetch((p) => {
    if (p === '/api/v1/video/queue') return json({ model: 'seedance-2-5-text-to-video-basic', queue_id: 'up-1' });
    if (p === '/api/v1/video/retrieve') return new Response(hd, { status: 200, headers: { 'content-type': 'video/mp4' } });
    return json({});
  });
  let result;
  try {
    result = await upgradeDraftTake(new VeniceClient('test-key'), take);
  } finally {
    restore();
  }
  const queued = calls.find(c => c.path === '/api/v1/video/queue').body;
  assert.equal(queued.draft_task_id, DRAFT_ID);
  assert.equal(queued.draft, undefined);
  assert.equal(queued.resolution, '1080p');
  assert.equal(readFileSync(path).length, hd.length);
  assert.ok(result.archivedDraft && existsSync(result.archivedDraft));
  assert.equal(readFileSync(result.archivedDraft).length, 200_000);
  const recipe = await readShotRecipe(path);
  assert.equal(recipe.passes.at(-1).resolution, '1080p');
  assert.equal(recipe.passes.at(-1).archivedPrevious, result.archivedDraft);
  assert.equal(await readDraftTake(path), null);
});
