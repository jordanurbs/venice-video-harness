#!/usr/bin/env node
// Smoke test for the three timeline exporters.
//
// Builds a tiny fixture (2 short mp4s + 1 short mp3 via ffmpeg lavfi),
// runs each exporter, and asserts the output XML structure looks right.
// Pure Node — no test framework dependency. Run after `npm run build`:
//
//   node tests/test-timeline-export.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportFcpxml,
  exportPremiereXml,
  exportDavinciFcpxml,
} from '../dist/mini-drama/timeline-export/index.js';

let failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  OK  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
function assertTrue(cond, label) {
  eq(cond, true, label);
}
function countMatches(xml, pattern) {
  return (xml.match(pattern) || []).length;
}

// ── Build fixture ───────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'ext15-test-'));
const fixtureDir = join(root, 'fixture');
mkdirSync(fixtureDir, { recursive: true });

// Two 1-second silent mp4s
const seg1 = join(fixtureDir, 'shot-001.mp4');
const seg2 = join(fixtureDir, 'shot-002.mp4');
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=24:d=1',
  '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000',
  '-shortest', '-c:v', 'libx264', '-c:a', 'aac', seg1,
], { stdio: 'pipe' });
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=24:d=1',
  '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000',
  '-shortest', '-c:v', 'libx264', '-c:a', 'aac', seg2,
], { stdio: 'pipe' });

// One 0.5s silent mp3 dialogue clip
const dialoguePath = join(fixtureDir, 'dialogue-shot-001.mp3');
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'anullsrc=cl=mono:r=48000', '-t', '0.5', dialoguePath,
], { stdio: 'pipe' });

const opts = {
  segments: [
    { path: seg1, label: 'shot-001', durSec: 1.0, startSec: 0.0 },
    { path: seg2, label: 'shot-002', durSec: 1.0, startSec: 1.0 },
  ],
  audio: [
    {
      path: dialoguePath,
      label: '001 NARRATOR',
      startSec: 0.2,
      audioDur: 0.5,
      lane: -1,
      role: 'dialogue.dialogue',
    },
  ],
  totalDurationSec: 2.0,
  fps: 24,
  width: 1920,
  height: 1080,
  eventName: 'Fixture Test',
};

// ── FCPXML ──────────────────────────────────────────────────────────────
const fcpxmlPath = join(root, 'out.fcpxml');
await exportFcpxml({ ...opts, outputPath: fcpxmlPath });
const fcpxml = readFileSync(fcpxmlPath, 'utf-8');
assertTrue(fcpxml.includes('<fcpxml version="1.10">'), 'FCPXML: root element correct');
eq(countMatches(fcpxml, /<asset-clip /g), 2, 'FCPXML: 2 asset-clips on the spine');
eq(countMatches(fcpxml, /<audio /g), 1, 'FCPXML: 1 connected audio child');
eq(countMatches(fcpxml, /<media-rep /g), 3, 'FCPXML: 3 media-rep children (2 video + 1 audio)');
assertTrue(fcpxml.includes('lane="-1"'), 'FCPXML: dialogue placed on lane -1');
assertTrue(fcpxml.includes('48/24s'), 'FCPXML: rational time form present (2s = 48/24s)');

// ── Premiere xmeml ──────────────────────────────────────────────────────
const premierePath = join(root, 'out.premiere.xml');
await exportPremiereXml({ ...opts, outputPath: premierePath });
const xmeml = readFileSync(premierePath, 'utf-8');
assertTrue(xmeml.includes('<xmeml version="5">'), 'Premiere: xmeml v5 root');
eq(countMatches(xmeml, /<sequence /g), 1, 'Premiere: exactly one <sequence>');
eq(countMatches(xmeml, /<clipitem /g), 3, 'Premiere: 3 clipitems (2 video + 1 audio)');
eq(countMatches(xmeml, /<pathurl>/g), 3, 'Premiere: 3 pathurls (each unique file once)');
assertTrue(xmeml.includes('<timebase>24</timebase>'), 'Premiere: rate timebase=24');
assertTrue(xmeml.includes('<start>0</start>'), 'Premiere: integer frame counts (start=0)');

// ── DaVinci ─────────────────────────────────────────────────────────────
const davinciPath = join(root, 'out.resolve.fcpxml');
await exportDavinciFcpxml({ ...opts, outputPath: davinciPath });
const resolveXml = readFileSync(davinciPath, 'utf-8');
assertTrue(resolveXml.includes('<fcpxml version="1.10">'), 'DaVinci: FCPXML 1.10 root');
assertTrue(!resolveXml.includes('colorSpace='), 'DaVinci: colorSpace dropped from <format>');
assertTrue(resolveXml.includes('srcCh='), 'DaVinci: srcCh hint present on <audio>');
// Raw file:// path (not URI-encoded): the fixture path may have no spaces
// so this guard is loose — just confirm file:// is present and we did NOT
// URI-encode the tmpdir slashes into %2F.
assertTrue(resolveXml.includes('file://'), 'DaVinci: file:// prefix present');
assertTrue(!resolveXml.includes('%2F'), 'DaVinci: no URI-encoded slashes in paths');

// ── Cleanup ─────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll timeline-export assertions passed.');
