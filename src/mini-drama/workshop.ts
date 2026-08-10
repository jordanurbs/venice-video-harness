import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { REFERENCE_THUMBNAIL_PX, ThumbnailCache, type Thumbnails } from './thumbnails.js';
import type { ShotArtifacts, TreatmentProgress } from './treatment.js';
import type { VeniceClient } from '../venice/client.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import type { Character, EpisodeScript, Location, SeriesState } from '../series/types.js';
import { addEpisode, getCharacterDir, getLocationDir, saveEpisodeScript, saveSeries } from '../series/manager.js';
import { getProjectLanguage } from '../series/project-language.js';
import { DEFAULT_INTELLIGENCE_MODEL, describeIntelligence } from '../venice/text-models.js';

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

/** @deprecated Use {@link Thumbnails} from `./thumbnails.js`. */
export type ReferenceThumbnails = Thumbnails;

const MAX_THUMBNAILS = 24;

/**
 * Renders inline previews for the image and video references so the workshop
 * page shows the creative direction instead of a list of file paths.
 *
 * Best-effort throughout: a reference that can't be decoded (corrupt file,
 * exotic codec, no ffmpeg on PATH) is simply left out and falls back to its
 * path row in the page.
 */
export async function buildReferenceThumbnails(
  sources: ReadonlyArray<WorkshopReferenceSource>,
  cache?: ThumbnailCache,
): Promise<Thumbnails> {
  const previewable = sources
    .filter(source => source.kind === 'image' || source.kind === 'video')
    .slice(0, MAX_THUMBNAILS);
  if (previewable.length === 0) return new Map();

  const thumbnails = new Map<string, string>();
  const store = cache ?? ThumbnailCache.ephemeral();
  for (const source of previewable) {
    const dataUri = await store.get(
      source.path,
      REFERENCE_THUMBNAIL_PX,
      source.kind === 'video' ? 'video' : 'image',
    );
    if (dataUri) thumbnails.set(source.path, dataUri);
  }
  if (!cache) await store.save();
  return thumbnails;
}

/**
 * Inline art for the entities the page describes: each character's portrait
 * and each location's key angles, pulled from the reference images the
 * pipeline has already generated on disk. Keys are `character:<name>` and
 * `location:<slug>`; values are ordered data-URI thumbnails.
 *
 * Best-effort like everything else on this page — an entity whose references
 * have not been generated yet (or failed to decode) simply renders as the
 * text-only card it always was.
 */
export type EntityArt = Map<string, string[]>;

/** Reference angles to show per entity, in display order. */
const CHARACTER_ART_ANGLES = ['front.png', 'full-body.png'];
const LOCATION_ART_ANGLES = ['wide.png', 'medium.png', 'detail.png'];

