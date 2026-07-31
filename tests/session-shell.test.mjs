// Tests for the interactive-session layer: command-line tokenizing, Commander
// re-entrancy (the shell runs the same program object many times in one
// process), selected-context injection, and the pending-job registry that keeps
// an interrupted Venice generation re-attachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';

// Point config-backed state at a scratch dir before anything reads it.
const scratch = mkdtempSync(join(tmpdir(), 'vv-session-'));
process.env.VENICE_VIDEO_CONFIG_DIR = join(scratch, 'config');
process.env.VENICE_VIDEO_WORKSPACE = join(scratch, 'workspace');
process.env.VENICE_API_KEY ??= 'test-key-not-used';

const { tokenize, startShell } = await import('../dist/session/shell.js');
const { resetCommandState, runProgramLine, collectCommandSpecs, configureForRepl } =
  await import('../dist/session/program-runtime.js');
const { setContext, clearContext, resolveProjectRef } = await import('../dist/session/context.js');
const { applyContextDefaults } = await import('../dist/session/program-context.js');
const jobStore = await import('../dist/venice/job-store.js');
const { createSeries, saveSeries } = await import('../dist/series/manager.js');

// ---- tokenizing -----------------------------------------------------------

test('tokenize keeps quoted prompts as a single argument', () => {
  assert.deepEqual(
    tokenize('workshop-episode -e 2 --concept "she finds the letter"'),
    ['workshop-episode', '-e', '2', '--concept', 'she finds the letter'],
  );
});

test('tokenize handles single quotes, escapes, and empty strings', () => {
  assert.deepEqual(tokenize("add-character --name 'DR. WEBB'"), ['add-character', '--name', 'DR. WEBB']);
  assert.deepEqual(tokenize('a "b \\"c\\" d"'), ['a', 'b "c" d']);
  assert.deepEqual(tokenize('cmd --note ""'), ['cmd', '--note', '']);
  assert.deepEqual(tokenize('   '), []);
});

test('tokenize preserves paths with spaces', () => {
  assert.deepEqual(
    tokenize('status -p "/tmp/my projects/show one"'),
    ['status', '-p', '/tmp/my projects/show one'],
  );
});

// ---- Commander re-entrancy ------------------------------------------------

function buildFixtureProgram(calls) {
  const program = new Command();
  program.name('fixture').exitOverride();
  program
    .command('render')
    .requiredOption('-e, --episode <n>', 'episode', parseInt)
    .option('--force', 'overwrite existing output', false)
    .option('--no-subtitles', 'skip subtitles')
    .option('--label <text>', 'label', 'default-label')
    .action(opts => { calls.push({ ...opts }); });
  program
    .command('boom')
    .action(() => { process.exit(3); });
  return program;
}

test('option values do not leak from one command line to the next', async () => {
  const calls = [];
  const program = buildFixtureProgram(calls);

  await runProgramLine(program, ['render', '-e', '1', '--force']);
  await runProgramLine(program, ['render', '-e', '2']);

  assert.equal(calls[0].force, true);
  assert.equal(calls[1].force, false, 'a flag typed once must not stay on for the session');
  assert.equal(calls[1].episode, 2);
});

test('reset restores declared defaults, including negated flags', async () => {
  const calls = [];
  const program = buildFixtureProgram(calls);

  await runProgramLine(program, ['render', '-e', '1', '--no-subtitles', '--label', 'custom']);
  await runProgramLine(program, ['render', '-e', '1']);

  assert.equal(calls[0].subtitles, false);
  assert.equal(calls[0].label, 'custom');
  assert.equal(calls[1].subtitles, true, '--no-x defaults its key back to true');
  assert.equal(calls[1].label, 'default-label');
});

test('a required option is enforced again after a reset', async () => {
  const calls = [];
  const program = buildFixtureProgram(calls);
  configureForRepl(program, { writeOut() {}, writeErr() {} });

  await runProgramLine(program, ['render', '-e', '4']);
  const code = await runProgramLine(program, ['render']);

  assert.equal(calls.length, 1, 'the second line must not reuse the previous episode');
  assert.notEqual(code, 0, 'missing -e should still be an error');
});

test('a handler calling process.exit does not kill the session', async () => {
  const program = buildFixtureProgram([]);
  const code = await runProgramLine(program, ['boom']);
  assert.equal(code, 3, 'the exit code is reported instead of taken');

  // The process is still alive and usable, which is the whole point.
  const calls = [];
  const second = buildFixtureProgram(calls);
  await runProgramLine(second, ['render', '-e', '9']);
  assert.equal(calls[0].episode, 9);
});

test('resetCommandState reaches nested subcommands', () => {
  const seen = [];
  const program = new Command();
  program.name('fixture');
  const parent = program.command('config');
  parent.command('set').option('--dry-run', 'no writes', false).action(opts => seen.push(opts));

  const setCommand = parent.commands[0];
  setCommand.setOptionValueWithSource('dryRun', true, 'cli');
  resetCommandState(program);
  assert.equal(setCommand.getOptionValue('dryRun'), false);
  assert.equal(seen.length, 0);
});

