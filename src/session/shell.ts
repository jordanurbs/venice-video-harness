// ---------------------------------------------------------------------------
// venice-video shell -- a persistent session over the same Commander program.
//
// Every command in this CLI is a fresh node process today: ~0.5s of startup and
// module loading before any work begins, and no memory of what you were working
// on. The shell keeps one process alive, remembers the selected project and
// episode, lets a render run in the background while you keep working, and turns
// Ctrl-C into "cancel this operation" instead of "kill everything".
//
// It drives the *same* command tree as the one-shot CLI -- there is no second
// implementation of any command. See program-runtime.ts for the three things
// that had to change to make Commander safe to run repeatedly in one process.
// ---------------------------------------------------------------------------

import { createInterface, type Interface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';

import { getConfigDir, getWorkspaceDir } from '../user-config.js';
import { listSeries } from '../series/manager.js';
import { readContext } from './context.js';
import {
  collectCommandSpecs,
  configureForRepl,
  isBenignCommanderError,
  runProgramLine,
  type CommandSpec,
} from './program-runtime.js';
import { JobManager, formatDuration, type BackgroundJob } from './jobs.js';
import { installOutputRouter, runWithSink, writeDirect } from './output-router.js';
import { runInOperation, OperationAbortedError } from '../venice/operation-context.js';
import { listPendingJobs, prunePendingJobs } from '../venice/job-store.js';

// ---- Terminal styling -----------------------------------------------------

let colorEnabled = false;
const dim = (s: string): string => (colorEnabled ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s: string): string => (colorEnabled ? `\u001b[1m${s}\u001b[0m` : s);
/** Venetian blue, the one accent colour the brand allows for emphasis. */
const accent = (s: string): string => (colorEnabled ? `\u001b[38;5;68m${s}\u001b[0m` : s);
const red = (s: string): string => (colorEnabled ? `\u001b[31m${s}\u001b[0m` : s);

// ---- Line parsing ---------------------------------------------------------

/**
 * Split a shell line into argv, honouring quotes so prompts survive intact:
 *   workshop-episode --concept "she finds the letter"
 * Commander would otherwise receive five arguments instead of one.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (char === '\\' && quote === '"' && i + 1 < line.length) {
        current += line[++i];
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\' && i + 1 < line.length) { current += line[++i]; started = true; continue; }
    if (/\s/.test(char)) {
      if (started || current) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }

  if (started || current) tokens.push(current);
  return tokens;
}

// ---- History --------------------------------------------------------------

const HISTORY_LIMIT = 1000;

function historyPath(): string {
  return join(getConfigDir(), 'shell-history');
}

async function loadHistory(): Promise<string[]> {
  try {
    const raw = await readFile(historyPath(), 'utf-8');
    return raw.split('\n').filter(line => line.trim().length > 0);
  } catch {
    return [];
  }
}

async function saveHistory(lines: string[]): Promise<void> {
  try {
    await mkdir(dirname(historyPath()), { recursive: true, mode: 0o700 });
    await writeFile(historyPath(), `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`, 'utf-8');
  } catch {
    // History is a convenience; never fail a session over it.
  }
}

// ---- Shell ----------------------------------------------------------------

interface ShellState {
  program: Command;
  specs: CommandSpec[];
  jobs: JobManager;
  /** Writes shell chrome, bypassing any background job's output capture. */
  write: (text: string) => void;
  /** Cached project slugs for tab completion, refreshed on demand. */
  projectSlugs: string[];
  /** Set while a foreground command runs, so Ctrl-C can cancel it. */
  foreground?: AbortController;
  closing: boolean;
}

const META_COMMANDS = [
  '/help', '/status', '/use', '/unuse', '/jobs', '/cd', '/pwd', '/clear', '/exit', '/quit',
];

async function refreshProjectSlugs(state: ShellState): Promise<void> {
  try {
    const workspace = await getWorkspaceDir();
    state.projectSlugs = (await listSeries(workspace)).map(entry => entry.slug);
  } catch {
    state.projectSlugs = [];
  }
}

