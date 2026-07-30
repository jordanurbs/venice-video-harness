// ---------------------------------------------------------------------------
// Smoke test 2: voice lock with a DIFFERENT line than the donor clip.
//
// The first smoke test (smoke-voice-reference.ts) had the donor speak the
// SAME line the video prompt asked for — so a passing result could just be
// audio parroting. This test reuses the same two donors but prompts lines
// the donor never said. If the takes still carry the donor's timbre/accent/
// pacing, the voice lock is real (identity transfer, not copy).
//
// Run: npx tsx scripts/smoke-voice-reference-newline.ts
// Reuses: output/smoke-voice-ref/donor-*-clamped.mp3 (from smoke test 1)
// Outputs: output/smoke-voice-ref/take2-*.mp4
// ---------------------------------------------------------------------------

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VeniceClient, VeniceRequestError } from '../src/venice/client.js';

const MODEL = 'seedance-2-0-enhanced-reference-to-video';
const QUEUE_PATH = '/api/v1/video/queue';
const RETRIEVE_URL = 'https://api.venice.ai/api/v1/video/retrieve';

const apiKey = process.env.VENICE_API_KEY;
if (!apiKey) { console.error('VENICE_API_KEY not set'); process.exit(1); }
const client = new VeniceClient(apiKey);

const OUT_DIR = 'output/smoke-voice-ref';
const refPath = '/Users/venetian42069/projects/tools/venice-video-mcp/output/the-chrome-canary/characters/jack/front.png';
const refUri = `data:image/png;base64,${readFileSync(refPath).toString('base64')}`;

interface Take {
  name: string;
  donorFile: string;
  voiceHint: string;
  /** A line the donor NEVER said — deliberately different vocabulary/rhythm. */
  newLine: string;
}

const TAKES: Take[] = [
  {
    name: 'gravel-southern',
    donorFile: 'donor-gravel-southern-clamped.mp3',
    voiceHint: 'deep gravelly Southern drawl',
    // Donor said: "Well now, the river keeps its secrets, and so do I."
    newLine: 'Storm is coming in from the west. Best get the horses inside before nightfall.',
  },
  {
    name: 'crisp-british',
    donorFile: 'donor-crisp-british-clamped.mp3',
    voiceHint: 'crisp fast British accent',
    // Donor said: "Precisely on schedule, as I always am."
    newLine: 'The laboratory results were conclusive. Someone tampered with the evidence.',
  },
];

async function pollVideo(model: string, queueId: string, label: string): Promise<Buffer> {
  while (true) {
    await new Promise(r => setTimeout(r, 8_000));
    const res = await fetch(RETRIEVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, queue_id: queueId }),
    });
    if ((res.headers.get('content-type') ?? '').includes('video/mp4')) {
      return Buffer.from(await res.arrayBuffer());
    }
    const status = await res.json() as { status: string };
    process.stdout.write(`\r  [${label}] ${status.status}      `);
  }
}

async function renderTake(take: Take): Promise<void> {
  const outPath = join(OUT_DIR, `take2-${take.name}.mp4`);
  if (existsSync(outPath)) { console.log(`  take exists: ${outPath}`); return; }
  const donorPath = join(OUT_DIR, take.donorFile);
  if (!existsSync(donorPath)) {
    console.error(`  donor missing: ${donorPath} — run smoke-voice-reference.ts first.`);
    return;
  }
  const donorUri = `data:audio/mpeg;base64,${readFileSync(donorPath).toString('base64')}`;

  const body: Record<string, unknown> = {
    model: MODEL,
    prompt:
      `@Image1 is a man standing in a dim room, facing the camera. ` +
      `[@Image1, ${take.voiceHint}, calm]: "${take.newLine}" ` +
      `Use @Audio1 only for voice identity — timbre, accent, pacing; ` +
      `regenerate clean studio dialogue, do not copy any words or noise from the reference. ` +
      `Static shot. No background music. Only generate dialogue and ambient sound.`,
    duration: '8s',
    aspect_ratio: '16:9',
    resolution: '720p',
    audio: true,
    reference_image_urls: [refUri],
    reference_audio_urls: [donorUri],
  };

  console.log(`  queueing take2 (${take.name}) — new line: "${take.newLine.slice(0, 50)}…"`);
  let queueRes: { queue_id: string; model: string };
  try {
    queueRes = await client.post<{ queue_id: string; model: string }>(QUEUE_PATH, body);
  } catch (err) {
    if (err instanceof VeniceRequestError && err.status === 409) {
      console.log('  409 needs_consent — resubmitting with seedance attestation.');
      queueRes = await client.post<{ queue_id: string; model: string }>(QUEUE_PATH, {
        ...body,
        consents: {
          seedance: {
            confirmed_terms_and_privacy: true,
            confirmed_legal_right: true,
            confirmed_screening_acknowledged: true,
          },
        },
      });
    } else {
      throw err;
    }
  }
  const buf = await pollVideo(queueRes.model, queueRes.queue_id, `take2 ${take.name}`);
  writeFileSync(outPath, buf);
  console.log(`\n  take saved: ${outPath}`);
}

async function main() {
  console.log(`Voice-lock test 2 (DIFFERENT line than donor) on ${MODEL}\n`);
  for (const take of TAKES) {
    console.log(`\n=== ${take.name} ===`);
    await renderTake(take);
  }
  console.log(`\nDone. Compare take2-*.mp4 against the same donor-*.mp3 clips:`);
  console.log('  - Does the NEW line carry the donor timbre/accent/pacing?');
  console.log('  - Is the wording the prompted line (not the donor line)?');
}

main().catch(err => { console.error(err); process.exit(1); });
