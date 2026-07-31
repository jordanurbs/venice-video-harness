import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
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
  referenceSources?: WorkshopReferenceSource[];
}


export interface WorkshopReferenceSource {
  path: string;
  kind: 'text' | 'image' | 'video' | 'audio' | 'other';
  sizeBytes: number;
  content?: string;
  truncated?: boolean;
}

const TEXT_REFERENCE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.srt', '.vtt', '.fountain']);
const IMAGE_REFERENCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic']);
const VIDEO_REFERENCE_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const AUDIO_REFERENCE_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const MAX_REFERENCE_FILES = 100;
const MAX_TEXT_CHARS_PER_FILE = 20_000;

export function normalizeDroppedPath(value: string): string {
  let normalized = value.trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\\ /g, ' ');
  if (normalized === '~') normalized = homedir();
  else if (normalized.startsWith('~/')) normalized = join(homedir(), normalized.slice(2));
  return resolve(normalized);
}

function referenceKind(path: string): WorkshopReferenceSource['kind'] {
  const extension = extname(path).toLowerCase();
  if (TEXT_REFERENCE_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_REFERENCE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_REFERENCE_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_REFERENCE_EXTENSIONS.has(extension)) return 'audio';
  return 'other';
}

export async function inventoryReferencePath(value: string): Promise<WorkshopReferenceSource[]> {
  if (!value.trim()) return [];
  const root = normalizeDroppedPath(value);
  if (!existsSync(root)) throw new Error(`Reference path not found: ${root}`);
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    if (files.length >= MAX_REFERENCE_FILES) return;
    const info = await stat(path);
    if (info.isFile()) { files.push(path); return; }
    if (!info.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(join(path, entry.name));
      if (files.length >= MAX_REFERENCE_FILES) break;
    }
  };
  await walk(root);
  return Promise.all(files.map(async path => {
    const info = await stat(path);
    const kind = referenceKind(path);
    if (kind !== 'text') return { path, kind, sizeBytes: info.size };
    const full = await readFile(path, 'utf-8');
    return {
      path,
      kind,
      sizeBytes: info.size,
      content: full.slice(0, MAX_TEXT_CHARS_PER_FILE),
      truncated: full.length > MAX_TEXT_CHARS_PER_FILE || undefined,
    };
  }));
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

Develop the entire project coherently before generation. When a workshop input is blank, propose a strong answer from the project concept and supplied references; surface genuinely consequential uncertainty under openQuestions instead of stopping. Do not merely produce a shot list. Resolve the premise, audience, target duration, logline, synopsis, themes, structure, visual language, cast, locations, dialogue approach, continuity priorities, risks, and a production-ready shot script.

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
    inputs: {
      ...inputs,
      intendedAudienceResponse: inputs.objective,
      blanksPolicy: 'Any blank creative field is for the workshop to propose from the project concept and supplied references. Do not treat blanks as missing required data.',
    },
    referenceSources: inputs.referenceSources ?? [],
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


function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function htmlList(items: string[], empty = 'None'): string {
  return items.length > 0
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
}

