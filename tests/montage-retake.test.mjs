// Re-takes and skips that must not bill the wrong thing, and the montage
// cutter against a real render.
//
//   - `generate-videos --retake` renders only the units holding the named
//     shots, from the WHOLE plan: shots are matched to units in script order,
//     so a suffixed insert ("13b", whose single shares the id "unit-013")
//     keeps its own shot, and a chained unit still starts from the clip
//     before it, re-taken or not.
//   - A montage unit whose clips are all on disk is skipped even when no
//     master carries its (new) name: grouping changes rename units.
//   - The cutter snaps planned boundaries to the cuts ffmpeg detects.
//
// Scripted client, no network calls. Timers fire at once. Needs ffmpeg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'montage-retake-config-'));

import { archiveUnitOutputs, generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import { resolveUnitShots, unitIndicesForShots } from '../dist/mini-drama/generation-planner.js';
import { cutMontageIntoShots } from '../dist/mini-drama/montage.js';

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const MP4 = (() => {
  const file = join(mkdtempSync(join(tmpdir(), 'montage-retake-mp4-')), 'clip.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', '-pix_fmt', 'yuv420p', file);
  return readFileSync(file);
})();

const series = (dir) => ({
  name: 'R', slug: 'r', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic', palette: 'warm', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters: [], locations: [], episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-image-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
  },
  outputDir: dir, createdAt: '', updatedAt: '',
});

// Shot ids: 12, 13, 13b (an insert after 13), 14. The prompt marker names the
// shot for the scripted client (1302 is 13b).
const marker = (shot) => (shot.shotIdSuffix ? shot.shotNumber * 100 + 2 : shot.shotNumber);
const key = (shot) => `${String(shot.shotNumber).padStart(3, '0')}${shot.shotIdSuffix ?? ''}`;
const makeShot = (n, suffix) => {
  const s = {
    shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', environment: 'DAY_EXTERIOR',
    description: '', characters: [], cameraMovement: 'static', transition: 'DISSOLVE',
    ...(suffix ? { shotIdSuffix: suffix } : {}),
  };
  s.description = `marker-${marker(s)} crosses the square`;
  return s;
};
const SHOTS = [makeShot(12), makeShot(13), makeShot(13, 'b'), makeShot(14)];

// What the planner builds for these shots: one single each, and the insert's
// single shares its base shot's id and outputFile. 13b and 14 start from the
// previous clip's last frame.
const singleUnit = (shot, startFrameStrategy = 'panel') => ({
  unitId: `unit-${String(shot.shotNumber).padStart(3, '0')}`, unitType: 'single', shotNumbers: [shot.shotNumber],
  outputFile: `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`, model: 'action', duration: '5s',
  startFrameStrategy, endFrameStrategy: 'natural', decisionReasons: [], fallbackToSingles: false,
});
const PLAN = () => ({ episode: 1, units: [singleUnit(SHOTS[0]), singleUnit(SHOTS[1]), singleUnit(SHOTS[2], 'previous-last-frame'), singleUnit(SHOTS[3], 'previous-last-frame')] });

/** A scene with a panel and an already-rendered clip for every shot. */
function renderedScene() {
  const dir = mkdtempSync(join(tmpdir(), 'montage-retake-'));
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  for (const shot of SHOTS) {
    const panel = join(sceneDir, `shot-${key(shot)}.png`);
    writeFileSync(panel, PNG);
    writeFileSync(panel.replace(/\.png$/, '.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', hasFace: false }));
    writeFileSync(join(sceneDir, `shot-${key(shot)}.mp4`), MP4);
  }
  return { dir, sceneDir };
}

/** Queues instantly and delivers at once; records which shots were queued, with their bodies. */
function scriptedClient() {
  const queued = [];
  const bodies = new Map();
  const jobs = new Map();
  return {
    queued,
    bodies,
    async post(path, body) {
      if (path === '/api/v1/video/complete') return {};
      assert.equal(path, '/api/v1/video/queue', `unexpected POST ${path}`);
      const n = Number(/marker-(\d+)/.exec(body.prompt)?.[1]);
      queued.push(n);
      bodies.set(n, body);
      jobs.set(`q-${n}`, n);
      return { queue_id: `q-${n}`, model: body.model };
    },
    async postBinaryOrJson(path) {
      assert.equal(path, '/api/v1/video/retrieve');
      return { contentType: 'video/mp4', value: MP4 };
    },
  };
}

