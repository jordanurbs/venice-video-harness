// This module's implementation moved to src/mini-drama/timeline-export/.
// The exports below stay here as a stable re-export surface so existing
// callers don't break.

export {
  exportFcpxml,
  toRationalTime,
  type FcpxmlSegment,
  type FcpxmlAudioClip,
  type FcpxmlExportOptions,
} from './timeline-export/index.js';
