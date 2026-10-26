// Tests for the post-render video QA layer (rule 52) and its gates.
//
// The programmatic checks are exercised against tiny synthetic videos built
// with ffmpeg at test time (solid-color frames, with and without an injected
// head flash), so the luma math is tested for real without any API calls.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectHeadGlitch,
  headFrameLumas,
  frameLuma,
  ffprobeDurationSec,
  extractFrame,
  sampleUnitFrames,
  unitFootage,
} from '../dist/mini-drama/video-qa.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;

const dir = mkdtempSync(join(tmpdir(), 'video-qa-test-'));

/** A 2s dark clip at 24fps. */
function makeCleanClip() {
  const path = join(dir, 'clean.mp4');
  spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:d=2:r=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ], { encoding: 'utf-8' });
  return path;
}

/** A 2s dark clip with a 2-frame white flash at frames 4-5 — the head glitch. */
function makeGlitchClip() {
  const path = join(dir, 'glitch.mp4');
  spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:d=2:r=24',
    '-vf', "geq=lum='if(between(N,4,5),235,lum(X,Y))':cb=128:cr=128",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ], { encoding: 'utf-8' });
  return path;
}

test('headFrameLumas reads per-frame luma', { skip: !ffmpegAvailable }, () => {
  const clip = makeCleanClip();
  const lumas = headFrameLumas(clip, 8);
  assert.ok(lumas.length >= 6, `expected >=6 luma samples, got ${lumas.length}`);
  for (const l of lumas) assert.ok(l > 10 && l < 60, `dark clip luma out of range: ${l}`);
});

test('detectHeadGlitch flags a spike-and-revert flash', { skip: !ffmpegAvailable }, () => {
  const clip = makeGlitchClip();
  const finding = detectHeadGlitch(clip, 'unit-glitch');
  assert.ok(finding, 'expected the injected flash to be detected');
  assert.equal(finding.unitId, 'unit-glitch');
  assert.ok(finding.frameIndex >= 3 && finding.frameIndex <= 6, `flash located at frame ${finding.frameIndex}`);
  assert.ok(finding.lumaDelta > 100, `expected a large luma delta, got ${finding.lumaDelta}`);
});

test('detectHeadGlitch stays quiet on a clean clip', { skip: !ffmpegAvailable }, () => {
  const clip = makeCleanClip();
  assert.equal(detectHeadGlitch(clip, 'unit-clean'), undefined);
});

test('frameLuma and ffprobeDurationSec agree with the synthetic clip', { skip: !ffmpegAvailable }, () => {
  const clip = makeCleanClip();
  const duration = ffprobeDurationSec(clip);
  assert.ok(Math.abs(duration - 2) < 0.2, `expected ~2s, got ${duration}`);
  const luma = frameLuma(clip, 1.0);
  assert.ok(luma !== undefined && luma > 10 && luma < 60, `unexpected luma ${luma}`);
});

test('extractFrame writes a png', { skip: !ffmpegAvailable }, () => {
  const clip = makeCleanClip();
  const out = join(dir, 'frame.png');
  assert.equal(extractFrame(clip, 0.5, out), true);
  assert.ok(existsSync(out));
});

// A montage unit kept with its clips on disk but no master under its current
// name (a change in grouping renames units) is checked from its clips, never
// passed unchecked.
function clipOnlyUnit(sceneDir) {
  copyFileSync(makeGlitchClip(), join(sceneDir, 'shot-001.mp4'));
  copyFileSync(makeCleanClip(), join(sceneDir, 'shot-002.mp4'));
  return {
    unitId: 'montage-s02-001-002', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'montage-s02-001-002.mp4',
    model: 'seedance-2-5-reference-to-video', duration: '4s', decisionReasons: [], fallbackToSingles: false, sceneNumber: 2,
    segments: [
      { shotNumber: 1, startOffsetSec: 0, durationSec: 2, outputFile: 'shot-001.mp4' },
      { shotNumber: 2, startOffsetSec: 2, durationSec: 2, outputFile: 'shot-002.mp4' },
    ],
  };
}

