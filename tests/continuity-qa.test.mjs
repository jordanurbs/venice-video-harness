// Neighbour continuity at the cuts (qa-videos): cut lists from a plan, a
// {clips} list or an EDL; how each cut joins (continuous, a time cut, a join
// the script does not state, or not judged), read from the script; which cuts
// are checked; the pairwise vision call with a stub client; the checklist
// verdict, where a reply that does not answer it is unchecked, never a pass;
// the CLI's cut-list mode; and the plan check's word test for a close-up's
// object that the rest of the scene never shows. No network calls: the CLI
// runs here make no vision call and get no API key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  checkPairContinuity, cutListFromJson, cutListFromPlan, markJoins, pairsToCheck, verdictFromAnswers, clipProblem,
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

/** A small still image (a reference). */
function still(path, colour = 'red') {
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${colour}:s=64x64`, '-frames:v', '1', path]);
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

/** A stub vision client that records its calls. */
function stubClient(reply = answers()) {
  const calls = [];
  return { calls, async chatJson(options) { calls.push(options); return typeof reply === 'function' ? reply(options) : reply; } };
}

const clip = (shot, extra = {}) => ({ id: `shot ${shot}`, file: 'x', inSec: 0, shot, ...extra });
const joinsOf = clips => clips.map(c => (c.newScene ? 'skip' : c.join ?? 'continuous'));

// ---------------------------------------------------------------------------
// Cut lists
// ---------------------------------------------------------------------------

test('a cut list comes from {clips}, or from an EDL whose paths start at the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutlist-'));
  try {
    mkdirSync(join(root, 'edit'), { recursive: true });
    mkdirSync(join(root, 'renders'), { recursive: true });
    writeFileSync(join(root, 'renders', 'take-1.mp4'), '');
    const clips = cutListFromJson({ clips: [
      { file: 'a.mp4', in: 1, out: 3, shot: '4b', label: 'wide', location: 'boathouse' },
      { file: '/abs/b.mp4', newScene: true, generation: 'g2' },
    ] }, join(root, 'edit'));
    assert.deepEqual(clips.map(c => [c.id, c.file.endsWith('edit/a.mp4') || c.file, c.inSec, c.outSec, c.shot, c.shotIdSuffix, c.location, c.newScene ?? false]), [
      ['wide', true, 1, 3, 4, 'b', 'boathouse', false],
      ['clip 2', '/abs/b.mp4', 0, undefined, undefined, undefined, undefined, true],
    ]);
    // Two clips cut from one file are one generation, unless the list says otherwise.
    assert.equal(clips[0].generation, clips[0].file);
    assert.equal(clips[1].generation, 'g2');
    const edl = cutListFromJson({ cuts: [{ shot: 5, master: 'renders/take-1.mp4', srcIn: 1.5, srcOut: 6.25, location: 'boathouse' }] }, [join(root, 'edit'), root]);
    assert.equal(edl[0].file, join(root, 'renders', 'take-1.mp4'));
    assert.deepEqual([edl[0].id, edl[0].inSec, edl[0].outSec, edl[0].location, edl[0].generation, edl[0].problem], ['shot 5', 1.5, 6.25, 'boathouse', edl[0].file, undefined]);
    assert.throws(() => cutListFromJson({ nope: [] }, root), /Not a cut list/);
    assert.throws(() => cutListFromJson({ clips: [{ in: 1 }] }, root), /clip 1 has no "file"/);
    assert.throws(() => cutListFromJson({ cuts: [{ srcIn: 1 }] }, root), /cut 1 has no "master"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bad time or reference leaves that clip unreadable, and the cuts beside it unchecked with no call', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutlist-bad-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const clips = cutListFromJson({ clips: [
      { file: a, out: null },
      { file: a, in: 2, out: 2 },
      { file: a, in: 'soon' },
      { file: a, refs: [null] },
      { file: a, refs: 'boat.png' },
      { file: a, in: '0.5', out: 1.5 },
    ] }, dir);
    assert.match(clips[0].problem, /"out" is not a time in seconds \(null\)/);
    assert.match(clips[1].problem, /"out" \(2\) is not after "in" \(2\)/);
    assert.match(clips[2].problem, /"in" is not a time in seconds \("soon"\)/);
    assert.match(clips[3].problem, /reference 1 has no file \(null\)/);
    assert.match(clips[4].problem, /"refs" is not a list/);
    assert.deepEqual([clips[5].problem, clips[5].inSec, clips[5].outSec], [undefined, 0.5, 1.5]);
    assert.match(cutListFromJson({ cuts: [{ master: a, srcIn: 3, srcOut: 1 }] }, dir)[0].problem, /"srcOut" \(1\) is not after "srcIn" \(3\)/);
    const client = stubClient();
    for (const bad of clips.slice(0, 5)) {
      const result = await checkPairContinuity(client, 'stub', clips[5], bad, { framesDir: join(dir, 'frames') });
      assert.equal(result.errored, true, bad.problem);
      assert.ok(result.issues[0].includes(bad.problem));
    }
    assert.equal(client.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// How a cut joins
// ---------------------------------------------------------------------------

test('a script with no continuity field: only a cut within one known location is judged, and never as critical', () => {
  // Written before the continuity field. A time jump inside one place ("the same
  // room, next day, other clothes") must not read as one continuous action.
  const legacy = [
    { shotNumber: 1, location: 'lighthouse' },
    { shotNumber: 2, location: 'lighthouse' },
    { shotNumber: 3, location: 'boathouse' },
    { shotNumber: 4 },
    { shotNumber: 5 },
  ];
  assert.deepEqual(joinsOf(markJoins([clip(1), clip(2), clip(3), clip(4), clip(5)], legacy)), [
    'continuous', 'unknown', 'skip', 'skip', 'skip',
  ]);
});

test('the script\'s join is used as written: continuous in full, even across a change of location; later is a time cut', () => {
  const planned = [
    { shotNumber: 1, location: 'lighthouse' },
    { shotNumber: 2, location: 'lighthouse', continuity: { from: 'later' } },
    { shotNumber: 3, location: 'boathouse', continuity: { from: 'continuous' } },
    { shotNumber: 4, location: 'boathouse', continuity: { from: 'new-scene' } },
    { shotNumber: 5, location: 'boathouse', continuity: { endState: 'the boat is moored' } },
  ];
  assert.deepEqual(joinsOf(markJoins([clip(1), clip(2), clip(3), clip(4), clip(5)], planned)), [
    'continuous', 'later', 'continuous', 'skip', 'unknown',
  ]);
});

test('the script\'s join counts only when the clip before is the script\'s previous shot', () => {
  const shots = [
    { shotNumber: 3, location: 'quay' },
    { shotNumber: 4, location: 'quay', continuity: { from: 'continuous' } },
    { shotNumber: 7, location: 'quay', continuity: { from: 'continuous' } },
    { shotNumber: 8, location: 'lighthouse', continuity: { from: 'continuous' } },
  ];
  // A cutaway between 3 and 4: shot 4's "continuous" describes its join to 3, not to 7.
  assert.deepEqual(joinsOf(markJoins([clip(3), clip(7), clip(4)], shots)), ['continuous', 'unknown', 'unknown']);
  // Reordered across places: the join is not stated, and the place changes, so it is not judged.
  assert.deepEqual(joinsOf(markJoins([clip(4), clip(8)], shots)), ['continuous', 'skip']);
  // In order, 7 then 8 is continuous as written, across the change of place.
  assert.deepEqual(joinsOf(markJoins([clip(7), clip(8)], shots)), ['continuous', 'continuous']);
  // A cut inside one shot is one action.
  assert.deepEqual(joinsOf(markJoins([clip(3), clip(3, { inSec: 2 })], shots)), ['continuous', 'continuous']);
  // Shots with suffixes are told apart.
  const inserts = [{ shotNumber: 2, location: 'quay' }, { shotNumber: 2, shotIdSuffix: 'b', location: 'lighthouse' }];
  assert.deepEqual(joinsOf(markJoins([clip(2), clip(2, { shotIdSuffix: 'b' })], inserts)), ['continuous', 'skip']);
});

test('a clip from outside the script follows the cut list: continuous unless newScene or a change of location', () => {
  const outside = (id, extra = {}) => ({ id, file: 'x', inSec: 0, ...extra });
  assert.deepEqual(joinsOf(markJoins([outside('a'), outside('b'), outside('c', { newScene: true })], [])), ['continuous', 'continuous', 'skip']);
  assert.deepEqual(joinsOf(markJoins([outside('a', { location: 'quay' }), outside('b', { location: 'lighthouse' })], [])), ['continuous', 'skip']);
  assert.deepEqual(joinsOf(markJoins([clip(1), outside('b', { location: 'quay' })], [{ shotNumber: 1, location: 'quay' }])), ['continuous', 'continuous']);
});

test('the plan\'s clips carry their generation, joins and flip, and a missing clip stays in the list as unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planclips-'));
  try {
    for (const n of ['001', '002', '004', '005']) writeFileSync(join(dir, `shot-${n}.mp4`), '');
    const clips = cutListFromPlan(
      { units: [{ unitId: 'montage-s01-001-002', shotNumbers: [1, 2] }, { unitId: 'unit-003', shotNumbers: [3] }, { unitId: 'unit-004', shotNumbers: [4] }, { unitId: 'unit-005', shotNumbers: [5] }] },
      dir,
      [
        { shotNumber: 1, location: 'quay' },
        { shotNumber: 2, location: 'quay', continuity: { from: 'continuous' } },
        { shotNumber: 3, location: 'quay', continuity: { from: 'continuous' } },
        { shotNumber: 4, location: 'quay', continuity: { from: 'continuous' }, flip: true },
        { shotNumber: 5, location: 'boathouse' },
      ],
    );
    assert.deepEqual(clips.map(c => [c.id, c.generation, c.newScene ?? false, c.flip ?? false]), [
      ['shot 1', 'montage-s01-001-002', false, false],
      ['shot 2', 'montage-s01-001-002', false, false],
      ['shot 3', 'unit-003', false, false],
      ['shot 4', 'unit-004', false, true],
      ['shot 5', 'unit-005', true, false],
    ]);
    // Shot 3 was never rendered: the cuts on either side of it are checked against it, so they come out
    // unchecked, instead of shot 4 (continuous with 3) being judged against shot 2.
    assert.deepEqual(pairsToCheck(clips, 'joins').map(([a, b]) => `${a.id}>${b.id}`), ['shot 2>shot 3', 'shot 3>shot 4']);
    assert.match(clipProblem(clips[2]), /shot-003\.mp4 is not on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plan\'s clips are cut as assemble-episode cuts them: from trimStart, to trimEnd before the end', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'planclips-trim-'));
  try {
    videoClip(join(dir, 'shot-001.mp4'));
    const [trimmed] = cutListFromPlan({ units: [{ unitId: 'unit-001', shotNumbers: [1] }] }, dir, [{ shotNumber: 1, trimStart: 0.25, trimEnd: 0.5 }]);
    assert.equal(trimmed.inSec, 0.25);
    assert.ok(Math.abs(trimmed.outSec - (ffprobeDurationSec(trimmed.file) - 0.5)) < 1e-9, `out ${trimmed.outSec}`);
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
    const ref = still(join(dir, 'rowing-boat.png'));
    const client = stubClient(answers({ vehicle: { answer: 'different', note: 'A is a red rowing boat with a white stripe, B a blue dinghy' } }));
    const result = await checkPairContinuity(client, 'stub-vision',
      { id: 'shot 1', file: a, inSec: 0, generation: 'u1', refs: [{ name: 'RED ROWING BOAT', file: ref }] },
      { id: 'shot 2', file: b, inSec: 0, generation: 'u2', refs: [{ name: 'RED ROWING BOAT', file: ref }] },
      { framesDir: join(dir, 'frames'), aText: 'He rows the red boat out from the jetty.', bText: 'The boat clears the harbour wall.' });
    assert.equal(client.calls.length, 1);
    // Four frames, plus the boat's reference once.
    assert.equal(client.calls[0].images.length, 5);
    assert.ok(client.calls[0].images.every(uri => uri.startsWith('data:image/jpeg;base64,')));
    assert.match(client.calls[0].userPrompt, /Shot A \(shot 1\) should show: He rows the red boat out from the jetty\./);
    assert.match(client.calls[0].userPrompt, /Image 5 is the reference for RED ROWING BOAT/);
    assert.match(client.calls[0].userPrompt, /as one continuous sequence\?$/);
    assert.doesNotMatch(client.calls[0].userPrompt, /mirrored|time passes|does not say/i);
    assert.match(client.calls[0].systemPrompt, /a change the text asks for .* is not a fault/);
    assert.match(client.calls[0].systemPrompt, /every key present/);
    assert.deepEqual([result.verdict, result.kinds, result.acrossGenerations, result.errored ?? false], ['FLAG-CRITICAL', ['vehicle'], true, false]);
    assert.match(result.issues[0], /^vehicle: A is a red rowing boat with a white stripe, B a blue dinghy/);

    const broken = await checkPairContinuity({ async chatJson() { throw new Error('HTTP 500'); } }, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([broken.errored, broken.verdict], [true, 'FLAG-LOW']);
    assert.match(broken.issues[0], /HTTP 500/);

    // A clip that is not on disk is unchecked, and no call is made for it.
    const quiet = stubClient();
    const missing = await checkPairContinuity(quiet, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'gone', file: join(dir, 'gone.mp4'), inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([missing.errored, quiet.calls.length], [true, 0]);
    assert.match(missing.issues[0], /gone: .* is not on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reference that is a folder, or not on disk, leaves the cut unchecked instead of ending the run', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-refs-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'));
    mkdirSync(join(dir, 'boat-folder'));
    const client = stubClient();
    for (const file of [join(dir, 'boat-folder'), join(dir, 'no-boat.png')]) {
      const result = await checkPairContinuity(client, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0, refs: [{ name: 'RED ROWING BOAT', file }] }, { framesDir: join(dir, 'frames') });
      assert.equal(result.errored, true);
      assert.match(result.issues[0], /the reference for RED ROWING BOAT .* is not a file on disk/);
    }
    assert.equal(client.calls.length, 0);
    // A file that passes that check but cannot be read is caught while the images are encoded.
    if (process.getuid?.() !== 0) {
      const locked = still(join(dir, 'locked.png'));
      chmodSync(locked, 0o000);
      const failing = await checkPairContinuity(client, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0, refs: [{ name: 'RED ROWING BOAT', file: locked }] }, { framesDir: join(dir, 'frames') });
      chmodSync(locked, 0o644);
      assert.equal(failing.errored, true);
      assert.match(failing.issues[0], /continuity QA failed: .*(EACCES|permission)/i);
      assert.equal(client.calls.length, 0);
    }
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
      const result = await checkPairContinuity(stubClient(reply), 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
      assert.equal(result.errored, true, JSON.stringify(reply));
      assert.notEqual(result.verdict, 'PASS');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a time cut, or a join the script does not state, is told to the judge, and nothing it finds is critical', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-join-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'));
    const reply = answers({ people: { answer: 'different', note: 'another coat' }, facing: { answer: 'reversed', note: 'he faces the lighthouse' }, light: { answer: 'different', note: 'dusk' } });
    const later = stubClient(reply);
    const timeCut = await checkPairContinuity(later, 'stub', { id: 'shot 1', file: a, inSec: 0 }, { id: 'shot 2', file: b, inSec: 0, join: 'later' }, { framesDir: join(dir, 'frames') });
    assert.match(later.calls[0].userPrompt, /Time passes between shot A and shot B \(a time cut\)/);
    assert.deepEqual([timeCut.verdict, timeCut.kinds, timeCut.join], ['FLAG-MODERATE', ['people'], 'later']);
    const unstated = stubClient(reply);
    const unknown = await checkPairContinuity(unstated, 'stub', { id: 'shot 1', file: a, inSec: 0 }, { id: 'shot 2', file: b, inSec: 0, join: 'unknown' }, { framesDir: join(dir, 'frames') });
    assert.match(unstated.calls[0].userPrompt, /The script does not say whether shot B follows straight on from shot A/);
    assert.deepEqual([unknown.verdict, unknown.kinds, unknown.join], ['FLAG-MODERATE', ['people'], 'unknown']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the judge is told when a shot\'s frames are mirrored by the cut, so reversed markings are not a difference', { skip: !ffmpegAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paircheck-flip-'));
  try {
    const a = videoClip(join(dir, 'a.mp4'));
    const b = videoClip(join(dir, 'b.mp4'));
    const client = stubClient();
    await checkPairContinuity(client, 'stub', { id: 'shot 1', file: a, inSec: 0 }, { id: 'shot 2', file: b, inSec: 0, flip: true }, { framesDir: join(dir, 'frames') });
    assert.match(client.calls[0].userPrompt, /Shot B's frames are mirrored \(the cut flips it left to right\), so lettering and markings on it read reversed/);
    assert.doesNotMatch(client.calls[0].userPrompt, /Shot A's frames are mirrored/);
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
    const client = stubClient();
    const result = await checkPairContinuity(client, 'stub', { id: 'a', file: a, inSec: 0 }, { id: 'b', file: b, inSec: 0 }, { framesDir: join(dir, 'frames') });
    assert.deepEqual([client.calls.length, client.calls[0]?.images.length, result.errored ?? false, result.verdict], [1, 4, false, 'PASS']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('the verdict follows from the checklist: a different vehicle, person or prop, or a reversed facing, is critical', () => {
  assert.deepEqual(verdictFromAnswers(answers()), { verdict: 'PASS', issues: [], kinds: [] });
  assert.deepEqual(verdictFromAnswers(answers({ facing: { answer: 'Reversed', note: 'he faces the wall' } })), { verdict: 'FLAG-CRITICAL', issues: ['facing: he faces the wall'], kinds: ['facing'] });
  for (const key of ['vehicle', 'people', 'props']) {
    assert.equal(verdictFromAnswers(answers({ [key]: { answer: 'different' } })).verdict, 'FLAG-CRITICAL', key);
  }
  assert.equal(verdictFromAnswers(answers({ action: { answer: 'breaks', note: 'still seated' } })).verdict, 'FLAG-MODERATE');
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

test('on a cut that is not one continuous action only a different vehicle, person or prop counts, and as moderate', () => {
  for (const join of ['later', 'unknown']) {
    assert.deepEqual(verdictFromAnswers(answers({ vehicle: { answer: 'different', note: 'another boat' } }), { join }), { verdict: 'FLAG-MODERATE', issues: ['vehicle: another boat'], kinds: ['vehicle'] });
    assert.equal(verdictFromAnswers(answers({ facing: { answer: 'reversed' }, action: { answer: 'breaks' }, light: { answer: 'different' } }), { join }).verdict, 'PASS');
    assert.equal(verdictFromAnswers({}, { join }).errored, true);
  }
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
    for (const [slug, file] of [['red-rowing-boat', 'front.png'], ['anna', 'front.png'], ['brass-compass', 'anchor.png'], ['brass-compass', 'front.png']]) {
      mkdirSync(join(dir, 'characters', slug), { recursive: true });
      writeFileSync(join(dir, 'characters', slug, file), '');
    }
    const series = {
      outputDir: dir,
      characters: [
        { name: 'RED ROWING BOAT', baseTraits: 'inanimate object, prop; red hull with a white stripe' },
        { name: 'ANNA', baseTraits: 'a young woman' },
        { name: 'BRASS COMPASS', baseTraits: 'Inanimate object, prop; worn brass' },
        { name: 'MAP CASE', baseTraits: 'inanimate object, prop; leather' },
      ],
    };
    assert.deepEqual(objectRefsFor(series, ['Red Rowing Boat', 'ANNA', 'BRASS COMPASS', 'MAP CASE', 'NOBODY']), [
      { name: 'RED ROWING BOAT', file: join(dir, 'characters', 'red-rowing-boat', 'front.png') },
      { name: 'BRASS COMPASS', file: join(dir, 'characters', 'brass-compass', 'anchor.png') },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CLI
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

test('cut-list mode: an unchecked cut is counted, reported, and fails the run; the calls and the judge are named first', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeProject([{ ...SHOT, shotNumber: 1 }, { ...SHOT, shotNumber: 2 }]);
  try {
    videoClip(join(projectDir, 'a.mp4'));
    videoClip(join(projectDir, 'c.mp4'));
    const list = join(projectDir, 'edit.json');
    // Outside clips (no script shot): judged as continuous, as the list asks. One is missing, one has a bad out point.
    writeFileSync(list, JSON.stringify({ clips: [{ file: 'a.mp4' }, { file: 'missing.mp4' }, { file: 'c.mp4', in: 1, out: null }] }));
    const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--cut-list', list], projectDir);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /clip 3: "out" is not a time in seconds \(null\); the cuts beside it cannot be checked/);
    assert.match(r.stdout, /2 cut\(s\) to check, 0 vision call\(s\)/);
    assert.match(r.stdout, /The judge is .*; a weaker one misses breaks\. Pass a stronger vision model with --model, within the project's privacy tier\./);
    assert.match(r.stdout, /UNCHECKED/);
    assert.match(r.stdout, /0 critical, 2 unchecked/);
    assert.match(r.stdout, /Re-check after fixing: qa-videos -p .* -e 1 --cut-list /);
    const report = JSON.parse(readFileSync(join(projectDir, 'edit.continuity-report.json'), 'utf-8'));
    assert.deepEqual([report.summary.errored, report.summary.passed, report.continuity.every(r => r.errored)], [2, false, true]);
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
    { ...SHOT, shotNumber: 1, location: 'lighthouse' },
    // ANNA speaks on camera; her line is a 1.5 s tone in a 2 s clip, and trimEnd cuts it at 1.2 s.
    { ...SHOT, shotNumber: 2, location: 'boathouse', characters: ['ANNA'], dialogue: { character: 'ANNA', line: 'Mind the step.' }, trimEnd: 0.8 },
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

test('plan mode: a line that carries over a montage\'s beat cut into the next shot of the same generation is not flagged', { skip: !ffmpegAvailable }, () => {
  const { projectDir, episodeDir } = makeProject([
    { ...SHOT, shotNumber: 1, location: 'quay', characters: ['LEO'], dialogue: { character: 'LEO', line: 'Hold the rope, and wait for the tide.' } },
    { ...SHOT, shotNumber: 2, location: 'quay', characters: ['LEO'], continuity: { from: 'continuous' } },
  ]);
  try {
    const sceneDir = join(episodeDir, 'scene-001');
    // Both beat cuts sound to their edges: the line runs on from shot 1 into shot 2.
    for (const n of ['001', '002']) clipWithAudio(join(sceneDir, `shot-${n}.mp4`), { video: 1, audio: 1 });
    clipWithAudio(join(sceneDir, 'montage-s01-001-002.mp4'), { video: 2, audio: 2 });
    writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({
      episode: 1, generatedAt: new Date().toISOString(),
      units: [{ unitId: 'montage-s01-001-002', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'montage-s01-001-002.mp4' }],
    }));
    const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--skip-vision'], projectDir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /shot 1: the clip ends on sound/);
    const report = JSON.parse(readFileSync(join(episodeDir, 'video-qa-report.json'), 'utf-8'));
    assert.equal(report.speechTails, undefined);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The plan check: a close-up's object that its scene never shows
// ---------------------------------------------------------------------------

const LIGHTHOUSE = { slug: 'lighthouse', name: 'Lighthouse', description: 'A whitewashed tower room with one window over the sea.', spatialAnchors: 'View 1 (north): the window across the back; a chair and a table below it.' };
const INSERT = { shotNumber: 12, type: 'insert', location: 'lighthouse', description: 'Insert: the keeper\'s hand opens a ledger and marks the hour in ink.' };
const WIDE = { shotNumber: 13, type: 'action', location: 'lighthouse', description: 'The keeper stands at the window and watches the sea.' };
const propFindings = input => checkShotPlan(input).filter(f => f.kind === 'prop-continuity');

test('the plan check flags a close-up\'s object that the next shot and the plates never show', () => {
  // A prop whose description mentions the word ("logged in the ledger") has not cast the ledger.
  const cast = [{ name: 'RED ROWING BOAT', prop: true, description: 'a red rowing boat with a white stripe, logged in the harbour master\'s ledger' }];
  const findings = propFindings({ shots: [INSERT, WIDE], locations: [LIGHTHOUSE], cast });
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].shot, findings[0].severity, findings[0].noun], ['12', 'warn', 'book']);
  assert.match(findings[0].message, /Shot 12 shows the book, which neither shot 13 nor any plate of lighthouse shows/);
  // Shown in the next shot, or cast as an object: no finding.
  assert.equal(propFindings({ shots: [INSERT, { ...WIDE, description: 'The keeper closes the ledger and looks out.' }], locations: [LIGHTHOUSE], cast }).length, 0);
  assert.equal(propFindings({ shots: [INSERT, WIDE], locations: [LIGHTHOUSE], cast: [{ name: 'THE LEDGER', prop: true }] }).length, 0);
  // A new scene after the close-up is not its neighbour.
  assert.equal(propFindings({ shots: [INSERT, { ...WIDE, continuity: { from: 'new-scene' } }], locations: [LIGHTHOUSE], cast }).length, 0);
  // Not a close-up or an insert: not checked.
  assert.equal(propFindings({ shots: [{ ...INSERT, type: 'action' }, WIDE], locations: [LIGHTHOUSE] }).length, 0);
});

test('a word with another sense is not the object (key light, longer lens, lock of hair, lamp-lit, verbs); the object is', () => {
  const objectsIn = description => propFindings({ shots: [{ ...INSERT, type: 'close-up', description }, WIDE], locations: [LIGHTHOUSE] }).map(f => f.noun);
  // Not the object.
  assert.deepEqual(objectsIn('Close on her face in low-key light, a hard key light from the left, the key logo on the screen.'), []);
  assert.deepEqual(objectsIn('Close on the key witness, then the key grip adjusts a flag.'), []);
  assert.deepEqual(objectsIn('Close on her eyes through an 85mm lens, a longer lens than before, with a soft lens flare; she looks into the lens.'), []);
  assert.deepEqual(objectsIn('Close on a lock of her hair and the brass letters of the sign; the letters of the sign spell CLOSED.'), []);
  assert.deepEqual(objectsIn('Close on the clerk: she books passage and maps the route.'), []);
  assert.deepEqual(objectsIn('Close on the lamp-lit window in the lantern glow.'), []);
  assert.deepEqual(objectsIn('Close on her hands: she notes the time, locks the drawer, and cups her hands around the flame.'), []);
  // The object.
  assert.deepEqual(objectsIn('Close on the desk: the key turns.'), ['key']);
  assert.deepEqual(objectsIn('Close on the magnifying lens over the map.'), ['lens', 'map']);
  assert.deepEqual(objectsIn('Close on a folded note pinned beside the lock.'), ['lock', 'note']);
  assert.deepEqual(objectsIn('Close on a letter from her brother, the book of tides, an oil lamp and a tea cup.'), ['note', 'book', 'lamp', 'cup']);
  assert.deepEqual(objectsIn('Close on the lantern; the lantern glows.'), ['lamp']);
});
