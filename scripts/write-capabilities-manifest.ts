// Write the capability manifest snapshot to capabilities.json at the repo
// root. Run via `npm run manifest` (also part of `prepack`, so a stale
// snapshot can never ship in a release). The generatedAt timestamp is pinned
// to the current HEAD commit date when available so re-running the script
// with unchanged data produces an identical file (clean `git status`).

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCapabilitiesManifest, buildCapabilitiesManifest } from '../src/venice/capabilities-manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(repoRoot, 'capabilities.json');

function pinnedTimestamp(): string | undefined {
  // Keep the previous generatedAt when the data hasn't changed.
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf-8'));
      const prevBody = { ...prev, generatedAt: 'X' };
      const nextBody = { ...buildCapabilitiesManifest('X') };
      if (JSON.stringify(prevBody) === JSON.stringify(nextBody)) return prev.generatedAt;
    } catch {
      // fall through — regenerate with a fresh timestamp
    }
  }
  try {
    return execSync('git log -1 --format=%cI', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

writeFileSync(outPath, renderCapabilitiesManifest(pinnedTimestamp()));
console.log(`Wrote ${outPath}`);
