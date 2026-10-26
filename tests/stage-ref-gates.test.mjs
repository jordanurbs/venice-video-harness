// A staged shot (stage-ref, rule 65) whose clip is not from its pick is not
// rendered as far as every later step is concerned (rule 45): `status` sends
// it back to generate-videos, `qa-videos` leaves its unit and the cuts beside
// its clip unchecked (never a pass, also for an edit checked with --cut-list),
// and `assemble-episode` refuses it unless --force. No network; the CLI runs
// need ffmpeg for real clips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { collectProjectStatus, formatProjectStatus } = await import('../dist/session/status.js');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function project({ realClips = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-gates-'));
  writeFileSync(join(dir, 'series.json'), JSON.stringify({
    name: 'Gates', slug: 'gates', outputDir: dir,
    aesthetic: { style: 'test', palette: 'test', lighting: 'test', lensCharacteristics: 'test', filmStock: 'test' },
    videoDefaults: {}, characters: [{ name: 'ANNA', locked: true }], locations: [],
    episodes: [{ number: 1, title: 'One', status: 'produced' }], createdAt: '', updatedAt: '',
  }));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  const shot = (n, extra = {}) => ({
    shotNumber: n, type: 'action', duration: '1s', videoModel: 'action', description: `marker-${n}`, characters: ['ANNA'],
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...extra,
  });
  const staged = { path: 'episodes/episode-001/staging/shot-008/s1/1-gpt-image-2-edit.png', use: 'start-frame', source: 'x.png', model: 'gpt-image-2-edit', prompt: 'p', sha256: 'abc', session: 'episodes/episode-001/staging/shot-008/s1', pickedAt: '2026-10-26T00:00:00Z' };
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({
    episode: 1, title: 'One', seriesName: 'Gates', totalDuration: '2s', status: 'approved',
    shots: [shot(7), shot(8, { stagingRef: staged, mustStaySingle: true })],
  }));
  writeFileSync(join(episodeDir, 'qa-report.json'), '{}');
  writeFileSync(join(episodeDir, 'qa-approved.json'), '{}');
  for (const n of ['007', '008']) {
    writeFileSync(join(sceneDir, `shot-${n}.png`), PNG_1PX);
    if (realClips) {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-pix_fmt', 'yuv420p', '-y', join(sceneDir, `shot-${n}.mp4`)]);
    } else {
      writeFileSync(join(sceneDir, `shot-${n}.mp4`), 'clip');
    }
  }
  return { dir, episodeDir, sceneDir };
}

const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8' });

test('status sends a staged shot with a clip from before its pick back to generate-videos', async () => {
  const { dir, sceneDir } = project();
  const status = await collectProjectStatus(dir);
  const episode = status.episodes[0];
  assert.deepEqual(episode.stagedToRender, ['8']);
  assert.match(episode.stage, /staged shot\(s\) 8 need rendering from their staging ref/);
  assert.equal(episode.nextCommand, `generate-videos -p "${dir}" -e 1`);
  assert.match(formatProjectStatus(status), /2 clips · 1 staged to render/);

  // Rendered from the pick: the pipeline moves on to the video QA.
  writeFileSync(join(sceneDir, 'shot-008.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'abc' } } }));
  const after = (await collectProjectStatus(dir)).episodes[0];
  assert.deepEqual(after.stagedToRender, []);
  assert.equal(after.nextCommand, 'qa-videos -e 1');
});

test('assemble-episode refuses a staged shot with no clip from its pick; --force assembles with a warning', { skip: !ffmpegAvailable }, () => {
  const { dir } = project({ realClips: true });
  const blocked = run(['assemble-episode', '-p', dir, '-e', '1', '--no-subtitles', '--no-music', '--no-ambient', '--skip-video-qa']);
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /Blocked: 1 staged shot\(s\) have no clip from their staging ref: shot 8/);
  assert.match(blocked.stderr, /venice-video generate-videos -p "[^"]+" -e 1/);

  const forced = run(['assemble-episode', '-p', dir, '-e', '1', '--no-subtitles', '--no-music', '--no-ambient', '--skip-video-qa', '--force']);
  assert.doesNotMatch(forced.stderr, /Blocked: 1 staged shot/);
  assert.match(forced.stdout + forced.stderr, /--force: assembling 1 staged shot\(s\) without a clip from their staging ref/);
});

test('qa-videos leaves a unit with a staged shot not rendered from its pick unchecked, so the report does not pass', { skip: !ffmpegAvailable }, () => {
  const { dir, episodeDir } = project({ realClips: true });
  const unit = (n) => ({
    unitId: `unit-00${n}`, unitType: 'single', shotNumbers: [n], outputFile: `shot-00${n}.mp4`, model: 'action', duration: '1s',
    startFrameStrategy: 'panel', endFrameStrategy: 'natural', decisionReasons: [], fallbackToSingles: false,
  });
  writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({ episode: 1, generatedAt: '', units: [unit(7), unit(8)] }));
  const result = run(['qa-videos', '-p', dir, '-e', '1', '--skip-vision']);
  assert.match(result.stdout, /\? unit-008: not checked — staged shot\(s\) 8/);
  const report = JSON.parse(readFileSync(join(episodeDir, 'video-qa-report.json'), 'utf-8'));
  assert.deepEqual(report.notChecked.map(item => item.unitId), ['unit-008']);
  assert.equal(report.summary.errored, 1);
  assert.equal(report.summary.passed, false);
});

