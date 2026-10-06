export { VeniceClient, VeniceRequestError } from './venice/client.js';
export { generateVideo, quoteVideo } from './venice/video.js';
export { listVideoModels, getVideoModel } from 'venice-video-harness/core/venice/models.js';
export { createSeries, loadSeries, saveSeries, listSeries } from './series/manager.js';
export type { SeriesState, EpisodeScript, ShotScript } from 'venice-video-harness/core/series/types.js';
export { upscaleVideo, estimateUpscaleCostUsd, TOPAZ_VIDEO_UPSCALE_MODEL } from './venice/upscale.js';
export {
  buildCapabilitiesManifest,
  renderCapabilitiesManifest,
  CAPABILITIES_SCHEMA_VERSION,
} from 'venice-video-harness/core/venice/capabilities-manifest.js';
export type { CapabilitiesManifest } from 'venice-video-harness/core/venice/capabilities-manifest.js';
