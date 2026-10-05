// ---------------------------------------------------------------------------
// Panel approval binding.
//
// `qa-approve` used to write `{ episode, approvedAt, notes }` and
// `generate-videos` checked only that the file existed. Nothing tied the
// approval to the panels a human actually looked at: regenerate a panel
// (storyboard-episode --force, fix-panel, a hand edit), change the shot's
// description or the image model, and the stale approval still unblocked a
// billed render of something nobody reviewed.
//
// Now the approval records, per shot, (a) a sha256 of the panel file's bytes
// and (b) a digest of the settings the panel depends on: the image prompt the
// shot would produce today, the reference images it would use, and the image
// models. `generate-videos` recomputes both and refuses any shot that no
// longer matches, naming what changed and the command to re-approve.
//
// Pure helpers (`settingsDigest`, `compareApproval`) take plain data; the disk
// reads live in `approvalForShot` / `verifyApproval` so a browser host can
// reuse the digest logic with its own storage.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeriesState, ShotScript } from '../series/types.js';
import { getCharacterDir, getLocation, getLocationDir } from '../series/manager.js';
import { DEFAULT_IMAGE_EDIT_MODEL, DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';
import { buildImagePrompt } from './prompt-builder.js';
import { panelFileForShot, shotKey } from './shot-paths.js';

// ---- Shapes ----------------------------------------------------------------

/** The inputs a panel is a function of. Hashed into `settingsDigest`. */
export interface PanelSettings {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  generationModel: string;
  editModel: string;
  aspectRatio: string;
  /** Project-relative paths of the character / location references the panel would use. */
  referenceImages: string[];
  /** Extra per-shot inputs that change the panel without changing the prompt. */
  sceneImagePaths?: string[];
  sceneRefDescription?: string;
  skipRefine?: boolean;
}

export interface ShotApproval {
  /** sha256 of the panel file's bytes at approval time. */
  panelSha256: string;
  /** sha256 of the canonical JSON of `PanelSettings` at approval time. */
  settingsDigest: string;
}

export interface ApprovalArtifact {
  episode: number;
  approvedAt: string;
  notes: string;
  /** Approver, when known (`$USER`), for the audit trail. */
  by?: string;
  /** Per-shot binding keyed by `shotKey` ("003", "003b"). Absent on artifacts written before this binding existed. */
  shots?: Record<string, ShotApproval>;
}

export type ApprovalMismatch =
  | { kind: 'panel-missing' }
  | { kind: 'panel-changed' }
  | { kind: 'settings-changed' }
  | { kind: 'not-recorded' };

export interface ApprovalCheck {
  shotKey: string;
  shotNumber: number;
  mismatches: ApprovalMismatch[];
}

// ---- Pure --------------------------------------------------------------------

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON: keys sorted, so two equal settings objects always hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function settingsDigest(settings: PanelSettings): string {
  return sha256Hex(canonicalJson(settings));
}

/** Compare a recorded approval against the current panel hash + settings. Pure. */
export function compareApproval(
  recorded: ShotApproval | undefined,
  current: { panelSha256?: string; settingsDigest: string },
): ApprovalMismatch[] {
  if (!recorded) return [{ kind: 'not-recorded' }];
  const out: ApprovalMismatch[] = [];
  if (!current.panelSha256) out.push({ kind: 'panel-missing' });
  else if (current.panelSha256 !== recorded.panelSha256) out.push({ kind: 'panel-changed' });
  if (current.settingsDigest !== recorded.settingsDigest) out.push({ kind: 'settings-changed' });
  return out;
}

// ---- Disk-backed -------------------------------------------------------------

const CHARACTER_REF_ORDER = ['anchor.png', 'front.png', 'three-quarter.png'];
const LOCATION_REF_ORDER = ['north.png', 'south.png', 'east.png', 'west.png', 'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png'];

function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, '') : path;
}