export function renderWorkshopHtml(draft: WorkshopDraft): string {
  const structure = draft.structure.map((section, index) => `
    <article class="card structure-card">
      <span class="index">${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeHtml(section.name)}</h3>
      <p>${escapeHtml(section.purpose)}</p>
      ${htmlList(section.beats)}
    </article>`).join('');
  const characters = draft.characters.map(character => `
    <article class="card">
      <p class="eyebrow">Character</p>
      <h3>${escapeHtml(character.name)}</h3>
      <p>${escapeHtml(character.fullDescription)}</p>
      <dl><dt>Wardrobe</dt><dd>${escapeHtml(character.wardrobe)}</dd><dt>Voice</dt><dd>${escapeHtml(character.voiceDescription)}</dd></dl>
    </article>`).join('');
  const locations = draft.locations.map(location => `
    <article class="card">
      <p class="eyebrow">Location</p>
      <h3>${escapeHtml(location.name)}</h3>
      <p>${escapeHtml(location.description)}</p>
      <dl><dt>Lighting</dt><dd>${escapeHtml(location.lightingNotes ?? 'Not specified')}</dd></dl>
    </article>`).join('');
  const shots = draft.script.shots.map(shot => `
    <tr>
      <td class="shot-number">${escapeHtml(shot.shotNumber)}</td>
      <td><span class="pill">${escapeHtml(shot.type)}</span><br><span class="muted">${escapeHtml(shot.duration)} · ${escapeHtml(shot.location ?? 'No location')}</span></td>
      <td>${escapeHtml(shot.description)}</td>
      <td>${shot.dialogue ? `<strong>${escapeHtml(shot.dialogue.character)}</strong><br>“${escapeHtml(shot.dialogue.line)}”` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  const refs = draft.inputs.referenceSources ?? [];
  const references = refs.length
    ? `<div class="reference-list">${refs.map(source => `<div><span class="pill">${escapeHtml(source.kind)}</span> <code>${escapeHtml(source.path)}</code></div>`).join('')}</div>`
    : '<p class="muted">No references supplied; the workshop proposed the creative direction.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(draft.projectName)} — Workshop</title>
<style>
:root{color-scheme:dark;--bg:#0c0e12;--panel:#141820;--line:#29303d;--text:#f2efe7;--muted:#9da5b4;--accent:#7cb7ff;--warm:#d6b98c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#17263d 0,transparent 32%),var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1180px,calc(100% - 40px));margin:auto;padding:64px 0 100px}.hero{padding:48px;border:1px solid var(--line);background:linear-gradient(135deg,#151a24e8,#10141be8);border-radius:24px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:var(--accent);font-weight:700;margin:0 0 10px}h1{font:clamp(42px,7vw,82px)/.95 Georgia,serif;margin:0 0 24px;max-width:900px}h2{font:36px/1.1 Georgia,serif;margin:70px 0 24px}h3{font:24px/1.2 Georgia,serif;margin:4px 0 14px}.logline{font-size:22px;max-width:850px;color:#dce4ef}.meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}.pill{display:inline-block;padding:4px 10px;border:1px solid #3b4658;border-radius:999px;color:#cbd7e7;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{position:relative;padding:24px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}.structure-card{padding-left:64px}.index{position:absolute;left:22px;color:var(--warm);font:18px/1 ui-monospace,monospace}dl{display:grid;grid-template-columns:84px 1fr;gap:6px 12px;margin:18px 0 0}dt{color:var(--muted)}dd{margin:0}.muted{color:var(--muted)}.split{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}.aesthetic{border-left:3px solid var(--warm)}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}th,td{text-align:left;padding:16px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}.shot-number{font:20px ui-monospace,monospace;color:var(--warm)}code{font-size:12px;word-break:break-all}.reference-list{display:grid;gap:10px}.status{color:${draft.status === 'approved' ? '#8ee6b2' : '#ffd48a'}}@media(max-width:760px){main{width:min(100% - 24px,1180px);padding-top:20px}.hero{padding:28px}.split{grid-template-columns:1fr}table{display:block;overflow:auto}}
</style></head><body><main>
<section class="hero"><p class="eyebrow">${escapeHtml(draft.projectType)} workshop · revision ${draft.revision}</p><h1>${escapeHtml(draft.projectName)}</h1><p class="logline">${escapeHtml(draft.logline)}</p><div class="meta"><span class="pill status">${escapeHtml(draft.status)}</span><span class="pill">${escapeHtml(draft.script.totalDuration)}</span><span class="pill">${draft.script.shots.length} shots</span><span class="pill">${draft.productionNotes.delivery === '4k' ? '4K delivery' : 'Standard delivery'}</span></div></section>
<section class="split"><div><h2>Story</h2><p>${escapeHtml(draft.synopsis)}</p><h3>Themes</h3>${htmlList(draft.themes)}</div><div><h2>Workshop inputs</h2><div class="card"><dl><dt>Outcome</dt><dd>${escapeHtml(draft.inputs.objective || 'Workshop-generated')}</dd><dt>Audience</dt><dd>${escapeHtml(draft.inputs.audience || 'Workshop-generated')}</dd><dt>Runtime</dt><dd>${escapeHtml(draft.inputs.targetDuration)}</dd><dt>Must include</dt><dd>${escapeHtml(draft.inputs.mustInclude || 'Workshop-generated')}</dd><dt>Avoid</dt><dd>${escapeHtml(draft.inputs.avoid || 'None specified')}</dd></dl></div></div></section>
<h2>Structure</h2><section class="grid">${structure}</section>
<h2>Visual language</h2><section class="card aesthetic"><dl><dt>Style</dt><dd>${escapeHtml(draft.aesthetic.style)}</dd><dt>Palette</dt><dd>${escapeHtml(draft.aesthetic.palette)}</dd><dt>Lighting</dt><dd>${escapeHtml(draft.aesthetic.lighting)}</dd><dt>Lens</dt><dd>${escapeHtml(draft.aesthetic.lensCharacteristics)}</dd><dt>Texture</dt><dd>${escapeHtml(draft.aesthetic.filmStock)}</dd></dl></section>
<h2>Cast</h2><section class="grid">${characters || '<p class="muted">No characters.</p>'}</section>
<h2>Locations</h2><section class="grid">${locations || '<p class="muted">No locations.</p>'}</section>
<section class="split"><div><h2>Production plan</h2><div class="card"><p><strong>Audio:</strong> ${escapeHtml(draft.productionNotes.audioApproach)}</p><h3>Continuity</h3>${htmlList(draft.productionNotes.continuityPriorities)}<h3>Risks</h3>${htmlList(draft.productionNotes.risks)}</div></div><div><h2>Open questions</h2><div class="card">${htmlList(draft.productionNotes.openQuestions)}</div></div></section>
<h2>Creative references</h2>${references}
<h2>Shot script</h2><table><thead><tr><th>#</th><th>Shot</th><th>Direction</th><th>Dialogue</th></tr></thead><tbody>${shots}</tbody></table>
</main></body></html>`;
}

export async function saveWorkshop(series: SeriesState, draft: WorkshopDraft): Promise<void> {
  const jsonPath = getWorkshopPath(series);
  if (existsSync(jsonPath)) {
    const archive = join(series.outputDir, `workshop-v${Math.max(1, draft.revision - 1)}.json`);
    if (!existsSync(archive)) await rename(jsonPath, archive);
  }
  await writeFile(jsonPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf-8');
  await writeFile(join(series.outputDir, 'WORKSHOP.md'), renderWorkshopMarkdown(draft), 'utf-8');
  await writeFile(join(series.outputDir, 'WORKSHOP.html'), renderWorkshopHtml(draft), 'utf-8');
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
