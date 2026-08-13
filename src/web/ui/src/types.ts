// Mirrors the server's src/web/state.ts + jobs.ts response shapes.

export interface ProjectListEntry {
  name: string;
  slug: string;
  dir: string;
}

export interface ShotMedia {
  key: string;
  shotNumber: number;
  panel?: string;
  clip?: string;
  dialogue?: string;
  qaVerdict?: string;
  qaIssues?: string[];
  /** Which identities were anchored to real reference bytes vs prompt text. */
  refUsage?: {
    base: string;
    anchored: string[];
    textOnly: string[];
  };
  /**
   * Panel-building reference images (character/location) this panel was made
   * from that no longer exist on disk — they were removed after the panel was
   * generated. Non-empty means the panel is stale and should be regenerated.
   */
  staleRefs?: string[];
}

export interface UnitMedia {
  unitId: string;
  file?: string;
  shotNumbers: number[];
  model?: string;
  prompt?: string;
}

export interface Dialogue {
  character: string;
  line: string;
}

export interface Shot {
  shotNumber: number;
  shotIdSuffix?: string;
  type: string;
  duration: string;
  description: string;
  panelDescription?: string;
  characters: string[];
  silhouetteCharacters?: string[];
  location?: string;
  blocking?: string;
  dialogue?: Dialogue | null;
  sfx?: string;
  cameraMovement?: string;
  transition?: string;
}

export interface EpisodeScript {
  episode: number;
  title: string;
  totalDuration: string;
  status?: string;
  shots: Shot[];
}

export interface EpisodeState {
  episode: number;
  script: EpisodeScript | null;
  scriptVersions: number[];
  qaReport: QaReport | null;
  videoQaReport: unknown;
  generationPlan: unknown;
  shots: ShotMedia[];
  units: UnitMedia[];
  finalCut?: string;
  music?: string;
}

export interface QaReport {
  summary?: {
    total?: number;
    pass?: number;
    flagCritical?: number;
    flagModerate?: number;
    flagLow?: number;
    errored?: number;
  };
  results?: Array<{
    shotNumber: number;
    verdict: string;
    issues?: string[];
    notes?: string;
  }>;
}

export interface EpisodeStatus {
  episode: number;
  title?: string;
  stage: string;
  nextCommand?: string;
  shotCount: number;
  panelCount: number;
  videoCount: number;
  dialogueCount: number;
  hasMusic: boolean;
  hasFinalCut: boolean;
  scriptApproved: boolean;
  qaReported: boolean;
  qaApproved: boolean;
  videoQaReported: boolean;
}

export interface ProjectStatus {
  projectDir: string;
  name: string;
  slug: string;
  aestheticSet: boolean;
  characterCount: number;
  lockedVoiceCount: number;
  locationCount: number;
  episodes: EpisodeStatus[];
  nextCommand?: string;
}

export interface SeriesInfo {
  name: string;
  slug: string;
  concept: string;
  genre: string;
  setting: string;
  projectType?: string;
  aesthetic: { style?: string; palette?: string } | null;
  episodes: Array<{ number: number; title: string; status: string }>;
}

export interface AngleArt {
  angle: string;
  image?: string;
  prompt?: string;
  /** Entity description changed since this art was generated (old look). */
  stale?: boolean;
}

export interface WorkshopDraft {
  status?: string;
  revision?: number;
  logline?: string;
  synopsis?: string;
  themes?: string[];
  structure?: Array<{ name: string; purpose: string; beats: string[] }>;
  aesthetic?: {
    style?: string;
    palette?: string;
    lighting?: string;
    lensCharacteristics?: string;
    filmStock?: string;
  };
  characters?: Array<{
    name: string;
    gender?: string;
    age?: string;
    description?: string;
    wardrobe?: string;
    voiceDescription?: string;
  }>;
  locations?: Array<{
    name: string;
    slug: string;
    description?: string;
    spatialAnchors?: string;
  }>;
  /** The draft's full shot script — production state only after approval. */
  script?: EpisodeScript;
  productionNotes?: {
    audioApproach?: string;
    continuityPriorities?: string[];
    risks?: string[];
    openQuestions?: string[];
  };
}

export interface ProjectState {
  series: SeriesInfo;
  status: ProjectStatus | null;
  workshop: WorkshopDraft | null;
  episodes: EpisodeState[];
  characters: Array<{
    name: string;
    dir: string;
    art: string[];
    angles: AngleArt[];
    gender?: string;
    age?: string;
    description?: string;
    wardrobe?: string;
    voiceLocked: boolean;
  }>;
  locations: Array<{ name: string; slug: string; art: string[]; angles: AngleArt[] }>;
}

export interface JobLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface JobRecord {
  id: string;
  project: string;
  command: string;
  args: string[];
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  lines: JobLine[];
}

export interface JobRequest {
  command: string;
  episode?: number;
  options?: Record<string, string>;
  flags?: string[];
}
