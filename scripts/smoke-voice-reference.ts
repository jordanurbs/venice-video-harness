// ---------------------------------------------------------------------------
// Smoke test: voice-identity references on Seedance 2.0 R2V Enhanced.
//
// User decision 2026-07-30: default dialogue strategy is reference_audio_urls
// (voice-donor clip per speaker, model generates the dialogue) — but only if
// the donor voice is actually honored. This script runs the check:
//
//   1. Generate a distinctive voice-donor clip via seed-audio-1-0 (or reuse
//      an existing one passed via --voice <path>).
//   2. Queue a short Seedance R2V Enhanced dialogue shot in PURE reference
//      mode: character ref as @Image1, donor clip as @Audio1, no image_url.
//   3. Repeat for a second contrasting voice (two takes = "a few test
//      generations" without burning budget).
//   4. Save the clips to output/smoke-voice-ref/ for a human listen: does
//      the spoken line carry the donor's timbre/accent/pacing?
//
// Run: npx tsx scripts/smoke-voice-reference.ts [--ref <char-front.png>]
// Cost: ~2 x 5s Enhanced R2V + 2 x seed-audio clips.
// ---------------------------------------------------------------------------

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VeniceClient, VeniceRequestError } from '../src/venice/client.js';
import { generateSeedAudio } from '../src/venice/audio.js';

const MODEL = 'seedance-2-0-enhanced-reference-to-video';
const QUEUE_PATH = '/api/v1/video/queue';
const RETRIEVE_URL = 'https://api.venice.ai/api/v1/video/retrieve';

const apiKey = process.env.VENICE_API_KEY;
if (!apiKey) { console.error('VENICE_API_KEY not set'); process.exit(1); }
const client = new VeniceClient(apiKey);

const OUT_DIR = 'output/smoke-voice-ref';
mkdirSync(OUT_DIR, { recursive: true });

const refArgIdx = process.argv.indexOf('--ref');
const refPath = refArgIdx >= 0
  ? process.argv[refArgIdx + 1]
  : '/Users/venetian42069/projects/tools/venice-video-mcp/output/the-chrome-canary/characters/jack/front.png';
if (!existsSync(refPath)) { console.error(`Character ref not found: ${refPath}`); process.exit(1); }
const refUri = `data:image/png;base64,${readFileSync(refPath).toString('base64')}`;

interface Take {
  name: string;
  voicePrompt: string;
  line: string;
}

// Two deliberately contrasting voices so a listen test is unambiguous.
const TAKES: Take[] = [
  {
    name: 'gravel-southern',
    voicePrompt: 'Speak in this voice: a deep gravelly Southern American drawl, slow and weathered, like an old rancher. Say: "Well now, the river keeps its secrets, and so do I."',
    line: 'Well now, the river keeps its secrets, and so do I.',
  },
  {
    name: 'crisp-british',
    voicePrompt: 'Speak in this voice: a crisp high-pitched British Received Pronunciation accent, fast and clipped, like an impatient professor. Say: "Precisely on schedule, as I always am."',
    line: 'Precisely on schedule, as I always am.',
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
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('video/mp4')) {
      return Buffer.from(await res.arrayBuffer());
    }
    const status = await res.json() as { status: string };
    process.stdout.write(`\r  [${label}] ${status.status}      `);
  }
}

async function generateDonor(take: Take): Promise<string> {
  const donorPath = join(OUT_DIR, `donor-${take.name}.mp3`);
  if (!existsSync(donorPath)) {
    console.log(`  generating donor clip (${take.name})…`);
    await generateSeedAudio(client, {
      prompt: take.voicePrompt,
      durationSeconds: 10,
    }, donorPath);
    console.log(`  donor saved: ${donorPath}`);
  } else {
    console.log(`  donor exists: ${donorPath}`);
  }
  // Trim-to-speech + fades per seed-audio-vo rules would apply in production;
  // for the smoke test we clamp to the 2-15s window with de-click fades.
  const clamped = donorPath.replace(/\.mp3$/, '-clamped.mp3');
  if (!existsSync(clamped)) {
    try {
      execFileSync('ffmpeg', ['-y', '-i', donorPath, '-t', '10', '-af', 'afade=t=in:d=0.03,afade=t=out:st=9.8:d=0.14', clamped], { stdio: 'ignore' });
    } catch {
      return donorPath;
    }
  }
  return clamped;
}

async function renderTake(take: Take, donorPath: string): Promise<void> {
  const outPath = join(OUT_DIR, `take-${take.name}.mp4`);
  if (existsSync(outPath)) { console.log(`  take exists: ${outPath}`); return; }
  const donorUri = `data:audio/mpeg;base64,${readFileSync(donorPath).toString('base64')}`;

  const body: Record<string, unknown> = {
    model: MODEL,
    prompt:
      `@Image1 is a man standing in a dim room, facing the camera. ` +
      `[@Image1, ${take.name.replace(/-/g, ' ')} voice, calm]: "${take.line}" ` +
      `Use @Audio1 only for voice identity — timbre, accent, pacing; ` +
      `regenerate clean studio dialogue, do not copy any noise from the reference. ` +
      `Static shot. No background music. Only generate dialogue and ambient sound.`,
    duration: '5s',
    aspect_ratio: '16:9',
    resolution: '720p',
    audio: true,
    reference_image_urls: [refUri],
    reference_audio_urls: [donorUri],
  };

  console.log(`  queueing take (${take.name}) on ${MODEL}…`);
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
  const buf = await pollVideo(queueRes.model, queueRes.queue_id, `take ${take.name}`);
  writeFileSync(outPath, buf);
  console.log(`\n  take saved: ${outPath}`);
}

async function main() {
  console.log(`Voice-reference smoke test on ${MODEL}\nCharacter ref: ${refPath}\n`);
  for (const take of TAKES) {
    console.log(`\n=== ${take.name} ===`);
    const donor = await generateDonor(take);
    await renderTake(take, donor);
  }
  console.log(`\nDone. Listen to the takes in ${OUT_DIR}/ and compare each against its donor-*.mp3:`);
  console.log('  - Does the rendered dialogue carry the donor timbre/accent/pacing?');
  console.log('  - Is the line clean (no copied noise from the donor clip)?');
  console.log('If both takes track their donors, the ref-audio default stands. If not, flip');
  console.log('videoDefaults.voiceReferenceForDialogue=false and prefer the Wan 2.7 lip-sync lane.');
}

main().catch(err => { console.error(err); process.exit(1); });
