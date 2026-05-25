#!/usr/bin/env node
// Smoke test for scripts/ken-burns-video.ts (W1.23). Synthesizes a 4-second
// video where the left half is solid red for t<2s and solid blue for t>=2s,
// runs the helper for 4s, samples a frame at t=3s, and asserts the dominant
// color is blue. If the helper accidentally used `zoompan` (which freezes
// on the first input frame), the frame at t=3s would still be red.
//
// Requires ffmpeg + ffprobe. Run with `node tests/test-ken-burns-video.mjs`
// after `npm run build`.

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  return r.status === 0;
}

if (!hasFfmpeg()) {
  console.log('  SKIP: ffmpeg not on PATH');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
try {
  const inPath = join(dir, 'in.mp4');
  const outPath = join(dir, 'out.mp4');

  // Build a 4s, 320x180 video: red for t in [0,2), blue for t in [2,4).
  // Two color sources concatenated.
  const buildArgs = [
    '-y',
    '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    inPath,
  ];
  const build = spawnSync('ffmpeg', buildArgs, { encoding: 'utf-8' });
  if (build.status !== 0) {
    console.error('failed to build test input:', build.stderr);
    process.exit(1);
  }

  // Run the helper.
  const run = spawnSync(
    'node',
    ['--import', 'tsx', join(process.cwd(), 'scripts', 'ken-burns-video.ts'),
      '--in', inPath, '--out', outPath,
      '--duration', '4', '--zoom-from', '1.0', '--zoom-to', '1.1',
      '--width', '320', '--height', '180', '--fps', '30',
    ],
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  if (run.status !== 0) {
    console.error('ken-burns-video failed:');
    console.error('  stdout:', run.stdout);
    console.error('  stderr:', run.stderr);
    process.exit(1);
  }
  ok('helper produced an output file', existsSync(outPath));

  // Sample a frame at t=3s and read average color.
  const samplePath = join(dir, 'frame.png');
  const sample = spawnSync('ffmpeg', [
    '-y', '-ss', '3', '-i', outPath, '-frames:v', '1',
    '-vf', 'scale=1:1', samplePath,
  ], { encoding: 'utf-8' });
  if (sample.status !== 0) {
    console.error('failed to sample frame:', sample.stderr);
    process.exit(1);
  }

  // Pull RGB of the 1x1 PNG via ffmpeg's signalstats.
  const stats = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v', '-of', 'csv=p=0',
    '-show_frames', '-f', 'lavfi',
    `movie=${samplePath},format=rgb24,signalstats`,
  ], { encoding: 'utf-8' });
  // Easier path: re-read the PNG and check its pixel.
  const buf = (await import('node:fs')).readFileSync(samplePath);
  // PNG is too involved to decode by hand here — but we can use ffmpeg to
  // convert to raw rgb and inspect.
  const rawPath = join(dir, 'frame.rgb');
  const conv = spawnSync('ffmpeg', [
    '-y', '-i', samplePath, '-vf', 'scale=1:1', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', rawPath,
  ], { encoding: 'utf-8' });
  if (conv.status !== 0) {
    console.error('failed to convert frame to rgb24:', conv.stderr);
    process.exit(1);
  }
  const rgb = (await import('node:fs')).readFileSync(rawPath);
  const r = rgb[0], g = rgb[1], b = rgb[2];
  console.log(`  sampled pixel at t=3s: rgb(${r}, ${g}, ${b})`);
  ok('frame at t=3s is blue (zoom-preserving motion, NOT zoompan-frozen red)',
    b > 100 && r < 80);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
