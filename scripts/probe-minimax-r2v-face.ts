// Verify whether MiniMax H3 Max R2V (create/production loop's character lane)
// survives a FACE-BEARING reference image — the open question left by PR #25.
//
// PR #25 proved MiniMax *i2v* dies server-side when the START frame (image_url)
// shows a human face: queued + billed, then /video/retrieve 500s forever. R2V is
// a different path — faces arrive as `reference_image_urls`, not a start frame —
// so it MIGHT be fine, but it was never verified. This runs one real 5s R2V
// render against a face image and reports whether it completes or 500s.
//
// COSTS MONEY: one 5s MiniMax H3 Max R2V render (~$0.12 at $0.024/s). It queues
// (and bills) at queue time, exactly like the pipeline.
//
// Usage (via the harness's local tsx):
//   npx tsx scripts/probe-minimax-r2v-face.ts --image /path/to/face.png
//   npx tsx scripts/probe-minimax-r2v-face.ts --project ~/VeniceVideos/rise-and-shine
//     (auto-picks the first characters/<slug>/*.png reference sheet)

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, '..');
const PROJECTS_ROOT = join(HARNESS, '..', '..'); // ~/projects (the .env SSOT)
const BASE = 'https://api.venice.ai';
const MODEL = 'minimax-h3-max-reference-to-video';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveApiKey(): string {
  for (const p of [join(PROJECTS_ROOT, '.env'), join(HARNESS, '.env')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^VENICE_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  if (process.env.VENICE_API_KEY) return process.env.VENICE_API_KEY.trim();
  throw new Error('VENICE_API_KEY not found in ~/projects/.env, harness .env, or the environment');
}

/** Find a face-bearing reference sheet under a project's characters/ dir. */
function findCharacterSheet(projectDir: string): string | undefined {
  const charsDir = join(projectDir, 'characters');
  if (!existsSync(charsDir)) return undefined;
  for (const slug of readdirSync(charsDir)) {
    const dir = join(charsDir, slug);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    const pick = files.find(f => /front|three|profile|full/i.test(f) && f.endsWith('.png'))
      ?? files.find(f => f.endsWith('.png'));
    if (pick) return join(dir, pick);
  }
  return undefined;
}

async function api(path: string, body: unknown, binary = false): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey()}` },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (binary && ct.includes('video/mp4')) return { kind: 'video', buf: Buffer.from(await res.arrayBuffer()) };
  let json: any; try { json = await res.json(); } catch { json = { raw: await res.text().catch(() => '') }; }
  return { ok: res.ok, status: res.status, kind: 'json', json };
}

function msg(j: any, s?: number): string {
  if (typeof j?.error === 'string') return j.error;
  if (j?.error?.message) return j.error.message;
  if (Array.isArray(j?.issues)) return j.issues.map((i: any) => i.message).join('; ');
  return `${JSON.stringify(j).slice(0, 300)} (HTTP ${s})`;
}

async function main(): Promise<void> {
  let image = arg('image');
  const project = arg('project');
  if (!image && project) image = findCharacterSheet(resolve(project));
  if (!image) {
    console.error('Provide a face image: --image <path>  (or --project <dir> to auto-pick a character sheet)');
    process.exit(2);
  }
  if (!existsSync(image)) { console.error(`No such image: ${image}`); process.exit(2); }

  const outDir = join(HARNESS, 'output', 'minimax-r2v-face-probe');
  mkdirSync(outDir, { recursive: true });
  const dataUri = `data:image/png;base64,${readFileSync(image).toString('base64')}`;
  const body = {
    model: MODEL,
    prompt: '@Image1 turns to face the camera and smiles, then holds a steady close-up. Soft natural light.',
    duration: '5s',
    resolution: '768P',
    aspect_ratio: '16:9',
    reference_image_urls: [dataUri],
  };

  console.log(`Probing ${MODEL} with a FACE reference: ${image}`);
  console.log('This queues + bills one ~5s render (~$0.12). Ctrl-C to abort.\n');

  const enq = await api('/api/v1/video/queue', body);
  if (!enq.ok) {
    console.log(`✗ queue REJECTED (free, not billed): ${msg(enq.json, enq.status)}`);
    console.log('  → R2V rejected the face reference at queue time (like a validation gate).');
    process.exit(1);
  }
  const { model, queue_id } = enq.json;
  console.log(`✓ queued (BILLED) queue_id=${queue_id}\n  polling /video/retrieve…`);

  const started = Date.now();
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    const r = await api('/api/v1/video/retrieve', { model, queue_id }, true);
    if (r.kind === 'video') {
      const f = join(outDir, 'r2v-face.mp4');
      writeFileSync(f, r.buf);
      console.log(`\n✓ SUCCESS in ~${Math.round((Date.now() - started) / 1000)}s — ${Math.round(r.buf.length / 1024)} KB → ${f}`);
      console.log('  → MiniMax H3 Max R2V ACCEPTS face-bearing reference sheets. Create-mode character loops are viable.');
      return;
    }
    if (!r.ok) {
      console.log(`\n✗ retrieve error after ~${Math.round((Date.now() - started) / 1000)}s: ${msg(r.json, r.status)}`);
      console.log('  → R2V dies server-side on a face reference too (same failure class as i2v). Create-mode face loops are NOT viable on MiniMax.');
      process.exit(1);
    }
    process.stdout.write(`\r  ${r.json.status} (${Math.round((Date.now() - started) / 1000)}s)      `);
  }
  console.log('\n✗ timed out after 30 min without a result.');
  process.exit(1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
