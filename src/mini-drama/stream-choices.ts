// ---------------------------------------------------------------------------
// Stream model choices: the writer (which model authors each beat) and the
// video family (which t2v/i2v pair renders it). Both are selectable at start
// and switchable at runtime from the Stream tab; a change applies to the NEXT
// beat, never to the one in flight.
//
// Speed matters more here than anywhere else in the harness: a stream is a
// live broadcast whose producer must keep up with the viewer. The wall time of
// one beat is writer latency + render latency, and the render is fixed by the
// video model. So the writer must be fast, and the video family must be
// chosen knowing that anything slower than Turbo will fall behind playback.
//
// Writer numbers come from scripts/bakeoff-stream-writer.ts against a real
// project (drop-the-beat, beat ~28), 3-6 rounds each, thinking disabled where
// the model allows it, 2026-09-05. Video prices are POST /video/quote for a
// 15s render at the family's draft resolution on the same day.
// ---------------------------------------------------------------------------

export interface StreamWriterChoice {
  id: string;
  label: string;
  /** Median seconds to write one beat in the bakeoff. */
  medianSec: number;
  /** Valid-JSON beats out of rounds attempted. */
  reliability: string;
  privacy: 'private' | 'anonymized';
  /** Send venice_parameters.disable_thinking. False for thinking-only models. */
  disableThinking: boolean;
  note: string;
}

export const STREAM_WRITER_CHOICES: ReadonlyArray<StreamWriterChoice> = [
  {
    id: 'deepseek-v4-flash-0731-fast', label: 'DeepSeek V4 Flash 0731 Fast', medianSec: 3.8, reliability: '9/9', privacy: 'private', disableThinking: true,
    note: 'Fastest reliable writer. Sharp sitcom beats, follows the camera rule. $0.35/$0.70 per M tokens.',
  },
  {
    id: 'mistral-small-2603', label: 'Mistral Small 2603', medianSec: 5.2, reliability: '9/9', privacy: 'private', disableThinking: true,
    note: 'Nearly as fast. Warmer, more physical comedy; occasionally writes the robot\'s display name into `characters` (normalized). $0.19/$0.75.',
  },
  {
    id: 'seed-2-1-turbo', label: 'Seed 2.1 Turbo', medianSec: 9.2, reliability: '9/9', privacy: 'anonymized', disableThinking: true,
    note: 'Reliable, mid speed. Anonymized tier. $0.63/$3.13.',
  },
  {
    id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', medianSec: 11.0, reliability: '6/6', privacy: 'private', disableThinking: true,
    note: 'Same family as the fast variant, about 3x slower per beat. Cheapest. $0.14/$0.28.',
  },
  {
    id: 'kimi-k3', label: 'Kimi K3', medianSec: 9.8, reliability: '8/9', privacy: 'private', disableThinking: true,
    note: 'The harness intelligence default. Strong writer, but slow (35s with thinking on) and drops one beat in nine without it. $3.75/$18.75.',
  },
  {
    id: 'minimax-m27', label: 'MiniMax M2.7', medianSec: 10.1, reliability: '5/6', privacy: 'private', disableThinking: false,
    note: 'Steady at ~10s with thinking on; worse without it. $0.38/$1.50.',
  },
  {
    id: 'gemini-3-8-flash', label: 'Gemini 3.8 Flash', medianSec: 19.1, reliability: '4/6', privacy: 'anonymized', disableThinking: false,
    note: 'Good prose, slow, and the thinking-off mode breaks its JSON. Anonymized. $0.94/$4.69.',
  },
];

export const STREAM_DEFAULT_WRITER = 'deepseek-v4-flash-0731-fast';

/** Not offered: thinking-only or unreliable in the bakeoff. Kept for the record. */
export const STREAM_WRITER_REJECTED: ReadonlyArray<{ id: string; why: string }> = [
  { id: 'z-ai-glm-5-3', why: 'Thinking-only (400 on disable_thinking); 0/3 valid beats with thinking on — spent the whole budget reasoning.' },
  { id: 'z-ai-glm-5-3-flash', why: '2/3 with thinking (21s median); 0/3 without — answers with prose, not JSON.' },
  { id: 'grok-4-6', why: 'Valid but 67s median. Too slow for a stream.' },
  { id: 'qwen3-6-35b-a3b', why: 'Fast (2s) but truncates the JSON 1 in 3.' },
  { id: 'qwen3-235b-a22b-instruct-2507', why: 'Valid but 39s median.' },
  { id: 'kimi-k3-fast', why: 'HTTP 500 "Inference processing failed" on every call.' },
];

export function getStreamWriterChoice(id: string): StreamWriterChoice | undefined {
  return STREAM_WRITER_CHOICES.find(c => c.id === id);
}

/** Whether to send disable_thinking for a writer. Unknown ids default to true. */
export function writerDisablesThinking(id: string): boolean {
  return getStreamWriterChoice(id)?.disableThinking ?? true;
}

// ---- Video families -------------------------------------------------------

