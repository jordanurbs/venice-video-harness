import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { VeniceClient } from './client.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_VENICE_TTS_MODEL = 'tts-kokoro';
export const DEFAULT_VENICE_AUDIO_MODEL = 'stable-audio-25';

export interface TTSOptions {
  voiceId: string;
  text: string;
  modelId?: string;
  prompt?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'wav' | 'flac';
}

export interface DialogueLine {
  shotNumber: number;
  character: string;
  voiceId: string;
  text: string;
  voicePrompt?: string;
}

export interface SFXOptions {
  text: string;
  durationSeconds?: number;
  modelId?: string;
}

export interface MusicOptions {
  prompt: string;
  durationSeconds?: number;
  modelId?: string;
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

interface QueuedAudioOptions {
  prompt: string;
  modelId?: string;
  durationSeconds?: number;
  forceInstrumental?: boolean;
  voice?: string;
  languageCode?: string;
  speed?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
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
  } = options;

  const body: Record<string, unknown> = {
    input: text,
    model: modelId,
    voice: voiceId,
    response_format: responseFormat,
    speed,
  };

  if (prompt && modelId.startsWith('tts-qwen3')) {
    body.prompt = prompt;
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

export async function generateSoundEffect(
  client: VeniceClient,
  options: SFXOptions,
  outputPath: string,
): Promise<string> {
  const {
    text,
    durationSeconds = 5,
    modelId = DEFAULT_VENICE_AUDIO_MODEL,
  } = options;

  return generateQueuedAudio(client, {
    prompt: text,
    modelId,
    durationSeconds: clamp(durationSeconds, 5, 190),
  }, outputPath);
}

export async function generateMusic(
  client: VeniceClient,
  options: MusicOptions,
  outputPath: string,
): Promise<string> {
  const {
    prompt,
    durationSeconds = 60,
    modelId = DEFAULT_VENICE_AUDIO_MODEL,
  } = options;

  return generateQueuedAudio(client, {
    prompt,
    modelId,
    durationSeconds: clamp(durationSeconds, 5, 190),
  }, outputPath);
}

export async function generateQueuedAudio(
  client: VeniceClient,
  options: QueuedAudioOptions,
  outputPath: string,
): Promise<string> {
  const {
    prompt,
    modelId = DEFAULT_VENICE_AUDIO_MODEL,
    durationSeconds,
    forceInstrumental,
    voice,
    languageCode,
    speed,
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

  const queued = await client.post<AudioQueueResponse>('/api/v1/audio/queue', queueBody);

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(pollIntervalMs);
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

      await client.post('/api/v1/audio/complete', {
        model: queued.model,
        queue_id: queued.queue_id,
      });

      return outputPath;
    }

    const status = response.value as AudioRetrieveStatus;
    if (status.status === 'PROCESSING') {
      console.log(
        `  Audio still processing (${Math.round(status.execution_duration / 1000)}s / ~${Math.round(status.average_execution_time / 1000)}s)`,
      );
    }
  }

  throw new Error(`Timed out waiting for Venice audio generation: ${queued.model} (${queued.queue_id})`);
}

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
