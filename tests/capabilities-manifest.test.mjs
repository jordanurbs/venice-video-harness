// Capability manifest coverage: the manifest must carry the full registry,
// stay consistent with the capability sets, and keep the shape downstream
// clients (the Venice Video Creator app) parse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCapabilitiesManifest,
  renderCapabilitiesManifest,
  CAPABILITIES_SCHEMA_VERSION,
} from '../packages/core/dist/venice/capabilities-manifest.js';
import { VIDEO_MODELS } from '../packages/core/dist/venice/models.js';
import {
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_USING_IMAGE_TAGS,
  DEFAULT_MULTISHOT_MODEL,
} from '../packages/core/dist/series/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest carries the full video registry verbatim', () => {
  const m = buildCapabilitiesManifest();
  assert.equal(m.schemaVersion, CAPABILITIES_SCHEMA_VERSION);
  assert.equal(m.videoModels.length, VIDEO_MODELS.length);
  const ids = new Set(m.videoModels.map(s => s.id));
  for (const spec of VIDEO_MODELS) assert.ok(ids.has(spec.id), `missing ${spec.id}`);
});

test('capability sets match the exported constants and reference known ids', () => {
  const m = buildCapabilitiesManifest();
  assert.deepEqual(
    [...m.capabilitySets.referenceImages].sort(),
    [...MODELS_SUPPORTING_REFERENCE_IMAGES].sort(),
  );
  assert.deepEqual(
    [...m.capabilitySets.imageTags].sort(),
    [...MODELS_USING_IMAGE_TAGS].sort(),
  );
  // Every id in every set must exist in the registry (no dangling ids).
  const known = new Set(VIDEO_MODELS.map(s => s.id));
  for (const [setName, ids] of Object.entries(m.capabilitySets)) {
    for (const id of ids) {
      assert.ok(known.has(id), `capabilitySets.${setName} references unknown id ${id}`);
    }
  }
});

test('routing defaults are registry-known and multi-shot default is Seedance 2.5 R2V', () => {
  const m = buildCapabilitiesManifest();
  const known = new Set(VIDEO_MODELS.map(s => s.id));
  assert.equal(m.defaults.multiShotModel, DEFAULT_MULTISHOT_MODEL);
  for (const key of ['actionModel', 'atmosphereModel', 'characterConsistencyModel', 'multiShotModel', 'lipSyncModel']) {
    assert.ok(known.has(m.defaults[key]), `defaults.${key} = ${m.defaults[key]} not in registry`);
  }
});

test('generatedAt pin makes the render deterministic', () => {
  const a = renderCapabilitiesManifest({ generatedAt: '2026-01-01T00:00:00Z' });
  const b = renderCapabilitiesManifest({ generatedAt: '2026-01-01T00:00:00Z' });
  assert.equal(a, b);
});

test('harnessVersion is supplied by the host, not read from disk by core', () => {
  // Core cannot read package.json (it runs in a browser too). Without a
  // version it stamps 0.0.0; the CLI and the snapshot script pass the real one.
  assert.equal(buildCapabilitiesManifest().harnessVersion, '0.0.0');
  assert.equal(buildCapabilitiesManifest({ harnessVersion: '9.9.9' }).harnessVersion, '9.9.9');
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));
  const snapshot = JSON.parse(readFileSync(resolve(repoRoot, 'capabilities.json'), 'utf-8'));
  assert.equal(snapshot.harnessVersion, pkg.version, 'committed snapshot carries the root package version');
});

test('CLI `capabilities` command emits parseable JSON with the schema version', () => {
  const out = execFileSync('node', [resolve(repoRoot, 'dist/mini-drama/cli.js'), 'capabilities'], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.schemaVersion, CAPABILITIES_SCHEMA_VERSION);
  assert.ok(Array.isArray(parsed.videoModels) && parsed.videoModels.length > 50);
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));
  assert.equal(parsed.harnessVersion, pkg.version, 'CLI stamps the real version');
});
