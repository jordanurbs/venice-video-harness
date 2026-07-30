// ---------------------------------------------------------------------------
// Probe: does HappyHorse 1.1 R2V accept @ImageN prompt tags + 9 reference
// images + reference_audio_urls the way Seedance 2.0 R2V does?
//
// Stage 1 (free): POST /video/quote with the full reference-first body —
//   9 reference_image_urls, an @ImageN-tagged prompt, reference_audio_urls,
//   and NO image_url. A 200 means the validator accepts the shape.
// Stage 2 (paid, --render): queue a cheap 3s 720p job with 2 refs and
//   @Image1/@Image2 mentions, poll to completion, and save the clip for a
//   human eyeball check of whether the tags were semantically honored.
//
// Run: npx tsx scripts/probe-happyhorse-image-tags.ts [--render]
// ---------------------------------------------------------------------------

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VeniceClient, VeniceRequestError } from '../src/venice/client.js';

const MODEL = 'happyhorse-1-1-reference-to-video';
const QUOTE_PATH = '/api/v1/video/quote';
const QUEUE_PATH = '/api/v1/video/queue';
const RETRIEVE_URL = 'https://api.venice.ai/api/v1/video/retrieve';

const apiKey = process.env.VENICE_API_KEY;
if (!apiKey) { console.error('VENICE_API_KEY not set'); process.exit(1); }
const client = new VeniceClient(apiKey);

// Tiny valid PNG (1x1, red) — enough for validator shape checks.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function tryQuote(label: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await client.post<Record<string, unknown>>(QUOTE_PATH, body);
    console.log(`  OK   ${label} -> ${JSON.stringify(res).slice(0, 120)}`);
    return true;
  } catch (err) {
    if (err instanceof VeniceRequestError) {
      console.log(`  FAIL ${label} -> HTTP ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`);
    } else {
      console.log(`  FAIL ${label} -> ${(err as Error).message}`);
    }
    return false;
  }
}

const tagPrompt =
  '@Image1 is a knight named Bob. @Image2 is a queen named Alice. ' +
  '@Image3 is the castle courtyard location reference. ' +
  '@Image1 and @Image2 walk through the courtyard talking. Static shot.';

async function main() {
  const render = process.argv.includes('--render');

  console.log(`Probing ${MODEL} via ${QUOTE_PATH} (free validation)…\n`);

  // 1. Baseline: prompt + 2 refs, no image_url (pure reference mode).
  await tryQuote('2 refs, @ImageN prompt, NO image_url', {
    model: MODEL, prompt: tagPrompt, duration: '3s',
    aspect_ratio: '16:9', resolution: '720p', audio: true,
    reference_image_urls: [TINY_PNG, TINY_PNG],
  });

  // 2. Full 9-image budget.
  await tryQuote('9 refs (documented HappyHorse 1.1 cap)', {
    model: MODEL, prompt: tagPrompt, duration: '3s',
    aspect_ratio: '16:9', resolution: '720p', audio: true,
    reference_image_urls: Array(9).fill(TINY_PNG),
  });

  // 3. 10 refs — should 400 if the cap is really 9.
  await tryQuote('10 refs (expect FAIL if cap is 9)', {
    model: MODEL, prompt: tagPrompt, duration: '3s',
    aspect_ratio: '16:9', resolution: '720p', audio: true,
    reference_image_urls: Array(10).fill(TINY_PNG),
  });

  // 4. reference_audio_urls alongside refs (voice-donor lane).
  const TINY_MP3 = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAABAAADQgD///////////////////////////8AAAA5TEFNRTMuMTAwAc0AAAAAAAAAABSAJAJAQgAAgAAAA0LSwpZbAAAAAAAAAAAAAAAAAAAA';
  await tryQuote('refs + reference_audio_urls (voice donor lane)', {
    model: MODEL, prompt: tagPrompt + ' @Audio1 is Bob\'s voice.', duration: '3s',
    aspect_ratio: '16:9', resolution: '720p', audio: true,
    reference_image_urls: [TINY_PNG, TINY_PNG],
    reference_audio_urls: [TINY_MP3],
  });

  if (!render) {
    console.log('\nStage 1 complete. Re-run with --render for the paid semantic check (3s clip).');
    return;
  }

  // Stage 2: real render with real character refs if available.
  console.log('\nStage 2: queueing a real 3s render (paid)…');
  const refDirCandidates = [
    process.env.HH_PROBE_REF_A,
    process.env.HH_PROBE_REF_B,
  ].filter(Boolean) as string[];
  const toDataUri = (p: string) =>
    `data:image/png;base64,${readFileSync(p).toString('base64')}`;
  const refs = refDirCandidates.length >= 2 && refDirCandidates.every(p => existsSync(p))
    ? refDirCandidates.map(toDataUri)
    : [TINY_PNG, TINY_PNG];
  if (refs[0] === TINY_PNG) {
    console.log('  (set HH_PROBE_REF_A / HH_PROBE_REF_B to real character PNGs for a meaningful check)');
  }

  // NOTE: HappyHorse 1.1 is audioConfigurable:false — sending `audio` at all
  // (even `audio: true` at quote time is tolerated, but `audio: false` 400s
  // on queue). Omit the field entirely.
  const body = {
    model: MODEL,
    prompt: '@Image1 is a man. @Image2 is a woman. @Image1 waves at @Image2. Static shot. No background music.',
    duration: '3s', aspect_ratio: '16:9', resolution: '720p',
    reference_image_urls: refs,
  };
  const { queue_id, model } = await client.post<{ queue_id: string; model: string }>(QUEUE_PATH, body);
  console.log(`  queued: ${queue_id}`);

  while (true) {
    await new Promise(r => setTimeout(r, 10_000));
    const res = await fetch(RETRIEVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, queue_id }),
    });
    if (res.headers.get('content-type')?.includes('video/mp4')) {
      const out = join('output', `probe-happyhorse-image-tags.mp4`);
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log(`  saved: ${out} — eyeball whether @Image1/@Image2 were honored.`);
      break;
    }
    const status = await res.json() as { status: string };
    process.stdout.write(`\r  ${status.status}   `);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
