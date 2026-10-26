// Neighbour continuity at the cuts (qa-videos): cut lists from a plan, a
// {clips} list or an EDL; how each cut joins (new scene, time cut,
// continuous), read from the script; which cuts are checked; the pairwise
// vision call with a stub client; the checklist verdict, where a reply that
// does not answer it is unchecked, never a pass; the CLI's cut-list mode; and
// the plan check's word test for a close-up's object that the rest of the
// scene never shows. No network calls: the CLI runs here make no vision call
// and get no API key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  checkPairContinuity, cutListFromJson, cutListFromPlan, markJoins, pairsToCheck, verdictFromAnswers,
  extractFrameAtOrBefore, videoStreamDurationSec, ffprobeDurationSec, objectRefsFor, speaksOnCamera,
} from '../dist/mini-drama/video-qa.js';
import { checkShotPlan } from '../dist/mini-drama/plan-check.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;
const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
}

/** A clip with picture only. */
function videoClip(path, { seconds = 2, source = 'testsrc2' } = {}) {
  ffmpeg(['-f', 'lavfi', '-i', `${source}=s=320x180:d=${seconds}:r=24`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
  return path;
}

/** A clip whose picture is `video` seconds long and its audio `audio` seconds (audio may run longer). */
function clipWithAudio(path, { video, audio }) {
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x303030:s=320x180:d=${video}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${audio}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path,
  ]);
  return path;
}