export async function buildEntityArt(
  series: SeriesState,
  draft: Pick<WorkshopDraft, 'characters' | 'locations'>,
  cache?: ThumbnailCache,
): Promise<EntityArt> {
  const art: EntityArt = new Map();
  const store = cache ?? ThumbnailCache.ephemeral();

  for (const character of draft.characters) {
    if (!character.name) continue;
    const dir = getCharacterDir(series, character.name);
    const uris: string[] = [];
    for (const angle of CHARACTER_ART_ANGLES) {
      const uri = await store.get(join(dir, angle), REFERENCE_THUMBNAIL_PX);
      if (uri) uris.push(uri);
    }
    if (uris.length) art.set(`character:${character.name}`, uris);
  }

  for (const location of draft.locations) {
    const slugOrName = location.slug || location.name;
    if (!slugOrName) continue;
    const dir = getLocationDir(series, slugOrName);
    const uris: string[] = [];
    for (const angle of LOCATION_ART_ANGLES) {
      const uri = await store.get(join(dir, angle), REFERENCE_THUMBNAIL_PX);
      if (uri) uris.push(uri);
    }
    if (uris.length) art.set(`location:${slugOrName}`, uris);
  }

  if (!cache) await store.save();
  return art;
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

Treat 4K as a final delivery/finishing target, never as a reason to make every draft generation at 4K. Native dialogue means the selected video model speaks in-frame; Seedance and HappyHorse use voice-donor references when available. Exact lip-sync means Venice speech is rendered first, passed to the video model as an audio file, and the character's mouth follows that recording. Respect the project's selected audio strategy.

SPATIAL CONSISTENCY IS A FIRST-CLASS DELIVERABLE. Every location gets a "spatialAnchors" field: 3-5 named landmarks and their FIXED positions relative to each other (e.g. "bar counter along the back wall; entrance door opposite it; neon window left of the door as seen from the counter"). Every shot with characters gets a "blocking" field: 1-2 sentences of concrete geometry — each character's position relative to the location's named anchors, their frame side (screen left/center/right) and depth (foreground/background), and their facing/eyeline direction. Across consecutive shots in a scene, characters keep their screen side and relative positions unless a movement is written into the action; preserve screen direction and eyelines (180-degree rule); and always reference the SAME named anchors so "by the window" means one specific window. This geometry is injected verbatim into every image, blocking-plate, and video prompt, so vague blocking becomes spatial drift on screen.

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
    locations: [{ name: '', slug: '', description: '', lightingNotes: '', spatialAnchors: 'named landmarks and their fixed relative positions', seed: 1 }],
    script: { episode: 1, title: '', seriesName: series.name, totalDuration: '', status: 'draft', locations: [], shots: [{ shotNumber: 1, type: 'establishing', environment: 'DAY_EXTERIOR', location: '', duration: '10s', videoModel: 'atmosphere', description: '', blocking: 'each character/object: position vs named location anchors, frame side, depth, facing/eyeline — consistent with adjacent shots', panelDescription: '', characters: [], dialogue: null, sfx: null, cameraMovement: '', transition: 'CUT' }] },
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
  const parsed = await client.chatJson<WorkshopDraft>({
    model,
    systemPrompt: buildWorkshopSystemPrompt(series),
    userPrompt: buildWorkshopUserPrompt(series, inputs, previous, feedback),
    maxTokens: 16_000,
    temperature: 0.65,
    label: 'workshop',
  });
  return normalizeDraft(
    parsed,
    series,
    inputs,
    (previous?.revision ?? 0) + 1,
    [...(previous?.feedbackHistory ?? []), ...(feedback ? [feedback] : [])],
  );
}

/**
 * Image references become markdown embeds so a preview pane shows them
 * inline; everything else stays a plain path row.
 */
function renderReferenceMarkdown(refs: ReadonlyArray<WorkshopReferenceSource>): string[] {
  if (refs.length === 0) return ['- None supplied; the workshop proposed the creative direction.'];
  return refs.map(source => (source.kind === 'image'
    ? `![${basename(source.path)}](${source.path})`
    : `- ${source.kind}: \`${source.path}\``));
}

function renderProgressMarkdown(progress: TreatmentProgress | undefined): string[] {
  if (!progress) return [];
  return [
    '## Production progress',
    `Stage: **${progress.stage}** · refreshed ${new Date(progress.refreshedAt).toLocaleString()}`,
    '',
    `- Panels: ${progress.panelCount} / ${progress.shotCount}`,
    `- Clips: ${progress.videoCount} / ${progress.shotCount}`,
    `- Dialogue: ${progress.dialogueCount} / ${progress.shotCount}`,
    `- Music: ${progress.hasMusic ? 'rendered' : 'not yet'}`,
    ...(progress.finalCutPath ? [`- Final cut: \`${progress.finalCutPath}\``] : []),
    '',
    ...(progress.nextCommand
      ? ['Next command:', '', '```bash', progress.nextCommand, '```', '']
      : ['Nothing pending — this episode is assembled.', '']),
  ];
}

