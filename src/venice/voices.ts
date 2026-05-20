// ---------------------------------------------------------------------------
// Venice TTS Voice Catalog
//
// Covers Kokoro voices (tts-kokoro) and Qwen3 voices (tts-qwen3-0-6b,
// tts-qwen3-1-7b). Voice IDs are model-specific -- using an incompatible
// voice returns a 400 error.
// ---------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { VeniceClient } from './client.js';
import { generateSpeech, DEFAULT_VENICE_TTS_MODEL } from './audio.js';

export interface VoiceInfo {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string | null;
  description: string | null;
}

export type TTSModel = 'tts-kokoro' | 'tts-qwen3-0-6b' | 'tts-qwen3-1-7b';

const KOKORO_VOICES: VoiceInfo[] = buildKokoroVoices();
const QWEN3_VOICES: VoiceInfo[] = buildQwen3Voices();
const ALL_VOICES: VoiceInfo[] = [...KOKORO_VOICES, ...QWEN3_VOICES];

export async function listVoices(model?: TTSModel): Promise<VoiceInfo[]> {
  if (model === 'tts-kokoro') return KOKORO_VOICES;
  if (model?.startsWith('tts-qwen3')) return QWEN3_VOICES;
  return ALL_VOICES;
}

/**
 * Filter voices by gender, age, and language.
 *
 * Language matching is intentionally fuzzy so callers can ask for "british",
 * "uk", "en-gb", or "british english" and reach `bm_george` / `bf_alice`
 * et al. — the previous strict-equality match required callers to know the
 * exact catalog string ("British English"), which made the audition-voices
 * CLI miss every British voice in the PNW field-guide production.
 *
 * Match rules (case-insensitive):
 *   - language alias like 'british' / 'uk' / 'en-gb' / 'british english'
 *     matches catalog 'British English' AND any voice_id starting with
 *     'bm_' / 'bf_' (Kokoro British male/female prefixes).
 *   - 'american' / 'us' / 'en-us' / 'american english' matches catalog
 *     'American English' AND 'am_' / 'af_'.
 *   - 'english' / 'en' (with no region) matches any English variant
 *     (American + British) so generic queries still work.
 *   - Any other value falls back to a substring match against
 *     labels.language and labels.accent. Pass undefined to use the
 *     legacy default ('English' family).
 */
export function filterVoices(
  voices: VoiceInfo[],
  gender?: string,
  age?: string,
  language?: string,
): VoiceInfo[] {
  return voices.filter(v => {
    const labels = v.labels ?? {};
    if (gender && labels.gender && labels.gender.toLowerCase() !== gender.toLowerCase()) {
      return false;
    }
    if (age && labels.age && labels.age.toLowerCase() !== age.toLowerCase()) {
      return false;
    }
    return matchesLanguage(v, language);
  });
}

function matchesLanguage(v: VoiceInfo, language?: string): boolean {
  const labels = v.labels ?? {};
  const labelLang = (labels.language ?? '').toLowerCase();
  const labelAccent = ((labels as { accent?: string }).accent ?? '').toLowerCase();
  const id = v.voice_id.toLowerCase();
  if (!language) return labelLang.includes('english');
  const q = language.trim().toLowerCase();
  const britishAliases = ['british', 'british english', 'uk', 'en-gb', 'engb', 'gb'];
  const americanAliases = ['american', 'american english', 'us', 'en-us', 'enus'];
  const genericEnglishAliases = ['english', 'en'];
  if (britishAliases.includes(q)) {
    return labelLang.includes('british')
      || labelAccent === 'british'
      || id.startsWith('bm_')
      || id.startsWith('bf_');
  }
  if (americanAliases.includes(q)) {
    return labelLang.includes('american')
      || labelAccent === 'american'
      || id.startsWith('am_')
      || id.startsWith('af_');
  }
  if (genericEnglishAliases.includes(q)) {
    return labelLang.includes('english');
  }
  // Fallback: substring match against language label, accent, and id.
  return labelLang.includes(q) || labelAccent.includes(q) || id.includes(q);
}

export async function generateVoiceSample(
  client: VeniceClient,
  voiceId: string,
  sampleText: string,
  outputPath: string,
  modelId?: string,
): Promise<string> {
  return generateSpeech(
    client,
    {
      voiceId,
      text: sampleText,
      modelId: modelId ?? DEFAULT_VENICE_TTS_MODEL,
    },
    outputPath,
  );
}

export async function auditionVoices(
  client: VeniceClient,
  candidateVoices: VoiceInfo[],
  sampleText: string,
  outputDir: string,
  modelId?: string,
): Promise<{ voiceId: string; voiceName: string; samplePath: string }[]> {
  await mkdir(outputDir, { recursive: true });

  const results: { voiceId: string; voiceName: string; samplePath: string }[] = [];

  for (const voice of candidateVoices) {
    const safeName = voice.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const samplePath = join(outputDir, `${safeName}-${voice.voice_id.slice(0, 8)}.mp3`);

    try {
      await generateVoiceSample(client, voice.voice_id, sampleText, samplePath, modelId ?? voice.category);
      results.push({
        voiceId: voice.voice_id,
        voiceName: voice.name,
        samplePath,
      });
      console.log(`  Generated sample: ${voice.name} -> ${samplePath}`);
    } catch (err) {
      console.warn(`  Failed to generate sample for ${voice.name}: ${err}`);
    }
  }

  return results;
}