test('collectCommandSpecs flattens nested command paths', () => {
  const program = new Command();
  program.name('fixture');
  const parent = program.command('config').description('configuration');
  parent.command('show').description('show config').option('--json', 'as json');

  const specs = collectCommandSpecs(program);
  const paths = specs.map(spec => spec.path);
  assert.ok(paths.includes('config'));
  assert.ok(paths.includes('config show'));
  assert.deepEqual(specs.find(spec => spec.path === 'config show').flags, ['--json']);
});

// ---- selected context -----------------------------------------------------

test('context supplies -p and -e when the flags are omitted', async () => {
  const workspace = process.env.VENICE_VIDEO_WORKSPACE;
  const series = createSeries('Ctx Show', 'concept', 'drama', 'a room', { workspace });
  await saveSeries(series);

  const seen = [];
  const program = new Command();
  program.name('fixture').option('--workspace <dir>', 'workspace');
  program
    .command('act')
    .requiredOption('-p, --project <dir>', 'project')
    .requiredOption('-e, --episode <n>', 'episode', parseInt)
    .action(opts => seen.push({ ...opts }));
  applyContextDefaults(program);

  await setContext({ project: series.outputDir, episode: 7 });
  await runProgramLine(program, ['act']);

  assert.equal(seen[0].project, series.outputDir);
  assert.equal(seen[0].episode, 7);

  // Explicit flags still win over the selection.
  await runProgramLine(program, ['act', '-e', '2']);
  assert.equal(seen[1].episode, 2);

  await clearContext();
});

test('a command with neither flag nor selection explains both remedies', async () => {
  const program = new Command();
  program.name('fixture');
  program
    .command('act')
    .requiredOption('-p, --project <dir>', 'project')
    .action(() => { throw new Error('handler must not run'); });
  applyContextDefaults(program);

  await clearContext();
  await assert.rejects(
    () => runProgramLine(program, ['act']),
    error => /no project selected/i.test(error.message) && /venice-video use/.test(error.message),
  );
});

test('a project slug resolves against the workspace', async () => {
  const workspace = process.env.VENICE_VIDEO_WORKSPACE;
  const series = createSeries('Slug Show', 'concept', 'drama', 'a room', { workspace });
  await saveSeries(series);

  assert.equal(await resolveProjectRef('slug-show'), series.outputDir);
  assert.equal(await resolveProjectRef(series.outputDir), series.outputDir);
});

// ---- the shell loop -------------------------------------------------------

/**
 * Drive the shell over plain streams. Each line is sent only once the shell has
 * drawn its prompt again, so lines can't be dropped between question() calls.
 */
async function driveShell(program, lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', chunk => { transcript += chunk.toString(); });

  const session = startShell(program, { input, output, interactive: true, color: false });

  const promptCount = () => (transcript.match(/›/g) ?? []).length;
  const waitForPrompt = async expected => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (promptCount() >= expected) return;
      await new Promise(resolveTick => setTimeout(resolveTick, 10));
    }
    throw new Error(`Prompt ${expected} never appeared. Transcript so far:\n${transcript}`);
  };

  for (const [index, line] of lines.entries()) {
    await waitForPrompt(index + 1);
    input.write(`${line}\n`);
  }

  await waitForPrompt(lines.length);
  input.end();
  await session;
  return transcript;
}

test('the shell runs commands, keeps the session, and exits cleanly', async () => {
  const calls = [];
  const program = buildFixtureProgram(calls);
  program.version('9.9.9');

  const transcript = await driveShell(program, [
    'render -e 1 --force',
    'render -e 2',
    'exit',
  ]);

  assert.equal(calls.length, 2, 'both lines ran in the same process');
  assert.equal(calls[0].force, true);
  assert.equal(calls[1].force, false, 'the shell must reset flags between lines');
  assert.match(transcript, /Venice Video/);
  assert.match(transcript, /Bye\./);
});

test('a failing command does not end the shell session', async () => {
  const calls = [];
  const program = buildFixtureProgram(calls);

  const transcript = await driveShell(program, ['boom', 'render -e 5', 'exit']);

  assert.equal(calls.length, 1, 'the line after the failure still ran');
  assert.equal(calls[0].episode, 5);
  assert.match(transcript, /exited with code 3/);
});

test('/help and /pwd are handled by the shell itself', async () => {
  const program = buildFixtureProgram([]);
  const transcript = await driveShell(program, ['/help', '/pwd', 'exit']);

  assert.match(transcript, /Shell commands/);
  assert.match(transcript, /Production commands/);
  assert.match(transcript, /render/);
  assert.ok(transcript.includes(process.cwd()));
});

