// ---------------------------------------------------------------------------
// Venice Audio API -- TTS, music, sound effects, queued audio generation
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { VeniceClient } from './client.js';
import { clearPendingJob, findPendingJob, recordPendingJob, touchPendingJob } from './job-store.js';
import { abortableSleep, reportProgress, throwIfAborted } from './operation-context.js';
import { getMusicModel } from './models.js';

const execFileAsync = promisify(execFile);

// ---- Default Models -------------------------------------------------------

export const DEFAULT_VENICE_TTS_MODEL = 'tts-kokoro';
export const DEFAULT_VENICE_MUSIC_MODEL = 'elevenlabs-music';
export const DEFAULT_VENICE_SFX_MODEL = 'elevenlabs-sound-effects-v2';
/** BytePlus Seed Audio 1.0 — expressive prompt-driven speech/audio via the audio queue. */
export const DEFAULT_VENICE_SEED_AUDIO_MODEL = 'seed-audio-1-0';

/**
 * @deprecated Use DEFAULT_VENICE_MUSIC_MODEL or DEFAULT_VENICE_SFX_MODEL.
 * Kept for backward compatibility with existing scripts.
 */
export const DEFAULT_VENICE_AUDIO_MODEL = 'stable-audio-25';

// ---- TTS ------------------------------------------------------------------

export interface TTSOptions {
  voiceId: string;
  text: string;
  modelId?: string;
  /** Qwen3 TTS style prompt (e.g. "Very happy.", "Sad and slow.") */
  prompt?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'wav' | 'flac' | 'aac' | 'opus' | 'pcm';
  streaming?: boolean;
  /** Qwen3 TTS only */
  language?: string;
  /** Qwen3 TTS only: sampling temperature (0-2) */
  temperature?: number;
  /** Qwen3 TTS only: nucleus sampling (0-1) */
  top_p?: number;
}

export interface DialogueLine {
  shotNumber: number;
  character: string;
  voiceId: string;
  text: string;
  voicePrompt?: string;
}

export async function generateSpeech(
  client: VeniceClient,
  options: TTSOptions,
  outputPath: string,
): Promise<string> {
  const {
    voiceId,
    text,
    modelId = DEFAULT_VENICE_TTS_MODEL,
    prompt,
    speed = 1,
    responseFormat = 'mp3',
    streaming = false,
    language,
    temperature,
    top_p,
  } = options;

  const body: Record<string, unknown> = {
    input: text,
    model: modelId,
    voice: voiceId,
    response_format: responseFormat,
    speed,
    streaming,
  };

  if (prompt && (modelId.startsWith('tts-qwen3') || modelId.startsWith('elevenlabs'))) {
    body.prompt = prompt;
  }
  if (language && modelId.startsWith('tts-qwen3')) {
    body.language = language;
  }
  if (temperature !== undefined && modelId.startsWith('tts-qwen3')) {
    body.temperature = temperature;
  }
  if (top_p !== undefined && modelId.startsWith('tts-qwen3')) {
    body.top_p = top_p;
  }

  const audioBuffer = await client.postBinary('/api/v1/audio/speech', body);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, audioBuffer);
  return outputPath;
}

export async function generateDialogueForShots(
  client: VeniceClient,
  lines: DialogueLine[],
  outputDir: string,
): Promise<{ shotNumber: number; character: string; text: string; path: string }[]> {
  await mkdir(outputDir, { recursive: true });
  const results: { shotNumber: number; character: string; text: string; path: string }[] = [];

  for (const line of lines) {
    const shotNum = String(line.shotNumber).padStart(3, '0');
    const filename = `dialogue-shot-${shotNum}.mp3`;
    const outputPath = `${outputDir}/${filename}`;

    await generateSpeech(
      client,
      {
        voiceId: line.voiceId,
        text: line.text,
        prompt: line.voicePrompt,
      },
      outputPath,
    );

    results.push({
      shotNumber: line.shotNumber,
      character: line.character,
      text: line.text,
      path: outputPath,
    });

    console.log(`  TTS [${line.character}] shot ${shotNum}: "${line.text.slice(0, 40)}..." -> ${filename}`);
  }

  return results;
}

// ---- Sound Effects --------------------------------------------------------

export interface SFXOptions {
  text: string;
  durationSeconds?: number;
  modelId?: string;
}

export async function generateSoundEffect(
  client: VeniceClient,
  options: SFXOptions,
  outputPath: string,
): Promise<string> {
  const {
    text,
    durationSeconds = 5,
    modelId = DEFAULT_VENICE_SFX_MODEL,
  } = options;

  return generateQueuedAudio(client, {
    prompt: text,
    modelId,
    durationSeconds: clamp(durationSeconds, 1, 190),
  }, outputPath);
}

