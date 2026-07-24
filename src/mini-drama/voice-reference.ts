// ---------------------------------------------------------------------------
// Character Voice References
//
// A voice reference is a short (2-15s) voice-donor clip attached to a video
// generation as a `reference_audio_urls` entry (bound in-prompt as @AudioN)
// so a character's voice — timbre, accent, pacing — stays consistent across
// shots on reference-audio-capable models (Seedance 2.0 R2V family,
// HappyHorse 1.1 R2V). See CLAUDE.md rule 40.
//
// Default source: seed-audio-1-0 (BytePlus Seed Audio 1.0), steered by the
// character's `voiceDescription`. Operators can override the spoken text, the
// named voice, the playback speed, or supply their own clip file.
//
// The clip is normalized into the Venice-accepted window (2-15s, mp3) and
// written to `characters/<slug>/voice-reference.mp3`. Prior versions are
// archived as `-v1`, `-v2`, … per the asset-safety rule (never destructive).
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import type { VeniceClient } from '../venice/client.js';
import type { Character, SeriesState } from '../series/types.js';
import { generateSeedAudio, DEFAULT_VENICE_SEED_AUDIO_MODEL } from '../venice/audio.js';
import { getCharacterDir } from '../series/manager.js';
import { appendRecipePass } from '../venice/recipe.js';

/** Venice `reference_audio_urls` per-clip bounds. */
export const VOICE_REF_MIN_SEC = 2;
export const VOICE_REF_MAX_SEC = 15;
/** Target length of an auto-generated voice-donor clip (well within 2-15s). */
export const VOICE_REF_TARGET_SEC = 10;

/**
 * A neutral sample utterance that runs ~10s so the donor clip carries enough
 * natural speech for the model to lock the voice. Combined with the
 * character's `voiceDescription` when steering seed-audio's "Describe in
 * prompt" voice.
 */