test('a backgrounded command runs detached, captures its log, and can be cancelled', async () => {
  const { abortableSleep } = await import('../dist/venice/operation-context.js');

  const program = new Command();
  program.name('fixture').exitOverride();
  let started = false;
  let finished = false;
  program
    .command('slow')
    .action(async () => {
      started = true;
      console.log('slow: working');
      // Cancellation reaches this through the ambient operation context, the
      // same path a real Venice poll loop uses.
      await abortableSleep(30_000);
      finished = true;
    });

  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', chunk => { transcript += chunk.toString(); });

  const session = startShell(program, { input, output, interactive: true, color: false });
  const promptCount = () => (transcript.match(/›/g) ?? []).length;
  const waitForPrompt = async expected => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (promptCount() >= expected) return;
      await new Promise(resolveTick => setTimeout(resolveTick, 10));
    }
    throw new Error(`Prompt ${expected} never appeared:\n${transcript}`);
  };
  const waitUntil = async (predicate, description) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return;
      await new Promise(resolveTick => setTimeout(resolveTick, 10));
    }
    throw new Error(`Timed out waiting for ${description}:\n${transcript}`);
  };

  await waitForPrompt(1);
  input.write('slow &\n');

  // The prompt must come back immediately -- that is the point of backgrounding.
  await waitForPrompt(2);
  assert.match(transcript, /started in the background/);
  await waitUntil(() => started, 'the background job to start');
  assert.equal(finished, false);

  input.write('/jobs\n');
  await waitForPrompt(3);
  assert.match(transcript, /\[1\] running/);

  input.write('/jobs log 1\n');
  await waitForPrompt(4);
  assert.match(transcript, /slow: working/, 'background output is captured, not printed over the prompt');

  input.write('/jobs cancel 1\n');
  await waitForPrompt(5);
  await waitUntil(() => /\[1\] slow cancelled/.test(transcript), 'the cancellation notice');
  assert.equal(finished, false, 'cancelling must actually stop the work');

  input.write('/jobs\n');
  await waitForPrompt(6);
  assert.match(transcript, /\[1\] cancelled/);

  input.write('exit\n');
  await waitForPrompt(6);
  input.end();
  await session;
});

test('exiting the shell cancels jobs still running', async () => {
  const { abortableSleep } = await import('../dist/venice/operation-context.js');

  const program = new Command();
  program.name('fixture').exitOverride();
  let finished = false;
  program.command('slow').action(async () => {
    await abortableSleep(30_000);
    finished = true;
  });

  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', chunk => { transcript += chunk.toString(); });

  const session = startShell(program, { input, output, interactive: true, color: false });
  const waitForPrompt = async expected => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((transcript.match(/›/g) ?? []).length >= expected) return;
      await new Promise(resolveTick => setTimeout(resolveTick, 10));
    }
    throw new Error(`Prompt ${expected} never appeared:\n${transcript}`);
  };

  await waitForPrompt(1);
  input.write('slow &\n');
  await waitForPrompt(2);
  input.write('exit\n');
  input.end();

  // Must not hang for the job's full 30s sleep.
  await session;
  assert.match(transcript, /Cancelling 1 background job/);
  assert.equal(finished, false);
});

test('an unknown command reports an error without exiting', async () => {
  const program = buildFixtureProgram([]);
  const transcript = await driveShell(program, ['nope --wat', 'render -e 8', 'exit']);

  assert.match(transcript, /unknown command|error/i);
  assert.match(transcript, /Bye\./);
});

// ---- pending Venice jobs --------------------------------------------------

test('a queued job is recorded, found, and cleared', async () => {
  const outputPath = join(scratch, 'episodes', 'episode-001', 'scene-001', 'shot-001.mp4');
  await jobStore.recordPendingJob({
    kind: 'video',
    model: 'seedance-2-0',
    queueId: 'queue-abc',
    outputPath,
    prompt: 'a wide establishing shot',
  });

  const found = await jobStore.findPendingJob(outputPath);
  assert.equal(found.queueId, 'queue-abc');
  assert.equal(found.kind, 'video');

  await jobStore.clearPendingJob(outputPath);
  assert.equal(await jobStore.findPendingJob(outputPath), undefined);
});

test('recording the same output twice keeps only the newest queue id', async () => {
  const outputPath = join(scratch, 'shot-002.mp4');
  const base = { kind: 'video', model: 'seedance-2-0', outputPath };
  await jobStore.recordPendingJob({ ...base, queueId: 'first' });
  await jobStore.recordPendingJob({ ...base, queueId: 'second' });

  const all = await jobStore.listPendingJobs();
  const matching = all.filter(job => job.outputPath === outputPath);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].queueId, 'second');

  await jobStore.clearPendingJob(outputPath);
});

test('stale jobs are ignored for resume and pruned away', async () => {
  const outputPath = join(scratch, 'shot-003.mp4');
  await jobStore.recordPendingJob({
    kind: 'audio',
    model: 'elevenlabs-music',
    queueId: 'queue-old',
    outputPath,
  });

  // Backdate past the queue TTL by rewriting the registry directly.
  const { readFile, writeFile } = await import('node:fs/promises');
  const storePath = jobStore.getJobStorePath();
  const registry = JSON.parse(await readFile(storePath, 'utf-8'));
  for (const job of registry.jobs) {
    if (job.outputPath === outputPath) {
      job.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    }
  }
  await writeFile(storePath, JSON.stringify(registry));

  assert.equal(
    await jobStore.findPendingJob(outputPath),
    undefined,
    'a job Venice has long since dropped must not be resumed',
  );
  assert.ok(await jobStore.prunePendingJobs() >= 1);
});
