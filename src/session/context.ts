// ---------------------------------------------------------------------------
// Selected context -- the project and episode commands act on by default.
//
// Nearly every command in this CLI used to require both `-p <project-dir>` and
// `-e <episode>`, which meant retyping an absolute path dozens of times in a
// session. Context works like `git` HEAD or a `kubectl` context: select once,
// then omit the flags. Explicit flags always win, so scripts and the MCP server
// (which pass flags for everything) are unaffected.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { listSeries } from '../series/manager.js';
import {
  getWorkspaceDir,
  readUserConfig,
  updateUserConfig,
  type SelectedContext,
} from '../user-config.js';

export type { SelectedContext };

export async function readContext(): Promise<SelectedContext> {
  return (await readUserConfig()).context ?? {};
}

export async function setContext(patch: SelectedContext): Promise<SelectedContext> {
  const next: SelectedContext = { ...(await readContext()), ...patch };
  if (next.project === undefined) delete next.project;
  if (next.episode === undefined) delete next.episode;
  await updateUserConfig({ context: Object.keys(next).length > 0 ? next : undefined });
  return next;
}

export async function clearContext(): Promise<void> {
  await updateUserConfig({ context: undefined });
}

function looksLikeProjectDir(candidate: string): boolean {
  return existsSync(join(candidate, 'series.json'));
}

/**
 * Turn a user-supplied project reference into an absolute project directory.
 *
 * Accepts an absolute path, a path relative to the cwd, or a bare slug/name
 * resolved against the workspace -- so `use mini-drama` works from anywhere.
 * Returns the resolved path even when it holds no series.json, so `new-series`
 * can create one; callers that need an existing project check loadSeries().
 */
export async function resolveProjectRef(ref: string, workspaceOverride?: string): Promise<string> {
  const direct = resolve(ref);
  if (looksLikeProjectDir(direct)) return direct;

  // A bare name is a workspace lookup, matched on slug first then display name.
  if (!isAbsolute(ref) && !ref.includes('/')) {
    const workspace = await getWorkspaceDir(workspaceOverride);
    const candidate = join(workspace, ref);
    if (looksLikeProjectDir(candidate)) return candidate;

    const needle = ref.toLowerCase();
    const all = await listSeries(workspace);
    const match = all.find(s => s.slug.toLowerCase() === needle)
      ?? all.find(s => s.name.toLowerCase() === needle);
    if (match) return match.dir;
  }

  return direct;
}

export class MissingContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingContextError';
  }
}

/**
 * Project directory for the current command: the explicit flag, else the
 * selected context. Throws with both remedies when neither is available.
 */
export async function resolveProjectDir(
  explicit?: string,
  workspaceOverride?: string,
): Promise<string> {
  if (explicit) return resolveProjectRef(explicit, workspaceOverride);

  const { project } = await readContext();
  if (project) return project;

  throw new MissingContextError(
    'No project selected. Pass -p <project> or select one with `venice-video use <project>`.',
  );
}

/** Episode number for the current command: the explicit flag, else context. */
export async function resolveEpisodeNumber(explicit?: number): Promise<number> {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;

  const { episode } = await readContext();
  if (episode !== undefined) return episode;

  throw new MissingContextError(
    'No episode selected. Pass -e <number> or select one with `venice-video use <project> --episode <n>`.',
  );
}
