// ---------------------------------------------------------------------------
// Wire selected context into every command that takes -p / -e.
//
// Roughly 35 commands declare `-p, --project` and `-e, --episode` as required
// options. Rather than edit each handler, this walks the command tree once,
// drops the "mandatory" flag, and fills the values from the selected context in
// a preAction hook. Explicit flags still win, and a command that gets neither a
// flag nor a context selection fails with a message naming both remedies.
//
// Order matters: Commander enforces mandatory options inside _parseCommand,
// which runs BEFORE preAction hooks. So the flags must be relaxed at wiring
// time and re-validated ourselves in the hook.
// ---------------------------------------------------------------------------

import type { Command, Option } from 'commander';
import {
  MissingContextError,
  readContext,
  resolveProjectRef,
} from './context.js';

/**
 * Commands that configure or report on context rather than operating inside it.
 * Injecting into these would be circular (`use` setting the episode it was
 * meant to change) or nonsensical (`doctor` has no project).
 */
const CONTEXT_EXEMPT_COMMANDS = new Set([
  'use', 'unuse', 'status', 'queue', 'shell',
  'setup', 'config', 'doctor', 'update', 'new', 'new-series', 'list-series',
]);

interface RelaxedOption {
  command: Command;
  option: Option;
  attribute: 'project' | 'episode';
  wasMandatory: boolean;
}

function walkCommands(command: Command, visit: (cmd: Command) => void): void {
  visit(command);
  for (const child of command.commands) walkCommands(child, visit);
}

/**
 * Relax `-p` / `-e` across the tree and fill them from context at run time.
 * Call once, after every command has been registered.
 */
export function applyContextDefaults(program: Command): void {
  const relaxed: RelaxedOption[] = [];

  walkCommands(program, cmd => {
    if (CONTEXT_EXEMPT_COMMANDS.has(cmd.name())) return;
    for (const option of cmd.options) {
      const attribute = option.attributeName();
      if (attribute !== 'project' && attribute !== 'episode') continue;
      relaxed.push({
        command: cmd,
        option,
        attribute,
        wasMandatory: Boolean(option.mandatory),
      });
      option.makeOptionMandatory(false);
    }
  });

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    const entries = relaxed.filter(entry => entry.command === actionCommand);
    if (entries.length === 0) return;

    const context = await readContext();
    const workspaceOverride = program.opts().workspace as string | undefined;
    const injected: string[] = [];

    for (const entry of entries) {
      const current = actionCommand.getOptionValue(entry.attribute);

      if (entry.attribute === 'project') {
        if (current !== undefined) {
          // Normalise explicit values too, so `-p my-series` resolves a slug
          // against the workspace instead of only accepting a full path.
          const resolvedPath = await resolveProjectRef(String(current), workspaceOverride);
          actionCommand.setOptionValueWithSource(entry.attribute, resolvedPath, 'cli');
          continue;
        }
        if (context.project) {
          actionCommand.setOptionValueWithSource(entry.attribute, context.project, 'config');
          injected.push(`project ${context.project}`);
          continue;
        }
        if (entry.wasMandatory) {
          throw new MissingContextError(
            `${actionCommand.name()}: no project selected. Pass -p <project> or run `
            + '`venice-video use <project>`.',
          );
        }
        continue;
      }

      if (current !== undefined) continue;
      if (context.episode !== undefined) {
        actionCommand.setOptionValueWithSource(entry.attribute, context.episode, 'config');
        injected.push(`episode ${context.episode}`);
        continue;
      }
      if (entry.wasMandatory) {
        throw new MissingContextError(
          `${actionCommand.name()}: no episode selected. Pass -e <number> or run `
          + '`venice-video use <project> --episode <n>`.',
        );
      }
    }

    // Say what the command is acting on whenever it wasn't spelled out. These
    // commands write to disk and cost money; silent defaults would be hostile.
    if (injected.length > 0) {
      console.log(`  (using ${injected.join(', ')})`);
    }
  });
}
