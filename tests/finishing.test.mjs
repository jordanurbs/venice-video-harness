import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { estimateUpscaleCostUsd, TOPAZ_VIDEO_UPSCALE_MODEL } from '../dist/venice/upscale.js';
import { getVideoModel } from '../dist/venice/models.js';
import { createSeries, saveSeries } from '../dist/series/manager.js';
import { saveWorkshop } from '../dist/mini-drama/workshop.js';

const cli = new URL('../dist/mini-drama/cli.js', import.meta.url).pathname;
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } });
}
function workshop(series, delivery) {
  return {
    version: 1, status: 'approved', revision: 1, generatedAt: new Date().toISOString(), projectName: series.name, projectType: 'film',
    inputs: { objective: '', targetDuration: '10 seconds', audience: '', mustInclude: '', avoid: '', references: '', delivery },
    logline: '', synopsis: '', themes: [], structure: [],
    aesthetic: { style: '', palette: '', lighting: '', lensCharacteristics: '', filmStock: '' }, characters: [], locations: [],
    script: { episode: 1, title: series.name, seriesName: series.name, totalDuration: '10s', status: 'approved', shots: [] },
    productionNotes: { delivery, audioApproach: '', continuityPriorities: [], risks: [], openQuestions: [] }, feedbackHistory: [],
  };
}
async function makeVideo(path) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', path], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
}

test('Topaz model and cost estimate are registered', () => {
  assert.equal(TOPAZ_VIDEO_UPSCALE_MODEL, 'topaz-video-upscale');
  assert.equal(getVideoModel(TOPAZ_VIDEO_UPSCALE_MODEL)?.videoInput, true);
  assert.equal(estimateUpscaleCostUsd(100), 12);
});

test('finish respects standard workshop delivery without spending', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'finish-standard-'));
  const series = createSeries('Standard Film', 'test', 'drama', '', { workspace, projectType: 'film' });
  await saveSeries(series); await saveWorkshop(series, workshop(series, 'standard'));
  const partDir = join(series.outputDir, 'episodes', 'episode-001'); await mkdir(partDir, { recursive: true });
  const master = join(partDir, 'episode-001-final.mp4'); await makeVideo(master);
  const result = run(['finish', '-p', series.outputDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Standard master/);
  assert.match(result.stdout, /Use --4k/);
});

test('finish reads 4K workshop target and prints estimate before spending', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'finish-4k-'));
  const series = createSeries('Four K Film', 'test', 'drama', '', { workspace, projectType: 'film' });
  await saveSeries(series); await saveWorkshop(series, workshop(series, '4k'));
  const partDir = join(series.outputDir, 'episodes', 'episode-001'); await mkdir(partDir, { recursive: true });
  const master = join(partDir, 'episode-001-final.mp4'); await makeVideo(master);
  const result = run(['finish', '-p', series.outputDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /topaz-video-upscale/);
  assert.match(result.stdout, /Estimated cost/);
  assert.match(result.stdout, /re-run with --yes/);
  assert.match(result.stdout, /masters\/four-k-film-master-4k\.mp4/);
});
