// ---------------------------------------------------------------------------
// Inline thumbnails for the treatment page.
//
// WORKSHOP.html is a plain file the operator opens from disk, and browsers
// refuse to load `file://` subresources from it. So every image the page shows
// -- creative references, storyboard panels, rendered clips -- is embedded as a
// self-contained `data:image/webp` URI. That also means the page survives being
// moved, zipped, or emailed.
//
// Encoding is the expensive part, and the page is rewritten after every
// pipeline step, so results are cached on disk keyed by path + mtime + size.
// A panel is only re-encoded when it is actually regenerated.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/** Longest edge, in pixels, for a reference or gallery thumbnail. */
export const REFERENCE_THUMBNAIL_PX = 640;
/** Panels sit in a table cell, so they need far less. */
export const PANEL_THUMBNAIL_PX = 384;

/** Inline previews keyed by the source file's absolute path. */
export type Thumbnails = ReadonlyMap<string, string>;

export async function encodeThumbnail(input: string | Buffer, edge: number): Promise<string> {
  const webp = await sharp(input)
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  return `data:image/webp;base64,${webp.toString('base64')}`;
}

/** Grabs a frame half a second in, which skips fade-ups and black leaders. */
export function extractVideoPoster(path: string): Buffer | undefined {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-ss', '0.5', '-i', path, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout?.length) return undefined;
  return result.stdout;
}

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  edge: number;
  dataUri: string;
}

const CACHE_FILE = '.treatment-thumbs.json';

/**
 * Disk-backed thumbnail cache scoped to one project directory.
 *
 * Every lookup is best-effort: an unreadable file, an exotic codec, or a
 * missing ffmpeg yields `undefined` and the caller falls back to showing a
 * path. Nothing here should ever fail a production command.
 */
export class ThumbnailCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  private constructor(private readonly cachePath?: string) {}

  /** In-memory only. For callers with no project directory to persist into. */
  static ephemeral(): ThumbnailCache {
    return new ThumbnailCache();
  }

  static async open(projectDir: string): Promise<ThumbnailCache> {
    const cachePath = join(projectDir, CACHE_FILE);
    const cache = new ThumbnailCache(cachePath);
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf-8')) as Record<string, CacheEntry>;
      for (const [path, entry] of Object.entries(raw)) cache.entries.set(path, entry);
    } catch {
      // No cache yet, or it was corrupted. Rebuild from scratch.
    }
    return cache;
  }

  /**
   * Thumbnail for one file. Videos are posterized with ffmpeg first; anything
   * sharp can decode is resized directly.
   */
  async get(path: string, edge: number, kind: 'image' | 'video' = 'image'): Promise<string | undefined> {
    if (!existsSync(path)) return undefined;
    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }

    const cached = this.entries.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size && cached.edge === edge) {
      return cached.dataUri;
    }

    try {
      const input = kind === 'video' ? extractVideoPoster(path) : path;
      if (!input) return undefined;
      const dataUri = await encodeThumbnail(input, edge);
      this.entries.set(path, { mtimeMs: info.mtimeMs, sizeBytes: info.size, edge, dataUri });
      this.dirty = true;
      return dataUri;
    } catch {
      return undefined;
    }
  }

  /** Drops entries for files that no longer exist, then writes if anything changed. */
  async save(): Promise<void> {
    if (!this.cachePath) return;
    for (const path of [...this.entries.keys()]) {
      if (!existsSync(path)) {
        this.entries.delete(path);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    try {
      await writeFile(this.cachePath, JSON.stringify(Object.fromEntries(this.entries)), 'utf-8');
      this.dirty = false;
    } catch {
      // A cache we cannot persist just means the next refresh re-encodes.
    }
  }
}
