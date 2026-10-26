// generate-videos with a staging ref (stage-ref, rule 65): a start-frame pick
// renders the shot i2v from the pick and the clip from before it is archived
// only when the new one lands; a plate pick goes to R2V (or Kling's scene
// images) in place of the view it was edited from. A shot that cannot render
// from its pick is refused before anything is billed or moved, and reported.
// Scripted client, no network. Needs ffmpeg (builds the stub mp4 the client
// "delivers").
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stage-render-config-'));

const { generateEpisodeVideos, renderVideoFile } = await import('../dist/mini-drama/video-generator.js');
const { recordPendingJob, listPendingJobs } = await import('../dist/venice/job-store.js');

const MP4 = (() => {
  const file = join(mkdtempSync(join(tmpdir(), 'stage-render-mp4-')), 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-y', file]);
  return readFileSync(file);
})();

const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');
const png = (color) => sharp({ create: { width: 160, height: 90, channels: 3, background: color } }).png().toBuffer();
const uri = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const PICK = 'episodes/episode-001/staging/shot-008/s1/1-gpt-image-2-edit.png';

async function setup(videoDefaults = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-render-'));
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  mkdirSync(join(dir, 'characters', 'anna'), { recursive: true });
  writeFileSync(join(dir, 'characters', 'anna', 'front.png'), await png('#101010'));
  const plates = join(dir, 'locations', 'harbour-steps');
  mkdirSync(plates, { recursive: true });
  const colors = { north: '#200000', east: '#002000', south: '#000020', west: '#202000' };
  for (const [view, color] of Object.entries(colors)) writeFileSync(join(plates, `${view}.png`), await png(color));
  const staging = join(dir, 'episodes', 'episode-001', 'staging', 'shot-008', 's1');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, '1-gpt-image-2-edit.png'), await png('#445566'));
  writeFileSync(join(staging, '1-gpt-image-2-edit.provenance.json'), JSON.stringify({ generationModel: 'gpt-image-2', editModels: ['gpt-image-2-edit'], hasFace: true }));
  const series = {
    name: 'S', slug: 's', concept: '', genre: '', setting: '',
    aesthetic: { style: 'Cinematic', palette: 'cobalt', lighting: 'haze', lensCharacteristics: '35mm', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    characters: [{ name: 'ANNA', gender: 'female', age: '30s', description: 'd', fullDescription: 'fd', wardrobe: 'grey coat', voiceDescription: '', locked: true, seed: 1 }],
    locations: [{ name: 'Harbour Steps', slug: 'harbour-steps', description: 'Stone water steps under an arcade.', seed: 1 }],
    episodes: [],
    videoDefaults: {
      actionModel: 'seedance-2-5-reference-to-video', atmosphereModel: 'seedance-2-5-reference-to-video',
      characterConsistencyModel: 'seedance-2-5-reference-to-video', ...videoDefaults,
    },
    outputDir: dir, createdAt: '', updatedAt: '',
  };
  return { dir, sceneDir, series, pick: join(staging, '1-gpt-image-2-edit.png'), plates };
}

const shot = (extra) => ({
  shotNumber: 8, type: 'action', duration: '5s', videoModel: 'action', environment: 'DAY_EXTERIOR',
  description: 'marker-8 ANNA hands a note up to LEO.', characters: ['ANNA'], location: 'harbour-steps', plateView: 'north',
  dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...extra,
});

const staged = (use, sha256, extra = {}) => ({
  path: PICK, use, source: use === 'plate' ? 'locations/harbour-steps/north.png' : 'x.png',
  ...(use === 'plate' ? { replacesView: 'north' } : {}),
  model: 'gpt-image-2-edit', prompt: 'Remove the flag.', sha256, session: 's1', pickedAt: '2026-10-25T12:00:00Z', ...extra,
});

const unit = {
  unitId: 'unit-008', unitType: 'single', shotNumbers: [8], outputFile: 'shot-008.mp4', model: 'action', duration: '5s',
  startFrameStrategy: 'previous-last-frame', endFrameStrategy: 'next-panel-target', decisionReasons: [], fallbackToSingles: false,
};

