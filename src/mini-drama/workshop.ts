import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VeniceClient } from '../venice/client.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import type { Character, EpisodeScript, Location, SeriesState } from '../series/types.js';
import { addEpisode, saveEpisodeScript, saveSeries } from '../series/manager.js';
import { getProjectLanguage } from '../series/project-language.js';

export interface WorkshopInputs {
  objective: string;
  targetDuration: string;
  audience: string;
  mustInclude: string;
  avoid: string;
  references: string;
  delivery: 'standard' | '4k';
}

export interface WorkshopDraft {
  version: 1;
  status: 'draft' | 'approved';
  revision: number;
  generatedAt: string;
  projectName: string;
  projectType: string;
  inputs: WorkshopInputs;
  logline: string;
  synopsis: string;
  themes: string[];
  structure: Array<{ name: string; purpose: string; beats: string[] }>;
  aesthetic: AestheticProfile;
  characters: Character[];
  locations: Location[];
  script: EpisodeScript;
  productionNotes: {
    delivery?: 'standard' | '4k';
    audioApproach: string;
    continuityPriorities: string[];
    risks: string[];
    openQuestions: string[];
  };
  feedbackHistory: string[];
}

export function getWorkshopPath(series: Pick<SeriesState, 'outputDir'>): string {
  return join(series.outputDir, 'workshop.json');
}

export async function loadWorkshop(series: Pick<SeriesState, 'outputDir'>): Promise<WorkshopDraft | null> {
  const path = getWorkshopPath(series);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as WorkshopDraft;
}

function stableSeed(value: string): number {
  return Math.abs([...value].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)) % 999_999_999;
}

function normalizeDraft(raw: WorkshopDraft, series: SeriesState, inputs: WorkshopInputs, revision: number, feedback: string[]): WorkshopDraft {
  if (!raw || !raw.script || !Array.isArray(raw.script.shots) || raw.script.shots.length === 0) {
    throw new Error('Workshop response did not contain a usable shot-by-shot script.');
  }
  const language = getProjectLanguage(series);
  raw.productionNotes = {
    ...raw.productionNotes,
    delivery: raw.productionNotes?.delivery ?? inputs.delivery ?? 'standard',
  };
  const characters = (raw.characters ?? []).map(character => ({
    ...character,
    name: character.name.toUpperCase(),
    locked: false,
    seed: character.seed ?? stableSeed(character.name),
  }));
  const locations = (raw.locations ?? []).map(location => ({
    ...location,
    slug: location.slug || location.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    seed: location.seed ?? stableSeed(location.name),
  }));
  return {
    ...raw,
    version: 1,
    status: 'draft',
    revision,
    generatedAt: new Date().toISOString(),
    projectName: series.name,
    projectType: series.projectType ?? 'series',
    inputs,
    characters,
    locations,
    script: {
      ...raw.script,
      episode: raw.script.episode || 1,
      seriesName: series.name,
      totalDuration: raw.script.totalDuration || language.defaultDuration,
      status: 'draft',
    },
    feedbackHistory: feedback,
  };
}

export function buildWorkshopSystemPrompt(series: SeriesState): string {
  const language = getProjectLanguage(series);
  return `You are the complete creative-development team for a ${language.projectNounLower}: story editor, director, production designer, casting director, cinematographer, sound director, and AI-video production planner.

Develop the entire project coherently before generation. Do not merely produce a shot list. Resolve the premise, audience, target duration, logline, synopsis, themes, structure, visual language, cast, locations, dialogue approach, continuity priorities, risks, and a production-ready shot script.

${language.namingGuidance}
${language.targetDurationGuidance}
${language.openingGuidance}
${language.endingGuidance}
${language.structureGuidance}
${language.closingShotGuidance}
${language.locationGuidance}

Treat 4K as a final delivery/finishing target, never as a reason to make every draft generation at 4K. Native dialogue means the selected video model speaks in-frame; Seedance and HappyHorse use voice-donor references when available. Exact lip-sync means Venice speech drives Wan 2.7 mouth movement. Respect the project's selected audio strategy.

Every shot must have one dramatic intention, specific camera/blocking/light/performance direction, a location slug, a valid duration string, and no background music or sound effects baked into its description. Return ONLY valid JSON matching the requested schema.`;
}

export function buildWorkshopUserPrompt(
  series: SeriesState,
  inputs: WorkshopInputs,
  previous?: WorkshopDraft | null,
  feedback?: string,
): string {
  const context = {
    project: {
      name: series.name,
      type: series.projectType ?? 'series',
      concept: series.concept,
      genre: series.genre,
      setting: series.setting,
      audioStrategy: series.videoDefaults.audioStrategy ?? 'native',
      videoFamily: series.videoDefaults.videoFamilyPreference ?? 'auto',
    },
    inputs,
    existingAesthetic: series.aesthetic,
    existingCharacters: series.characters,
    existingLocations: series.locations ?? [],
    previousDraft: previous ?? null,
    revisionFeedback: feedback ?? null,
  };
  return `Develop or revise the complete project workshop from this context:
${JSON.stringify(context, null, 2)}

Return this JSON shape:
${JSON.stringify({
    version: 1,
    status: 'draft',
    revision: (previous?.revision ?? 0) + 1,
    generatedAt: 'ISO timestamp',
    projectName: series.name,
    projectType: series.projectType ?? 'series',
    inputs,
    logline: 'one sentence',
    synopsis: 'complete narrative synopsis',
    themes: ['theme'],
    structure: [{ name: 'Act or movement', purpose: 'dramatic purpose', beats: ['beat'] }],
    aesthetic: { style: '', palette: '', lighting: '', lensCharacteristics: '', filmStock: '' },
    characters: [{ name: '', gender: 'other', age: '', description: '', fullDescription: '', wardrobe: '', voiceDescription: '', locked: false, seed: 1 }],
    locations: [{ name: '', slug: '', description: '', lightingNotes: '', seed: 1 }],
    script: { episode: 1, title: '', seriesName: series.name, totalDuration: '', status: 'draft', locations: [], shots: [{ shotNumber: 1, type: 'establishing', environment: 'DAY_EXTERIOR', location: '', duration: '10s', videoModel: 'atmosphere', description: '', panelDescription: '', characters: [], dialogue: null, sfx: null, cameraMovement: '', transition: 'CUT' }] },
    productionNotes: { delivery: inputs.delivery, audioApproach: '', continuityPriorities: [''], risks: [''], openQuestions: [''] },
    feedbackHistory: [],
  }, null, 2)}`;
}