function buildCompleter(state: ShellState) {
  return (line: string): [string[], string] => {
    const trimmedStart = line.replace(/^\s+/, '');
    if (trimmedStart.startsWith('/')) {
      const hits = META_COMMANDS.filter(name => name.startsWith(trimmedStart));
      return [hits.length > 0 ? hits : META_COMMANDS, trimmedStart];
    }

    const tokens = line.split(/\s+/);
    const currentToken = tokens[tokens.length - 1];
    const previousToken = tokens.length >= 2 ? tokens[tokens.length - 2] : '';

    // A project slug is far more useful here than a command name.
    if (previousToken === '-p' || previousToken === '--project') {
      const hits = state.projectSlugs.filter(slug => slug.startsWith(currentToken));
      return [hits.length > 0 ? hits : state.projectSlugs, currentToken];
    }

    if (currentToken.startsWith('-')) {
      const commandPath = tokens.slice(0, -1).filter(Boolean).join(' ');
      const spec = state.specs.find(candidate => candidate.path === commandPath)
        ?? state.specs.find(candidate => commandPath.startsWith(candidate.path));
      const flags = spec?.flags ?? [];
      const hits = flags.filter(flag => flag.startsWith(currentToken));
      return [hits.length > 0 ? hits : flags, currentToken];
    }

    // Complete against the whole command path so `config sh<tab>` works.
    const typed = tokens.filter(Boolean).join(' ');
    const matches = state.specs
      .map(spec => spec.path)
      .filter(path => path.startsWith(typed));
    if (matches.length === 0) return [[], line];
    // Hand readline only the fragment it should replace.
    const consumed = tokens.slice(0, -1).filter(Boolean).join(' ');
    const offset = consumed.length > 0 ? consumed.length + 1 : 0;
    return [matches.map(path => path.slice(offset)), currentToken];
  };
}

async function buildPrompt(): Promise<string> {
  const context = await readContext();
  if (!context.project) {
    return `${accent('venice-video')} ${dim('(no project)')} ${accent('›')} `;
  }
  const label = basename(context.project);
  const episode = context.episode !== undefined
    ? dim(` · ep ${String(context.episode).padStart(2, '0')}`)
    : '';
  return `${accent('venice-video')} ${bold(label)}${episode} ${accent('›')} `;
}

function printBanner(state: ShellState): void {
  state.write(`\n${bold('Venice Video')} ${dim(`shell · ${state.program.version() ?? ''}`)}\n`);
  state.write(dim('  Commands run as usual, minus the process restart: `storyboard-episode -e 2`.\n'));
  state.write(dim('  Append & to background a render. /help for shell commands, Ctrl-D to exit.\n\n'));
}

function printHelp(state: ShellState): void {
  state.write(`\n${bold('Shell commands')}\n`);
  const meta: Array<[string, string]> = [
    ['/help', 'this list'],
    ['/status', 'pipeline state and the next command to run'],
    ['/use <project> [-e n]', 'select the project (and episode) commands default to'],
    ['/unuse', 'clear the selection'],
    ['/jobs [log|cancel <id>]', "this session's background commands"],
    ['/cd <dir>, /pwd', 'change or show the working directory'],
    ['/clear', 'clear the screen'],
    ['/exit', 'leave the shell (Ctrl-D also works)'],
    ['!<command>', 'run <command> in your system shell'],
    ['<command> &', 'run a harness command in the background'],
  ];
  for (const [name, description] of meta) {
    state.write(`  ${name.padEnd(26)} ${dim(description)}\n`);
  }

  state.write(dim("\n  `/jobs` is this session's commands; `queue` is Venice renders still in flight.\n"));

  state.write(`\n${bold('Production commands')} ${dim('(-p / -e default to the selection)')}\n`);
  for (const spec of state.specs) {
    if (spec.path.includes(' ')) continue; // subcommands show under their parent
    state.write(`  ${spec.path.padEnd(26)} ${dim(spec.description)}\n`);
  }
  state.write('\n');
}

function formatJobLine(job: BackgroundJob): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const status = job.status === 'running'
    ? accent('running')
    : job.status === 'done'
      ? 'done'
      : red(job.status);
  const progress = job.status === 'running' && job.progress?.detail
    ? dim(` — ${job.progress.detail}`)
    : '';
  const failure = job.error ? dim(` — ${job.error}`) : '';
  const padding = ' '.repeat(Math.max(0, 9 - job.status.length));
  return `  [${job.id}] ${status}${padding} ${elapsed.padStart(6)}  ${job.label}${progress}${failure}`;
}

