export { VeniceClient, VeniceRequestError } from './venice/client.js';
export { generateVideo, quoteVideo } from './venice/video.js';
export { listVideoModels, getVideoModel } from './venice/models.js';
export {
  supportsCameraTrajectory,
  validateCameraTrajectory,
  buildOrbitTrajectory,
  buildStartEndTrajectory,
  CAMERA_TRAJECTORY_MIN_KEYFRAMES,
  CAMERA_TRAJECTORY_MAX_KEYFRAMES,
  CAMERA_MAX_AZIMUTH_TURNS,
  CAMERA_MAX_AZIMUTH_TRAVEL_DEG,
} from './venice/models.js';
export type { CameraKeyframe, CameraRamp, OrbitTrajectoryOptions } from './venice/models.js';
export { createSeries, loadSeries, saveSeries, listSeries } from './series/manager.js';
export type { SeriesState, EpisodeScript, ShotScript } from './series/types.js';
export { upscaleVideo, estimateUpscaleCostUsd, TOPAZ_VIDEO_UPSCALE_MODEL } from './venice/upscale.js';
export {
  buildCapabilitiesManifest,
  renderCapabilitiesManifest,
  CAPABILITIES_SCHEMA_VERSION,
} from './venice/capabilities-manifest.js';
export type { CapabilitiesManifest } from './venice/capabilities-manifest.js';
