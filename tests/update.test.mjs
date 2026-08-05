// Tests for `venice-video update`.
//
// The failure these guard against is a silent no-op: npm reports a successful
// global install while the executable on PATH keeps running the old version,
// because the `npm` that ran belongs to a different prefix than the copy being
// replaced. So the assertions are mostly about which prefix and which npm the
// command targets, verified against a simulated global tree rather than by
// mutating the real one.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PACKAGE_NAME,
  classifyInstall,
  compareVersions,
  fetchPublishedVersion,
  manualUpdateInstructions,
  npmInvocation,
} from '../dist/update.js';

const repoRoot = new URL('..', import.meta.url).pathname;
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');

/** Serve npm's abbreviated packument for one package. */
async function startRegistry(distTags) {
  const server = createServer((request, response) => {
    if (!request.url.includes(PACKAGE_NAME)) {
      response.writeHead(404).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: PACKAGE_NAME, 'dist-tags': distTags }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Run the CLI without blocking this process — the registry above is served
 * from this event loop, so a synchronous spawn would deadlock until the
 * child's fetch timed out.
 */
function run(cliPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf-8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('a global install is traced back to the prefix that owns it', () => {
  const install = classifyInstall('/opt/homebrew/lib/node_modules/venice-video-harness', 'darwin');
  assert.equal(install.kind, 'npm-global');
  assert.equal(install.prefix, '/opt/homebrew');
  assert.equal(install.globalRoot, '/opt/homebrew/lib/node_modules');
});

test('a version manager prefix is not mistaken for the default one', () => {
  // The whole point of deriving the prefix from the package path: this install
  // is invisible to an `npm` that resolves to /usr/local.
  const install = classifyInstall('/Users/me/.hermes/node/lib/node_modules/venice-video-harness');
  assert.equal(install.kind, 'npm-global');
  assert.equal(install.prefix, '/Users/me/.hermes/node');
});

test("Windows global installs live under the prefix's own node_modules", () => {
  const install = classifyInstall(
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\venice-video-harness',
    'win32',
  );
  assert.equal(install.kind, 'npm-global');
  assert.equal(install.prefix, 'C:\\Users\\me\\AppData\\Roaming\\npm');
});

test('a project dependency and a source checkout are not npm-global', () => {
  const local = classifyInstall('/srv/app/node_modules/venice-video-harness', 'linux');
  assert.equal(local.kind, 'npm-local');
  assert.equal(local.projectDir, '/srv/app');
  assert.match(manualUpdateInstructions(local).join('\n'), /cd \/srv\/app/);

  const source = classifyInstall('/Users/me/projects/venice-video-harness', 'linux');
  assert.equal(source.kind, 'source');
  assert.match(manualUpdateInstructions(source).join('\n'), /git pull/);
});

test('version comparison orders releases above their prereleases', () => {
  assert.equal(compareVersions('2.6.0', '2.9.0'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.9.0', '2.9.0'), 0);
  assert.equal(compareVersions('v2.9.0', '2.9.0+build.7'), 0);
  assert.equal(compareVersions('2.9.0-beta.1', '2.9.0'), -1);
  assert.equal(compareVersions('2.9.0-beta.2', '2.9.0-beta.10'), -1);
  assert.equal(compareVersions('2.9.0-alpha', '2.9.0-beta'), -1);
});

test('the install command pins the prefix and the colocated npm', () => {
  const install = classifyInstall('/opt/prefix/lib/node_modules/venice-video-harness', 'linux');
  const npmCli = '/opt/prefix/lib/node_modules/npm/bin/npm-cli.js';

  const pinned = npmInvocation(install, `${PACKAGE_NAME}@2.9.0`, {
    platform: 'linux',
    exists: path => path === npmCli,
    nodePath: '/opt/prefix/bin/node',
  });
  assert.equal(pinned.command, '/opt/prefix/bin/node');
  assert.equal(pinned.usesShell, false);
  assert.deepEqual(pinned.args, [
    npmCli,
    'install', '--global',
    '--prefix', '/opt/prefix',
    `${PACKAGE_NAME}@2.9.0`,
    '--foreground-scripts',
  ]);

  const fallback = npmInvocation(install, `${PACKAGE_NAME}@2.9.0`, {
    platform: 'linux',
    exists: () => false,
  });
  assert.equal(fallback.command, 'npm');
  assert.deepEqual(fallback.args.slice(0, 4), ['install', '--global', '--prefix', '/opt/prefix']);
});

test('an unknown dist-tag names the tags that do exist', async () => {
  const registry = await startRegistry({ latest: '2.9.0' });
  try {
    assert.equal(await fetchPublishedVersion('latest', { registry: registry.url }), '2.9.0');
    await assert.rejects(
      fetchPublishedVersion('canary', { registry: registry.url }),
      /no "canary" release on npm \(published tags: latest\)/,
    );
  } finally {
    registry.close();
  }
});

test('--check reports an available release without installing it', async () => {
  const registry = await startRegistry({ latest: '99.0.0' });
  try {
    const result = await run(cli, ['update', '--check'], { VENICE_VIDEO_REGISTRY: registry.url });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Published {2}checking latest\.\.\. 99\.0\.0/);
    assert.match(result.stdout, /99\.0\.0 is available/);
  } finally {
    registry.close();
  }
});

test('a build ahead of the published tag is not silently downgraded', async () => {
  const registry = await startRegistry({ latest: '0.0.1' });
  try {
    const result = await run(cli, ['update'], { VENICE_VIDEO_REGISTRY: registry.url });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ahead of latest/);
    assert.doesNotMatch(result.stdout, /Installing/);
  } finally {
    registry.close();
  }
});

test('a source checkout is sent to git rather than npm', async () => {
  const registry = await startRegistry({ latest: '99.0.0' });
  try {
    const result = await run(cli, ['update'], { VENICE_VIDEO_REGISTRY: registry.url });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /runs from a source checkout/);
    assert.match(result.stdout, /git pull && npm install && npm run build/);
  } finally {
    registry.close();
  }
});

// Runs last: it flips this process into "shell session" mode, which is global.
test('an update from inside the interactive shell is deferred, not applied', async () => {
  const registry = await startRegistry({ latest: '99.0.0' });
  const previousRegistry = process.env.VENICE_VIDEO_REGISTRY;
  const previousExitCode = process.exitCode;
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };

  try {
    process.env.VENICE_VIDEO_REGISTRY = registry.url;
    const { program } = await import('../dist/mini-drama/cli.js');
    const { markSessionActive } = await import('../dist/update.js');
    markSessionActive();
    await program.parseAsync(['update'], { from: 'user' });

    const transcript = lines.join('\n');
    assert.match(transcript, /Exit the shell/);
    assert.doesNotMatch(transcript, /Installing/);
  } finally {
    console.log = log;
    process.exitCode = previousExitCode;
    if (previousRegistry === undefined) delete process.env.VENICE_VIDEO_REGISTRY;
    else process.env.VENICE_VIDEO_REGISTRY = previousRegistry;
    registry.close();
  }
});

test('a global install targets its own prefix, not the ambient npm', async () => {
  // Reproduce npm's global layout in a temp prefix and run the CLI from inside
  // it, so the prefix under test is the one the code discovers for itself.
  // realpath because macOS hands out /var paths that resolve to /private/var,
  // and the CLI resolves its own location before reporting it.
  const prefix = realpathSync(await mkdtemp(join(tmpdir(), 'venice-video-prefix-')));
  const globalRoot = join(prefix, 'lib', 'node_modules');
  const packageDir = join(globalRoot, PACKAGE_NAME);
  await mkdir(join(globalRoot, 'npm', 'bin'), { recursive: true });
  await writeFile(join(globalRoot, 'npm', 'bin', 'npm-cli.js'), '');
  await mkdir(packageDir, { recursive: true });
  await cp(join(repoRoot, 'dist'), join(packageDir, 'dist'), { recursive: true });
  await cp(join(repoRoot, 'package.json'), join(packageDir, 'package.json'));
  // Dependencies resolve from the package's own node_modules first.
  await symlink(join(repoRoot, 'node_modules'), join(packageDir, 'node_modules'));

  const registry = await startRegistry({ latest: '99.0.0' });
  try {
    const result = await run(join(packageDir, 'dist', 'mini-drama', 'cli.js'), ['update', '--dry-run'], {
      VENICE_VIDEO_REGISTRY: registry.url,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`--prefix ${prefix} ${PACKAGE_NAME}@99\\.0\\.0`));
    assert.match(result.stdout, /npm\/bin\/npm-cli\.js install --global/);
    assert.doesNotMatch(result.stdout, /source checkout/);
  } finally {
    registry.close();
  }
});
