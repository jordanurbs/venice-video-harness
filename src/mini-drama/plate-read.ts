// ---------------------------------------------------------------------------
// Plate reading: what a vision pass over a location's real plates says about
// the shots staged on it. The harness defines the shape, the messages and the
// gates; a caller supplies the reader (workshop.ts `readPlates`), for example
// a library of shared location sets whose plates exist before the story does.
//
// Rule 46 applies: a shot the reader did not read (the call failed, the
// plates are not on disk, the answer left it out) is unchecked, never a pass.
// ---------------------------------------------------------------------------

import type { Location, PlateView, SeriesState } from 'venice-video-harness/core/series/types.js';
import type { VeniceClient } from '../venice/client.js';
import type { PlanShot } from './plan-check.js';

export interface PlateReadResult {
  shot: string;
  location: string;
  fits: boolean;
  /** The view that carries the shot, when one does. */
  view?: PlateView;
  /** What the shot needs that no view shows close enough. */
  missing?: string;
  reason?: string;
}

/** A shot the reader did not read. Not a pass: the plates may not carry it. */
export interface PlateReadUnchecked {
  shot: string;
  location: string;
  reason: string;
}

export interface PlateReadReport {
  results: PlateReadResult[];
  /** Locations the reader does not apply to, with why (a new place whose plates come from the shots). */
  skipped: string[];
  /** Shots on locations the reader applies to that it could not read. */
  unchecked?: PlateReadUnchecked[];
  model: string;
}

export interface PlateReadRequest {
  client: VeniceClient;
  series: SeriesState;
  /** The draft's places (and the project's): the reader picks the ones whose plates are fixed. */
  locations: Location[];
  shots: PlanShot[];
  visionModel: string;
}

/** Reads the plates of a draft's fixed locations and says, per shot, whether a view carries it. */
export type PlateReader = (request: PlateReadRequest) => Promise<PlateReadReport>;

export function plateMisfitMessage(result: PlateReadResult): string {
  return `Shot ${result.shot} does not fit the plates of ${result.location}${result.missing ? ` (missing: ${result.missing})` : ''}.${result.reason ? ` ${result.reason}` : ''} Stage it on a new location whose plates show it.`;
}

export function plateUncheckedMessage(entry: PlateReadUnchecked): string {
  return `Shot ${entry.shot} was not checked against the plates of ${entry.location}: ${entry.reason}.`;
}

export function describePlateRead(report: PlateReadReport): string[] {
  const lines: string[] = [];
  for (const result of report.results) if (!result.fits) lines.push(`✗ ${plateMisfitMessage(result)}`);
  for (const entry of report.unchecked ?? []) lines.push(`? ${plateUncheckedMessage(entry)}`);
  for (const note of report.skipped) lines.push(`  plate check skipped ${note}`);
  return lines;
}
