// Re-takes and skips that must not bill the wrong thing, and the montage
// cutter against a real render.
//
//   - `generate-videos --retake` renders only the units holding the named
//     shots, from the WHOLE plan: shots are matched to units in script order,
//     so a suffixed insert ("13b", whose single shares the id "unit-013")
//     keeps its own shot, and a chained unit still starts from the clip
//     before it, re-taken or not.
//   - It validates before it archives: an empty or unknown shot list, or a
//     plan that fails the duration preflight, leaves every clip in place.
//   - A montage unit whose clips are all on disk is skipped even when no
//     master carries its (new) name: grouping changes rename units.
//   - The cutter snaps planned boundaries to the cuts ffmpeg detects, keeps
//     all the audio, holds a frame (video only) at an unconfirmed cut, keeps
//     every clip inside a short render, and fails loudly on a clip without
//     video.
//
// Scripted client, no network calls. Timers fire at once. Needs ffmpeg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'montage-retake-config-'));

import { archiveRetakeUnits, generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import { unitIndicesForShots } from '../dist/mini-drama/generation-planner.js';
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
  const archived = archiveRetakeUnits(sceneDir, SHOTS, plan, indices);
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
  assert.ok(lines.some(line => /shot cuts exist, skipping \(no montage-s02-001-002\.mp4 on disk; the cuts are kept and nothing is billed\)/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /generate-videos -p .+ -e 2 --retake 1,2/.test(line)), lines.join('\n'));
});

test('a re-take validates before it archives', () => {
  const { sceneDir } = renderedScene();
  // A unit the duration preflight refuses (45 s on a model that stops at 15 s) stops the run first.
  const plan = PLAN();
  plan.units[1] = { ...plan.units[1], unitType: 'montage', model: 'seedance-2-0-reference-to-video', duration: '45s' };
  assert.throws(() => archiveRetakeUnits(sceneDir, SHOTS, plan, [1]), /duration preflight failed/);
  assert.deepEqual(readdirSync(sceneDir).filter(f => /-v\d+\.mp4$/.test(f)), [], 'nothing archived');
});

test('generate-videos refuses an empty or unknown --retake before any work', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'montage-retake-cli-'));
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify({ ...series(projectDir), episodes: [{ number: 1, title: 'R', status: 'scripted' }] }));
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ episode: 1, title: 'R', status: 'approved', shots: SHOTS }));
  const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');
  const run = (spec) => spawnSync(process.execPath, [cli, 'generate-videos', '-p', projectDir, '-e', '1', '--skip-qa', '--retake', spec], {
    encoding: 'utf-8',
    env: { ...process.env, VENICE_API_KEY: '', VENICE_VIDEO_CONFIG_DIR: join(projectDir, '.test-config') },
  });
  const empty = run('');
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /--retake "" names no shots/);
  const unknown = run('13,99');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /shot\(s\) 99 are not in episode 1/);
});