test('a unit with no master is read from its clips', { skip: !ffmpegAvailable }, () => {
  const sceneDir = mkdtempSync(join(tmpdir(), 'video-qa-clips-'));
  const unit = clipOnlyUnit(sceneDir);
  const footage = unitFootage(unit, sceneDir);
  assert.deepEqual(footage.clips, [join(sceneDir, 'shot-001.mp4'), join(sceneDir, 'shot-002.mp4')]);
  assert.equal(footage.head, join(sceneDir, 'shot-001.mp4'));
  assert.equal(footage.tail, join(sceneDir, 'shot-002.mp4'));
  assert.equal(unitFootage({ ...unit, segments: [...unit.segments, { shotNumber: 3, startOffsetSec: 4, durationSec: 2, outputFile: 'shot-003.mp4' }] }, sceneDir), null, 'a missing clip: not rendered');

  const script = { shots: [1, 2].map(n => ({ shotNumber: n, characters: ['NORA'] })) };
  const samples = sampleUnitFrames([unit], sceneDir, script, { framesDir: join(sceneDir, 'frames') });
  assert.deepEqual(samples.map(s => s.shotNumber), [1, 2]);
  assert.ok(samples.every(s => existsSync(s.framePath) && Math.abs(s.atSec - 1) < 0.2), JSON.stringify(samples));
});

test('qa-videos checks a unit with no master from its clips instead of passing it', { skip: !ffmpegAvailable }, () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'video-qa-clip-unit-'));
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify({
    name: 'clip-unit', slug: 'clip-unit', outputDir: projectDir, characters: [], locations: [],
    episodes: [{ number: 1, title: 'Clips', status: 'produced' }], createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ episode: 1, title: 'Clips', shots: [1, 2].map(n => ({ shotNumber: n, type: 'action', duration: '2s', description: `beat ${n}`, characters: [] })) }));
  writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({ episode: 1, generatedAt: new Date().toISOString(), units: [clipOnlyUnit(sceneDir)] }));

  const r = runCli(['qa-videos', '-p', projectDir, '-e', '1', '--skip-vision']);
  assert.match(r.stdout, /1 rendered unit\(s\)/);
  assert.match(r.stdout, /Checked from their clips[^\n]*montage-s02-001-002/);
  // The head glitch in its first clip is found, so the run does not pass.
  assert.match(r.stdout, /montage-s02-001-002: head-glitch flash/);
  assert.notEqual(r.status, 0);
  const report = JSON.parse(readFileSync(join(episodeDir, 'video-qa-report.json'), 'utf-8'));
  assert.equal(report.summary.units, 1);
  assert.equal(report.summary.passed, false);
});

// ---------------------------------------------------------------------------
// Gate behavior: qa-approve reads the report it approves (rule 55).
// Exercised through the CLI against a synthetic project directory.
// ---------------------------------------------------------------------------

const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8' });
}

function makeProject(qaReportSummary) {
  const projectDir = mkdtempSync(join(tmpdir(), 'video-qa-gate-'));
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify({
    name: 'gate-test', slug: 'gate-test', outputDir: projectDir,
    characters: [], locations: [], episodes: [{ number: 1, title: 'Gate', status: 'scripted' }],
    createdAt: new Date().toISOString(),
  }));
  if (qaReportSummary) {
    writeFileSync(join(episodeDir, 'qa-report.json'), JSON.stringify({
      episode: 1, summary: qaReportSummary, results: [],
    }));
  }
  return projectDir;
}

test('qa-approve blocks without a qa-report.json', () => {
  const projectDir = makeProject(undefined);
  const r = runCli(['qa-approve', '-p', projectDir, '-e', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no qa-report\.json/);
});

test('qa-approve blocks on criticals and unchecked shots, --force overrides', () => {
  const projectDir = makeProject({ total: 3, pass: 1, flagCritical: 1, flagModerate: 0, flagLow: 0, errored: 1 });
  const blocked = runCli(['qa-approve', '-p', projectDir, '-e', '1']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /1 critical issue\(s\) and 1 unchecked shot\(s\)/);
  assert.ok(!existsSync(join(projectDir, 'episodes', 'episode-001', 'qa-approved.json')));

  const forced = runCli(['qa-approve', '-p', projectDir, '-e', '1', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(existsSync(join(projectDir, 'episodes', 'episode-001', 'qa-approved.json')));
});

test('qa-approve passes on a clean report', () => {
  const projectDir = makeProject({ total: 3, pass: 3, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 0 });
  const r = runCli(['qa-approve', '-p', projectDir, '-e', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(projectDir, 'episodes', 'episode-001', 'qa-approved.json')));
});