export function renderWorkshopMarkdown(draft: WorkshopDraft, progress?: TreatmentProgress): string {
  const lines = [
    `# ${draft.projectName} — workshop`,
    '',
    `Status: **${draft.status}** · Revision ${draft.revision}`,
    '',
    ...renderProgressMarkdown(progress),
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
    '', '## Creative references',
    ...renderReferenceMarkdown(draft.inputs.referenceSources ?? []),
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

function renderReferences(
  refs: ReadonlyArray<WorkshopReferenceSource>,
  thumbnails: ReferenceThumbnails,
): string {
  if (refs.length === 0) {
    return '<p class="muted">No references supplied; the workshop proposed the creative direction.</p>';
  }
  const shown = refs.filter(source => thumbnails.has(source.path));
  const listed = refs.filter(source => !thumbnails.has(source.path));
  const gallery = shown.length
    ? `<div class="reference-gallery">${shown.map(source => `
      <figure>
        <a href="${escapeHtml(source.path)}"><img src="${thumbnails.get(source.path)}" alt="${escapeHtml(basename(source.path))}" loading="lazy"></a>
        <figcaption title="${escapeHtml(source.path)}"><span class="pill">${escapeHtml(source.kind)}</span> <code>${escapeHtml(basename(source.path))}</code></figcaption>
      </figure>`).join('')}</div>`
    : '';
  const list = listed.length
    ? `<div class="reference-list">${listed.map(source => `<div><span class="pill">${escapeHtml(source.kind)}</span> <code>${escapeHtml(source.path)}</code></div>`).join('')}</div>`
    : '';
  return gallery + list;
}

const STAGE_ORDER: ReadonlyArray<{ label: string; done: (p: TreatmentProgress) => boolean }> = [
  { label: 'Script', done: p => p.scriptApproved },
  { label: 'Panels', done: p => p.shotCount > 0 && p.panelCount >= p.shotCount },
  { label: 'QA', done: p => p.qaApproved },
  { label: 'Clips', done: p => p.shotCount > 0 && p.videoCount >= p.shotCount },
  { label: 'Final cut', done: p => Boolean(p.finalCutPath) },
];

function renderProgressSection(progress: TreatmentProgress): string {
  const steps = STAGE_ORDER.map(step => {
    const done = step.done(progress);
    return `<li class="${done ? 'done' : 'todo'}"><span class="tick">${done ? '●' : '○'}</span>${escapeHtml(step.label)}</li>`;
  }).join('');

  const counts: Array<[string, string]> = [
    ['Panels', `${progress.panelCount} / ${progress.shotCount}`],
    ['Clips', `${progress.videoCount} / ${progress.shotCount}`],
    ['Dialogue', `${progress.dialogueCount} / ${progress.shotCount}`],
    ['Music', progress.hasMusic ? 'rendered' : 'not yet'],
  ];
  const countRows = counts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');

  const next = progress.nextCommand
    ? `<p class="next-label">Next command</p><pre class="next"><code>${escapeHtml(progress.nextCommand)}</code></pre>`
    : '<p class="next-label">Next command</p><p class="muted">Nothing pending — this episode is assembled.</p>';

  const finalCut = progress.finalCutPath
    ? `<p class="final-cut">Final cut: <a href="${escapeHtml(progress.finalCutPath)}"><code>${escapeHtml(basename(progress.finalCutPath))}</code></a></p>`
    : '';

  const others = progress.otherEpisodes.length > 0
    ? `<p class="muted others">Other parts: ${progress.otherEpisodes
      .map(item => `${String(item.episode).padStart(2, '0')}${item.title ? ` ${escapeHtml(item.title)}` : ''} — ${escapeHtml(item.stage)}`)
      .join(' · ')}</p>`
    : '';

  return `<h2>Production progress</h2>
<section class="card progress">
  <div class="progress-head">
    <div><p class="eyebrow">Stage</p><h3>${escapeHtml(progress.stage)}</h3></div>
    <p class="muted refreshed">Refreshed ${escapeHtml(new Date(progress.refreshedAt).toLocaleString())}<br>Re-run any command, then reload this page.</p>
  </div>
  <ol class="stage-track">${steps}</ol>
  <dl class="counts">${countRows}</dl>
  ${next}
  ${finalCut}
  ${others}
</section>`;
}

const VERDICT_CLASS: Record<string, string> = {
  PASS: 'qa-pass',
  'FLAG-LOW': 'qa-low',
  'FLAG-MODERATE': 'qa-moderate',
  'FLAG-CRITICAL': 'qa-critical',
};

/** The leading cell of a shot row: the newest artifact, plus what exists. */
function renderShotProgressCell(artifacts: ShotArtifacts | undefined): string {
  if (!artifacts) return '<td class="shot-art"><span class="muted">—</span></td>';

  // A rendered clip supersedes its panel: seeing the shot move is the point.
  const thumbnail = artifacts.clipThumbnail ?? artifacts.panelThumbnail;
  const target = artifacts.clipPath ?? artifacts.panelPath;
  const preview = thumbnail && target
    ? `<a href="${escapeHtml(target)}"><img src="${thumbnail}" alt="Shot ${escapeHtml(artifacts.key)}" loading="lazy"></a>`
    : '<div class="pending">Not generated yet</div>';

  const badges: string[] = [];
  if (artifacts.panelPath) badges.push('<span class="pill">panel</span>');
  if (artifacts.clipPath) badges.push('<span class="pill live">clip</span>');
  if (artifacts.dialoguePath) badges.push('<span class="pill">vo</span>');
  if (artifacts.qaVerdict) {
    const cls = VERDICT_CLASS[artifacts.qaVerdict] ?? 'qa-low';
    const title = artifacts.qaIssues?.length ? ` title="${escapeHtml(artifacts.qaIssues.join('; '))}"` : '';
    badges.push(`<span class="pill ${cls}"${title}>${escapeHtml(artifacts.qaVerdict.replace('FLAG-', ''))}</span>`);
  }

  return `<td class="shot-art">${preview}<div class="badges">${badges.join('')}</div></td>`;
}

/** An image strip for an entity card. Empty string when no art exists. */
function renderEntityArt(uris: string[] | undefined, alt: string): string {
  if (!uris?.length) return '';
  return `<div class="entity-art">${uris
    .map(uri => `<img src="${uri}" alt="${escapeHtml(alt)}" loading="lazy">`)
    .join('')}</div>`;
}

export function renderWorkshopHtml(
  draft: WorkshopDraft,
  thumbnails: ReferenceThumbnails = new Map(),
  progress?: TreatmentProgress,
  /** Which reasoning model produced this, shown alongside the other settings. */
  intelligence?: string,
  /** Character portraits + location stills from generated references. */
  entityArt: EntityArt = new Map(),
): string {
  const structure = draft.structure.map((section, index) => `
    <article class="card structure-card">
      <span class="index">${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeHtml(section.name)}</h3>
      <p>${escapeHtml(section.purpose)}</p>
      ${htmlList(section.beats)}
    </article>`).join('');
  const characters = draft.characters.map(character => `
    <article class="card">
      ${renderEntityArt(entityArt.get(`character:${character.name}`), character.name)}
      <p class="eyebrow">Character</p>
      <h3>${escapeHtml(character.name)}</h3>
      <p>${escapeHtml(character.fullDescription)}</p>
      <dl><dt>Wardrobe</dt><dd>${escapeHtml(character.wardrobe)}</dd><dt>Voice</dt><dd>${escapeHtml(character.voiceDescription)}</dd></dl>
    </article>`).join('');
  const locations = draft.locations.map(location => `
    <article class="card">
      ${renderEntityArt(entityArt.get(`location:${location.slug || location.name}`), location.name)}
      <p class="eyebrow">Location</p>
      <h3>${escapeHtml(location.name)}</h3>
      <p>${escapeHtml(location.description)}</p>
      <dl><dt>Lighting</dt><dd>${escapeHtml(location.lightingNotes ?? 'Not specified')}</dd></dl>
    </article>`).join('');
  const shots = draft.script.shots.map(shot => {
    const key = String(shot.shotNumber).padStart(3, '0') + (shot.shotIdSuffix ?? '');
    return `
    <tr>
      <td class="shot-number">${escapeHtml(shot.shotNumber)}${shot.shotIdSuffix ? escapeHtml(shot.shotIdSuffix) : ''}</td>
      ${progress ? renderShotProgressCell(progress.shots.get(key)) : ''}
      <td><span class="pill">${escapeHtml(shot.type)}</span><br><span class="muted">${escapeHtml(shot.duration)} · ${escapeHtml(shot.location ?? 'No location')}</span></td>
      <td>${escapeHtml(shot.description)}</td>
      <td>${shot.dialogue?.line?.trim() ? `<strong>${escapeHtml(shot.dialogue.character)}</strong><br>“${escapeHtml(shot.dialogue.line)}”` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const references = renderReferences(draft.inputs.referenceSources ?? [], thumbnails);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(draft.projectName)} — Workshop</title>
<style>
:root{color-scheme:dark;--bg:#0c0e12;--panel:#141820;--line:#29303d;--text:#f2efe7;--muted:#9da5b4;--accent:#7cb7ff;--warm:#d6b98c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#17263d 0,transparent 32%),var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1180px,calc(100% - 40px));margin:auto;padding:64px 0 100px}.hero{padding:48px;border:1px solid var(--line);background:linear-gradient(135deg,#151a24e8,#10141be8);border-radius:24px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:var(--accent);font-weight:700;margin:0 0 10px}h1{font:clamp(42px,7vw,82px)/.95 Georgia,serif;margin:0 0 24px;max-width:900px}h2{font:36px/1.1 Georgia,serif;margin:70px 0 24px}h3{font:24px/1.2 Georgia,serif;margin:4px 0 14px}.logline{font-size:22px;max-width:850px;color:#dce4ef}.meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}.pill{display:inline-block;padding:4px 10px;border:1px solid #3b4658;border-radius:999px;color:#cbd7e7;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{position:relative;padding:24px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}.structure-card{padding-left:64px}.index{position:absolute;left:22px;color:var(--warm);font:18px/1 ui-monospace,monospace}dl{display:grid;grid-template-columns:84px 1fr;gap:6px 12px;margin:18px 0 0}dt{color:var(--muted)}dd{margin:0}.muted{color:var(--muted)}.split{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}.aesthetic{border-left:3px solid var(--warm)}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}th,td{text-align:left;padding:16px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}.shot-number{font:20px ui-monospace,monospace;color:var(--warm)}code{font-size:12px;word-break:break-all}.reference-list{display:grid;gap:10px;margin-top:16px}.reference-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}.reference-gallery figure{margin:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}.reference-gallery a{display:block;line-height:0}.reference-gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}.reference-gallery figcaption{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:12px;color:var(--muted)}.reference-gallery figcaption .pill{flex:none}.reference-gallery figcaption code{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-break:normal}.status{color:${draft.status === 'approved' ? '#8ee6b2' : '#ffd48a'}}
.progress{border-left:3px solid var(--accent)}.progress-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap}.progress-head h3{margin:0;text-transform:capitalize}.refreshed{font-size:12px;text-align:right;line-height:1.5}
.stage-track{display:flex;flex-wrap:wrap;gap:8px 22px;list-style:none;margin:22px 0;padding:0;font-size:13px;text-transform:uppercase;letter-spacing:.08em}.stage-track li{display:flex;align-items:center;gap:7px;color:var(--muted)}.stage-track li.done{color:#8ee6b2}.tick{font-size:11px}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px;margin:0 0 22px;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.counts>div{display:block}.counts dt{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.counts dd{margin:4px 0 0;font:19px/1.2 ui-monospace,monospace;color:var(--text)}
.next-label{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 8px}pre.next{margin:0;padding:14px 16px;background:#0a0c10;border:1px solid var(--line);border-radius:12px;overflow-x:auto}pre.next code{font-size:13px;color:var(--accent);word-break:normal;white-space:pre}
.final-cut{margin:18px 0 0}.final-cut a{color:var(--accent)}.others{margin:14px 0 0;font-size:13px}
.entity-art{display:flex;gap:8px;margin:-8px -8px 16px}.entity-art img{min-width:0;flex:1 1 0;aspect-ratio:1/1;object-fit:cover;border-radius:12px;border:1px solid var(--line);display:block}.entity-art img:first-child:not(:only-child){flex:1.6 1 0;aspect-ratio:auto}
.shot-art{width:220px}.shot-art img{width:200px;aspect-ratio:16/9;object-fit:cover;border-radius:10px;display:block;border:1px solid var(--line)}.shot-art .pending{width:200px;aspect-ratio:16/9;border:1px dashed var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px}.badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.badges .pill{font-size:10px;padding:2px 8px}.pill.live{border-color:#3f7f5c;color:#8ee6b2}.pill.qa-pass{border-color:#3f7f5c;color:#8ee6b2}.pill.qa-low{border-color:#5d6a80;color:#b9c4d6}.pill.qa-moderate{border-color:#8a7233;color:#ffd48a}.pill.qa-critical{border-color:#8f4747;color:#ff9d9d}
@media(max-width:760px){main{width:min(100% - 24px,1180px);padding-top:20px}.hero{padding:28px}.split{grid-template-columns:1fr}table{display:block;overflow:auto}.refreshed{text-align:left}}
</style></head><body><main>
<section class="hero"><p class="eyebrow">${escapeHtml(draft.projectType)} workshop · revision ${draft.revision}</p><h1>${escapeHtml(draft.projectName)}</h1><p class="logline">${escapeHtml(draft.logline)}</p><div class="meta"><span class="pill status">${escapeHtml(draft.status)}</span><span class="pill">${escapeHtml(draft.script.totalDuration)}</span><span class="pill">${draft.script.shots.length} shots</span><span class="pill">${draft.productionNotes.delivery === '4k' ? '4K delivery' : 'Standard delivery'}</span>${intelligence ? `<span class="pill">${escapeHtml(intelligence)}</span>` : ''}</div></section>
<section class="split"><div><h2>Story</h2><p>${escapeHtml(draft.synopsis)}</p><h3>Themes</h3>${htmlList(draft.themes)}</div><div><h2>Workshop inputs</h2><div class="card"><dl><dt>Outcome</dt><dd>${escapeHtml(draft.inputs.objective || 'Workshop-generated')}</dd><dt>Audience</dt><dd>${escapeHtml(draft.inputs.audience || 'Workshop-generated')}</dd><dt>Runtime</dt><dd>${escapeHtml(draft.inputs.targetDuration)}</dd><dt>Must include</dt><dd>${escapeHtml(draft.inputs.mustInclude || 'Workshop-generated')}</dd><dt>Avoid</dt><dd>${escapeHtml(draft.inputs.avoid || 'None specified')}</dd></dl></div></div></section>
<h2>Structure</h2><section class="grid">${structure}</section>
<h2>Visual language</h2><section class="card aesthetic"><dl><dt>Style</dt><dd>${escapeHtml(draft.aesthetic.style)}</dd><dt>Palette</dt><dd>${escapeHtml(draft.aesthetic.palette)}</dd><dt>Lighting</dt><dd>${escapeHtml(draft.aesthetic.lighting)}</dd><dt>Lens</dt><dd>${escapeHtml(draft.aesthetic.lensCharacteristics)}</dd><dt>Texture</dt><dd>${escapeHtml(draft.aesthetic.filmStock)}</dd></dl></section>
<h2>Cast</h2><section class="grid">${characters || '<p class="muted">No characters.</p>'}</section>
<h2>Locations</h2><section class="grid">${locations || '<p class="muted">No locations.</p>'}</section>
<section class="split"><div><h2>Production plan</h2><div class="card"><p><strong>Audio:</strong> ${escapeHtml(draft.productionNotes.audioApproach)}</p><h3>Continuity</h3>${htmlList(draft.productionNotes.continuityPriorities)}<h3>Risks</h3>${htmlList(draft.productionNotes.risks)}</div></div><div><h2>Open questions</h2><div class="card">${htmlList(draft.productionNotes.openQuestions)}</div></div></section>
${progress ? renderProgressSection(progress) : ''}
<h2>Creative references</h2>${references}
<h2>Shot script</h2><table><thead><tr><th>#</th>${progress ? '<th>Output</th>' : ''}<th>Shot</th><th>Direction</th><th>Dialogue</th></tr></thead><tbody>${shots}</tbody></table>
</main></body></html>`;
}

export async function saveWorkshop(series: SeriesState, draft: WorkshopDraft): Promise<void> {
  const jsonPath = getWorkshopPath(series);
  if (existsSync(jsonPath)) {
    const archive = join(series.outputDir, `workshop-v${Math.max(1, draft.revision - 1)}.json`);
    if (!existsSync(archive)) await rename(jsonPath, archive);
  }
  await writeFile(jsonPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf-8');
  const cache = await ThumbnailCache.open(series.outputDir);
  const thumbnails = await buildReferenceThumbnails(draft.inputs.referenceSources ?? [], cache);
  const entityArt = await buildEntityArt(series, draft, cache);
  await cache.save();
  await writeFile(join(series.outputDir, 'WORKSHOP.md'), renderWorkshopMarkdown(draft), 'utf-8');
  await writeFile(
    join(series.outputDir, 'WORKSHOP.html'),
    renderWorkshopHtml(draft, thumbnails, undefined, describeIntelligence(series.intelligence?.model ?? DEFAULT_INTELLIGENCE_MODEL), entityArt),
    'utf-8',
  );
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
