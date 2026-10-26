// qa-videos on a 1080p montage episode.
//
// Vision calls came back HTTP 413: frames and reference sheets went to the model as full-size PNGs. Images are now
// sent at most VISION_MAX_EDGE on the long edge, as JPEG. And every unit join in a montage episode is a change of
// location, so the boundary-luma check flagged ordinary scene cuts as "critical" jumps; joins that change location
// are no longer compared. No network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { visionDataUri, isLocationChange, VISION_MAX_EDGE } from '../dist/mini-drama/video-qa.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;

test('a 1080p frame goes to the vision model as a JPEG no wider than VISION_MAX_EDGE', { skip: !ffmpegAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-uri-'));
  try {
    const png = join(dir, 'frame.png');
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:d=1', '-frames:v', '1', png]);
    const uri = visionDataUri(png);
    assert.match(uri, /^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(uri.split(',')[1], 'base64');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: bytes });
    const [w, h] = probe.stdout.toString().trim().split(',').map(Number);
    assert.equal(w, VISION_MAX_EDGE);
    assert.equal(h, 576);
    assert.ok(bytes.length < 400 * 1024, `still ${bytes.length} bytes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a join between two locations is a scene cut; a join inside one location is checked', () => {
  const shots = [
    { shotNumber: 1, location: 'lighthouse' },
    { shotNumber: 2, location: 'lighthouse' },
    { shotNumber: 3, location: 'boathouse' },
    { shotNumber: 4 },
  ];
  assert.equal(isLocationChange({ shotNumbers: [1] }, { shotNumbers: [2] }, shots), false);
  assert.equal(isLocationChange({ shotNumbers: [1, 2] }, { shotNumbers: [3] }, shots), true);
  assert.equal(isLocationChange({ shotNumbers: [3] }, { shotNumbers: [4] }, shots), false, 'untagged: keep checking');
});