/**
 * The settings a shot's panel depends on, computed from the live script and
 * series. Mirrors what `storyboard-episode` feeds the image call: the image
 * prompt (aesthetic, description, blocking, wardrobe, environment), the
 * location note, the character / location references that exist on disk, and
 * the image models.
 */
export function panelSettingsForShot(series: SeriesState, shot: ShotScript): PanelSettings {
  const imagePrompt = buildImagePrompt(shot, series);

  let locationNote = '';
  const referenceImages: string[] = [];
  for (const name of shot.characters) {
    const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    if (!char) continue;
    const dir = getCharacterDir(series, char.name);
    const ref = CHARACTER_REF_ORDER.map(f => join(dir, f)).find(p => existsSync(p));
    if (ref) referenceImages.push(relativeTo(series.outputDir, ref));
  }
  if (shot.location) {
    const location = getLocation(series, shot.location);
    if (location) {
      const dir = getLocationDir(series, location.slug);
      const ref = LOCATION_REF_ORDER.map(f => join(dir, f)).find(p => existsSync(p));
      if (ref) referenceImages.push(relativeTo(series.outputDir, ref));
      locationNote = ` Location: ${location.description}`
        + (location.lightingNotes ? ` Lighting: ${location.lightingNotes}.` : '')
        + (location.spatialAnchors ? ` Fixed layout (never rearrange): ${location.spatialAnchors}.` : '');
    }
  }

  return {
    prompt: imagePrompt.prompt + locationNote,
    negativePrompt: imagePrompt.negativePrompt,
    seed: imagePrompt.seed,
    generationModel: series.videoDefaults.imageDefaults?.generationModel ?? DEFAULT_IMAGE_GENERATION_MODEL,
    editModel: series.videoDefaults.imageDefaults?.editModel ?? DEFAULT_IMAGE_EDIT_MODEL,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    referenceImages,
    sceneImagePaths: shot.sceneImagePaths,
    sceneRefDescription: shot.sceneRefDescription,
    skipRefine: shot.skipRefine,
  };
}

export function shotIdOf(shot: ShotScript): string {
  return `${shot.shotNumber}${shot.shotIdSuffix ?? ''}`;
}

export function panelSha256(panelPath: string): string | undefined {
  if (!existsSync(panelPath)) return undefined;
  return sha256Hex(readFileSync(panelPath));
}

/** The binding to record for one shot at approval time. `undefined` when the panel is missing. */
export function approvalForShot(series: SeriesState, shot: ShotScript, panelDir: string): ShotApproval | undefined {
  const hash = panelSha256(panelFileForShot(panelDir, shotIdOf(shot)));
  if (!hash) return undefined;
  return { panelSha256: hash, settingsDigest: settingsDigest(panelSettingsForShot(series, shot)) };
}

/**
 * Check every shot against the recorded approval. Returns only the shots that
 * do not match. An artifact with no `shots` map (written before this binding
 * existed) reports every shot as `not-recorded`.
 */
export function verifyApproval(
  artifact: ApprovalArtifact,
  series: SeriesState,
  shots: ShotScript[],
  panelDir: string,
): ApprovalCheck[] {
  const out: ApprovalCheck[] = [];
  for (const shot of shots) {
    const key = shotKey(shotIdOf(shot));
    const mismatches = compareApproval(artifact.shots?.[key], {
      panelSha256: panelSha256(panelFileForShot(panelDir, shotIdOf(shot))),
      settingsDigest: settingsDigest(panelSettingsForShot(series, shot)),
    });
    if (mismatches.length > 0) out.push({ shotKey: key, shotNumber: shot.shotNumber, mismatches });
  }
  return out;
}

export function describeMismatch(m: ApprovalMismatch): string {
  switch (m.kind) {
    case 'panel-missing': return 'panel file is missing';
    case 'panel-changed': return 'panel was regenerated or edited after approval';
    case 'settings-changed': return 'prompt, references or image model changed after approval';
    case 'not-recorded': return 'approval predates per-shot binding (or shot was added after approval)';
  }
}
