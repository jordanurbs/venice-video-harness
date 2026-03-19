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

const KOKORO_VOICES: VoiceInfo[] = buildKokoroVoices();

export async function listVoices(): Promise<VoiceInfo[]> {
  return KOKORO_VOICES;
}

export function filterVoices(
  voices: VoiceInfo[],
  gender?: string,
  age?: string,
): VoiceInfo[] {
  return voices.filter(v => {
    const labels = v.labels ?? {};
    if (gender && labels.gender && labels.gender.toLowerCase() !== gender.toLowerCase()) {
      return false;
    }
    if (age && labels.age && labels.age.toLowerCase() !== age.toLowerCase()) {
      return false;
    }
    return labels.language === 'English';
  });
}

export async function generateVoiceSample(
  client: VeniceClient,
  voiceId: string,
  sampleText: string,
  outputPath: string,
): Promise<string> {
  return generateSpeech(
    client,
    {
      voiceId,
      text: sampleText,
      modelId: DEFAULT_VENICE_TTS_MODEL,
    },
    outputPath,
  );
}

export async function auditionVoices(
  client: VeniceClient,
  candidateVoices: VoiceInfo[],
  sampleText: string,
  outputDir: string,
): Promise<{ voiceId: string; voiceName: string; samplePath: string }[]> {
  await mkdir(outputDir, { recursive: true });

  const results: { voiceId: string; voiceName: string; samplePath: string }[] = [];

  for (const voice of candidateVoices) {
    const safeName = voice.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const samplePath = join(outputDir, `${safeName}-${voice.voice_id.slice(0, 8)}.mp3`);

    try {
      await generateVoiceSample(client, voice.voice_id, sampleText, samplePath);
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

function buildKokoroVoices(): VoiceInfo[] {
  return [
    ...buildVoiceGroup('American English', 'female', ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jadzia', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky']),
    ...buildVoiceGroup('American English', 'male', ['am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa']),
    ...buildVoiceGroup('British English', 'female', ['bf_alice', 'bf_emma', 'bf_lily']),
    ...buildVoiceGroup('British English', 'male', ['bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis']),
    ...buildVoiceGroup('Spanish', 'female', ['ef_dora']),
    ...buildVoiceGroup('Spanish', 'male', ['em_alex', 'em_santa']),
    ...buildVoiceGroup('French', 'female', ['ff_siwis']),
    ...buildVoiceGroup('Hindi', 'female', ['hf_alpha', 'hf_beta']),
    ...buildVoiceGroup('Hindi', 'male', ['hm_omega', 'hm_psi']),
    ...buildVoiceGroup('Italian', 'female', ['if_sara']),
    ...buildVoiceGroup('Italian', 'male', ['im_nicola']),
    ...buildVoiceGroup('Japanese', 'female', ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro']),
    ...buildVoiceGroup('Japanese', 'male', ['jm_kumo']),
    ...buildVoiceGroup('Portuguese', 'female', ['pf_dora']),
    ...buildVoiceGroup('Portuguese', 'male', ['pm_alex', 'pm_santa']),
    ...buildVoiceGroup('Chinese', 'female', ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi']),
    ...buildVoiceGroup('Chinese', 'male', ['zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang']),
  ];
}

function buildVoiceGroup(language: string, gender: string, ids: string[]): VoiceInfo[] {
  return ids.map((voiceId) => ({
    voice_id: voiceId,
    name: titleCase(voiceId.split('_')[1] ?? voiceId),
    category: DEFAULT_VENICE_TTS_MODEL,
    labels: {
      gender,
      age: 'adult',
      language,
    },
    preview_url: null,
    description: `${gender} ${language} voice in Venice Kokoro TTS`,
  }));
}

function titleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