/** The full checklist, all clear, with any answers overridden. */
function answers(overrides = {}) {
  return {
    vehicle: { answer: 'same', note: '' },
    people: { answer: 'n/a', note: '' },
    props: { answer: 'n/a', note: '' },
    facing: { answer: 'same', note: '' },
    action: { answer: 'continues', note: '' },
    light: { answer: 'same', note: '' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cut lists
// ---------------------------------------------------------------------------

test('a cut list comes from {clips}, or from an EDL whose paths start at the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutlist-'));
  try {
    mkdirSync(join(root, 'edit'), { recursive: true });
    mkdirSync(join(root, 'episodes'), { recursive: true });
    writeFileSync(join(root, 'episodes', 'm1.mp4'), '');
    const clips = cutListFromJson({ clips: [{ file: 'a.mp4', in: 1, out: 3, shot: '4b', label: 'deck' }, { file: '/abs/b.mp4', newScene: true, generation: 'g2' }] }, join(root, 'edit'));
    assert.deepEqual(clips.map(c => [c.id, c.file.endsWith('edit/a.mp4') || c.file, c.inSec, c.outSec, c.shot, c.shotIdSuffix, c.newScene ?? false]), [
      ['deck', true, 1, 3, 4, 'b', false],
      ['clip 2', '/abs/b.mp4', 0, undefined, undefined, undefined, true],
    ]);
    // Two clips cut from one file are one generation, unless the list says otherwise.
    assert.equal(clips[0].generation, clips[0].file);
    assert.equal(clips[1].generation, 'g2');
    const edl = cutListFromJson({ cuts: [{ shot: 8, master: 'episodes/m1.mp4', srcIn: 0.3, srcOut: 4.09, location: 'harbour-station' }] }, [join(root, 'edit'), root]);
    assert.equal(edl[0].file, join(root, 'episodes', 'm1.mp4'));
    assert.deepEqual([edl[0].id, edl[0].inSec, edl[0].outSec, edl[0].location, edl[0].generation], ['shot 8', 0.3, 4.09, 'harbour-station', edl[0].file]);
    assert.throws(() => cutListFromJson({ nope: [] }, root), /Not a cut list/);
    assert.throws(() => cutListFromJson({ clips: [{ in: 1 }] }, root), /clip 1 has no "file"/);
    assert.throws(() => cutListFromJson({ cuts: [{ master: 'x.mp4', srcIn: 'soon' }] }, root), /cut 1 "srcIn" is not a time/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('which cuts are checked: joins between generations by default, every cut on request, never into a new scene', () => {
  const clips = [
    { id: '1', file: 'x', inSec: 0, generation: 'u1' },
    { id: '2', file: 'x', inSec: 0, generation: 'u1' },
    { id: '3', file: 'x', inSec: 0, generation: 'u2' },
    { id: '4', file: 'x', inSec: 0, generation: 'u3', newScene: true },
    { id: '5', file: 'x', inSec: 0 },
  ];
  assert.deepEqual(pairsToCheck(clips, 'joins').map(([a, b]) => `${a.id}>${b.id}`), ['2>3', '4>5']);
  assert.deepEqual(pairsToCheck(clips, 'all').map(([a, b]) => `${a.id}>${b.id}`), ['1>2', '2>3', '4>5']);
});

test('how a cut joins comes from the script; a script with no continuity field treats a location change as a new scene', () => {
  const clip = (shot, extra = {}) => ({ id: `shot ${shot}`, file: 'x', inSec: 0, shot, ...extra });
  // Written before the continuity field: only a change of location is a scene change.
  const legacy = [
    { shotNumber: 1, location: 'harbour-station' },
    { shotNumber: 2, location: 'harbour-station' },
    { shotNumber: 3, location: 'ferry-deck' },
  ];
  assert.deepEqual(markJoins([clip(1), clip(2), clip(3)], legacy).map(c => [c.newScene ?? false, c.timeCut ?? false]), [
    [false, false], [false, false], [true, false],
  ]);
  // With the field: new-scene skips, later is a time cut, continuous is judged even across a change of location.
  const planned = [
    { shotNumber: 1, location: 'harbour-station' },
    { shotNumber: 2, location: 'harbour-station', continuity: { from: 'later' } },
    { shotNumber: 3, location: 'ferry-deck', continuity: { from: 'continuous' } },
    { shotNumber: 4, location: 'ferry-deck', continuity: { from: 'new-scene' } },
  ];
  assert.deepEqual(markJoins([clip(1), clip(2), clip(3), clip(4)], planned).map(c => [c.newScene ?? false, c.timeCut ?? false]), [
    [false, false], [false, true], [false, false], [true, false],
  ]);
  // An EDL's cuts take their joins from the script when their shot is known; a cut inside one shot is continuous.
  const edl = markJoins([clip(1), clip(1, { inSec: 3 }), clip(3)], legacy);
  assert.deepEqual(edl.map(c => c.newScene ?? false), [false, false, true]);
  // A shot the script does not know falls back to the clip's own location; an explicit newScene stays.
  assert.equal(markJoins([clip(1), { id: 'x', file: 'x', inSec: 0, location: 'market' }], legacy)[1].newScene, true);
  assert.equal(markJoins([clip(1), clip(2, { newScene: true })], legacy)[1].newScene, true);
  // Joins inside a known shot (suffix) look up the right shot.
  const inserts = [{ shotNumber: 2, location: 'a' }, { shotNumber: 2, shotIdSuffix: 'b', location: 'b' }];
  assert.equal(markJoins([clip(2), clip(2, { shotIdSuffix: 'b' })], inserts)[1].newScene, true);
});

test('the plan\'s shot clips carry their generation, the script\'s joins and its flip; missing clips are left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planclips-'));
  try {
    for (const n of ['001', '002', '004', '005']) writeFileSync(join(dir, `shot-${n}.mp4`), '');
    const clips = cutListFromPlan(
      { units: [{ unitId: 'montage-s01-001-002', shotNumbers: [1, 2] }, { unitId: 'unit-003', shotNumbers: [3] }, { unitId: 'unit-004', shotNumbers: [4] }, { unitId: 'unit-005', shotNumbers: [5] }] },
      dir,
      [
        { shotNumber: 1, location: 'harbour-station' },
        { shotNumber: 2, location: 'harbour-station', continuity: { from: 'continuous' } },
        { shotNumber: 3 },
        { shotNumber: 4, location: 'harbour-station', continuity: { from: 'new-scene' }, flip: true },
        { shotNumber: 5, location: 'ferry-deck' },
      ],
    );
    assert.deepEqual(clips.map(c => [c.id, c.generation, c.newScene ?? false, c.flip ?? false]), [
      ['shot 1', 'montage-s01-001-002', false, false],
      ['shot 2', 'montage-s01-001-002', false, false],
      ['shot 4', 'unit-004', true, true],
      ['shot 5', 'unit-005', true, false],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plan\'s clips are cut as assemble-episode cuts them: from trimStart, to trimEnd before the end', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'planclips-trim-'));
  try {
    videoClip(join(dir, 'shot-001.mp4'));
    const [clip] = cutListFromPlan({ units: [{ unitId: 'unit-001', shotNumbers: [1] }] }, dir, [{ shotNumber: 1, trimStart: 0.25, trimEnd: 0.5 }]);
    assert.equal(clip.inSec, 0.25);
    assert.ok(Math.abs(clip.outSec - (ffprobeDurationSec(clip.file) - 0.5)) < 1e-9, `out ${clip.outSec}`);
    const [untrimmed] = cutListFromPlan({ units: [] }, dir, [{ shotNumber: 1 }]);
    assert.deepEqual([untrimmed.inSec, untrimmed.outSec], [0, undefined]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The pairwise call
// ---------------------------------------------------------------------------

test('one vision call per cut: the end of A and the start of B, with the shot text and the vehicle\'s reference', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'), { source: 'testsrc' });
    const ref = join(dir, 'ferry.png');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=navy:s=64x64', '-frames:v', '1', ref]);
    const calls = [];
    const client = { async chatJson(options) {
      calls.push(options);
      return answers({ vehicle: { answer: 'different', note: 'A is the long ferry, B a short launch' } });
    } };
    const result = await checkPairContinuity(client, 'stub-vision',
      { id: 'shot 1', file: a, inSec: 0, generation: 'u1', refs: [{ name: 'HARBOUR FERRY', file: ref }] },
      { id: 'shot 2', file: b, inSec: 0, generation: 'u2', refs: [{ name: 'HARBOUR FERRY', file: ref }] },
      { framesDir: join(dir, 'frames'), aText: 'She boards the ferry.', bText: 'The ferry pulls away.' });
    assert.equal(calls.length, 1);
    // Four frames, plus the ferry's reference once.
    assert.equal(calls[0].images.length, 5);
    assert.ok(calls[0].images.every(uri => uri.startsWith('data:image/jpeg;base64,')));
    assert.match(calls[0].userPrompt, /Shot A \(shot 1\) should show: She boards the ferry\./);
    assert.match(calls[0].userPrompt, /Image 5 is the reference for HARBOUR FERRY/);
    assert.match(calls[0].systemPrompt, /a change the text asks for .* is not a fault/);
    assert.match(calls[0].systemPrompt, /every key present/);
    assert.deepEqual([result.verdict, result.kinds, result.acrossGenerations, result.errored ?? false], ['FLAG-CRITICAL', ['vehicle'], true, false]);
    assert.match(result.issues[0], /^vehicle: A is the long ferry, B a short launch/);

    const broken = await checkPairContinuity({ async chatJson() { throw new Error('HTTP 500'); } }, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([broken.errored, broken.verdict], [true, 'FLAG-LOW']);
    assert.match(broken.issues[0], /HTTP 500/);

    // A clip that is not on disk is unchecked, and no call is made for it.
    let called = false;
    const missing = await checkPairContinuity({ async chatJson() { called = true; return answers(); } }, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'gone', file: join(dir, 'gone.mp4'), inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([missing.errored, called], [true, false]);
    assert.match(missing.issues[0], /gone: .* is not on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reply that does not fill in the checklist makes the cut unchecked, never a pass', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-partial-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'));
    for (const reply of [{}, { verdict: 'PASS', issues: [] }, { vehicle: { answer: 'same' } }]) {
      const result = await checkPairContinuity({ async chatJson() { return reply; } }, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
      assert.equal(result.errored, true, JSON.stringify(reply));
      assert.notEqual(result.verdict, 'PASS');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a time cut tells the judge time passes, and nothing it finds is critical', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-later-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'));
    const calls = [];
    const client = { async chatJson(options) {
      calls.push(options);
      return answers({ people: { answer: 'different', note: 'another coat' }, facing: { answer: 'reversed', note: 'she faces the shore' }, light: { answer: 'different', note: 'dusk' } });
    } };
    const result = await checkPairContinuity(client, 'stub', { id: 'shot 1', file: a, inSec: 0 }, { id: 'shot 2', file: b, inSec: 0, timeCut: true }, { framesDir: join(dir, 'frames') });
    assert.match(calls[0].userPrompt, /Time passes between shot A and shot B \(a time cut\)/);
    assert.deepEqual([result.verdict, result.kinds, result.timeCut], ['FLAG-MODERATE', ['people'], true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the last frame of a clip whose audio runs past its picture is still read', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-long-audio-'));
  try {
    // One second of picture, two of sound: the container ends a second after the last frame.
    const a = clipWithAudio(join(dir, 'a.mp4'), { video: 1, audio: 2 });
    const b = videoClip(join(dir, 'b.mp4'));
    assert.ok(Math.abs(ffprobeDurationSec(a) - 2) < 0.1, 'the container runs to the end of the audio');
    assert.ok(Math.abs(videoStreamDurationSec(a) - 1) < 0.1, 'the picture ends at 1 s');
    // A seek past the last frame writes nothing; stepping back finds it.
    const out = join(dir, 'last.png');
    const at = extractFrameAtOrBefore(a, ffprobeDurationSec(a) - 0.05, out);
    assert.ok(at !== undefined && at < 1 && existsSync(out), `read at ${at}`);
    const calls = [];
    const result = await checkPairContinuity({ async chatJson(options) { calls.push(options); return answers(); } }, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([calls.length, calls[0]?.images.length, result.errored ?? false, result.verdict], [1, 4, false, 'PASS']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('the verdict follows from the checklist: a different vehicle, person or prop, or a reversed facing, is critical', () => {
  assert.deepEqual(verdictFromAnswers(answers()), { verdict: 'PASS', issues: [], kinds: [] });
  assert.deepEqual(verdictFromAnswers(answers({ facing: { answer: 'Reversed', note: 'she faces aft' } })), { verdict: 'FLAG-CRITICAL', issues: ['facing: she faces aft'], kinds: ['facing'] });
  for (const key of ['vehicle', 'people', 'props']) {
    assert.equal(verdictFromAnswers(answers({ [key]: { answer: 'different' } })).verdict, 'FLAG-CRITICAL', key);
  }
  assert.equal(verdictFromAnswers(answers({ action: { answer: 'breaks', note: 'still moored' } })).verdict, 'FLAG-MODERATE');
  assert.deepEqual(verdictFromAnswers(answers({ light: { answer: 'different' } })), { verdict: 'FLAG-LOW', issues: ['light'], kinds: ['light'] });
});

test('a reply that misses an answer, has the wrong shape or answers off the list is unchecked (rule 46)', () => {
  const unchecked = reply => {
    const result = verdictFromAnswers(reply);
    assert.equal(result.errored, true, JSON.stringify(reply));
    assert.notEqual(result.verdict, 'PASS');
    return result;
  };
  unchecked({});
  unchecked(null);
  unchecked([]);
  unchecked('PASS');
  // The identity schema is not the checklist.
  unchecked({ verdict: 'PASS', issues: [] });
  // Omitted keys: the reply answered only some questions.
  assert.match(unchecked({ vehicle: { answer: 'same' }, facing: { answer: 'same' }, action: { answer: 'continues' }, light: { answer: 'same' } }).issues[0], /people, props/);
  // A bare string is not an answer object.
  unchecked({ vehicle: 'different', people: 'n/a', props: 'n/a', facing: 'same', action: 'continues', light: 'same' });
  // An answer outside the allowed set.
  assert.match(unchecked(answers({ facing: { answer: 'mostly the same' } })).issues[0], /facing/);
  unchecked(answers({ action: { answer: 'n/a' } }));
});

test('on a time cut only a different vehicle, person or prop counts, and as moderate', () => {
  assert.deepEqual(verdictFromAnswers(answers({ vehicle: { answer: 'different', note: 'another boat' } }), { timeCut: true }), { verdict: 'FLAG-MODERATE', issues: ['vehicle: another boat'], kinds: ['vehicle'] });
  assert.equal(verdictFromAnswers(answers({ facing: { answer: 'reversed' }, action: { answer: 'breaks' }, light: { answer: 'different' } }), { timeCut: true }).verdict, 'PASS');
  assert.equal(verdictFromAnswers({}, { timeCut: true }).errored, true);
});

// ---------------------------------------------------------------------------
// The script's side: who speaks on camera, and the object cast's references
// ---------------------------------------------------------------------------

test('a line is on camera when its speaker is in the shot and is not the narrator', () => {
  assert.equal(speaksOnCamera({ characters: ['ANNA'], dialogue: { character: 'Anna', line: 'This way.' } }), true);
  assert.equal(speaksOnCamera({ characters: ['ANNA'], dialogue: { character: 'NARRATOR', line: 'She waited.' } }), false);
  assert.equal(speaksOnCamera({ characters: ['LEO'], dialogue: { character: 'ANNA', line: 'Over here.' } }), false);
  assert.equal(speaksOnCamera({ characters: ['ANNA'], dialogue: { character: 'ANNA', line: '  ' } }), false);
  assert.equal(speaksOnCamera({ characters: ['ANNA'], dialogue: null }), false);
  assert.equal(speaksOnCamera(undefined), false);
});

test('the judge gets the references of the object cast in a shot, not of its people', () => {
  const dir = mkdtempSync(join(tmpdir(), 'objectrefs-'));
  try {
    for (const [slug, file] of [['harbour-ferry', 'front.png'], ['anna', 'front.png'], ['brass-key', 'anchor.png'], ['brass-key', 'front.png']]) {
      mkdirSync(join(dir, 'characters', slug), { recursive: true });
      writeFileSync(join(dir, 'characters', slug, file), '');
    }
    const series = {
      outputDir: dir,
      characters: [
        { name: 'HARBOUR FERRY', baseTraits: 'inanimate object, prop; navy hull' },
        { name: 'ANNA', baseTraits: 'a young woman' },
        { name: 'BRASS KEY', baseTraits: 'Inanimate object, prop; worn brass' },
        { name: 'MAP CASE', baseTraits: 'inanimate object, prop; leather' },
      ],
    };
    assert.deepEqual(objectRefsFor(series, ['Harbour Ferry', 'ANNA', 'BRASS KEY', 'MAP CASE', 'NOBODY']), [
      { name: 'HARBOUR FERRY', file: join(dir, 'characters', 'harbour-ferry', 'front.png') },
      { name: 'BRASS KEY', file: join(dir, 'characters', 'brass-key', 'anchor.png') },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CLI's cut-list mode
// ---------------------------------------------------------------------------

function makeProject(shots) {
  const projectDir = mkdtempSync(join(tmpdir(), 'continuity-cli-'));
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  mkdirSync(join(episodeDir, 'scene-001'), { recursive: true });
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify({
    name: 'cut-test', slug: 'cut-test', outputDir: projectDir,
    characters: [], locations: [], episodes: [{ number: 1, title: 'Cuts', status: 'scripted' }],
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ episode: 1, title: 'Cuts', status: 'approved', shots }));
  return { projectDir, episodeDir };
}

/** No key anywhere: an empty key, an empty config dir, and a working directory with no .env. */
function runCli(args, cwd) {
  const configDir = mkdtempSync(join(tmpdir(), 'continuity-cli-config-'));
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, VENICE_API_KEY: '', VENICE_VIDEO_CONFIG_DIR: configDir },
  });
}

const SHOT = { type: 'action', duration: '2s', videoModel: 'action', description: 'x', characters: [], dialogue: null, sfx: null, cameraMovement: '', transition: 'CUT' };

test('cut-list mode: --skip-vision and --continuity off make no vision call and need no key', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeProject([{ ...SHOT, shotNumber: 1 }, { ...SHOT, shotNumber: 2 }]);
  try {
    videoClip(join(projectDir, 'a.mp4'));
    videoClip(join(projectDir, 'b.mp4'));
    const list = join(projectDir, 'edit.json');
    writeFileSync(list, JSON.stringify({ clips: [{ file: 'a.mp4', shot: 1 }, { file: 'b.mp4', shot: 2 }] }));
    for (const flag of [['--skip-vision'], ['--continuity', 'off']]) {
      const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--cut-list', list, ...flag], projectDir);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, new RegExp(`Neighbour continuity: skipped \\(${flag.join(' ')}\\)`));
      const report = JSON.parse(readFileSync(join(projectDir, 'edit.continuity-report.json'), 'utf-8'));
      assert.deepEqual([report.continuity, report.summary.passed, report.continuitySkipped], [[], true, flag.join(' ')]);
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('cut-list mode: an unchecked cut is counted, reported, and fails the run; the calls are counted first', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeProject([{ ...SHOT, shotNumber: 1 }, { ...SHOT, shotNumber: 2 }]);
  try {
    videoClip(join(projectDir, 'a.mp4'));
    const list = join(projectDir, 'edit.json');
    writeFileSync(list, JSON.stringify({ clips: [{ file: 'a.mp4', shot: 1 }, { file: 'missing.mp4', shot: 2 }] }));
    const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--cut-list', list], projectDir);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /1 cut\(s\) to check, 0 vision call\(s\)/);
    assert.match(r.stdout, /UNCHECKED/);
    assert.match(r.stdout, /0 critical, 1 unchecked/);
    assert.match(r.stdout, /Re-check after fixing: qa-videos -p .* -e 1 --cut-list /);
    const report = JSON.parse(readFileSync(join(projectDir, 'edit.continuity-report.json'), 'utf-8'));
    assert.deepEqual([report.summary.errored, report.summary.passed, report.continuity[0].errored], [1, false, true]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('qa-videos rejects an unknown --continuity scope', () => {
  const { projectDir } = makeProject([{ ...SHOT, shotNumber: 1 }]);
  try {
    const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--continuity', 'some'], projectDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--continuity takes joins, all or off/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('plan mode: a join that changes location is not compared for light, and a line cut by trimEnd is flagged', { skip: !ffmpegAvailable }, () => {
  const { projectDir, episodeDir } = makeProject([
    { ...SHOT, shotNumber: 1, location: 'harbour-station' },
    // ANNA speaks on camera; her line is a 1.5 s tone in a 2 s clip, and trimEnd cuts it at 1.2 s.
    { ...SHOT, shotNumber: 2, location: 'ferry-deck', characters: ['ANNA'], dialogue: { character: 'ANNA', line: 'All aboard.' }, trimEnd: 0.8 },
  ]);
  try {
    const sceneDir = join(episodeDir, 'scene-001');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x101010:s=320x180:d=2:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(sceneDir, 'shot-001.mp4')]);
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=320x180:d=2:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-af', 'apad=whole_dur=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '2', join(sceneDir, 'shot-002.mp4'),
    ]);
    writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({
      episode: 1, generatedAt: new Date().toISOString(),
      units: [
        { unitId: 'unit-001', unitType: 'single', shotNumbers: [1], outputFile: 'shot-001.mp4' },
        { unitId: 'unit-002', unitType: 'single', shotNumbers: [2], outputFile: 'shot-002.mp4' },
      ],
    }));
    const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--skip-vision'], projectDir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // Dark into bright would be a critical luma jump; it is a scene cut.
    assert.match(r.stdout, /1 join\(s\) change location/);
    assert.match(r.stdout, /shot 2: the speech runs \d+ ms past the cut at 1\.20 s/);
    const report = JSON.parse(readFileSync(join(episodeDir, 'video-qa-report.json'), 'utf-8'));
    assert.deepEqual([report.boundaries, report.summary.passed, report.speechTails.length], [[], true, 1]);
    assert.ok(Math.abs(report.speechTails[0].runsPastMs - 300) <= 40, `runs past ${report.speechTails[0].runsPastMs} ms`);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The plan check: a close-up's object that its scene never shows
// ---------------------------------------------------------------------------

const WORKS = { slug: 'works', name: 'Works', description: 'A long stone hall with a workbench.', spatialAnchors: 'View 1 (north): the bench across the bottom; machines beyond it.' };
const CLOSE_UP = { shotNumber: 23, type: 'close-up', location: 'works', description: 'Close on the bench: a hand sets a bronze key into a plate and turns it.' };
const WIDE = { shotNumber: 24, type: 'action', location: 'works', description: 'Every station starts at once; the builder watches.' };
const propFindings = input => checkShotPlan(input).filter(f => f.kind === 'prop-continuity');

test('the plan check flags a close-up\'s object that the next shot and the plates never show', () => {
  // A ferry whose description mentions its "crossed-keys mark" is not a cast key.
  const cast = [{ name: 'HARBOUR FERRY', prop: true, description: 'navy hull, the gold crossed-keys mark on the bow' }];
  const findings = propFindings({ shots: [CLOSE_UP, WIDE], locations: [WORKS], cast });
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].shot, findings[0].severity, findings[0].noun], ['23', 'warn', 'key']);
  assert.match(findings[0].message, /Shot 23 shows the key, which neither shot 24 nor any plate of works shows/);
  // Shown in the next shot, or cast as an object: no finding.
  assert.equal(propFindings({ shots: [CLOSE_UP, { ...WIDE, description: 'The key turns; every station starts.' }], locations: [WORKS], cast }).length, 0);
  assert.equal(propFindings({ shots: [CLOSE_UP, WIDE], locations: [WORKS], cast: [{ name: 'BRONZE KEY', prop: true }] }).length, 0);
  // A new scene after the close-up is not its neighbour.
  assert.equal(propFindings({ shots: [CLOSE_UP, { ...WIDE, continuity: { from: 'new-scene' } }], locations: [WORKS], cast }).length, 0);
  // Not a close-up or an insert: not checked.
  assert.equal(propFindings({ shots: [{ ...CLOSE_UP, type: 'action' }, WIDE], locations: [WORKS] }).length, 0);
});

test('a word with another sense is not the object: key light, a crossed-keys mark, an 85mm lens, verbs', () => {
  const closeUp = description => propFindings({ shots: [{ ...CLOSE_UP, description }, WIDE], locations: [WORKS] }).map(f => f.noun);
  // Not the object.
  assert.deepEqual(closeUp('Close on her face, low-key light from the left, a hard key light on the cheek.'), []);
  assert.deepEqual(closeUp('Close on the gold crossed-keys mark on the bow.'), []);
  assert.deepEqual(closeUp('Close on her eyes, shot on an 85mm lens, a soft lens flare; she looks into the lens.'), []);
  assert.deepEqual(closeUp('Close on her hands: she notes the time, locks the drawer, and cups her hands around the flame.'), []);
  // The object.
  assert.deepEqual(closeUp('Close on the bench: the key turns.'), ['key']);
  assert.deepEqual(closeUp('Close on the magnifying lens over the map.'), ['lens', 'map']);
  assert.deepEqual(closeUp('Close on a folded note pinned beside the lock.'), ['lock', 'note']);
  assert.deepEqual(closeUp('Close on her hands around a tea cup.'), ['cup']);
});