// ---- Music ----------------------------------------------------------------

export interface MusicOptions {
  prompt: string;
  durationSeconds?: number;
  modelId?: string;
  lyricsPrompt?: string;
  forceInstrumental?: boolean;
  voice?: string;
  /** Playback speed for speed-enabled models (e.g. seed-audio-1-0: 0.5–2). */
  speed?: number;
  /** ISO 639-1 language code for models with supports_language_code. */
  languageCode?: string;
}

export async function generateMusic(
  client: VeniceClient,
  options: MusicOptions,
  outputPath: string,
): Promise<string> {
  const {
    prompt,
    durationSeconds = 60,
    modelId = DEFAULT_VENICE_MUSIC_MODEL,
    lyricsPrompt,
    forceInstrumental,
    voice,
    speed,
    languageCode,
  } = options;

  return generateQueuedAudio(client, {
    prompt,
    modelId,
    durationSeconds: clamp(durationSeconds, 1, 190),
    lyricsPrompt,
    forceInstrumental,
    voice,
    speed,
    languageCode,
  }, outputPath);
}

// ---- Seed Audio 1.0 -------------------------------------------------------
//
// Seed Audio 1.0 is a `music`-type model that produces expressive speech (and
// general audio) from a text prompt — think premium, prompt-directed narration
// with named voices and a 2048-char script, delivered through the async audio
// queue rather than the synchronous /audio/speech TTS endpoint.

export interface SeedAudioOptions {
  /** The text/script to speak, or an audio description. Up to 2048 chars. */
  prompt: string;
  /** A voice from the model's roster, or "Describe in prompt" to steer via text. */
  voice?: string;
  /** Playback speed, 0.5–2 (default 1). */
  speed?: number;
  /** Generation length in seconds (default 120). */
  durationSeconds?: number;
  /** Override the model id (defaults to seed-audio-1-0). */
  modelId?: string;
}

export async function generateSeedAudio(
  client: VeniceClient,
  options: SeedAudioOptions,
  outputPath: string,
): Promise<string> {
  const modelId = options.modelId ?? DEFAULT_VENICE_SEED_AUDIO_MODEL;
  const spec = getMusicModel(modelId);

  const prompt = options.prompt?.trim() ?? '';
  const minLen = spec?.minPromptLength ?? 1;
  const maxLen = spec?.promptCharacterLimit ?? 2048;
  if (prompt.length < minLen) {
    throw new Error(`${modelId}: prompt is required (min ${minLen} char).`);
  }
  if (prompt.length > maxLen) {
    throw new Error(
      `${modelId}: prompt is ${prompt.length} chars, exceeds the ${maxLen}-char limit. ` +
        `Split into multiple calls and concatenate the audio.`,
    );
  }

  // Only send a voice the model actually offers; otherwise let the model use
  // its default ("Describe in prompt" for seed-audio) so voice steering can
  // live in the prompt text.
  let voice = options.voice;
  if (voice && spec?.voices && !spec.voices.includes(voice)) {
    throw new Error(
      `${modelId}: unknown voice "${voice}". Valid voices: ${spec.voices.join(', ')}.`,
    );
  }
  if (!voice && spec?.defaultVoice) voice = spec.defaultVoice;

  let speed = options.speed;
  if (speed !== undefined && spec?.supportsSpeed) {
    speed = clamp(speed, spec.minSpeed ?? 0.5, spec.maxSpeed ?? 2);
  } else if (speed !== undefined && spec && !spec.supportsSpeed) {
    speed = undefined; // model ignores speed; drop it to keep the request clean
  }

  const durationSeconds = options.durationSeconds ?? spec?.defaultDurationSec ?? 120;

  return generateQueuedAudio(client, {
    prompt,
    modelId,
    durationSeconds,
    voice,
    speed,
  }, outputPath);
}

// ---- Queued Audio (generic) -----------------------------------------------

