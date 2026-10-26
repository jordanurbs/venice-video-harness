// A spoken line cut off by the picture cut (qa-videos): the cut of a clip with
// on-camera speech belongs in silence. Synthetic audio stands in for a line: a
// tone, then silence. No network calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { audioStreamDurationSec, checkSpeechTail, cutListFromPlan, hasAudioStream, playsOn, silencesIn } from '../dist/mini-drama/video-qa.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
}

test('a clip with on-camera speech cut before the line falls silent is flagged; one cut in silence is not', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-'));
  try {
    // 1 s of "speech" (a tone), then 1 s of silence.
    const file = join(dir, 'line.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'apad=pad_dur=1', '-ar', '48000', file]);
    assert.ok(silencesIn(file, 0, 2).some(([start]) => Math.abs(start - 1) < 0.05));
    const cut = checkSpeechTail({ id: 'shot 2', file, inSec: 0, outSec: 0.9 });
    assert.ok(cut);
    assert.ok(Math.abs(cut.runsPastMs - 100) <= 30, `runs past ${cut.runsPastMs} ms`);
    assert.match(cut.message, /the speech runs \d+ ms past the cut at 0\.90 s/);
    assert.equal(checkSpeechTail({ id: 'shot 2', file, inSec: 0, outSec: 1.4 }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clip that ends on sound with nothing after it says so', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-end-'));
  try {
    const file = join(dir, 'tone.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', file]);
    const finding = checkSpeechTail({ id: 'shot 3', file, inSec: 0 });
    assert.equal(finding?.runsPastMs, undefined);
    assert.match(finding?.message ?? '', /shot 3: the clip ends on sound at 1\.00 s, not in silence\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clip with no audio stream has nothing to check, and is not read as "ends on sound"', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-mute-'));
  try {
    const file = join(dir, 'mute.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:d=2:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    assert.equal(hasAudioStream(file), false);
    // ffmpeg fails on it: that is no reading, not "no silence".
    assert.equal(silencesIn(file, 1, 1), undefined);
    assert.equal(checkSpeechTail({ id: 'shot 4', file, inSec: 0, outSec: 1.5 }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a trimEnd that cuts through the line is flagged, though the untrimmed clip ends in silence', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-trim-'));
  try {
    // A 2 s shot: the line sounds for 1.5 s, then silence.
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:d=2:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-af', 'apad=whole_dur=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '2', join(dir, 'shot-001.mp4'),
    ]);
    const plan = { units: [{ unitId: 'unit-001', shotNumbers: [1] }] };
    const [untrimmed] = cutListFromPlan(plan, dir, [{ shotNumber: 1 }]);
    assert.equal(checkSpeechTail(untrimmed), undefined);
    // assemble-episode cuts this shot 0.8 s before its end, at 1.2 s: in the middle of the line.
    const [trimmed] = cutListFromPlan(plan, dir, [{ shotNumber: 1, trimEnd: 0.8 }]);
    const finding = checkSpeechTail(trimmed);
    assert.ok(finding, 'the trimmed cut is flagged');
    assert.ok(Math.abs(finding.runsPastMs - 300) <= 40, `runs past ${finding.runsPastMs} ms`);
    assert.match(finding.message, /shot 1: the speech runs \d+ ms past the cut at 1\.20 s \(it falls silent at 1\.5\d s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clip whose sound stops before the picture does has nothing to check at its cut', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-short-audio-'));
  try {
    // Two seconds of picture, a tone for the first 1.5 s and then no audio at all.
    const file = join(dir, 'short-audio.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:d=2:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
    ]);
    assert.ok(Math.abs(audioStreamDurationSec(file) - 1.5) < 0.1, `audio ends at ${audioStreamDurationSec(file)}`);
    // A window with no decoded audio is no reading, not "no silence".
    assert.equal(silencesIn(file, 1.6, 0.4), undefined);
    assert.equal(checkSpeechTail({ id: 'shot 5', file, inSec: 0 }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a line that ends less than 60 ms before the end of the file has ended', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-short-pause-'));
  try {
    // The line sounds until 0.96 s; the file ends 40 ms later, too short a pause for the usual 60 ms test.
    const file = join(dir, 'line.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.96', '-af', 'apad=whole_dur=1', '-ar', '48000', file]);
    assert.equal(checkSpeechTail({ id: 'shot 6', file, inSec: 0 }), undefined);
    // Cut 100 ms before that end, the line is still sounding.
    assert.match(checkSpeechTail({ id: 'shot 6', file, inSec: 0, outSec: 0.86 })?.message ?? '', /shot 6: the clip ends on sound at 0\.86 s, not in silence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cut where the next clip plays on from the same sound is not a cut through the line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tail-plays-on-'));
  try {
    for (const name of ['shot-001.mp4', 'shot-002.mp4', 'take.mp4']) writeFileSync(join(dir, name), '');
    const one = { id: 'shot 1', file: join(dir, 'shot-001.mp4'), inSec: 0, generation: 'montage-s01-001-002' };
    const two = { id: 'shot 2', file: join(dir, 'shot-002.mp4'), inSec: 0, generation: 'montage-s01-001-002' };
    // A montage's beat cuts: the next shot of the same generation, nothing trimmed between.
    assert.equal(playsOn(one, two), true);
    assert.equal(playsOn({ ...one, outSec: 0.8 }, two), false, 'a trimEnd drops sound at the cut');
    assert.equal(playsOn(one, { ...two, inSec: 0.2 }), false, 'a trimStart drops sound at the cut');
    assert.equal(playsOn(one, { ...two, generation: 'unit-002' }), false, 'another generation');
    assert.equal(playsOn(one, { ...two, file: join(dir, 'gone.mp4') }), false, 'the next clip is not on disk');
    assert.equal(playsOn(one, undefined), false, 'the last clip');
    // An edit's contiguous cuts in one take.
    const take = join(dir, 'take.mp4');
    assert.equal(playsOn({ id: 'a', file: take, inSec: 0, outSec: 2 }, { id: 'b', file: take, inSec: 2, outSec: 4 }), true);
    assert.equal(playsOn({ id: 'a', file: take, inSec: 0, outSec: 2 }, { id: 'b', file: take, inSec: 3, outSec: 4 }), false, 'a jump within the take');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
