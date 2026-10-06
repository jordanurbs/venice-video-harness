// measureLipSyncFidelity: a render that passes the clip through passes; one that re-performed
// part of it fails. Synthetic audio only; needs ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { measureLipSyncFidelity } from '../dist/mini-drama/lip-sync-fidelity.js';

const dir = mkdtempSync(join(tmpdir(), 'venice-lipsync-fidelity-'));
const ff = args => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
const speechy = seed => `anoisesrc=d=6:c=pink:r=44100:seed=${seed},volume='0.2+0.8*abs(sin(2*PI*2.5*t))':eval=frame`;

const clip = join(dir, 'clip.wav');
ff(['-f', 'lavfi', '-i', speechy(1), '-ac', '1', clip]);

function renderWith(audio, name) {
  const out = join(dir, name);
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=7', '-i', audio, '-af', 'apad', '-t', '7',
    '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', out]);
  return out;
}

test('a render that passes the clip through is accepted', () => {
  const f = measureLipSyncFidelity(renderWith(clip, 'faithful.mp4'), clip);
  assert.ok(f.ok, JSON.stringify(f));
  assert.ok(f.corr >= 0.9);
});

test('a render that re-performed two seconds is rejected', () => {
  const other = join(dir, 'other.wav');
  ff(['-f', 'lavfi', '-i', speechy(2), '-ac', '1', other]);
  const mixed = join(dir, 'mixed.wav');
  ff(['-i', clip, '-i', other, '-filter_complex',
    '[0]atrim=0:2[a];[1]atrim=2:4,asetpts=PTS-STARTPTS[b];[0]atrim=4:6,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1',
    '-ac', '1', mixed]);
  const f = measureLipSyncFidelity(renderWith(mixed, 'reperformed.mp4'), clip);
  assert.equal(f.ok, false, JSON.stringify(f));
  assert.ok(f.minWindowCorr < 0.6);
});