// ---- Kokoro voices --------------------------------------------------------

function buildKokoroVoices(): VoiceInfo[] {
  return [
    ...buildVoiceGroup('tts-kokoro', 'American English', 'female', [
      'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jadzia',
      'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river',
      'af_sarah', 'af_sky',
    ]),
    ...buildVoiceGroup('tts-kokoro', 'American English', 'male', [
      'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
      'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    ]),
    ...buildVoiceGroup('tts-kokoro', 'British English', 'female', ['bf_alice', 'bf_emma', 'bf_lily']),
    ...buildVoiceGroup('tts-kokoro', 'British English', 'male', ['bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis']),
    ...buildVoiceGroup('tts-kokoro', 'Spanish', 'female', ['ef_dora']),
    ...buildVoiceGroup('tts-kokoro', 'Spanish', 'male', ['em_alex', 'em_santa']),
    ...buildVoiceGroup('tts-kokoro', 'French', 'female', ['ff_siwis']),
    ...buildVoiceGroup('tts-kokoro', 'Hindi', 'female', ['hf_alpha', 'hf_beta']),
    ...buildVoiceGroup('tts-kokoro', 'Hindi', 'male', ['hm_omega', 'hm_psi']),
    ...buildVoiceGroup('tts-kokoro', 'Italian', 'female', ['if_sara']),
    ...buildVoiceGroup('tts-kokoro', 'Italian', 'male', ['im_nicola']),
    ...buildVoiceGroup('tts-kokoro', 'Japanese', 'female', ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro']),
    ...buildVoiceGroup('tts-kokoro', 'Japanese', 'male', ['jm_kumo']),
    ...buildVoiceGroup('tts-kokoro', 'Portuguese', 'female', ['pf_dora']),
    ...buildVoiceGroup('tts-kokoro', 'Portuguese', 'male', ['pm_alex', 'pm_santa']),
    ...buildVoiceGroup('tts-kokoro', 'Chinese', 'female', ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi']),
    ...buildVoiceGroup('tts-kokoro', 'Chinese', 'male', ['zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang']),
  ];
}

// ---- Qwen3 voices ---------------------------------------------------------

function buildQwen3Voices(): VoiceInfo[] {
  return [
    { voice_id: 'Vivian', name: 'Vivian', category: 'tts-qwen3-1-7b',
      labels: { gender: 'female', age: 'adult', language: 'English' },
      preview_url: null, description: 'Female English voice for Qwen3 TTS (supports style prompts)' },
    { voice_id: 'Serena', name: 'Serena', category: 'tts-qwen3-1-7b',
      labels: { gender: 'female', age: 'adult', language: 'English' },
      preview_url: null, description: 'Female English voice for Qwen3 TTS (supports style prompts)' },
    { voice_id: 'Ono_Anna', name: 'Ono Anna', category: 'tts-qwen3-1-7b',
      labels: { gender: 'female', age: 'adult', language: 'Japanese' },
      preview_url: null, description: 'Female Japanese voice for Qwen3 TTS' },
    { voice_id: 'Sohee', name: 'Sohee', category: 'tts-qwen3-1-7b',
      labels: { gender: 'female', age: 'adult', language: 'Korean' },
      preview_url: null, description: 'Female Korean voice for Qwen3 TTS' },
    { voice_id: 'Uncle_Fu', name: 'Uncle Fu', category: 'tts-qwen3-1-7b',
      labels: { gender: 'male', age: 'adult', language: 'Chinese' },
      preview_url: null, description: 'Male Chinese voice for Qwen3 TTS' },
    { voice_id: 'Dylan', name: 'Dylan', category: 'tts-qwen3-1-7b',
      labels: { gender: 'male', age: 'adult', language: 'English' },
      preview_url: null, description: 'Male English voice for Qwen3 TTS (supports style prompts)' },
    { voice_id: 'Eric', name: 'Eric', category: 'tts-qwen3-1-7b',
      labels: { gender: 'male', age: 'adult', language: 'English' },
      preview_url: null, description: 'Male English voice for Qwen3 TTS (supports style prompts)' },
    { voice_id: 'Ryan', name: 'Ryan', category: 'tts-qwen3-1-7b',
      labels: { gender: 'male', age: 'adult', language: 'English' },
      preview_url: null, description: 'Male English voice for Qwen3 TTS (supports style prompts)' },
    { voice_id: 'Aiden', name: 'Aiden', category: 'tts-qwen3-1-7b',
      labels: { gender: 'male', age: 'adult', language: 'English' },
      preview_url: null, description: 'Male English voice for Qwen3 TTS (supports style prompts)' },
  ];
}

// ---- Helpers --------------------------------------------------------------

function buildVoiceGroup(model: string, language: string, gender: string, ids: string[]): VoiceInfo[] {
  return ids.map((voiceId) => ({
    voice_id: voiceId,
    name: titleCase(voiceId.split('_')[1] ?? voiceId),
    category: model,
    labels: {
      gender,
      age: 'adult',
      language,
    },
    preview_url: null,
    description: `${gender} ${language} voice in Venice ${model}`,
  }));
}

function titleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