function printJobs(state: ShellState, argv: string[]): void {
  const [subcommand, rawId] = argv;

  if (subcommand === 'log') {
    const job = state.jobs.get(Number(rawId));
    if (!job) { state.write(red(`  No job ${rawId}.\n`)); return; }
    state.write(`\n${dim(`[${job.id}] ${job.label}`)}\n`);
    state.write(job.log.length > 0 ? `${job.log.join('\n')}\n\n` : dim('  (no output yet)\n\n'));
    return;
  }

  if (subcommand === 'cancel') {
    const id = Number(rawId);
    state.write(state.jobs.cancel(id)
      ? dim(`  Cancelling job ${id}…\n`)
      : red(`  Job ${rawId} is not running.\n`));
    return;
  }

  const jobs = state.jobs.list();
  if (jobs.length === 0) {
    state.write(dim('  No background jobs this session.\n'));
    return;
  }
  state.write('\n');
  for (const job of jobs) state.write(`${formatJobLine(job)}\n`);
  state.write('\n');
}

/** Run a command line through Commander, reporting cancellation distinctly. */
async function runForeground(state: ShellState, argv: string[], label: string): Promise<void> {
  const controller = new AbortController();
  state.foreground = controller;
  const startedAt = Date.now();

  try {
    const exitCode = await runInOperation(
      { signal: controller.signal, label },
      () => runProgramLine(state.program, argv),
    );
    const elapsed = Date.now() - startedAt;
    if (exitCode !== 0) {
      state.write(red(`  ${label} exited with code ${exitCode}`) + dim(` (${formatDuration(elapsed)})\n`));
    } else if (elapsed > 5_000) {
      // Only worth reporting for work that actually took time.
      state.write(dim(`  ✓ ${label} — ${formatDuration(elapsed)}\n`));
    }
  } catch (error) {
    if (error instanceof OperationAbortedError || controller.signal.aborted) {
      state.write(dim(`  Cancelled after ${formatDuration(Date.now() - startedAt)}.\n`));
      state.write(dim('  Any in-flight Venice job is recorded — re-run to re-attach. See `queue`.\n'));
      return;
    }
    if (isBenignCommanderError(error)) return;
    state.write(red(`  ${(error as Error).message ?? String(error)}\n`));
  } finally {
    state.foreground = undefined;
  }
}

function startBackground(state: ShellState, argv: string[], label: string): void {
  const job = state.jobs.start(
    label,
    context => runWithSink(
      context.appendLog,
      () => runInOperation(
        { signal: context.signal, label, onProgress: context.onProgress },
        () => runProgramLine(state.program, argv),
      ),
    ),
    settled => {
      const elapsed = formatDuration((settled.endedAt ?? Date.now()) - settled.startedAt);
      const outcome = settled.status === 'done'
        ? dim(`✓ [${settled.id}] ${settled.label} — ${elapsed}`)
        : red(`✗ [${settled.id}] ${settled.label} ${settled.status} — ${elapsed}`);
      state.write(`\n${outcome}${dim(`  (/jobs log ${settled.id})`)}\n`);
    },
  );
  state.write(dim(`  [${job.id}] started in the background. Check with /jobs.\n`));
}

function runSystemCommand(state: ShellState, line: string): Promise<void> {
  return new Promise(resolvePromise => {
    const child = spawn(process.env.SHELL ?? '/bin/sh', ['-c', line], { stdio: 'inherit' });
    child.on('close', () => resolvePromise());
    child.on('error', error => {
      state.write(red(`  ${error.message}\n`));
      resolvePromise();
    });
  });
}

/**
 * Report any Venice jobs a previous session left in flight. These are already
 * paid for, so the operator should know they can be re-attached rather than
 * regenerated.
 */
async function reportStrandedJobs(state: ShellState): Promise<void> {
  await prunePendingJobs();
  const pending = await listPendingJobs();
  if (pending.length === 0) return;

  state.write(dim(`  ${pending.length} Venice job(s) still in flight from an earlier run:\n`));
  for (const job of pending.slice(0, 5)) {
    state.write(dim(`    ${job.model}  ${basename(job.outputPath)}  (queued ${job.createdAt})\n`));
  }
  state.write(dim('  Re-running the command that produced them re-attaches instead of re-billing.\n\n'));
}

export interface ShellOptions {
  /** Defaults to process.stdin. Supplying a stream disables terminal mode. */
  input?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Override the TTY requirement (tests drive the loop over plain streams). */
  interactive?: boolean;
  color?: boolean;
}

