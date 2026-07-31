// ---------------------------------------------------------------------------
// Running the Commander program repeatedly inside one process.
//
// The CLI was built to parse once and exit, which shows up in three places when
// you try to host it in a REPL:
//
//  1. Commander never clears option values between parses -- defaults are
//     applied once at registration (see addOption in commander/lib/command.js),
//     and _parseCommand does not reset them. Without a reset, `--force` typed
//     once would silently stay on for the rest of the session.
//  2. A bad flag or `--help` calls process.exit via Command._exit. exitOverride
//     turns that into a throw, but _exitCallback is copied to subcommands when
//     they are created, so it has to be applied to the whole tree, not just root.
//  3. ~60 handlers call process.exit(1) directly for "not found" errors. Those
//     are trapped during a shell command and converted into a throw.
// ---------------------------------------------------------------------------

import { CommanderError, type Command, type Option } from 'commander';

/** Thrown in place of a handler's process.exit() call while in the shell. */
export class TrappedExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Command exited with code ${code}.`);
    this.name = 'TrappedExitError';
    this.code = code;
  }
}

function walkCommands(command: Command, visit: (cmd: Command) => void): void {
  visit(command);
  for (const child of command.commands) walkCommands(child, visit);
}

/**
 * The value Commander would hold for an option immediately after registration.
 * Mirrors addOption's default handling, including the `--no-x` rule where a
 * negated flag defaults its key to true unless a positive counterpart exists.
 */
function registrationDefault(cmd: Command, option: Option): unknown {
  if (option.negate) {
    const positiveLongFlag = option.long?.replace(/^--no-/, '--');
    const hasPositive = positiveLongFlag
      ? cmd.options.some(other => other !== option && other.long === positiveLongFlag)
      : false;
    if (hasPositive) return undefined;
    return option.defaultValue === undefined ? true : option.defaultValue;
  }
  return option.defaultValue;
}

/**
 * Return every option on the tree to its post-registration value, so one shell
 * line cannot leak flags into the next. Iterating in registration order
 * reproduces Commander's own resolution for keys owned by several flags.
 */
export function resetCommandState(program: Command): void {
  walkCommands(program, cmd => {
    for (const option of cmd.options) {
      const attribute = option.attributeName();
      const value = registrationDefault(cmd, option);
      cmd.setOptionValueWithSource(attribute, value, value === undefined ? undefined : 'default');
    }
    cmd.args = [];
    cmd.processedArgs = [];
  });
}

/**
 * Make the whole command tree throw instead of exiting, and route help/error
 * text through the supplied writers. Call once before the first shell line.
 */
export function configureForRepl(
  program: Command,
  output: { writeOut: (s: string) => void; writeErr: (s: string) => void },
): void {
  walkCommands(program, cmd => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      // Terminal width is stable for a session; Commander's default reads
      // process.stdout.isTTY per call, which is fine but noisy to override.
      getOutHelpWidth: () => process.stdout.columns,
      getErrHelpWidth: () => process.stdout.columns,
    });
  });
  program.showHelpAfterError(false);
}

/** Codes Commander uses for "printed something and stopped", not real errors. */
const BENIGN_COMMANDER_CODES = new Set([
  'commander.helpDisplayed',
  'commander.help',
  'commander.version',
  'commander.executeSubCommandAsync',
]);

export function isBenignCommanderError(error: unknown): boolean {
  return error instanceof CommanderError && BENIGN_COMMANDER_CODES.has(error.code);
}

/**
 * Parse and run one command line against the shared program.
 *
 * Resets sticky option state first and traps process.exit for the duration, so
 * a handler that bails with exit(1) reports an error instead of killing the
 * session. Returns the exit code the equivalent one-shot invocation would have.
 */
export async function runProgramLine(program: Command, argv: string[]): Promise<number> {
  resetCommandState(program);

  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  process.exit = ((code?: number) => {
    throw new TrappedExitError(code ?? 0);
  }) as typeof process.exit;

  try {
    await program.parseAsync(argv, { from: 'user' });
    // doctor and friends signal failure by setting exitCode rather than exiting.
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    return code;
  } catch (error) {
    if (error instanceof TrappedExitError) return error.code;
    if (isBenignCommanderError(error)) return 0;
    if (error instanceof CommanderError) return error.exitCode || 1;
    throw error;
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

export interface CommandSpec {
  /** Space-joined path, e.g. 'config show'. */
  path: string;
  description: string;
  /** Long flags including leading dashes, e.g. '--force'. */
  flags: string[];
}

/** Flatten the tree for tab completion and the shell's own help listing. */
export function collectCommandSpecs(program: Command): CommandSpec[] {
  const specs: CommandSpec[] = [];

  const visit = (cmd: Command, prefix: string[]): void => {
    for (const child of cmd.commands) {
      const path = [...prefix, child.name()];
      // A command with subcommands and no action of its own (like `config`) is
      // still worth completing, since the user types it on the way down.
      specs.push({
        path: path.join(' '),
        description: child.description(),
        flags: child.options
          .map(option => option.long)
          .filter((long): long is string => Boolean(long)),
      });
      visit(child, path);
    }
  };

  visit(program, []);
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}
