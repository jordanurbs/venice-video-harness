// EXT-15: timeline-export barrel.
//
// Single import point for all three exporters + shared types.

export type {
  TimelineSegment,
  TimelineAudioClip,
  TimelineExportOptions,
  // Back-compat (FCPXML-specific) aliases.
  FcpxmlSegment,
  FcpxmlAudioClip,
  FcpxmlExportOptions,
} from './types.js';

export {
  toRationalTime,
  toFrames,
  pathToFileUri,
  xmlEscape,
  probeAudioInfo,
  segmentContaining,
} from './probe.js';

export { exportFcpxml } from './fcpxml.js';
export { exportPremiereXml } from './premiere-xmeml.js';
export { exportDavinciFcpxml } from './davinci-fcpxml.js';

export type TimelineExportFormat = 'fcpxml' | 'premiere' | 'davinci';

import type { TimelineExportOptions } from './types.js';
import { exportFcpxml } from './fcpxml.js';
import { exportPremiereXml } from './premiere-xmeml.js';
import { exportDavinciFcpxml } from './davinci-fcpxml.js';

/**
 * Dispatch by format. Used by the CLI command so the exporter selection
 * lives in one place.
 */
export async function exportTimeline(
  format: TimelineExportFormat,
  opts: TimelineExportOptions,
): Promise<string> {
  switch (format) {
    case 'fcpxml': return exportFcpxml(opts);
    case 'premiere': return exportPremiereXml(opts);
    case 'davinci': return exportDavinciFcpxml(opts);
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = format;
      throw new Error(`Unknown timeline export format: ${_exhaustive}`);
    }
  }
}
