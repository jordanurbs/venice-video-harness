import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = new URL('../dist/mini-drama/cli.js', import.meta.url).pathname;

function run(args, env = {}) {
  const merged = { ...process.env, ...env };
  // These tests configure the workspace through `setup`. An ambient
  // VENICE_VIDEO_WORKSPACE (env beats stored config) would silently redirect
  // every project they create.
  if (!('VENICE_VIDEO_WORKSPACE' in env)) delete merged.VENICE_VIDEO_WORKSPACE;
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf-8',
    env: merged,
  });
}

test('setup stores a masked standalone config with private permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-video-config-'));
  const configDir = join(root, 'config');
  const workspace = join(root, 'films');
  const result = run(['setup', '--api-key', 'test-api-key-123456', '--workspace', workspace, '--skip-validation'], {
    VENICE_VIDEO_CONFIG_DIR: configDir,
    VENICE_API_KEY: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Venice Video is configured/);
  assert.doesNotMatch(result.stdout, /test-api-key-123456/);

  const configPath = join(configDir, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  assert.equal(config.apiKey, 'test-api-key-123456');
  assert.equal(config.workspace, workspace);
  if (process.platform !== 'win32') {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
});

test('noninteractive Film creation uses the configured workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-video-film-'));
  const configDir = join(root, 'config');
  const workspace = join(root, 'workspace');
  const env = { VENICE_VIDEO_CONFIG_DIR: configDir, VENICE_API_KEY: '' };
  let result = run(['setup', '--api-key', 'test-api-key-123456', '--workspace', workspace, '--skip-validation'], env);
  assert.equal(result.status, 0, result.stderr);

  result = run([
    'new', '--type', 'film', '--name', 'Long Horizon', '--concept', 'A feature-length journey',
    '--genre', 'adventure', '--setting', 'open ocean', '--audio-strategy', 'native', '--video-family', 'auto',
  ], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Film created/);

  const series = JSON.parse(await readFile(join(workspace, 'long-horizon', 'series.json'), 'utf-8'));
  assert.equal(series.projectType, 'film');
  assert.equal(series.videoDefaults.characterConsistencyModel, 'seedance-2-5-reference-to-video');
  assert.equal(series.outputDir, join(workspace, 'long-horizon'));
});

test('config show never reveals the full API key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-video-show-'));
  const configDir = join(root, 'config');
  const env = { VENICE_VIDEO_CONFIG_DIR: configDir, VENICE_API_KEY: '' };
  const secret = 'test-api-key-123456';
  let result = run(['setup', '--api-key', secret, '--workspace', join(root, 'workspace'), '--skip-validation'], env);
  assert.equal(result.status, 0, result.stderr);
  result = run(['config', 'show'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.match(result.stdout, /test.*3456/);
});

test('Film script scaffold uses Film terminology and a non-episodic duration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-video-film-script-'));
  const configDir = join(root, 'config');
  const workspace = join(root, 'workspace');
  const env = { VENICE_VIDEO_CONFIG_DIR: configDir, VENICE_API_KEY: '' };
  let result = run(['setup', '--api-key', 'test-api-key-123456', '--workspace', workspace, '--skip-validation'], env);
  assert.equal(result.status, 0, result.stderr);
  result = run(['new', '--type', 'film', '--name', 'Long Horizon', '--concept', 'A long ocean crossing'], env);
  assert.equal(result.status, 0, result.stderr);

  const project = join(workspace, 'long-horizon');
  result = run(['new-script', '-p', project, '--title', 'Long Horizon'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Film script created/);
  assert.doesNotMatch(result.stdout, /Episode 1 created/);

  const script = JSON.parse(await readFile(join(project, 'episodes', 'episode-001', 'script.json'), 'utf-8'));
  assert.equal(script.totalDuration, '300s');
});

test('new project hands off to the complete workshop instead of manual command chaining', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-video-workshop-handoff-'));
  const configDir = join(root, 'config');
  const workspace = join(root, 'workspace');
  const env = { VENICE_VIDEO_CONFIG_DIR: configDir, VENICE_API_KEY: '' };
  let result = run(['setup', '--api-key', 'test-api-key-123456', '--workspace', workspace, '--skip-validation'], env);
  assert.equal(result.status, 0, result.stderr);
  result = run(['new', '--type', 'film', '--name', 'Rocketship', '--concept', 'A complete space film'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Next: venice-video workshop -p/);
  assert.doesNotMatch(result.stdout, /storyboard-episode/);
  assert.doesNotMatch(result.stdout, /workshop your shot-by-shot script/);
});
