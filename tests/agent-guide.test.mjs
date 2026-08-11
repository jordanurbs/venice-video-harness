// Tests for the agent-facing self-describing surface: `agent-guide` and
// `pipeline`. These ship the operating knowledge inside the binary, so the
// contract is (a) `--json` prints exactly one JSON object and nothing else,
// (b) the pipeline states its gates and never tells an agent that --skip-*
// is the fix, and (c) the pipeline order matches the on-disk state machine.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PIPELINE_STAGES, formatPipeline } from '../dist/agent/pipeline.js';
import { AGENT_GUIDE, formatGuide } from '../dist/agent/guide.js';

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

test('the pipeline stages follow the on-disk gate order', () => {
  const ids = PIPELINE_STAGES.map(s => s.id);
  assert.deepEqual(ids, [
    'aesthetic', 'cast', 'episode', 'script', 'approve-script',
    'storyboard', 'qa-storyboard', 'qa-approve', 'render', 'qa-videos', 'assemble',
  ]);
  // The human gates are the ones that carry a gate note: the two sign-offs
  // plus assembly, which blocks on a failing video-qa-report.json (rule 52).
  const gated = PIPELINE_STAGES.filter(s => s.gate).map(s => s.id);
  assert.deepEqual(gated, ['approve-script', 'qa-approve', 'assemble']);
});

test('the pipeline never presents --skip-* as the fix', () => {
  const text = formatPipeline();
  assert.match(text, /Never use --skip-approval \/ --skip-qa/);
  for (const stage of PIPELINE_STAGES) {
    if (stage.gate) assert.match(stage.gate, /does not/);
  }
});

test('pipeline --json prints exactly one JSON object', async () => {
  const result = await run(['pipeline', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout); // throws if it is not clean JSON
  assert.equal(parsed.version, 1);
  assert.equal(parsed.stages.length, PIPELINE_STAGES.length);
  assert.equal(parsed.stages[0].id, 'aesthetic');
});

test('the guide covers the money-losing non-negotiables', () => {
  const text = formatGuide().toLowerCase();
  assert.match(text, /queue time/);      // billing model
  assert.match(text, /re-attach/);       // the anti-double-bill rule
  assert.match(text, /background/);      // long-render timeout survival
  assert.match(text, /gates are human/); // the approval gates
  assert.ok(AGENT_GUIDE.length >= 5);
});

test('agent-guide --json prints exactly one JSON object', async () => {
  const result = await run(['agent-guide', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.sections));
});

test('the global --json flag works before the subcommand', async () => {
  const result = await run(['--json', 'pipeline']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});
