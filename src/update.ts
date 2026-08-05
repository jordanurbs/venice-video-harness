// ---------------------------------------------------------------------------
// Self-update for the standalone CLI.
//
// The hard part is not fetching a version number, it is installing into the
// prefix this copy actually lives in. The `npm` on PATH is not always the one
// that owns the running executable — a version manager can leave the two
// pointing at different prefixes, and `npm install -g` against the wrong one
// reports success while the old executable stays exactly where it was. So the
// install location is derived from this module's own path and passed back to
// npm explicitly.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The npm package this CLI ships as. */
export const PACKAGE_NAME = 'venice-video-harness';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Where this copy of the CLI is running from.
 *
 * `npm-global` is the only kind `update` can replace on its own. A local
 * dependency is owned by a project's lockfile, and a source checkout would be
 * clobbered — both get instructions instead of an install.
 */
export type Install =
  | { kind: 'npm-global'; packageDir: string; prefix: string; globalRoot: string }
  | { kind: 'npm-local'; packageDir: string; projectDir: string }
  | { kind: 'source'; packageDir: string };

/**
 * Classify an install from its directory alone, so it stays testable across
 * platforms without touching the filesystem.
 *
 * npm's global tree is `<prefix>/lib/node_modules` everywhere except Windows,
 * where it is `<prefix>/node_modules` with the prefix being the `npm`
 * directory itself. Anything else under a `node_modules` is a project
 * dependency; anything not under one is a checkout.
 */
export function classifyInstall(
  packageDir: string,
  platform: NodeJS.Platform = process.platform,
): Install {
  const separator = packageDir.includes('\\') ? '\\' : '/';
  const segments = packageDir.split(/[\\/]/);
  const index = segments.lastIndexOf('node_modules');
  if (index < 1) return { kind: 'source', packageDir };

  const container = segments[index - 1];
  const containerDir = segments.slice(0, index).join(separator);
  const globalRoot = segments.slice(0, index + 1).join(separator);

  if (container === 'lib') {
    return { kind: 'npm-global', packageDir, prefix: dirname(containerDir), globalRoot };
  }
  if (platform === 'win32' && container === 'npm') {
    return { kind: 'npm-global', packageDir, prefix: containerDir, globalRoot };
  }
  return { kind: 'npm-local', packageDir, projectDir: containerDir };
}

/**
 * Walk up from `startDir` to the directory holding this package's own
 * `package.json`. Walking beats a fixed `../..` because it survives the file
 * being moved between `src/` and a deeper build layout.
 */
export function resolvePackageDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch { /* unreadable manifest — keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** Classify the install this process is running from. */
export function currentInstall(): Install {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolvePackageDir(here);
  // A global bin is reached through a symlink; classification needs the real
  // path or every install looks like a checkout.
  return classifyInstall(existsSync(packageDir) ? realpathSync(packageDir) : packageDir);
}

/** Version recorded in a package directory, or undefined if unreadable. */
export function readInstalledVersion(packageDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return parsed.version;
  } catch {
    return undefined;
  }
}

function parseVersion(value: string): { numbers: number[]; prerelease: string } {
  const clean = value.trim().replace(/^v/, '').split('+')[0];
  const dash = clean.indexOf('-');
  const core = dash < 0 ? clean : clean.slice(0, dash);
  return {
    numbers: core.split('.').map(part => Number.parseInt(part, 10) || 0),
    prerelease: dash < 0 ? '' : clean.slice(dash + 1),
  };
}

/**
 * Semver ordering, enough of it for release comparison: numeric triplet first,
 * then prerelease rules (a release outranks its own prereleases, numeric
 * identifiers sort below alphanumeric ones).
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const difference = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const leftParts = left.prerelease.split('.');
  const rightParts = right.prerelease.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const leftPart = leftParts[i];
    const rightPart = rightParts[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Registry to query. Overridable so tests can serve their own metadata. */
export function registryUrl(): string {
  const configured = process.env.VENICE_VIDEO_REGISTRY ?? process.env.npm_config_registry;
  return (configured?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/** Resolve a dist-tag (`latest`, `next`, …) to a published version. */
export async function fetchPublishedVersion(
  tag = 'latest',
  options: { packageName?: string; registry?: string; timeoutMs?: number } = {},
): Promise<string> {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const registry = options.registry ?? registryUrl();
  const response = await fetch(`${registry}/${packageName}`, {
    // Abbreviated metadata: a few KB instead of the full packument.
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    throw new Error(`The npm registry returned HTTP ${response.status} for ${packageName}`);
  }
  const body = await response.json() as { 'dist-tags'?: Record<string, string> };
  const version = body['dist-tags']?.[tag];
  if (!version) {
    const known = Object.keys(body['dist-tags'] ?? {}).join(', ') || 'none';
    throw new Error(`${packageName} has no "${tag}" release on npm (published tags: ${known})`);
  }
  return version;
}

export interface NpmInvocation {
  command: string;
  args: string[];
  usesShell: boolean;
}

/**
 * Build the install command for a global install.
 *
 * npm ships inside the same global tree, so it can usually be run as a script
 * under the current Node — no shell, no PATH lookup, no chance of picking a
 * different npm than the one that owns this prefix.
 */
export function npmInvocation(
  install: Extract<Install, { kind: 'npm-global' }>,
  spec: string,
  options: {
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
    nodePath?: string;
  } = {},
): NpmInvocation {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const args = [
    'install',
    '--global',
    '--prefix', install.prefix,
    spec,
    // The package's postinstall prints a PATH diagnostic that npm otherwise
    // swallows on a successful install.
    '--foreground-scripts',
  ];

  const npmCli = join(install.globalRoot, 'npm', 'bin', 'npm-cli.js');
  if (exists(npmCli)) {
    return { command: options.nodePath ?? process.execPath, args: [npmCli, ...args], usesShell: false };
  }
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    usesShell: platform === 'win32',
  };
}

let sessionActive = false;

/**
 * Declared by the interactive shell, which runs commands in-process and keeps
 * lazily importing from this package for the life of the session. Overwriting
 * those files underneath it would leave one process running two versions.
 */
export function markSessionActive(): void {
  sessionActive = true;
}

export function isSessionActive(): boolean {
  return sessionActive;
}

/** Run the install, streaming npm's output straight through. */
export function runInstall(invocation: NpmInvocation): number {
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    shell: invocation.usesShell,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** What to do when `update` cannot install for you. */
export function manualUpdateInstructions(install: Install): string[] {
  if (install.kind === 'npm-local') {
    return [
      `This copy is a dependency of ${install.projectDir}, so its version is owned by that`,
      'project. Update it there:',
      '',
      `  cd ${install.projectDir}`,
      `  npm install ${PACKAGE_NAME}@latest`,
    ];
  }
  return [
    `This copy runs from a source checkout at ${install.packageDir}, so npm would`,
    'overwrite local work. Update it with git:',
    '',
    `  cd ${install.packageDir}`,
    '  git pull && npm install && npm run build',
  ];
}
