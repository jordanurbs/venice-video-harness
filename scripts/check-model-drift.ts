// Compare the video model registry (packages/core/src/venice/models.ts) with
// the live `GET /api/v1/models?type=video` list. Run by the weekly workflow;
// locally: `npm run build && npx tsx scripts/check-model-drift.ts`.
//
// The registry decides what the harness will send before a paid call
// (`validateVideoRequest`), so a model Venice added, retired, or re-laddered
// shows up here before it shows up as a 400. GET /models needs no key and
// costs nothing.
//
// Prints a markdown report. Exit 0 = no drift, 1 = drift, 2 = the check
// itself failed (network, unexpected shape).

import { VIDEO_MODELS } from 'venice-video-harness/core/venice/models.js';

interface LiveConstraints {
  model_type?: string;
  durations?: string[];
  resolutions?: string[];
  aspect_ratios?: string[];
  audio?: boolean;
  audio_configurable?: boolean;
  audio_input?: boolean;
  video_input?: boolean;
}

interface LiveModel {
  id: string;
  model_spec?: { offline?: boolean; constraints?: LiveConstraints };
}

const BASE_URL = process.env.VENICE_BASE_URL ?? 'https://api.venice.ai';

/**
 * Registry ids absent from the public list that still answer `/video/quote`
 * with the ladder recorded here (checked 2026-10-06). Venice serves them
 * unlisted, e.g. the face-capable Seedance twins and beta lanes. Reported in a
 * collapsed section, not as drift. Re-check an id with a free quote before
 * adding it; one that now validates against a different ladder is retired, so
 * mark it `offline` in the registry instead.
 */
const KNOWN_UNLISTED = new Set([
  'grok-imagine-image-to-video', 'grok-imagine-reference-to-video', 'grok-imagine-text-to-video', 'grok-imagine-video-to-video',
  'ltx-2-fast-image-to-video', 'ltx-2-fast-text-to-video', 'ltx-2-full-image-to-video', 'ltx-2-full-text-to-video',
  'minimax-hailuo-03-image-to-video', 'minimax-hailuo-03-reference-to-video', 'minimax-hailuo-03-text-to-video',
  'runway-gen4-aleph',
  'seedance-2-0-enhanced-reference-to-video', 'seedance-2-0-fast-image-to-video', 'seedance-2-0-fast-reference-to-video',
  'seedance-2-0-fast-text-to-video', 'seedance-2-0-image-to-video', 'seedance-2-0-reference-to-video', 'seedance-2-0-text-to-video',
  'seedance-2-5-image-to-video', 'seedance-2-5-reference-to-video', 'seedance-2-5-text-to-video',
  'wan-2-7-spicy-image-to-video', 'wan-2.1-pro-image-to-video', 'wan-2.2-a14b-text-to-video', 'wan-2.6-reference-to-video',
  'wan-3-0-enhanced-reference-to-video', 'wan-3-0-enhanced-text-to-video',
]);

function setDiff(registry: readonly string[], live: readonly string[] | undefined): string | undefined {
  if (!live) return undefined;
  const missing = live.filter(v => !registry.includes(v));
  const extra = registry.filter(v => !live.includes(v));
  if (missing.length === 0 && extra.length === 0) return undefined;
  const parts: string[] = [];
  if (missing.length) parts.push(`live adds ${missing.join(', ')}`);
  if (extra.length) parts.push(`registry has ${extra.join(', ')} that live doesn't`);
  return parts.join('; ');
}

async function main(): Promise<number> {
  const res = await fetch(`${BASE_URL}/api/v1/models?type=video`);
  if (!res.ok) {
    console.log(`GET /models?type=video returned HTTP ${res.status}; drift not checked.`);
    return 2;
  }
  const body = await res.json() as { data?: LiveModel[] };
  if (!Array.isArray(body.data)) {
    console.log('GET /models?type=video returned no `data` array; drift not checked.');
    return 2;
  }

  const live = new Map(body.data.map(m => [m.id, m]));
  const registry = new Map(VIDEO_MODELS.map(m => [m.id, m]));

  const added = [...live.keys()].filter(id => !registry.has(id)).sort();
  const unlisted = [...registry.keys()].filter(id => !live.has(id)).sort();
  const expected = unlisted.filter(id => registry.get(id)!.offline || KNOWN_UNLISTED.has(id));
  const gone = unlisted.filter(id => !expected.includes(id));
  const changed: string[] = [];

  for (const [id, spec] of registry) {
    const c = live.get(id)?.model_spec?.constraints;
    if (!c) continue;
    const issues: string[] = [];
    if (c.model_type && c.model_type !== spec.type) issues.push(`type ${spec.type} → ${c.model_type}`);
    for (const [label, reg, liveList] of [
      ['durations', spec.durations, c.durations],
      ['resolutions', spec.resolutions, c.resolutions],
      ['aspect ratios', spec.aspectRatios, c.aspect_ratios],
    ] as const) {
      const d = setDiff(reg, liveList);
      if (d) issues.push(`${label}: ${d}`);
    }
    for (const [label, reg, liveFlag] of [
      ['audio', spec.audio, c.audio],
      ['audio_configurable', spec.audioConfigurable, c.audio_configurable],
      ['audio_input', spec.audioInput, c.audio_input],
      ['video_input', spec.videoInput, c.video_input],
    ] as const) {
      if (typeof liveFlag === 'boolean' && liveFlag !== reg) issues.push(`${label} ${reg} → ${liveFlag}`);
    }
    if (issues.length) changed.push(`- \`${id}\`: ${issues.join('; ')}`);
  }

  const lines = [
    `Registry: ${registry.size} video models. Live: ${live.size}. Checked ${new Date().toISOString().slice(0, 10)}.`,
    '',
  ];
  if (added.length) lines.push(`### On Venice, not in the registry (${added.length})`, '', ...added.map(id => `- \`${id}\``), '');
  if (gone.length) lines.push(`### In the registry, not on Venice (${gone.length})`, '', ...gone.map(id => `- \`${id}\``), '');
  if (changed.length) lines.push(`### Constraints differ (${changed.length})`, '', ...changed, '');
  if (!added.length && !gone.length && !changed.length) lines.push('No drift.');
  if (expected.length) {
    lines.push(
      '',
      `<details><summary>Unlisted as expected (${expected.length}): offline in the registry, or still served unlisted</summary>`,
      '',
      ...expected.map(id => `- \`${id}\`${registry.get(id)!.offline ? ' (offline)' : ''}`),
      '',
      '</details>',
    );
  }
  console.log(lines.join('\n'));

  return added.length || gone.length || changed.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, err => {
  console.log(`Drift check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
