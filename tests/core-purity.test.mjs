// packages/core must stay pure: plain data in, plain data out.
//
// Core runs in the CLI and in a browser bundler with no Node polyfills, so
// nothing under packages/core/src may import a Node builtin, an npm dependency
// that needs Node, or any module outside the package, and nothing may touch
// process.env, Buffer or import.meta.url. This test walks the sources and
// fails on the first violation, naming file and line. It is what keeps core
// pure after the split; add to the deny lists rather than relaxing them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreSrc = join(repoRoot, 'packages', 'core', 'src');

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);
const DENIED_PACKAGES = new Set(['sharp', 'dotenv', 'commander', 'chokidar', 'fountain-js', 'pdf-parse']);
const DENIED_GLOBALS = [
  { re: /\bprocess\s*\.\s*env\b/, label: 'process.env' },
  { re: /\bprocess\s*\.\s*(argv|exit|cwd|stdout|stderr|platform)\b/, label: 'process.*' },
  { re: /\bBuffer\s*[.(]/, label: 'Buffer' },
  { re: /\bimport\.meta\.url\b/, label: 'import.meta.url' },
  { re: /\b__dirname\b|\b__filename\b/, label: '__dirname/__filename' },
  { re: /\brequire\s*\(/, label: 'require()' },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Strip comments and string contents so a mention in prose is not a violation. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, m => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`);
}

/** Every module specifier a file imports, re-exports or dynamically imports. */
function specifiers(source) {
  const out = [];
  const re = /(?:import|export)\s*(?:type\s*)?(?:[^'";]*?\s*from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\./g;
  let m;
  while ((m = re.exec(source))) out.push(m[1] ?? m[2] ?? m[3]);
  // Inline type references: `import('../x.js').Foo`
  const inline = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = inline.exec(source))) out.push(m[1]);
  return out;
}

const files = walk(coreSrc);

test('packages/core/src has sources to check', () => {
  assert.ok(files.length >= 10, `expected the moved modules, found ${files.length}`);
});

test('core imports no Node builtins, no Node-only npm packages, and nothing outside the package', () => {
  const violations = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    for (const spec of specifiers(readFileSync(file, 'utf-8'))) {
      const bare = spec.replace(/^node:/, '');
      if (spec.startsWith('node:') || NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(bare.split('/')[0])) {
        violations.push(`${rel}: imports Node builtin '${spec}'`);
      } else if (DENIED_PACKAGES.has(bare.split('/')[0])) {
        violations.push(`${rel}: imports Node-only package '${spec}'`);
      } else if (spec.startsWith('.')) {
        const target = join(dirname(file), spec);
        if (!target.startsWith(coreSrc)) violations.push(`${rel}: imports outside packages/core: '${spec}'`);
      } else if (!spec.startsWith('venice-video-harness/core') && !spec.startsWith('@venice-video-harness/core')) {
        violations.push(`${rel}: imports external package '${spec}' (core has no dependencies)`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('core touches no process.env, Buffer, import.meta.url, __dirname or require()', () => {
  const violations = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const lines = codeOnly(readFileSync(file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      for (const { re, label } of DENIED_GLOBALS) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}: uses ${label}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('the compiled core bundle loads in Node with no Node-specific globals needed', async () => {
  // Importing the dist entry must not throw; and the surface the browser app
  // needs is present.
  const core = await import('../packages/core/dist/index.js');
  assert.equal(typeof core.getVideoModel, 'function');
  assert.equal(typeof core.validateVideoRequest, 'function');
  assert.equal(typeof core.isFacesOffModel, 'function');
  assert.equal(typeof core.buildCapabilitiesManifest, 'function');
  assert.ok(Array.isArray(core.VIDEO_MODELS) && core.VIDEO_MODELS.length > 50);
  assert.ok(core.MODELS_SUPPORTING_REFERENCE_IMAGES instanceof Set);
  assert.equal(typeof core.DEFAULT_CHARACTER_CONSISTENCY_MODEL, 'string');
});

test('core package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages', 'core', 'package.json'), 'utf-8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.sideEffects, false);
});