/** A master to cut, built from lavfi video inputs (concatenated) and, optionally, a sine track. */
function cutScene(name, videos, audioSec) {
  const dir = mkdtempSync(join(tmpdir(), `montage-retake-${name}-`));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  const master = join(sceneDir, 'master.mp4');
  const inputs = videos.flatMap(v => ['-f', 'lavfi', '-i', v]);
  const audio = audioSec ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${audioSec}`] : [];
  const graph = videos.length > 1
    ? `${videos.map((_, i) => `[${i}:v]`).join('')}concat=n=${videos.length}:v=1:a=0,format=yuv420p[v]`
    : '[0:v]format=yuv420p[v]';
  ffmpeg(...inputs, ...audio, '-filter_complex', graph, '-map', '[v]', ...(audioSec ? ['-map', `${videos.length}:a`, '-c:a', 'aac'] : []), '-c:v', 'libx264', '-crf', '0', master);
  return { episodeDir, sceneDir, master };
}

function cut(scene, windows) {
  let at = 0;
  const montageBeats = windows.map((w, i) => {
    const beat = { shotNumber: i + 1, startSec: at, endSec: at + w };
    at += w;
    return beat;
  });
  const unit = {
    unitId: 'montage-s01', unitType: 'montage', shotNumbers: montageBeats.map(b => b.shotNumber), outputFile: 'master.mp4',
    model: 'seedance-2-5-reference-to-video', duration: `${Math.round(at)}s`, sceneNumber: 1, decisionReasons: [], montageBeats,
  };
  const shots = montageBeats.map(b => makeShot(b.shotNumber));
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const result = cutMontageIntoShots({ montagePath: scene.master, unit, shotsByNumber: new Map(shots.map(s => [s.shotNumber, s])), sceneDir: scene.sceneDir, episodeDir: scene.episodeDir, archiveExisting: () => {} });
    const manifest = JSON.parse(readFileSync(join(scene.episodeDir, 'media-library', 'scene-01', 'manifest.json'), 'utf-8'));
    return { ...result, manifest, warnings };
  } finally {
    console.warn = warn;
  }
}

const probe = (path, stream, entry) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', `stream=${entry}`, '-of', 'csv=p=0', path], { encoding: 'utf-8' }).stdout.trim();
const frames = (path) => Number(probe(path, 'v:0', 'nb_frames'));
const audioSec = (path) => Number(probe(path, 'a:0', 'duration'));

/** Each frame of a video as 32x18 grey pixels. */
function greyFrames(path) {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 }).stdout;
  return Array.from({ length: raw.length / 576 }, (_, i) => raw.subarray(i * 576, (i + 1) * 576));
}
const sameFrame = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length < 0.8;

test('the cutter cuts at the scene cuts ffmpeg finds, trims nothing there, and keeps all the audio', () => {
  // A hard cut at 2 s (red to blue) the plan put at 2.4 s, and a planned cut at 4 s that nothing confirms.
  const scene = cutScene('cut', ['color=c=red:s=64x36:r=25:d=2', 'color=c=blue:s=64x36:r=25:d=3'], 5);
  const { segments, shotPaths, manifest } = cut(scene, [2.4, 1.6, 1]);
  assert.deepEqual(manifest.boundaries.map(b => [b.at, b.snapped]), [[2, true], [4, false]]);
  assert.deepEqual(manifest.extraCuts, []);
  // The snapped cut is the new shot's first frame: clip 1 is exactly the red part.
  assert.deepEqual(shotPaths.map(frames), [50, 50, 25]);
  assert.deepEqual(segments.map(s => [s.startOffsetSec, s.durationSec]), [[0, 2], [2, 2], [4, 1]]);
  // No audio is cut away: the clips' audio adds up to the master's, and each clip's audio matches its video.
  const total = shotPaths.reduce((sum, p) => sum + audioSec(p), 0);
  assert.ok(Math.abs(total - audioSec(scene.master)) <= 1 / 25, `clip audio ${total.toFixed(3)} s vs master ${audioSec(scene.master)} s`);
  shotPaths.forEach((p, i) => assert.ok(Math.abs(audioSec(p) - frames(p) / 25) <= 1 / 25, `clip ${i + 1}: audio ${audioSec(p)} s, video ${frames(p) / 25} s`));
});

test('at a cut nothing confirms, the frame on each side shows its neighbour, and the clips stay in sync', () => {
  // A smooth ramp: every frame differs from the next, and no scene cut is detected.
  const scene = cutScene('hold', ["color=c=black:s=64x36:r=24:d=4,geq=lum='16+2*N':cb=128:cr=128"], 4);
  const { shotPaths, manifest } = cut(scene, [2, 2]);
  assert.deepEqual(manifest.boundaries.map(b => b.snapped), [false]);
  const master = greyFrames(scene.master);
  const [a, b] = shotPaths.map(greyFrames);
  assert.deepEqual([a.length, b.length], [48, 48], 'no frame lost');
  assert.ok(a.slice(0, 47).every((frame, i) => sameFrame(frame, master[i])), 'clip 1 up to its last frame is the master');
  assert.ok(sameFrame(a[47], master[46]) && !sameFrame(a[47], master[47]), 'clip 1 holds its second-last frame');
  assert.ok(sameFrame(b[0], master[49]) && !sameFrame(b[0], master[48]), 'clip 2 opens on its second frame');
  assert.ok(b.slice(1).every((frame, i) => sameFrame(frame, master[49 + i])), 'clip 2 after its first frame is the master');
});

test('cuts pushed past the end of a short render come back inside it; every clip has video', () => {
  // A 1 s render planned as four shots: the minimum gap would push the last two cuts past its end.
  const scene = cutScene('short', ['color=c=red:s=64x36:r=25:d=1'], 1);
  const { shotPaths, manifest, warnings } = cut(scene, [0.8, 0.1, 0.05, 0.05]);
  assert.ok(manifest.boundaries.every(b => b.at < 1), JSON.stringify(manifest.boundaries));
  assert.ok(shotPaths.every(p => frames(p) >= 1), shotPaths.map(frames).join(','));
  assert.equal(shotPaths.reduce((sum, p) => sum + frames(p), 0), 25);
  assert.ok(warnings.some(w => /does not fit the 1\.\d+ s render/.test(w)), warnings.join('\n'));
});

test('a master with no video stream fails loudly instead of writing empty clips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montage-retake-novideo-'));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  const master = join(sceneDir, 'master.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', master);
  assert.throws(() => cut({ episodeDir, sceneDir, master }, [1, 1]), /has no video stream; cannot cut it/);
  assert.ok(!existsSync(join(sceneDir, 'shot-001.mp4')));
});
