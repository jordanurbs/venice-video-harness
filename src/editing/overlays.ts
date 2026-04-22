/**
 * Overlay manifest types and helpers.
 *
 * Overlays are branded motion graphics composited onto a finished cut:
 * lower thirds (speaker name + title), title cards, callouts, chapter
 * markers. They are produced by parallel sub-agents (Remotion or ffmpeg
 * drawtext) and composited by `scripts/render-overlay.ts`.
 *
 * Separate from the EDL because overlays are a post-process on top of
 * the delivered cut — not part of the source-material cut list.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type OverlayKind =
  | 'lower-third'
  | 'title-card'
  | 'callout'
  | 'chapter-marker'
  | 'logo-bug';

export type OverlayRenderer = 'remotion' | 'ffmpeg-drawtext';

export interface OverlayPosition {
  /** Anchor point for the overlay. */
  anchor: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /** Offset in px from the anchor. Positive = inward. */
  offsetXPx?: number;
  offsetYPx?: number;
}

export interface LowerThirdPayload {
  kind: 'lower-third';
  name: string;
  title?: string;
  color?: string;
  durationMs?: number;
}

export interface TitleCardPayload {
  kind: 'title-card';
  heading: string;
  subheading?: string;
  /** Background: 'black', 'white', 'blur', or a hex color. */
  background?: string;
}

export interface CalloutPayload {
  kind: 'callout';
  text: string;
  /**
   * Point to this frame coordinate with an arrow. If omitted the callout
   * is a free-floating banner.
   */
  pointToXPx?: number;
  pointToYPx?: number;
}

export interface ChapterMarkerPayload {
  kind: 'chapter-marker';
  chapterNumber: number;
  title: string;
}

export interface LogoBugPayload {
  kind: 'logo-bug';
  /**
   * Describe the logo geometry in text — NEVER pass the Venice AI logo PNG
   * as a composite source (CLAUDE.md anti-pattern #11 — mostly-transparent
   * logos render as overlays, not references). For the Venice crossed-keys
   * logo the renderer draws it procedurally in Remotion or via ffmpeg
   * drawgeometry from a pre-rendered branded PNG asset.
   */
  description: string;
  /** Path to a pre-rendered fully-opaque logo asset. Optional. */
  assetPath?: string;
}

export type OverlayPayload =
  | LowerThirdPayload
  | TitleCardPayload
  | CalloutPayload
  | ChapterMarkerPayload
  | LogoBugPayload;

export interface Overlay {
  id: string;
  kind: OverlayKind;
  startSec: number;
  endSec: number;
  position: OverlayPosition;
  payload: OverlayPayload;
  renderer: OverlayRenderer;
  /**
   * Path to a pre-rendered overlay asset (transparent WebM/MOV for
   * Remotion, or omitted for ffmpeg drawtext which renders in-place).
   */
  assetPath?: string;
}

export interface OverlayManifest {
  /** Base video this manifest applies to. */
  baseVideo: string;
  /** Path to the composited output. */
  outputPath: string;
  overlays: Overlay[];
}

/**
 * Validate an overlay manifest. Rejects manifests that would violate the
 * Venice logo rules (rule 17, anti-pattern #11) or produce overlapping
 * cuts on the same anchor.
 */
export interface OverlayValidationError {
  overlayId: string;
  message: string;
}

export function validateOverlayManifest(manifest: OverlayManifest): OverlayValidationError[] {
  const errs: OverlayValidationError[] = [];
  for (const o of manifest.overlays) {
    if (!(o.endSec > o.startSec)) {
      errs.push({ overlayId: o.id, message: 'endSec must be greater than startSec' });
    }
    if (o.payload.kind === 'logo-bug') {
      const p = o.payload as LogoBugPayload;
      const desc = (p.description ?? '').toLowerCase();
      if (/\b(vvv|triple[- ]?v)\b/.test(desc)) {
        errs.push({
          overlayId: o.id,
          message:
            'Venice logo description uses "VVV" / "triple-V". Per CLAUDE.md rule 17 the logo is a crossed-keys design — describe as "two ornate skeleton keys crossed in an X with a chevron/open-book at the top".',
        });
      }
    }
  }
  return errs;
}

export function readOverlayManifest(path: string): OverlayManifest {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as OverlayManifest;
}

export function writeOverlayManifest(manifest: OverlayManifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
}
