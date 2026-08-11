// Tests for the remaining audit gates that shipped code-only during the
// canopy-run audit (2026-08-10/11):
//
//   1. assemble-episode video-QA gate: failing report blocks, missing report
//      warns, --skip-video-qa bypasses.
//   2. storyboard-episode reference preflight: missing character/location
//      references block with actionable instructions.
//   3. harvest-anchor: extracts a frame into anchor.png + provenance sidecar,
//      archives any prior anchor.
//   4. reference-slots: anchor.png outranks front.png in the primary slot.
//
// All exercised through the CLI (or the compiled module) against synthetic
// project directories -- no API calls, no billing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;
const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8' });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeSeries(overrides = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  const series = {
    name: 'gate-test', slug: 'gate-test', outputDir: projectDir,
    aesthetic: { style: 'test', palette: 'test', tone: 'test' },
    videoDefaults: {},
    characters: [], locations: [],
    episodes: [{ number: 1, title: 'Gate', status: 'scripted' }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify(series));
  return { projectDir, series };
}

function writeScript(projectDir, shots) {
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({
    episodeNumber: 1, title: 'Gate', status: 'approved', shots,
  }));
  return episodeDir;
}

function makeShotClip(sceneDir, name) {
  mkdirSync(sceneDir, { recursive: true });
  const path = join(sceneDir, name);
  spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:d=1:r=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path,
  ], { encoding: 'utf-8' });
  return path;
}

// ---------------------------------------------------------------------------
// 1. assemble-episode video-QA gate
// ---------------------------------------------------------------------------

test('assemble-episode blocks on a failing video-qa-report.json', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeSeries();
  const episodeDir = writeScript(projectDir, [
    { shotNumber: 1, type: 'action', duration: '1s', description: 'x', characters: [], dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' },
  ]);
  makeShotClip(join(episodeDir, 'scene-001'), 'shot-001.mp4');
  writeFileSync(join(episodeDir, 'video-qa-report.json'), JSON.stringify({
    episode: 1, summary: { units: 1, criticals: 2, errored: 0, passed: false },
  }));

  const r = runCli(['assemble-episode', '-p', projectDir, '-e', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Blocked: video QA found 2 critical issue/);
  assert.ok(!existsSync(join(episodeDir, 'episode-001-final.mp4')), 'must not assemble');
});

test('assemble-episode --skip-video-qa bypasses a failing report', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeSeries();
  const episodeDir = writeScript(projectDir, [
    { shotNumber: 1, type: 'action', duration: '1s', description: 'x', characters: [], dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' },
  ]);
  makeShotClip(join(episodeDir, 'scene-001'), 'shot-001.mp4');
  writeFileSync(join(episodeDir, 'video-qa-report.json'), JSON.stringify({
    episode: 1, summary: { units: 1, criticals: 2, errored: 0, passed: false },
  }));

  const r = runCli(['assemble-episode', '-p', projectDir, '-e', '1', '--skip-video-qa', '--no-music', '--no-subtitles', '--no-ambient']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(episodeDir, 'episode-001-final.mp4')));
});

test('assemble-episode warns (does not block) when the report is missing', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeSeries();
  const episodeDir = writeScript(projectDir, [
    { shotNumber: 1, type: 'action', duration: '1s', description: 'x', characters: [], dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' },
  ]);
  makeShotClip(join(episodeDir, 'scene-001'), 'shot-001.mp4');

  const r = runCli(['assemble-episode', '-p', projectDir, '-e', '1', '--no-music', '--no-subtitles', '--no-ambient']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /No video-qa-report\.json/);
  assert.ok(existsSync(join(episodeDir, 'episode-001-final.mp4')));
});

// ---------------------------------------------------------------------------
// 2. storyboard-episode reference preflight
// ---------------------------------------------------------------------------

