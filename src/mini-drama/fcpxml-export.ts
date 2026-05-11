// EXT-14 / EXT-15: this module's contents moved to
// src/mini-drama/timeline-export/. Keep this file as a stable re-export so
// existing callers (including pre-merge PR consumers) don't break.

export {
  exportFcpxml,
  toRationalTime,
  type FcpxmlSegment,
  type FcpxmlAudioClip,
  type FcpxmlExportOptions,
} from './timeline-export/index.js';
