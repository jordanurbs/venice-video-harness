// Tests for the two contracts an agent relies on when the human niceties are
// off: honest exit codes, and errors that are not raw Node stack traces.
//
// The bugs these guard against were real: `status` with no project printed a
// note and exited 0 (an agent checking $? saw success on an error), and an
// ordinary usage error surfaced as an uncaught exception with a stack trace
// and a `Node.js v22.x` footer that reads as a crash.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

// A config dir with no selection, so `status` finds no project to report on.
const noSelection = { VENICE_VIDEO_CONFIG_DIR: '/tmp/venice-video-empty-config-for-tests' };

test('status with no project exits non-zero (not 0)', async () => {
  const result = await run(['status'], noSelection);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No project selected/);
});

test('status --json with no project emits a JSON error envelope and exits non-zero', async () => {
  const result = await run(['status', '--json'], noSelection);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /No project selected/);
});

test('queue --json prints exactly one JSON object', async () => {
  const result = await run(['queue', '--json'], noSelection);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.jobs));
});

test('a missing series prints a clean error, not a Node stack trace', async () => {
  const result = await run(['status', '-p', '/tmp/venice-video-nonexistent-project-xyz']);
  assert.equal(result.status, 1);
  // Clean: an `error:`/message line, and none of the crash tells.
  assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/);
  assert.doesNotMatch(result.stderr, /Node\.js v\d/);
});