export interface StreamVideoChoice {
  /** Family key used on the wire and in the manifest. */
  id: string;
  label: string;
  t2v: string;
  i2v: string;
  /** Resolution the stream pins for this family (draft tier). */
  resolution: string;
  /** Resolutions the operator may choose for this family. */
  resolutions: string[];
  /** USD for a 15s render at `resolution` (POST /video/quote, 2026-09-05). */
  usdPer15s: number;
  /** Rough wall seconds to render a 15s beat, observed or vendor-typical. */
  renderSecApprox: number;
  /** Plain-language speed verdict for the dropdown. */
  speed: 'keeps up' | 'falls behind' | 'much slower';
  note: string;
}

export const STREAM_VIDEO_CHOICES: ReadonlyArray<StreamVideoChoice> = [
  {
    id: 'minimax-h3-max-turbo', label: 'MiniMax H3 Max Turbo (default)',
    t2v: 'minimax-h3-max-turbo-text-to-video', i2v: 'minimax-h3-max-turbo-image-to-video',
    resolution: '480P', resolutions: ['480P', '768P'], usdPer15s: 0.11, renderSecApprox: 30, speed: 'keeps up',
    note: 'Fastest and cheapest lane. ~30s per 15s beat; with a fast writer the stream nearly keeps pace with playback. Native audio. i2v dies on a face-filled start frame (the engine soft-resets).',
  },
  {
    id: 'minimax-h3-max', label: 'MiniMax H3 Max',
    t2v: 'minimax-h3-max-text-to-video', i2v: 'minimax-h3-max-image-to-video',
    resolution: '768P', resolutions: ['480P', '768P'], usdPer15s: 0.22, renderSecApprox: 60, speed: 'falls behind',
    note: 'Higher fidelity, about 2x the Turbo render time and price. Same face-start-frame limit.',
  },
  {
    id: 'wan-3-0', label: 'Wan 3.0',
    t2v: 'wan-3-0-text-to-video', i2v: 'wan-3-0-image-to-video',
    resolution: '480p', resolutions: ['480p', '720p', '1080p'], usdPer15s: 0.68, renderSecApprox: 120, speed: 'much slower',
    note: 'Accepts face start frames. ~2 min per beat and 6x the Turbo price. Audio.',
  },
  {
    id: 'grok-imagine', label: 'Grok Imagine',
    t2v: 'grok-imagine-text-to-video', i2v: 'grok-imagine-image-to-video',
    resolution: '480p', resolutions: ['480p', '720p'], usdPer15s: 0.95, renderSecApprox: 90, speed: 'much slower',
    note: 'Accepts face start frames. ~1.5 min per beat, 9x the Turbo price.',
  },
  {
    id: 'seedance-2-0', label: 'Seedance 2.0',
    t2v: 'seedance-2-0-text-to-video', i2v: 'seedance-2-0-image-to-video',
    resolution: '480p', resolutions: ['480p', '720p'], usdPer15s: 1.32, renderSecApprox: 180, speed: 'much slower',
    note: 'The harness production default look, native dialogue and lip-sync. ~3 min per beat and 12x the Turbo price. The viewer will wait between every beat.',
  },
  {
    id: 'seedance-2-5', label: 'Seedance 2.5',
    t2v: 'seedance-2-5-text-to-video', i2v: 'seedance-2-5-image-to-video',
    resolution: '480p', resolutions: ['480p', '720p'], usdPer15s: 1.93, renderSecApprox: 180, speed: 'much slower',
    note: 'Newest Seedance. ~3 min per beat and 17x the Turbo price.',
  },
  {
    id: 'kling-o3-standard', label: 'Kling O3 Standard',
    t2v: 'kling-o3-standard-text-to-video', i2v: 'kling-o3-standard-image-to-video',
    resolution: '', resolutions: [], usdPer15s: 1.84, renderSecApprox: 150, speed: 'much slower',
    note: 'Accepts face start frames. ~2.5 min per beat, 16x the Turbo price. No resolution parameter.',
  },
];

export const STREAM_DEFAULT_VIDEO_FAMILY = 'minimax-h3-max-turbo';

export function getStreamVideoChoice(id: string): StreamVideoChoice | undefined {
  return STREAM_VIDEO_CHOICES.find(c => c.id === id);
}

/** Resolve a family key OR a raw model id (either lane) to its family. */
export function resolveStreamVideoFamily(idOrModel: string | undefined): StreamVideoChoice {
  if (!idOrModel) return getStreamVideoChoice(STREAM_DEFAULT_VIDEO_FAMILY)!;
  const byId = getStreamVideoChoice(idOrModel);
  if (byId) return byId;
  const byModel = STREAM_VIDEO_CHOICES.find(c => c.t2v === idOrModel || c.i2v === idOrModel);
  if (byModel) return byModel;
  throw new Error(`Unknown stream video family "${idOrModel}". Choices: ${STREAM_VIDEO_CHOICES.map(c => c.id).join(', ')}.`);
}