async function quietly(fn) {
  const real = globalThis.setTimeout;
  const { log, warn } = console;
  const lines = [];
  globalThis.setTimeout = (cb, _ms, ...args) => real(cb, 0, ...args);
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    globalThis.setTimeout = real;
    console.log = log;
    console.warn = warn;
  }
}

/** What --retake does: pick the units, archive their outputs, render only them from the whole plan. */
async function retake(client, dir, sceneDir, shotNumbers) {
  const plan = PLAN();
  const indices = unitIndicesForShots(plan, shotNumbers);
  const unitShots = resolveUnitShots(plan, SHOTS);
  const archived = indices.flatMap(index => archiveUnitOutputs(sceneDir, plan.units[index], unitShots[index]));
  const { result, lines } = await quietly(() => generateEpisodeVideos(
    client, series(dir), SHOTS, sceneDir, plan, undefined, { concurrency: 3, onlyUnits: new Set(indices) },
  ));
  return { indices, archived, result, lines };
}

const dataUri = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

test('--retake 13 re-renders shot 13 and its insert 13b, each into its own file, and nothing else', async () => {
  const { dir, sceneDir } = renderedScene();
  const client = scriptedClient();
  const { indices, archived, result } = await retake(client, dir, sceneDir, [13]);

  assert.deepEqual(indices, [1, 2], 'a number covers its suffixed insert');
  assert.deepEqual(archived.map(p => p.split('/').pop()), ['shot-013.mp4', 'shot-013b.mp4'], 'each unit archives its own clip, not the base shot\'s');
  assert.deepEqual(client.queued.sort((a, b) => a - b), [13, 1302], 'only the re-taken units are queued; 12 and 14 are not');
  for (const file of ['shot-013.mp4', 'shot-013b.mp4', 'shot-013-v1.mp4', 'shot-013b-v1.mp4', 'shot-012.mp4', 'shot-014.mp4']) {
    assert.ok(existsSync(join(sceneDir, file)), `${file} exists`);
  }
  assert.ok(!existsSync(join(sceneDir, 'shot-012-v1.mp4')) && !existsSync(join(sceneDir, 'shot-014-v1.mp4')), 'untouched units are not archived');

  // 13b starts from the last frame of the shot 13 rendered in this run.
  assert.equal(client.bodies.get(1302).image_url, dataUri(join(sceneDir, 'shot-013b-lastframe.png')));
  assert.notEqual(client.bodies.get(1302).image_url, dataUri(join(sceneDir, 'shot-013b.png')), 'not its own panel');
  assert.equal(client.bodies.get(13).image_url, dataUri(join(sceneDir, 'shot-013.png')));

  // The returned plan is the whole plan, every unit with its segments.
  assert.equal(result.plan.units.length, 4);
  assert.deepEqual(result.plan.units.map(u => u.segments?.[0]?.outputFile), ['shot-012.mp4', 'shot-013.mp4', 'shot-013b.mp4', 'shot-014.mp4']);
  assert.deepEqual(result.videoPaths.map(p => p.split('/').pop()), ['shot-012.mp4', 'shot-013.mp4', 'shot-013b.mp4', 'shot-014.mp4']);
});

test('a re-taken chained unit starts from the clip before it, which is not re-taken', async () => {
  const { dir, sceneDir } = renderedScene();
  // A unit left alone is never rendered, even when its clip is missing.
  unlinkSync(join(sceneDir, 'shot-012.mp4'));
  const client = scriptedClient();
  const { indices, result } = await retake(client, dir, sceneDir, [14]);

  assert.deepEqual(indices, [3]);
  assert.deepEqual(client.queued, [14]);
  // Chained from the existing 13b clip, not from its own panel.
  assert.equal(client.bodies.get(14).image_url, dataUri(join(sceneDir, 'shot-014-lastframe.png')));
  assert.notEqual(client.bodies.get(14).image_url, dataUri(join(sceneDir, 'shot-014.png')));
  assert.ok(!existsSync(join(sceneDir, 'shot-012.mp4')), 'shot 12 was not rendered');
  assert.equal(result.plan.units[0].segments, undefined);
});