interface QueuedAudioOptions {
  prompt: string;
  modelId?: string;
  durationSeconds?: number;
  forceInstrumental?: boolean;
  voice?: string;
  languageCode?: string;
  speed?: number;
  lyricsPrompt?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

interface AudioQueueResponse {
  model: string;
  queue_id: string;
  status: 'QUEUED';
}

interface AudioRetrieveStatus {
  status: 'PROCESSING';
  average_execution_time: number;
  execution_duration: number;
}

export async function generateQueuedAudio(
  client: VeniceClient,
  options: QueuedAudioOptions,
  outputPath: string,
): Promise<string> {
  const {
    prompt,
    modelId = DEFAULT_VENICE_MUSIC_MODEL,
    durationSeconds,
    forceInstrumental,
    voice,
    languageCode,
    speed,
    lyricsPrompt,
    pollIntervalMs = 5_000,
    maxPollAttempts = 120,
  } = options;

  const queueBody: Record<string, unknown> = {
    model: modelId,
    prompt,
  };

  if (durationSeconds !== undefined) {
    queueBody.duration_seconds = durationSeconds;
  }
  if (forceInstrumental !== undefined) {
    queueBody.force_instrumental = forceInstrumental;
  }
  if (voice) {
    queueBody.voice = voice;
  }
  if (languageCode) {
    queueBody.language_code = languageCode;
  }
  if (speed !== undefined) {
    queueBody.speed = speed;
  }
  if (lyricsPrompt) {
    queueBody.lyrics_prompt = lyricsPrompt;
  }

  // Persist the queue id before the first poll so an interrupted generation can
  // be re-attached instead of paid for twice (see venice/job-store.ts).
  const jobKey = resolvePath(outputPath);
  const existing = await findPendingJob(jobKey);
  let queued: AudioQueueResponse;
  if (existing && existing.kind === 'audio') {
    console.log(`  Re-attaching to in-flight audio job ${existing.queueId} (${existing.model}) — not re-queueing.`);
    queued = { model: existing.model, queue_id: existing.queueId, status: 'QUEUED' };
  } else {
    queued = await client.post<AudioQueueResponse>('/api/v1/audio/queue', queueBody);
    await recordPendingJob({
      kind: 'audio',
      model: queued.model,
      queueId: queued.queue_id,
      outputPath: jobKey,
      prompt,
    });
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    throwIfAborted();
    if (attempt > 0) {
      await abortableSleep(pollIntervalMs);
    }

    const response = await client.postBinaryOrJson<AudioRetrieveStatus>(
      '/api/v1/audio/retrieve',
      {
        model: queued.model,
        queue_id: queued.queue_id,
        delete_media_on_completion: false,
      },
    );

    if (Buffer.isBuffer(response.value)) {
      await writeAudioBuffer(response.value, response.contentType, outputPath);
      await clearPendingJob(jobKey);

      await client.post('/api/v1/audio/complete', {
        model: queued.model,
        queue_id: queued.queue_id,
      });

      return outputPath;
    }

    const status = response.value as AudioRetrieveStatus;
    await touchPendingJob(jobKey);
    if (status.status === 'PROCESSING') {
      reportProgress({
        phase: 'poll',
        detail: `audio ${Math.round(status.execution_duration / 1000)}s / ~${Math.round(status.average_execution_time / 1000)}s`,
      });
      console.log(
        `  Audio still processing (${Math.round(status.execution_duration / 1000)}s / ~${Math.round(status.average_execution_time / 1000)}s)`,
      );
    }
  }

  throw new Error(`Timed out waiting for Venice audio generation: ${queued.model} (${queued.queue_id})`);
}

// ---- Internals ------------------------------------------------------------

async function writeAudioBuffer(
  buffer: Buffer,
  contentType: string,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const inputExt = extensionFromContentType(contentType);
  const outputExt = extname(outputPath).toLowerCase();

  if (!inputExt || inputExt === outputExt) {
    await writeFile(outputPath, buffer);
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'venice-audio-'));
  const tempInput = join(tempDir, `source${inputExt}`);

  try {
    await writeFile(tempInput, buffer);
    const ffmpegArgs = ffmpegTranscodeArgs(tempInput, outputPath, outputExt);
    await execFileAsync('ffmpeg', ffmpegArgs);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extensionFromContentType(contentType: string): string | null {
  if (contentType.includes('audio/mpeg')) return '.mp3';
  if (contentType.includes('audio/wav')) return '.wav';
  if (contentType.includes('audio/flac')) return '.flac';
  if (contentType.includes('audio/aac')) return '.aac';
  if (contentType.includes('audio/opus')) return '.opus';
  if (contentType.includes('audio/pcm')) return '.pcm';
  return null;
}

function ffmpegTranscodeArgs(inputPath: string, outputPath: string, outputExt: string): string[] {
  switch (outputExt) {
    case '.mp3':
      return ['-y', '-i', inputPath, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outputPath];
    case '.wav':
      return ['-y', '-i', inputPath, '-vn', '-codec:a', 'pcm_s16le', outputPath];
    case '.flac':
      return ['-y', '-i', inputPath, '-vn', '-codec:a', 'flac', outputPath];
    case '.aac':
      return ['-y', '-i', inputPath, '-vn', '-codec:a', 'aac', outputPath];
    default:
      return ['-y', '-i', inputPath, outputPath];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