export async function startShell(program: Command, options: ShellOptions = {}): Promise<void> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const ownsTerminal = input === stdin && output === stdout;
  const interactive = options.interactive ?? Boolean(stdin.isTTY);

  if (!interactive) {
    throw new Error('The shell needs an interactive terminal. Run commands directly in scripts and CI.');
  }
  colorEnabled = options.color ?? (ownsTerminal && Boolean(stdout.isTTY) && !process.env.NO_COLOR);

  installOutputRouter();

  const write = (text: string): void => {
    if (ownsTerminal) writeDirect(text);
    else output.write(text);
  };
  configureForRepl(program, { writeOut: write, writeErr: write });

  const state: ShellState = {
    program,
    specs: collectCommandSpecs(program),
    jobs: new JobManager(),
    write,
    projectSlugs: [],
    closing: false,
  };
  await refreshProjectSlugs(state);

  const history = await loadHistory();
  const rl: Interface = createInterface({
    input,
    output,
    terminal: ownsTerminal,
    completer: buildCompleter(state),
    // readline expects most-recent-first.
    history: [...history].reverse(),
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });

  let idleQuestion: AbortController | undefined;
  const onInterrupt = (): void => {
    if (state.foreground) {
      state.foreground.abort();
      write(dim('\n  Cancelling (Ctrl-C)…\n'));
      return;
    }
    // Idle: abandon the half-typed line and redraw the prompt. Aborting the
    // question rejects our promise but leaves readline's own line buffer
    // populated, so the discarded text would otherwise be prepended to the
    // next command. Ctrl-U clears that buffer.
    if (ownsTerminal) rl.write(null, { ctrl: true, name: 'u' });
    idleQuestion?.abort();
  };
  rl.on('SIGINT', onInterrupt);
  if (ownsTerminal) process.on('SIGINT', onInterrupt);

  // Ctrl-D (or a closed input stream) has to break the question loop, which is
  // otherwise waiting on a promise that will never settle.
  rl.on('close', () => {
    state.closing = true;
    idleQuestion?.abort();
  });

  printBanner(state);
  await reportStrandedJobs(state);

  try {
    while (!state.closing) {
      const prompt = await buildPrompt();
      idleQuestion = new AbortController();

      let line: string;
      try {
        line = await rl.question(prompt, { signal: idleQuestion.signal });
      } catch {
        // Aborted by Ctrl-C (redraw) or by close (Ctrl-D, leave the loop).
        if (state.closing) break;
        // Clearing the buffer above makes readline redraw with its own default
        // prompt; erase that line so the next prompt lands cleanly.
        write(ownsTerminal ? '\r\u001b[2K' : '\n');
        continue;
      } finally {
        idleQuestion = undefined;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;
      history.push(trimmed);
      if (!ownsTerminal) write(`${trimmed}\n`);

      if (trimmed.startsWith('!')) {
        await runSystemCommand(state, trimmed.slice(1));
        continue;
      }

      // Slash forms are muscle-memory aliases; use/status/jobs are also real
      // commands so the same names work outside the shell.
      const isMeta = trimmed.startsWith('/');
      let tokens = tokenize(isMeta ? trimmed.slice(1) : trimmed);
      const head = tokens[0];

      if (head === 'exit' || head === 'quit') break;
      if (head === 'help' && isMeta) { printHelp(state); continue; }
      if (head === 'clear') { write('\u001b[2J\u001b[H'); continue; }
      if (head === 'pwd') { write(`  ${process.cwd()}\n`); continue; }
      if (head === 'cd') {
        const target = tokens[1] ? resolve(tokens[1]) : process.env.HOME ?? process.cwd();
        if (!existsSync(target)) { write(red(`  No such directory: ${target}\n`)); continue; }
        process.chdir(target);
        write(dim(`  ${process.cwd()}\n`));
        continue;
      }
      if (head === 'jobs' && isMeta) { printJobs(state, tokens.slice(1)); continue; }

      const background = tokens[tokens.length - 1] === '&';
      if (background) tokens = tokens.slice(0, -1);
      if (tokens.length === 0) continue;

      const label = tokens.join(' ');
      if (background) startBackground(state, tokens, label);
      else await runForeground(state, tokens, label);

      // `use` and project creation change what the prompt and completion show.
      if (head === 'use' || head === 'unuse' || head === 'new-series' || head === 'new') {
        await refreshProjectSlugs(state);
      }
    }
  } finally {
    rl.off('SIGINT', onInterrupt);
    if (ownsTerminal) process.off('SIGINT', onInterrupt);
    rl.close();
    await saveHistory(history);

    const running = state.jobs.running();
    if (running.length > 0) {
      write(dim(`\n  Cancelling ${running.length} background job(s)…\n`));
      write(dim('  In-flight Venice work stays recorded; re-run to re-attach.\n'));
      state.jobs.cancelAll();
      await state.jobs.drain();
    }
    write(dim('  Bye.\n'));
  }
}