test('a montage unit whose clips exist is skipped even when no master carries its name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montage-retake-skip-'));
  const sceneDir = join(dir, 'episodes', 'episode-002', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  const shots = [makeShot(1), makeShot(2)];
  for (const shot of shots) writeFileSync(join(sceneDir, `shot-${key(shot)}.mp4`), MP4);
  // Cut when the run was scene 3; it is scene 2 now, so the master under the new name is missing.
  writeFileSync(join(sceneDir, 'montage-s03-001-002.mp4'), MP4);
  const unit = {
    unitId: 'montage-s02-001-002', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'montage-s02-001-002.mp4',
    model: 'seedance-2-5-reference-to-video', duration: '10s', startFrameStrategy: 'panel', endFrameStrategy: 'natural',
    decisionReasons: [], fallbackToSingles: false, sceneNumber: 2,
    montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }, { shotNumber: 2, startSec: 5, endSec: 10 }],
  };
  const client = { async post(path) { throw new Error(`nothing may be queued (${path})`); } };
  const { result, lines } = await quietly(() => generateEpisodeVideos(client, series(dir), shots, sceneDir, { episode: 2, units: [unit] }));

  assert.deepEqual(result.videoPaths.map(p => p.split('/').pop()), ['shot-001.mp4', 'shot-002.mp4']);
  assert.equal(result.plan.units[0].segments.length, 2);
  assert.ok(Math.abs(result.plan.units[0].renderedDurationSec - 2) < 0.2, `rendered length from the clips (${result.plan.units[0].renderedDurationSec})`);
  assert.ok(lines.some(line => /No master named montage-s02-001-002\.mp4/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /generate-videos -p .+ -e 2 --retake 1,2/.test(line)), lines.join('\n'));
});

test('the cutter cuts at the scene cuts ffmpeg finds, not at the planned times', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montage-retake-cut-'));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  // Three flat colours with hard cuts at 2 s and 3 s; the plan put them at 2.4 s and 3.3 s.
  const master = join(sceneDir, 'montage-s01-001-003.mp4');
  ffmpeg(
    '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=64x36:r=25:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]', master,
  );
  const unit = {
    unitId: 'montage-s01-001-003', unitType: 'montage', shotNumbers: [1, 2, 3], outputFile: 'montage-s01-001-003.mp4',
    model: 'seedance-2-5-reference-to-video', duration: '5s', sceneNumber: 1, decisionReasons: [],
    montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 2.4 }, { shotNumber: 2, startSec: 2.4, endSec: 3.3 }, { shotNumber: 3, startSec: 3.3, endSec: 5 }],
  };
  const shots = [makeShot(1), makeShot(2), makeShot(3)];
  const warn = console.warn;
  console.warn = () => {};
  let segments;
  try {
    ({ segments } = cutMontageIntoShots({
      montagePath: master, unit, shotsByNumber: new Map(shots.map(s => [s.shotNumber, s])), sceneDir, episodeDir, archiveExisting: () => {},
    }));
  } finally {
    console.warn = warn;
  }
  const manifest = JSON.parse(readFileSync(join(episodeDir, 'media-library', 'scene-01', 'manifest.json'), 'utf-8'));
  assert.deepEqual(manifest.boundaries.map(b => b.snapped), [true, true]);
  assert.ok(Math.abs(manifest.boundaries[0].at - 2) < 0.05 && Math.abs(manifest.boundaries[1].at - 3) < 0.05, JSON.stringify(manifest.boundaries));
  assert.deepEqual(manifest.extraCuts, []);
  // Each clip starts one frame after its cut and ends one frame before the next.
  assert.ok(Math.abs(segments[0].durationSec - 1.96) < 0.05, JSON.stringify(segments));
  assert.ok(Math.abs(segments[1].startOffsetSec - 2.04) < 0.05 && Math.abs(segments[1].durationSec - 0.92) < 0.05, JSON.stringify(segments));
  assert.ok(existsSync(join(sceneDir, 'shot-003.mp4')));
});