function client() {
  const bodies = [];
  return {
    bodies,
    async post(path, body) {
      if (path === '/api/v1/video/complete') return {};
      assert.equal(path, '/api/v1/video/queue');
      bodies.push(body);
      return { queue_id: `q-${bodies.length}`, model: body.model };
    },
    async postBinaryOrJson(path) {
      assert.equal(path, '/api/v1/video/retrieve');
      return { contentType: 'video/mp4', value: MP4 };
    },
  };
}

async function quietly(fn) {
  const { log, warn } = console;
  const real = globalThis.setTimeout;
  console.log = console.warn = () => {};
  globalThis.setTimeout = (cb, _ms, ...args) => real(cb, 0, ...args);
  try { return await fn(); } finally { console.log = log; console.warn = warn; globalThis.setTimeout = real; }
}

const render = (c, series, shots, sceneDir, units = [unit]) =>
  quietly(() => generateEpisodeVideos(c, series, shots, sceneDir, { units }, undefined, { concurrency: 1 }));

test('a start-frame pick re-renders the shot i2v from the pick; the old clip is archived when the new one lands', async () => {
  const { sceneDir, series, pick } = await setup();
  writeFileSync(join(sceneDir, 'shot-008.mp4'), MP4);
  const s8 = shot({ stagingRef: staged('start-frame', 'abc'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);

  assert.equal(c.bodies.length, 1);
  const body = c.bodies[0];
  assert.equal(body.model, 'seedance-2-5-image-to-video');
  assert.equal(body.image_url, uri(pick), 'the pick is the start frame, over a chained last frame');
  assert.equal(body.reference_image_urls, undefined);
  assert.equal(body.end_image_url, undefined);
  assert.match(body.prompt, /starts exactly on the first frame/);
  assert.ok(existsSync(join(sceneDir, 'shot-008-v1.mp4')), 'the clip from before the pick is archived');
  const meta = JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8'));
  assert.equal(meta.metadata.stagingRef.sha256, 'abc');
  assert.deepEqual(result.unrenderedStaged, []);

  // Rendered from the pick: the next run leaves it alone, even once the pick's image is gone.
  rmSync(pick);
  const again = client();
  const second = await render(again, series, [s8], sceneDir);
  assert.equal(again.bodies.length, 0);
  assert.deepEqual(second.videoPaths, [join(sceneDir, 'shot-008.mp4')]);
  assert.deepEqual(second.unrenderedStaged, []);
});

test('a plate pick goes to R2V in place of the view it was edited from', async () => {
  const { sceneDir, series, pick, plates } = await setup();
  const s8 = shot({ stagingRef: staged('plate', 'def'), mustStaySingle: true });
  const c = client();
  await render(c, series, [s8], sceneDir, [{ ...unit, startFrameStrategy: 'panel', endFrameStrategy: 'natural' }]);
  const body = c.bodies[0];
  assert.equal(body.model, 'seedance-2-5-reference-to-video');
  assert.equal(body.image_url, undefined, 'pure reference mode');
  assert.ok(body.reference_image_urls.includes(uri(pick)));
  assert.equal(body.reference_image_urls.includes(uri(join(plates, 'north.png'))), false, 'the north plate is not sent');
  assert.ok(body.reference_image_urls.includes(uri(join(plates, 'east.png'))));
  assert.match(body.prompt, /edited for this shot/);
  assert.equal(JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8')).metadata.stagingRef.sha256, 'def');
});

test('a plate pick on Kling O3 R2V is its scene image, in place of the plate', async () => {
  const { sceneDir, series, pick, plates } = await setup({ characterConsistencyModel: 'kling-o3-standard-reference-to-video' });
  writeFileSync(join(sceneDir, 'shot-008.png'), await png('#777777'));
  const s8 = shot({ stagingRef: staged('plate', 'kln'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir, [{ ...unit, startFrameStrategy: 'panel', endFrameStrategy: 'natural' }]);
  const body = c.bodies[0];
  assert.equal(body.model, 'kling-o3-standard-reference-to-video');
  assert.deepEqual(body.scene_image_urls, [uri(pick)]);
  assert.equal(JSON.stringify(body).includes(uri(join(plates, 'north.png'))), false, 'the north plate is not sent');
  assert.deepEqual(result.unrenderedStaged, []);
  assert.equal(JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8')).metadata.stagingRef.sha256, 'kln');
});

test('a plate pick on a lane that sends no location reference is refused before anything is billed or moved', async () => {
  const { sceneDir, series } = await setup({ atmosphereModel: 'seedance-2-0-image-to-video' });
  writeFileSync(join(sceneDir, 'shot-008.png'), await png('#777777'));
  writeFileSync(join(sceneDir, 'shot-008.mp4'), MP4);
  const s8 = shot({ characters: [], videoModel: 'atmosphere', stagingRef: staged('plate', 'i2v'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 0);
  assert.ok(existsSync(join(sceneDir, 'shot-008.mp4')), 'the clip stays where it is');
  assert.equal(existsSync(join(sceneDir, 'shot-008-v1.mp4')), false, 'nothing archived');
  assert.equal(result.unrenderedStaged.length, 1);
  assert.equal(result.unrenderedStaged[0].shot, '8');
  assert.match(result.unrenderedStaged[0].reason, /sends no location reference/);
  assert.match(result.unrenderedStaged[0].reason, /--use start-frame/);
  assert.match(result.unrenderedStaged[0].reason, /left as it is/);
});

test('a staged frame that may show a face on a MiniMax i2v lane is refused before the old clip is touched', async () => {
  const { sceneDir, series } = await setup({ characterConsistencyModel: 'minimax-h3-max-reference-to-video' });
  writeFileSync(join(sceneDir, 'shot-008.mp4'), MP4);
  const s8 = shot({ stagingRef: staged('start-frame', 'face'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 0, 'nothing queued');
  assert.ok(existsSync(join(sceneDir, 'shot-008.mp4')), 'the canonical clip is still there');
  assert.equal(existsSync(join(sceneDir, 'shot-008-v1.mp4')), false, 'nothing archived');
  assert.deepEqual(result.videoPaths, []);
  assert.equal(result.unrenderedStaged.length, 1);
  assert.match(result.unrenderedStaged[0].reason, /minimax-h3-max-image-to-video fails server-side, after billing/);
  assert.match(result.unrenderedStaged[0].reason, /1-gpt-image-2-edit\.provenance\.json/);
});

test('a pick whose image is gone renders nothing, keeps the clip, and is reported', async () => {
  const { sceneDir, series } = await setup();
  writeFileSync(join(sceneDir, 'shot-008.mp4'), MP4);
  const s8 = shot({ stagingRef: staged('plate', 'zzz', { path: 'episodes/episode-001/staging/shot-008/gone.png' }), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 0);
  assert.equal(existsSync(join(sceneDir, 'shot-008-v1.mp4')), false);
  assert.ok(existsSync(join(sceneDir, 'shot-008.mp4')));
  assert.deepEqual(result.videoPaths, [], 'the clip from before the pick is not counted as rendered');
  assert.equal(result.unrenderedStaged.length, 1);
  assert.match(result.unrenderedStaged[0].reason, /gone\.png is not on disk/);
});

test('generate-videos exits non-zero, names each staged shot it did not render, and does not mark the episode produced', async () => {
  const { dir, series } = await setup();
  writeFileSync(join(dir, 'series.json'), JSON.stringify({ ...series, episodes: [{ number: 1, title: 'one', status: 'scripted' }] }));
  const s8 = shot({ stagingRef: staged('plate', 'gone', { path: 'episodes/episode-001/staging/shot-008/gone.png' }), mustStaySingle: true });
  writeFileSync(join(dir, 'episodes', 'episode-001', 'script.json'), JSON.stringify({ episode: 1, title: 'one', seriesName: 'S', totalDuration: '5s', status: 'approved', shots: [s8] }));
  // The refused shot never reaches the client; the key only gets past the "no key" check.
  const run = spawnSync(process.execPath, [cli, 'generate-videos', '-p', dir, '-e', '1', '--skip-qa', '--concurrency', '1'], {
    encoding: 'utf-8', env: { ...process.env, VENICE_API_KEY: 'test-key-never-sent' },
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /1 shot\(s\) have no clip from their staging ref/);
  assert.match(run.stderr, /venice-video generate-videos -p "[^"]+" -e 1/);
  assert.match(run.stderr, /venice-video stage-ref -p "[^"]+" -e 1 --shot 8 --clear/);
  assert.match(run.stderr, /shot 8: the staging ref image \S+gone\.png is not on disk/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'series.json'), 'utf-8')).episodes[0].status, 'scripted', 'not marked produced');
});

test('a render queued before the pick is collected first (it is paid for), then the shot renders from the pick', async () => {
  const { sceneDir, series } = await setup();
  const output = resolve(join(sceneDir, 'shot-008.mp4'));
  // Queued before the pick (no tag), then the process died mid-poll.
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-reference-to-video', queueId: 'q-before-pick', outputPath: output, project: series.outputDir });
  const s8 = shot({ stagingRef: staged('start-frame', 'pick-1'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 1, 'one new render, from the pick');
  assert.equal(c.bodies[0].model, 'seedance-2-5-image-to-video');
  assert.ok(existsSync(join(sceneDir, 'shot-008-v1.mp4')), 'the collected render is kept, archived when the pick\'s render landed');
  assert.deepEqual(result.unrenderedStaged, []);
  assert.equal(JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8')).metadata.stagingRef.sha256, 'pick-1');
  assert.equal((await listPendingJobs()).some(job => job.outputPath === output), false);
  // The collected render's recipe does not claim the current inputs made it.
  const recipe = JSON.parse(readFileSync(join(sceneDir, 'shot-008.recipe.json'), 'utf-8'));
  assert.match(recipe.passes[0].label, /re-attached .* queued from inputs not recorded here/);
  assert.equal(recipe.passes[0].referenceImagePaths, undefined);
  assert.equal(recipe.passes[0].extra.reattached.queueId, 'q-before-pick');
});

test('a render queued for the pick is collected even when the shot would now be refused', async () => {
  const { sceneDir, series, pick } = await setup();
  const output = resolve(join(sceneDir, 'shot-008.mp4'));
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-image-to-video', queueId: 'q-pick', outputPath: output, project: series.outputDir, tag: 'staging:pick-3' });
  rmSync(pick); // the pick's image is gone, which refuses a new render
  const s8 = shot({ stagingRef: staged('start-frame', 'pick-3'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 0);
  assert.deepEqual(result.videoPaths, [output], 'the collected render is the shot\'s clip from the pick');
  assert.deepEqual(result.unrenderedStaged, []);
  assert.equal(JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8')).metadata.stagingRef.sha256, 'pick-3');

  // One queued before the pick is collected too, then the refusal stands.
  const other = await setup();
  const otherOutput = resolve(join(other.sceneDir, 'shot-008.mp4'));
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-reference-to-video', queueId: 'q-old', outputPath: otherOutput, project: other.series.outputDir });
  rmSync(other.pick);
  const refusedRun = await render(client(), other.series, [shot({ stagingRef: staged('start-frame', 'pick-4'), mustStaySingle: true })], other.sceneDir);
  assert.ok(existsSync(otherOutput), 'collected, not lost');
  assert.equal(refusedRun.unrenderedStaged.length, 1);
  assert.match(refusedRun.unrenderedStaged[0].reason, /not on disk/);
  assert.equal((await listPendingJobs()).some(job => job.outputPath === otherOutput), false);
});

test('a unit that starts from a refused shot\'s last frame waits instead of chaining off an older clip', async () => {
  const { sceneDir, series } = await setup();
  writeFileSync(join(sceneDir, 'shot-007.mp4'), MP4); // an older clip it could chain from
  const s7 = shot({ shotNumber: 7, description: 'marker-7' });
  const s8 = shot({ stagingRef: staged('plate', 'gone', { path: 'episodes/episode-001/staging/shot-008/gone.png' }), mustStaySingle: true });
  const s9 = shot({ shotNumber: 9, description: 'marker-9' });
  const s10 = shot({ shotNumber: 10, description: 'marker-10' });
  const key = n => String(n).padStart(3, '0');
  const chained = n => ({ ...unit, unitId: `unit-${key(n)}`, shotNumbers: [n], outputFile: `shot-${key(n)}.mp4`, startFrameStrategy: 'previous-last-frame', endFrameStrategy: 'natural' });
  const units = [
    { ...unit, unitId: 'unit-007', shotNumbers: [7], outputFile: 'shot-007.mp4', startFrameStrategy: 'panel', endFrameStrategy: 'natural' },
    { ...unit, startFrameStrategy: 'panel', endFrameStrategy: 'natural' },
    // A unit that renders nothing in between does not let shot 9 reach back to shot 7.
    { ...unit, unitId: 'unit-099', shotNumbers: [99], outputFile: 'shot-099.mp4', startFrameStrategy: 'panel', endFrameStrategy: 'natural' },
    chained(9),
    chained(10),
  ];
  const c = client();
  const result = await render(c, series, [s7, s8, s9, s10], sceneDir, units);
  assert.equal(c.bodies.length, 0, 'shots 9 and 10 are not rendered from shot 7\'s last frame');
  assert.deepEqual(result.unrenderedStaged.map(item => item.shot), ['8', '9', '10']);
  assert.match(result.unrenderedStaged[1].reason, /starts from the last frame of shot 8/);
  assert.match(result.unrenderedStaged[2].reason, /starts from the last frame of shot 9, which has no clip from its staging ref yet \(or waits on one\)/);

  // With its own clip on disk, shot 9 has nothing to render and is not
  // reported, and shot 10 starts from it.
  writeFileSync(join(sceneDir, 'shot-009.mp4'), MP4);
  const c2 = client();
  const again = await render(c2, series, [s7, s8, s9, s10], sceneDir, units);
  assert.deepEqual(again.unrenderedStaged.map(item => item.shot), ['8']);
  assert.equal(c2.bodies.length, 1);
  assert.match(c2.bodies[0].prompt, /marker-10/);
});

test('a job re-attached under another tag is collected, and its recipe names the job\'s model, not this request\'s inputs', async () => {
  const { dir, sceneDir, plates } = await setup();
  // The keyframe pass of the lip-sync keyframe pipeline, queued before the pick.
  const output = resolve(join(sceneDir, 'shot-008-r2v-keyframe.mp4'));
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-reference-to-video', queueId: 'q-keyframe', outputPath: output, project: dir });
  const c = client();
  let resumed;
  await quietly(() => renderVideoFile(c, {
    prompt: { prompt: 'p', model: 'seedance-2-0-enhanced-reference-to-video', duration: '5s', audio: false },
    outputPath: output,
    referenceImagePaths: [join(plates, 'east.png')],
    aspectRatio: '16:9',
    project: dir,
    jobTag: 'staging:pick-9',
    onResumed: job => { resumed = job; },
  }));
  assert.equal(c.bodies.length, 0, 'collected, not queued again');
  assert.equal(resumed.queueId, 'q-keyframe');
  assert.equal(resumed.tag, undefined, 'the caller sees it was queued under another tag');
  const recipe = JSON.parse(readFileSync(output.replace(/\.mp4$/, '.recipe.json'), 'utf-8'));
  assert.match(recipe.passes[0].label, /queued from inputs not recorded here/);
  assert.equal(recipe.passes[0].model, 'seedance-2-5-reference-to-video');
  assert.equal(recipe.passes[0].referenceImagePaths, undefined);
});

test('a staged start frame with no image-to-video lane in its privacy tier is refused before any spend', async () => {
  const { sceneDir, series } = await setup({ actionModel: 'wan-2.2-a14b-text-to-video', characterConsistencyModel: 'wan-2.2-a14b-text-to-video', atmosphereModel: 'seedance-2-5-reference-to-video' });
  const s8 = shot({ stagingRef: staged('start-frame', 'private'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir, [{ ...unit, startFrameStrategy: 'panel', endFrameStrategy: 'natural' }]);
  assert.equal(c.bodies.length, 0);
  assert.equal(result.unrenderedStaged.length, 1);
  assert.match(result.unrenderedStaged[0].reason, /no image-to-video lane in the private tier/);
});

test('a render queued for the same pick and re-attached is marked as made from it', async () => {
  const { sceneDir, series } = await setup();
  const output = resolve(join(sceneDir, 'shot-008.mp4'));
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-image-to-video', queueId: 'q-same-pick', outputPath: output, project: series.outputDir, tag: 'staging:pick-2' });
  const s8 = shot({ stagingRef: staged('start-frame', 'pick-2'), mustStaySingle: true });
  const c = client();
  const result = await render(c, series, [s8], sceneDir);
  assert.equal(c.bodies.length, 0);
  assert.deepEqual(result.unrenderedStaged, []);
  assert.equal(JSON.parse(readFileSync(join(sceneDir, 'shot-008.video.json'), 'utf-8')).metadata.stagingRef.sha256, 'pick-2');
});