export async function generateWorkshop(
  client: VeniceClient,
  series: SeriesState,
  inputs: WorkshopInputs,
  model: string,
  previous?: WorkshopDraft | null,
  feedback?: string,
): Promise<WorkshopDraft> {
  const response = await client.post<{ choices: Array<{ message: { content: string } }> }>('/api/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: buildWorkshopSystemPrompt(series) },
      { role: 'user', content: buildWorkshopUserPrompt(series, inputs, previous, feedback) },
    ],
    max_tokens: 16_000,
    temperature: 0.65,
  });
  const raw = response.choices?.[0]?.message?.content ?? '';
  const json = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(json) as WorkshopDraft;
  return normalizeDraft(
    parsed,
    series,
    inputs,
    (previous?.revision ?? 0) + 1,
    [...(previous?.feedbackHistory ?? []), ...(feedback ? [feedback] : [])],
  );
}

export function renderWorkshopMarkdown(draft: WorkshopDraft): string {
  const lines = [
    `# ${draft.projectName} — workshop`,
    '',
    `Status: **${draft.status}** · Revision ${draft.revision}`,
    '',
    '## Logline', draft.logline, '',
    '## Synopsis', draft.synopsis, '',
    '## Themes', ...draft.themes.map(item => `- ${item}`), '',
    '## Structure',
    ...draft.structure.flatMap(section => [`### ${section.name}`, section.purpose, ...section.beats.map(beat => `- ${beat}`), '']),
    '## Aesthetic',
    `- Style: ${draft.aesthetic.style}`,
    `- Palette: ${draft.aesthetic.palette}`,
    `- Lighting: ${draft.aesthetic.lighting}`,
    `- Lens: ${draft.aesthetic.lensCharacteristics}`,
    `- Texture: ${draft.aesthetic.filmStock}`,
    '', '## Characters',
    ...draft.characters.flatMap(character => [`### ${character.name}`, character.fullDescription, `- Wardrobe: ${character.wardrobe}`, `- Voice: ${character.voiceDescription}`, '']),
    '## Locations',
    ...draft.locations.flatMap(location => [`### ${location.name}`, location.description, `- Lighting: ${location.lightingNotes ?? 'Not specified'}`, '']),
    '## Production notes',
    `- Delivery: ${draft.productionNotes.delivery === '4k' ? '4K master' : 'Standard master'}`,
    `- Audio: ${draft.productionNotes.audioApproach}`,
    ...draft.productionNotes.continuityPriorities.map(item => `- Continuity: ${item}`),
    ...draft.productionNotes.risks.map(item => `- Risk: ${item}`),
    '', '## Open questions',
    ...(draft.productionNotes.openQuestions.length ? draft.productionNotes.openQuestions.map(item => `- ${item}`) : ['- None']),
    '', `## Script`,
    `- Title: ${draft.script.title}`,
    `- Duration: ${draft.script.totalDuration}`,
    `- Shots: ${draft.script.shots.length}`,
    '', 'The complete shot script is stored in `workshop.json` and becomes `script.json` when approved.',
    '',
  ];
  return lines.join('\n');
}

export async function saveWorkshop(series: SeriesState, draft: WorkshopDraft): Promise<void> {
  const jsonPath = getWorkshopPath(series);
  if (existsSync(jsonPath)) {
    const archive = join(series.outputDir, `workshop-v${Math.max(1, draft.revision - 1)}.json`);
    if (!existsSync(archive)) await rename(jsonPath, archive);
  }
  await writeFile(jsonPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf-8');
  await writeFile(join(series.outputDir, 'WORKSHOP.md'), renderWorkshopMarkdown(draft), 'utf-8');
}

export async function approveWorkshop(series: SeriesState, draft: WorkshopDraft): Promise<WorkshopDraft> {
  series.aesthetic = draft.aesthetic;
  for (const character of draft.characters) {
    const index = series.characters.findIndex(existing => existing.name.toUpperCase() === character.name.toUpperCase());
    if (index >= 0) series.characters[index] = { ...series.characters[index], ...character };
    else series.characters.push(character);
  }
  if (!series.locations) series.locations = [];
  for (const location of draft.locations) {
    const index = series.locations.findIndex(existing => existing.slug === location.slug);
    if (index >= 0) series.locations[index] = { ...series.locations[index], ...location };
    else series.locations.push(location);
  }
  const part = draft.script.episode || 1;
  if (!series.episodes.find(item => item.number === part)) addEpisode(series, draft.script.title);
  draft.script.episode = part;
  draft.script.seriesName = series.name;
  draft.script.status = 'approved';
  await saveEpisodeScript(series, draft.script);
  const meta = series.episodes.find(item => item.number === part);
  if (meta) { meta.title = draft.script.title; meta.status = 'scripted'; }
  draft.status = 'approved';
  await saveSeries(series);
  await saveWorkshop(series, draft);
  return draft;
}