test('qa-videos: a montage unit kept from its clips that holds a stale staged shot, and a staged shot no unit holds, are not checked', { skip: !ffmpegAvailable }, () => {
  const { dir, episodeDir } = project({ realClips: true });
  const script = JSON.parse(readFileSync(join(episodeDir, 'script.json'), 'utf-8'));
  script.shots.push({ ...script.shots[1], shotNumber: 9, description: 'marker-9' }); // staged, no clip, not in the plan
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify(script));
  // The run was cut before the pick, and no master carries its name now.
  writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({ episode: 1, generatedAt: '', units: [{
    unitId: 'montage-s01-007-008', unitType: 'montage', shotNumbers: [7, 8], outputFile: 'montage-s01-007-008.mp4', model: 'seedance-2-5-reference-to-video', duration: '2s',
    startFrameStrategy: 'panel', endFrameStrategy: 'natural', decisionReasons: [], fallbackToSingles: false,
    segments: [{ shotNumber: 7, startOffsetSec: 0, durationSec: 1, outputFile: 'shot-007.mp4' }, { shotNumber: 8, startOffsetSec: 1, durationSec: 1, outputFile: 'shot-008.mp4' }],
  }] }));
  const result = run(['qa-videos', '-p', dir, '-e', '1', '--skip-vision']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\? montage-s01-007-008: not checked — staged shot\(s\) 8 \(its clip was not rendered from the pick/);
  assert.match(result.stdout, /\? \(not in the generation plan\): not checked — staged shot\(s\) 9 \(no clip yet/);
  const report = JSON.parse(readFileSync(join(episodeDir, 'video-qa-report.json'), 'utf-8'));
  assert.deepEqual(report.notChecked.map(item => item.shots), [['8'], ['9']]);
  assert.equal(report.summary.passed, false);
});

test('qa-videos --cut-list: an edit that uses a staged shot\'s footage from before its pick does not pass', { skip: !ffmpegAvailable }, () => {
  const { dir, sceneDir } = project({ realClips: true });
  const list = join(dir, 'edit.json');
  writeFileSync(list, JSON.stringify({ clips: [
    { file: join(sceneDir, 'shot-007.mp4'), shot: 7 },
    { file: join(sceneDir, 'shot-008.mp4'), shot: 8 },
  ] }));
  const result = run(['qa-videos', '-p', dir, '-e', '1', '--cut-list', list, '--skip-vision']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /clip 2: shot 8 has a staging ref \(stage-ref\) and this footage is not rendered from its pick; the cuts beside it cannot be checked/);
  assert.match(result.stdout, /Staged shot\(s\) 8 \(stage-ref\) are in the edit from footage not rendered from their pick: not passed/);
  const report = JSON.parse(readFileSync(join(dir, 'edit.continuity-report.json'), 'utf-8'));
  assert.deepEqual(report.staleStagedShots, ['8']);
  assert.equal(report.summary.passed, false);

  // Rendered from the pick, the same edit passes.
  writeFileSync(join(sceneDir, 'shot-008.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'abc' } } }));
  const again = run(['qa-videos', '-p', dir, '-e', '1', '--cut-list', list, '--skip-vision']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test('the cuts beside a staged shot\'s clip from before its pick are unchecked, with no vision call', { skip: !ffmpegAvailable }, async () => {
  const { markStaleStagedClips } = await import('../dist/mini-drama/staging.js');
  const qa = await import('../dist/mini-drama/video-qa.js');
  const { dir, episodeDir, sceneDir } = project({ realClips: true });
  const script = JSON.parse(readFileSync(join(episodeDir, 'script.json'), 'utf-8'));
  const plan = { units: [{ unitId: 'unit-007', shotNumbers: [7] }, { unitId: 'unit-008', shotNumbers: [8] }] };
  const clips = markStaleStagedClips(qa.cutListFromPlan(plan, sceneDir, script.shots), script.shots);
  assert.equal(clips[0].problem, undefined);
  assert.match(clips[1].problem, /shot 8 has a staging ref/);
  let calls = 0;
  const client = { async chatJson() { calls += 1; return {}; } };
  const pairs = qa.pairsToCheck(clips, 'all');
  assert.equal(pairs.length, 0, 'unstated joins between untagged shots are not judged');
  const forced = await qa.checkPairContinuity(client, 'm', clips[0], clips[1], { framesDir: join(dir, 'frames') });
  assert.equal(forced.errored, true);
  assert.match(forced.issues[0], /shot 8: shot 8 has a staging ref/);
  assert.equal(calls, 0);
});
