// ---------------------------------------------------------------------------
// @venice-video-harness/core -- the pure half of the harness.
//
// Plain data in, plain data out. Nothing in this package touches the
// filesystem, the network, `process.env`, `Buffer`, ffmpeg or `sharp`;
// `tests/core-purity.test.mjs` enforces that. It runs in Node and in a
// browser bundler with no polyfills. The CLI imports from here; a browser app
// imports the same code via the `venice-video-harness/core` subpath.
//
// Subpath entries (`@venice-video-harness/core/venice/models` etc.) keep the
// original module boundaries for callers that want them; this barrel is the
// flat surface.
// ---------------------------------------------------------------------------

// Model registry: specs, capability predicates, request validation, prompt budgets.
export * from './venice/models.js';

// Venice wire types. `VideoElement` here is the snake_case request shape;
// the camelCase series-side shape of the same name is exported from
// series/types below, so the wire one is aliased in the barrel.
export type {
  InitImageMode,
  ImageGenerateRequest,
  GeneratedImage,
  ImageGenerateResponse,
  ImageEditRequest,
  ImageEditResponse,
  MultiEditModel,
  MultiEditRequest,
  ImageUpscaleRequest,
  BackgroundRemoveRequest,
  VideoQueueRequest,
  VideoQueueResponse,
  VideoRetrieveRequest,
  VideoRetrieveStatus,
  VideoQuoteRequest,
  VideoQuoteResponse,
  VideoCompleteRequest,
  SpeechRequest,
  AudioQueueRequest,
  AudioQueueResponse,
  AudioRetrieveRequest,
  AudioRetrieveStatus,
  CharacterReference,
  GenerateWithReferencesOptions,
  GenerateWithReferencesResult,
  VeniceApiError,
  VideoElement as VideoElementRequest,
} from './venice/types.js';

// Text / intelligence model catalogue.
export * from './venice/text-models.js';

// Silent-reject detection (byte-size thresholds by resolution).
export * from './venice/rejection.js';

// Capabilities manifest for downstream apps (version passed in by the host).
export * from './venice/capabilities-manifest.js';

// The series schema: SeriesState, EpisodeScript, ShotScript, defaults, capability sets.
export * from './series/types.js';
export * from './series/project-language.js';

// Agent-facing pipeline description and guide text.
export * from './agent/pipeline.js';
export * from './agent/guide.js';

// Wizard / stream choice tables.
export * from './mini-drama/choices.js';
export * from './mini-drama/stream-choices.js';