const DEFAULT_SAMPLE_TEXT =
  'Here is a short sample of how I speak, in my natural voice and rhythm. ' +
  'This clip is only meant to capture the sound of my voice for reference.';

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    throw new Error(`${command} failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function probeDurationSec(path: string): number {
  const out = runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]).trim();
  const sec = parseFloat(out);
  if (!Number.isFinite(sec)) throw new Error(`Could not parse ffprobe duration for ${path}`);
  return sec;
}

/** Absolute + series-relative path for a character's voice-reference clip. */
export function voiceReferencePathsFor(
  series: SeriesState,
  characterName: string,
): { absPath: string; relPath: string } {
  const dir = getCharacterDir(series, characterName);
  const absPath = join(dir, 'voice-reference.mp3');
  return { absPath, relPath: relative(series.outputDir, absPath) };
}

/** Resolve a stored `voiceReferencePath` (relative or absolute) to an absolute path. */
export function resolveVoiceReferenceAbsPath(
  series: SeriesState,
  character: Character,
): string | undefined {
  if (!character.voiceReferencePath) return undefined;
  return isAbsolute(character.voiceReferencePath)
    ? character.voiceReferencePath
    : resolve(series.outputDir, character.voiceReferencePath);
}

function archiveExisting(path: string): void {
  if (!existsSync(path)) return;
  let version = 1;
  let archive = path.replace(/\.mp3$/, `-v${version}.mp3`);
  while (existsSync(archive)) {
    version += 1;
    archive = path.replace(/\.mp3$/, `-v${version}.mp3`);
  }
  renameSync(path, archive);
  console.log(`  Archived previous voice reference: ${archive}`);
}

/**
 * Normalize a clip in place into the 2-15s window. Over-long clips are
 * trimmed to VOICE_REF_MAX_SEC; too-short clips are padded with trailing
 * silence up to VOICE_REF_MIN_SEC. Returns the final duration.
 */
function normalizeToWindow(path: string): number {
  const dur = probeDurationSec(path);
  if (dur >= VOICE_REF_MIN_SEC && dur <= VOICE_REF_MAX_SEC) return dur;

  const tmp = path.replace(/\.mp3$/, '-normtmp.mp3');
  if (dur > VOICE_REF_MAX_SEC) {
    runCommand('ffmpeg', ['-y', '-i', path, '-t', String(VOICE_REF_MAX_SEC),
      '-c:a', 'libmp3lame', '-q:a', '2', tmp]);
    renameSync(tmp, path);
    console.log(`  Trimmed voice reference ${dur.toFixed(2)}s -> ${VOICE_REF_MAX_SEC}s`);
    return VOICE_REF_MAX_SEC;
  }
  // dur < min: pad with trailing silence to the minimum.
  const padDur = (VOICE_REF_MIN_SEC - dur).toFixed(3);
  runCommand('ffmpeg', ['-y', '-i', path, '-af', `apad=pad_dur=${padDur}`,
    '-t', String(VOICE_REF_MIN_SEC), '-c:a', 'libmp3lame', '-q:a', '2', tmp]);
  renameSync(tmp, path);
  console.log(`  Padded voice reference ${dur.toFixed(2)}s -> ${VOICE_REF_MIN_SEC}s`);
  return VOICE_REF_MIN_SEC;
}

export interface GenerateVoiceReferenceOptions {
  /** Spoken text to render. Defaults to a neutral sample steered by voiceDescription. */
  text?: string;
  /** Named seed-audio voice (e.g. "Tim"). Defaults to "Describe in prompt" steering. */
  voice?: string;
  /** Playback speed 0.5-2 (default 1). */
  speed?: number;
  /** Path to an operator-supplied clip to use verbatim instead of generating. */
  file?: string;
  /** Override the seed-audio model id. */
  model?: string;
  /** Target seconds for the generated clip (default VOICE_REF_TARGET_SEC). */
  targetSec?: number;
}

/**
 * Build (or import) a voice-donor clip for a character, normalize it into the
 * 2-15s window, write it to `characters/<slug>/voice-reference.mp3` (archiving
 * any prior version), and return the absolute + series-relative paths plus the
 * model used. Does NOT mutate `character` or persist `character.json` — the
 * caller owns that (so both the CLI command and the inline auto-gen can decide
 * how to persist).
 */
export async function generateVoiceReference(
  client: VeniceClient,
  series: SeriesState,
  character: Character,
  options: GenerateVoiceReferenceOptions = {},
): Promise<{ absPath: string; relPath: string; model: string }> {
  const { absPath, relPath } = voiceReferencePathsFor(series, character.name);
  await mkdir(join(absPath, '..'), { recursive: true });

  archiveExisting(absPath);

  let model: string;
  if (options.file) {
    const src = resolve(options.file);
    if (!existsSync(src)) throw new Error(`--file voice reference not found: ${src}`);
    await copyFile(src, absPath);
    model = 'user-supplied';
    console.log(`  Imported voice reference from ${src}`);
  } else {
    const modelId = options.model ?? DEFAULT_VENICE_SEED_AUDIO_MODEL;
    model = modelId;
    const sampleText = options.text ?? DEFAULT_SAMPLE_TEXT;
    // When steering via "Describe in prompt", embed the voiceDescription so
    // seed-audio matches the character's timbre/accent. A named --voice
    // overrides the steering and the description is just flavor.
    const prompt = options.voice
      ? sampleText
      : `Speak in this voice: ${character.voiceDescription}. ${sampleText}`;
    console.log(`  Generating voice reference for ${character.name} via ${modelId}` +
      `${options.voice ? ` [voice: ${options.voice}]` : ' [voice: describe-in-prompt]'}`);
    await generateSeedAudio(client, {
      prompt,
      modelId,
      voice: options.voice,
      speed: options.speed,
      durationSeconds: options.targetSec ?? VOICE_REF_TARGET_SEC,
    }, absPath);
  }

  const finalDur = normalizeToWindow(absPath);

  await appendRecipePass(absPath, {
    kind: 'tts',
    role: 'identity',
    model,
    label: `voice reference (${character.name})`,
    prompt: options.file ? undefined : (options.text ?? `[describe] ${character.voiceDescription}`),
    duration: `${finalDur.toFixed(2)}s`,
    extra: {
      voice: options.voice ?? null,
      speed: options.speed ?? null,
      source: options.file ? 'user-supplied' : 'seed-audio',
    },
  });

  console.log(`  Voice reference saved: ${absPath} (${finalDur.toFixed(2)}s)`);
  return { absPath, relPath, model };
}
