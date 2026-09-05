// Stream writer bakeoff: time each candidate model on the REAL stream writer
// prompt (system + user, from stream-engine.ts) against a real project, and
// check that it returns a valid beat. Reports wall time, tokens, cost, and a
// JSON-validity verdict. No video is rendered; only chat completions bill.
//
//   npx tsx scripts/bakeoff-stream-writer.ts -p <project> [--rounds 3] [--models a,b,c] [--no-thinking]
//
// --no-thinking sends venice_parameters.disable_thinking=true so reasoning
// models answer directly. The stream writer wants a quick, in-character beat,
// not a chain of thought, so this is the mode the stream should use.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getVeniceApiKey } from '../src/config.js';
import { loadSeries } from '../src/series/manager.js';
import {
  buildStreamSystemPrompt,
  buildStreamUserPrompt,
  normalizeBeat,
  type AuthoredBeat,
  type StreamBeat,
} from '../src/mini-drama/stream-engine.js';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const projectDir = resolve(flag('-p') ?? flag('--project') ?? '.');
const rounds = Number.parseInt(flag('--rounds') ?? '3', 10);
const noThinking = args.includes('--no-thinking');
const show = args.includes('--show');
const models = (flag('--models') ?? [
  'kimi-k3',
  'kimi-k3-fast',
  'z-ai-glm-5-3',
  'z-ai-glm-5-3-flash',
  'deepseek-v4-flash-0731-fast',
  'deepseek-v4-flash',
  'minimax-m27',
  'qwen3-6-35b-a3b',
  'grok-4-6',
  'gemini-3-8-flash',
  'seed-2-1-turbo',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

interface Row {
  model: string;
  ok: number;
  fail: number;
  msMedian: number;
  msMin: number;
  msMax: number;
  outTokens: number;
  usd: number;
  sample?: string;
  error?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  return m ? m[1] : t;
}

async function main() {
  const series = await loadSeries(projectDir);
  if (!series) throw new Error(`Project not found at ${projectDir}`);
  series.outputDir = projectDir;
  const streamDir = join(projectDir, 'episodes', 'episode-001', 'stream');
  let storySoFar = '';
  let recent: StreamBeat[] = [];
  try {
    storySoFar = await readFile(join(streamDir, 'story-so-far.md'), 'utf-8');
    const manifest = JSON.parse(await readFile(join(streamDir, 'stream-manifest.json'), 'utf-8')) as { beats: StreamBeat[]; direction?: string };
    recent = manifest.beats.slice(-6);
    const direction = manifest.direction;
    const beatNumber = manifest.beats.length + 1;
    const system = buildStreamSystemPrompt(series, direction);
    const user = buildStreamUserPrompt({ series, beatNumber, storySoFar, recentBeats: recent, direction });
    await run(system, user);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const system = buildStreamSystemPrompt(series);
      const user = buildStreamUserPrompt({ series, beatNumber: 1, storySoFar: '', recentBeats: [] });
      await run(system, user);
    } else throw err;
  }
}

async function run(system: string, user: string) {
  const apiKey = await getVeniceApiKey();
  console.log(`Stream writer bakeoff: ${models.length} models x ${rounds} rounds, thinking ${noThinking ? 'OFF' : 'on (harness default)'}.`);
  console.log(`Prompt: system ${system.length} chars, user ${user.length} chars.\n`);

  const rows: Row[] = [];
  for (const model of models) {
    const times: number[] = [];
    let ok = 0; let fail = 0; let outTokens = 0; let usd = 0; let sample: string | undefined; let lastErr: string | undefined;
    for (let r = 0; r < rounds; r++) {
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 1500,
        temperature: 0.8,
      };
      if (noThinking) body.venice_parameters = { disable_thinking: true, strip_thinking_response: true };
      const t0 = Date.now();
      try {
        const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const ms = Date.now() - t0;
        const json = await res.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { completion_tokens?: number; prompt_tokens?: number };
          error?: unknown;
        };
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
        times.push(ms);
        outTokens += json.usage?.completion_tokens ?? 0;
        const cost = res.headers.get('x-venice-balance-usd-charged') ?? res.headers.get('x-venice-usd-charged');
        if (cost) usd += Number.parseFloat(cost) || 0;
        const content = json.choices?.[0]?.message?.content ?? '';
        const parsed = JSON.parse(stripFences(content)) as Partial<AuthoredBeat>;
        const beat = normalizeBeat(parsed, (await loadSeries(projectDir))!);
        if (beat.description.split(/\s+/).length > 160) throw new Error('beat over 160 words');
        ok += 1;
        if (!sample) sample = beat.description.slice(0, 140);
        if (show) console.log(`\n--- ${model} full beat ---\n${JSON.stringify(beat, null, 1)}\n`);
        process.stdout.write(`  ${model.padEnd(30)} round ${r + 1}: ${ms}ms ok\n`);
      } catch (err) {
        fail += 1;
        lastErr = (err as Error).message.slice(0, 160);
        times.push(Date.now() - t0);
        process.stdout.write(`  ${model.padEnd(30)} round ${r + 1}: FAIL ${lastErr}\n`);
      }
    }
    rows.push({ model, ok, fail, msMedian: median(times), msMin: Math.min(...times), msMax: Math.max(...times), outTokens, usd, sample, error: lastErr });
  }

  rows.sort((a, b) => (b.ok - a.ok) || (a.msMedian - b.msMedian));
  console.log('\nRESULTS (sorted: most valid beats, then fastest median)\n');
  console.log('model'.padEnd(30), 'ok/rounds', 'median'.padStart(8), 'min'.padStart(7), 'max'.padStart(7), 'out-tok'.padStart(8), 'usd'.padStart(8));
  for (const r of rows) {
    console.log(
      r.model.padEnd(30),
      `${r.ok}/${rounds}`.padEnd(9),
      `${(r.msMedian / 1000).toFixed(1)}s`.padStart(8),
      `${(r.msMin / 1000).toFixed(1)}s`.padStart(7),
      `${(r.msMax / 1000).toFixed(1)}s`.padStart(7),
      String(r.outTokens).padStart(8),
      r.usd ? `$${r.usd.toFixed(4)}`.padStart(8) : '     n/a',
    );
  }
  console.log('\nSAMPLES');
  for (const r of rows) {
    if (r.sample) console.log(`  ${r.model}: ${r.sample}…`);
    else if (r.error) console.log(`  ${r.model}: (no valid beat) ${r.error}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
