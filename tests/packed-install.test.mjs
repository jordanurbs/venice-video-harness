// The CLI must work from an installed tarball, not only inside this repo.
//
// Inside the repo, `node_modules/@venice-video-harness/core` is a workspace
// symlink, so every in-repo test resolves core whether or not the published
// package can. A user who runs `npm install -g venice-video-harness` has no
// such symlink: the root package must import core through its own
// `venice-video-harness/core` self-reference, and `files` must ship
// `packages/core/dist`. This test packs the repo, installs the tarball into a
// scratch directory, and runs the binaries and the library entry points there.
//
// Slow (~5-10 s) but it is the only test that exercises the real install.
// Skipped when SKIP_PACK_TEST=1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.SKIP_PACK_TEST === '1';

test('the packed tarball installs and the CLI + library resolve core without the workspace symlink', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-pack-'));
  try {
    // --ignore-scripts: skip prepack (clean + full rebuild + web UI); dist is already built by `npm test`.
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], { cwd: repoRoot, stdio: 'pipe' });
    const tgz = readdirSync(dir).find(f => f.endsWith('.tgz'));
    assert.ok(tgz, 'npm pack produced a tarball');

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pack-scratch', private: true, type: 'module' }));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `./${tgz}`], { cwd: dir, stdio: 'pipe' });

    const env = { ...process.env, VENICE_API_KEY: '' };
    const bin = (name, args) => spawnSync(join(dir, 'node_modules', '.bin', name), args, { cwd: dir, encoding: 'utf-8', env });

    const version = bin('venice-video', ['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);

    const caps = bin('venice-video', ['capabilities']);
    assert.equal(caps.status, 0, caps.stderr);
    const manifest = JSON.parse(caps.stdout);
    assert.ok(manifest.videoModels.length > 50, 'registry came through core');
    assert.notEqual(manifest.harnessVersion, '0.0.0', 'CLI stamps the real version');

    const legacy = bin('storyboard', ['--help']);
    assert.equal(legacy.status, 0, legacy.stderr);

    const lib = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const root = await import('venice-video-harness');
      const core = await import('venice-video-harness/core');
      const sub = await import('venice-video-harness/core/series/types.js');
      if (typeof root.VeniceClient !== 'function') throw new Error('root entry');
      if (typeof core.getVideoModel !== 'function') throw new Error('core entry');
      if (typeof sub.resolveMontageModel !== 'function') throw new Error('core subpath');
      console.log('ok');
    `], { cwd: dir, encoding: 'utf-8' });
    assert.equal(lib.status, 0, lib.stderr);
    assert.match(lib.stdout, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
