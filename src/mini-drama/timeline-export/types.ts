// ---------------------------------------------------------------------------
// Format-neutral types shared by every timeline exporter.
//
// The three supported formats (FCPXML 1.10, Resolve-tuned FCPXML, Final
// Cut Pro 7 xmeml v5 for Premiere) all consume the same input shape — an
// ordered list of video segments and a flat list of audio clips, each
// tagged with a lane and a role. The exporter functions translate this
// neutral form into format-specific XML.
//
// Back-compat: `Fcpxml*` type aliases below mirror the previous names that
// lived in `src/mini-drama/fcpxml-export.ts`.
// ---------------------------------------------------------------------------

/** One video clip placed on the primary storyline. */
export interface TimelineSegment {
  /** Path to the video file (mp4). */
  path: string;
  /** Display label. */
  label: string;
  /** Duration in seconds. */
  durSec: number;
  /** Timeline start in seconds. */
  startSec: number;
}

/** One connected audio clip on a non-primary lane. */
export interface TimelineAudioClip {
  /** Path to the audio file (mp3/wav/m4a). */
  path: string;
  /** Display label. */
  label: string;
  /** Timeline start in seconds. */
  startSec: number;
  /** Duration in seconds. */
  audioDur: number;
  /** Lane number — always negative (connected below primary in FCPXML). */
  lane: -1 | -2 | -3;
  /** FCP X role. Premiere/Resolve exporters map this to their track-name conventions. */
  role: 'dialogue.dialogue' | 'effects.effects' | 'music.music';
}

/**
 * Format-neutral export options. Every exporter accepts the same shape
 * so the CLI command can dispatch via a `--format` flag without inventing
 * per-format option types.
 */
export interface TimelineExportOptions {
  outputPath: string;
  /** Video segments in spine order. Caller is responsible for ordering. */
  segments: TimelineSegment[];
  /** Connected audio clips. Order within a lane doesn't matter. */
  audio: TimelineAudioClip[];
  /** Total sequence duration. Defaults to the cumulative segment duration. */
  totalDurationSec?: number;
  /** Frames per second. Defaults to 24. */
  fps?: number;
  /** Sequence width in pixels. Defaults to 1920. */
  width?: number;
  /** Sequence height in pixels. Defaults to 1080. */
  height?: number;
  /** Library / event name. Defaults to "Episode". */
  eventName?: string;
  /** Project / sequence name. Defaults to `<eventName> — fine-tune`. */
  projectName?: string;
}

// ---- Back-compat aliases (FCPXML-specific names) --------------------------
// Old callers imported these names from src/mini-drama/fcpxml-export.ts.
// Keep the aliases here so the re-export module is a literal two-line file.

/** @deprecated Use TimelineSegment. */
export type FcpxmlSegment = TimelineSegment;
/** @deprecated Use TimelineAudioClip. */
export type FcpxmlAudioClip = TimelineAudioClip;
/** @deprecated Use TimelineExportOptions. */
export type FcpxmlExportOptions = TimelineExportOptions;
