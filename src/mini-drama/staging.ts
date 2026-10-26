// ---------------------------------------------------------------------------
// Staging refs at render time: an edited plate or first frame a person picked
// for one shot with `stage-ref` (see stage-ref.ts for how they are made).
//
//   - `plate`: the picked image stands in for the view it was edited from in
//     the shot's references (reference-slots.ts; scene_image_urls on the lanes
//     that take them). The original view is not sent, so what the edit removed
//     cannot come back. A lane that sends no location reference (image-to-video
//     from the panel, text-to-video) cannot carry it: generate-videos refuses
//     the shot rather than render it without the pick.
//   - `start-frame`: the shot is re-generated i2v from the picked image
//     (prompt-builder.ts routes it to the family's image-to-video lane,
//     video-generator.ts sends it as image_url).
//
// A clip not rendered from the current pick is stale: generate-videos renders
// the shot again, and the old clip is archived when the new one lands.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SeriesState, ShotScript, ShotStagingRef } from 'venice-video-harness/core/series/types.js';

/** Absolute path of a staging ref's image. */
export function stagingRefPath(series: Pick<SeriesState, 'outputDir'>, ref: Pick<ShotStagingRef, 'path'>): string {
  return isAbsolute(ref.path) ? ref.path : join(series.outputDir, ref.path);
}

/** The shot's staged plate, when it has one on disk. */
export function stagedPlate(series: Pick<SeriesState, 'outputDir'>, shot: Pick<ShotScript, 'stagingRef'>): { path: string; ref: ShotStagingRef } | null {
  const ref = shot.stagingRef;
  if (!ref || ref.use !== 'plate') return null;
  const path = stagingRefPath(series, ref);
  return existsSync(path) ? { path, ref } : null;
}

/** The shot's staged first frame (absolute path), when it has one on disk. */
export function stagedStartFrame(series: Pick<SeriesState, 'outputDir'>, shot: Pick<ShotScript, 'stagingRef'>): string | null {
  const ref = shot.stagingRef;
  if (!ref || ref.use !== 'start-frame') return null;
  const path = stagingRefPath(series, ref);
  return existsSync(path) ? path : null;
}

/** What a render records about the staging ref it was made from (in the clip's .video.json). */
export function stagingMetadata(shot: Pick<ShotScript, 'stagingRef'>): { path: string; use: ShotStagingRef['use']; sha256: string } | undefined {
  const ref = shot.stagingRef;
  return ref ? { path: ref.path, use: ref.use, sha256: ref.sha256 } : undefined;
}

/**
 * The tag a staged shot's render carries on its pending-job record, so a
 * render queued before the pick (or for another pick) is told apart when it
 * is re-attached after an interruption.
 */
export function stagingJobTag(shot: Pick<ShotScript, 'stagingRef'>): string | undefined {
  return shot.stagingRef ? `staging:${shot.stagingRef.sha256}` : undefined;
}

/**
 * True when the shot has a staging ref and its clip was not rendered from it:
 * the clip's metadata does not name the picked image's hash (a clip from
 * before the pick, a montage cut, or a different pick).
 */
export function stagedClipIsStale(videoPath: string, shot: Pick<ShotScript, 'stagingRef'>): boolean {
  const ref = shot.stagingRef;
  if (!ref) return false;
  const metaPath = videoPath.replace(/\.mp4$/i, '.video.json');
  if (!existsSync(metaPath)) return true;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { metadata?: { stagingRef?: { sha256?: string } } };
    return meta.metadata?.stagingRef?.sha256 !== ref.sha256;
  } catch {
    return true;
  }
}