test('storyboard-episode blocks when a scripted character has no references', () => {
  const { projectDir } = makeSeries({
    characters: [{ name: 'WREN', gender: 'female', age: '19', description: 'x', wardrobe: 'y' }],
    locations: [],
  });
  writeScript(projectDir, [
    { shotNumber: 1, type: 'action', duration: '8s', description: 'x', characters: ['WREN'], dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' },
  ]);

  const r = runCli(['storyboard-episode', '-p', projectDir, '-e', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Blocked: reference images are missing/);
  assert.match(r.stderr, /Character WREN: no reference sheet/);
  assert.match(r.stderr, /add-character/);
});

test('storyboard-episode blocks when a scripted location has no references', () => {
  const { projectDir } = makeSeries({
    characters: [{ name: 'WREN', gender: 'female', age: '19', description: 'x', wardrobe: 'y' }],
    locations: [{ name: 'The Railvine Line', slug: 'railvine-line', description: 'x' }],
  });
  // Give WREN refs so only the location is missing.
  const charDir = join(projectDir, 'characters', 'wren');
  mkdirSync(charDir, { recursive: true });
  writeFileSync(join(charDir, 'front.png'), PNG_1PX);
  writeScript(projectDir, [
    { shotNumber: 1, type: 'action', duration: '8s', description: 'x', characters: ['WREN'], location: 'railvine-line', dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' },
  ]);

  const r = runCli(['storyboard-episode', '-p', projectDir, '-e', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Location railvine-line: no reference angles/);
  assert.match(r.stderr, /generate-location-references/);
});

// ---------------------------------------------------------------------------
// 3. harvest-anchor
// ---------------------------------------------------------------------------

test('harvest-anchor extracts a frame, writes provenance, archives prior anchor', { skip: !ffmpegAvailable }, () => {
  const { projectDir } = makeSeries({
    characters: [{ name: 'WREN', gender: 'female', age: '19', description: 'x', wardrobe: 'y' }],
  });
  const charDir = join(projectDir, 'characters', 'wren');
  mkdirSync(charDir, { recursive: true });
  // Pre-existing anchor that must be archived, not clobbered.
  writeFileSync(join(charDir, 'anchor.png'), PNG_1PX);

  const clip = makeShotClip(join(projectDir, 'renders'), 'unit.mp4');
  const r = runCli(['harvest-anchor', '-p', projectDir, '-c', 'WREN', '--video', clip, '--at', '0.5']);
  assert.equal(r.status, 0, r.stderr);

  const anchor = join(charDir, 'anchor.png');
  assert.ok(existsSync(anchor));
  assert.ok(readFileSync(anchor).length > PNG_1PX.length, 'anchor should be the extracted frame, not the old 1px png');

  const prov = JSON.parse(readFileSync(join(charDir, 'anchor.provenance.json'), 'utf-8'));
  assert.equal(prov.character, 'WREN');
  assert.equal(prov.atSec, 0.5);
  assert.ok(prov.sourceVideo.endsWith('unit.mp4'));

  const archived = readdirSync(charDir).filter(f => /^anchor-.*\.png$/.test(f));
  assert.equal(archived.length, 1, 'prior anchor must be archived');
});

test('harvest-anchor fails cleanly on unknown character or missing video', () => {
  const { projectDir } = makeSeries();
  const r1 = runCli(['harvest-anchor', '-p', projectDir, '-c', 'NOBODY', '--video', '/tmp/nope.mp4', '--at', '1']);
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /Character not found/);
});

// ---------------------------------------------------------------------------
// 4. reference-slots: anchor.png outranks the generated sheets
// ---------------------------------------------------------------------------

test('buildReferenceSlotPlan prefers anchor.png over front.png for the primary slot', () => {
  const { projectDir, series } = makeSeries({
    characters: [{ name: 'WREN', gender: 'female', age: '19', description: 'x', wardrobe: 'y' }],
  });
  const charDir = join(projectDir, 'characters', 'wren');
  mkdirSync(charDir, { recursive: true });
  writeFileSync(join(charDir, 'front.png'), PNG_1PX);

  const shot = { shotNumber: 1, type: 'action', duration: '8s', description: 'x', characters: ['WREN'], dialogue: null, sfx: '', cameraMovement: '', transition: 'CUT' };

  // Without an anchor: front.png is the primary.
  let plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
  let primary = plan.slots.find(s => s.kind === 'character-primary');
  assert.ok(primary.path.endsWith('front.png'));

  // With an anchor: anchor.png takes the slot.
  writeFileSync(join(charDir, 'anchor.png'), PNG_1PX);
  plan = buildReferenceSlotPlan(series, shot, 'seedance-2-5-reference-to-video');
  primary = plan.slots.find(s => s.kind === 'character-primary');
  assert.ok(primary.path.endsWith('anchor.png'), `expected anchor.png, got ${primary.path}`);
  assert.equal(primary.imageIndex, 1, 'primary stays @Image1');
});
