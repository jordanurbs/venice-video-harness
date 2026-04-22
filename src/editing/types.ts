/**
 * Editing pipeline types.
 *
 * The editing pipeline is parallel to the generation pipeline. It consumes
 * existing video/audio files (either Venice-generated shots or raw footage),
 * transcribes them, produces an LLM-readable pack, then drives an EDL-based
 * cut with a self-evaluating QA loop.
 *
 * Design principle from browser-use/video-use: text is the primary surface;
 * pixels are consulted on demand via the timeline_view composite.
 */

// ---------------------------------------------------------------------------
// Transcription primitives
// ---------------------------------------------------------------------------

export interface WordTiming {
  /** The word as transcribed (may include punctuation attached by whisper). */
  word: string;
  /** Seconds from the start of the source file. */
  startSec: number;
  endSec: number;
  /** Optional confidence 0..1 from the transcriber. */
  confidence?: number;
}

export interface AudioEvent {
  /**
   * Event label e.g. `(laughter)`, `(applause)`, `(sigh)`, `(music)`.
   * Whisper.cpp does not emit these natively; aligner can inject them from
   * script cues (`shot.sfx`) for generated content.
   */
  label: string;
  startSec: number;
  endSec: number;
}

export interface TakePhrase {
  /**
   * Speaker label. For generated content this is the character name from
   * `shot.characters[0]`. For real footage it defaults to `S0` (single-
   * speaker). Pyannote integration in a future phase will populate this.
   */
  speaker: string;
  startSec: number;
  endSec: number;
  text: string;
  words: WordTiming[];
}

export interface Take {
  /**
   * Short opaque id used in `takes_packed.md` headings. Pattern `CNNNN`
   * (e.g. `C0103`) to match video-use. Generated from the source file name
   * hash + ordinal.
   */
  id: string;
  /** Absolute path to the source media file. */
  file: string;
  /** Total duration in seconds (from ffprobe). */
  durationSec: number;
  phrases: TakePhrase[];
  audioEvents: AudioEvent[];
  /** ISO timestamp when this take was transcribed. */
  transcribedAt: string;
  /** Transcriber that produced this take (e.g. `whisper-cpp:base.en`). */
  transcriber: string;
  /** Mode: pure ASR vs forced-aligned ground-truth script. */
  mode: 'asr' | 'aligned';
}

export interface TakesPack {
  takes: Take[];
  /** ISO timestamp when the pack was assembled. */
  generatedAt: string;
  /** Short description of the source folder. */
  sourceLabel: string;
}

// ---------------------------------------------------------------------------
// Transcriber provider interface
//
// Kept minimal so alternate providers (faster-whisper, OpenAI Whisper,
// ElevenLabs Scribe) can slot in later without changing callers.
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  /** Language code or 'auto' for detection. */
  language?: string;
  /** Whisper model size: tiny, base, small, medium, large. */
  modelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'tiny.en' | 'base.en' | 'small.en' | 'medium.en';
  /** Word-level timestamp threshold (whisper.cpp `--word-thold`). */
  wordThreshold?: number;
  /** Max cpu threads for whisper.cpp. */
  threads?: number;
}

export interface TranscribeResult {
  /** Per-word timings for the entire source. */
  words: WordTiming[];
  /** Full text (joined words, preserving whisper's punctuation). */
  text: string;
  /** Language detected. */
  language: string;
  /** Duration of the source in seconds (from ffprobe, not the transcriber). */
  durationSec: number;
  /** Human-readable transcriber label, e.g. `whisper-cpp:base.en`. */
  transcriberLabel: string;
}

export interface TranscriberProvider {
  /** Unique id for this provider, used in Take.transcriber. */
  readonly id: string;
  /**
   * Transcribe a single audio or video file. Callers are responsible for
   * audio extraction; providers should accept any file ffmpeg can decode.
   */
  transcribe(file: string, options?: TranscribeOptions): Promise<TranscribeResult>;
  /**
   * Check that the provider's dependencies are available (binary on PATH,
   * API key present, etc.). Throws with a helpful install message if not.
   */
  assertAvailable(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Edit Decision List (EDL)
//
// JSON-serializable so the LLM can read/modify it as part of the
// edit-footage command.
// ---------------------------------------------------------------------------

export type EdlTransition = 'cut' | 'crossfade' | 'fade-to-black';

export interface EdlClip {
  /** Source take id (matches Take.id). */
  sourceId: string;
  /** Seconds into the source where this clip starts. */
  startSec: number;
  endSec: number;
  /** Trim extra frames off the head/tail (applied on top of start/end). */
  trimStartMs?: number;
  trimEndMs?: number;
  /** Transition entering this clip (from previous clip). Default 'cut'. */
  transitionIn?: EdlTransition;
  /** Transition leaving this clip (to next clip). Default 'cut'. */
  transitionOut?: EdlTransition;
  /** Transition duration when crossfade/fade-to-black. Default 250ms. */
  transitionMs?: number;
  /**
   * Optional human-readable note from the LLM explaining why this clip was
   * included. Preserved through re-renders for audit.
   */
  rationale?: string;
}

export interface EdlColorGrade {
  /** Named grade preset, e.g. `warm-cinematic`, `neutral-punch`. */
  preset?: string;
  /** Raw ffmpeg filter chain (e.g. `eq=contrast=1.05:saturation=1.1`). */
  filter?: string;
}

export interface Edl {
  clips: EdlClip[];
  /** Global audio fade at every cut boundary (video-use's "no pops" rule). */
  audioFadeMs: number;
  /** Optional global color grade applied to every clip. */
  colorGrade?: EdlColorGrade;
  /** Target container / codec settings. */
  output: {
    width?: number;
    height?: number;
    fps?: number;
    videoCodec: string;
    audioCodec: string;
    crf: number;
  };
}

// ---------------------------------------------------------------------------
// Edit Session (persistent memory, analogous to video-use's project.md)
// ---------------------------------------------------------------------------

export interface CutQaFinding {
  kind:
    | 'visual-jump'
    | 'aspect-regression'
    | 'subtitle-overlap'
    | 'vo-truncation'
    | 'lighting-discontinuity'
    | 'audio-pop';
  /** Trailer-time seconds where the issue was observed. */
  atSec: number;
  /** Which EDL clip index(es) triggered the finding. */
  clipIndex?: number;
  severity: 'warn' | 'fail';
  message: string;
  /** Path to a timeline_view composite illustrating the issue. */
  evidencePath?: string;
}

export interface CutQaReport {
  iteration: number;
  generatedAt: string;
  findings: CutQaFinding[];
  passed: boolean;
}

export interface EditSession {
  project: string;
  sourcesDir: string;
  editDir: string;
  takesPackPath: string;
  sources: string[];
  edl: Edl;
  iterations: CutQaReport[];
  createdAt: string;
  updatedAt: string;
}
