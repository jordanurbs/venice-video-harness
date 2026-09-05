// ---------------------------------------------------------------------------
// Stream engine -- an infinite, live-authored story.
//
// This is NOT the loop. The loop takes a fixed plan and re-renders the same N
// shots forever so the playback cycles. The stream never repeats a shot and
// never renders a shot twice. It writes the story forward, one beat at a time:
//
//   beat 1  -> the intelligence model writes it from the series bible
//           -> renders t2v (the only render with no start frame)
//   beat 2  -> the model writes it from the bible + what has happened so far
//           -> renders i2v off beat 1's LAST frame
//   beat 3  -> i2v off beat 2's last frame
//   ...     -> forever, until stopped or the budget is reached
//
// The story is infinite; the playback is linear. A viewer starts at beat 1
// and plays forward. Every beat stays on disk in order (no ring buffer). There
// is no re-anchoring: each frame descends from the frame before it, so the
// picture evolves the way a very long single take would.
//
// Output lives under `episodes/episode-NNN/stream/`: `beat-NNNNN.mp4`,
// `beat-NNNNN.json` (the authored beat), `story-so-far.md` (the rolling memory
// the writer reads and appends to), and `stream-manifest.json`. Canonical
// `scene-001/` renders and series.json are never touched.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { VeniceClient } from '../venice/client.js';
import type { SeriesState, ShotScript } from '../series/types.js';
import { closestValidDuration } from '../venice/models.js';
import { buildVideoPrompt, type MiniDramaVideoPrompt } from './prompt-builder.js';
import { renderVideoFile, extractLastFrame, type RenderVideoOptions } from './video-generator.js';
import {
  STREAM_DEFAULT_WRITER,
  STREAM_VIDEO_CHOICES,
  STREAM_WRITER_CHOICES,
  getStreamVideoChoice,
  resolveStreamVideoFamily,
  writerDisablesThinking,
  type StreamVideoChoice,
} from './stream-choices.js';

/** The render primitive, injectable so tests can drive the engine offline. */
export type RenderFn = (client: VeniceClient, options: RenderVideoOptions) => Promise<string>;

/** The writer primitive, injectable so tests can author beats offline. */
export type AuthorFn = (input: AuthorInput) => Promise<AuthoredBeat>;

// Default lanes: MiniMax H3 Max Turbo, the cheapest and fastest i2v chain in
// the registry. Other families are selectable (see stream-choices.ts); every
// one of them is slower than playback.
export const STREAM_MODEL_T2V = 'minimax-h3-max-turbo-text-to-video';
export const STREAM_MODEL_I2V = 'minimax-h3-max-turbo-image-to-video';
export { STREAM_WRITER_CHOICES, STREAM_VIDEO_CHOICES, STREAM_DEFAULT_WRITER } from './stream-choices.js';
export const STREAM_DEFAULT_DURATION = '15s';
export const STREAM_DEFAULT_BUDGET_USD = 2.0;
export const STREAM_DEFAULT_RESOLUTION = '480P';
/** How many recent beats the writer sees verbatim; older ones live in the summary. */
export const STREAM_RECENT_BEATS = 6;

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'stream-manifest.json';
const STORY_FILE = 'story-so-far.md';
const ERROR_BACKOFF_MS = 5_000;
/** Stop after this many consecutive failures — a stream cannot skip a beat. */
const MAX_CONSECUTIVE_ERRORS = 3;
/**
 * When a chained render dies server-side, the START FRAME is the usual cause
 * (MiniMax i2v rejects some frames after billing — AGENTS.md anti-pattern 31).
 * Retrying the same frame is a guaranteed repeat. So each retry steps back
 * through the previous beat's clip by these offsets (seconds from the end) and
 * keeps the beat that was already written. A step of a second or two is
 * invisible in the story; a skipped beat is not.
 */
export const STREAM_CHAIN_STEP_BACK_SEC = [0, 0.5, 1.5, 3.0];
/**
 * How many chained (i2v) render failures on one beat before the engine gives
 * up on the chain for that beat and renders it t2v instead. A t2v beat is a
 * soft reset: the picture re-establishes from the beat text and the scene
 * memory, identity drifts for one beat, and the story keeps going. Without it a
 * single face-ending beat kills the whole stream (anti-pattern 31: MiniMax i2v
 * dies server-side on a face-bearing start frame, after billing). Two chained
 * attempts cover the 0s and 0.5s step-backs; a face that fills the frame for
 * the whole tail of a 15s clip does not leave in 3s either.
 */
export const STREAM_CHAIN_FAILURES_BEFORE_RESET = 2;

/** What the writer produces for one beat. A subset of ShotScript, plus memory. */
export interface AuthoredBeat {
  /** One or two sentences: what happens on screen. Present tense. */
  description: string;
  /** Who is on screen. Names must match series.characters. */
  characters: string[];
  dialogue: { character: string; line: string; delivery?: string } | null;
  /** Diegetic sound for this beat. */
  sfx: string | null;
  cameraMovement: string;
  /** One sentence for the story memory: what changed. */
  summary: string;
}

export interface AuthorInput {
  series: SeriesState;
  /** Beat number being written (1-based). */
  beatNumber: number;
  /** Rolling memory: summaries of every prior beat, oldest first. */
  storySoFar: string;
  /** The last few beats verbatim, oldest first. */
  recentBeats: StreamBeat[];
  /** Operator direction that applies to every beat (e.g. "laugh track"). */
  direction?: string;
}

export interface StreamBeat {
  n: number;
  /** Project-relative path to the beat mp4 (for /media URLs). */
  file: string;
  beat: AuthoredBeat;
  /** t2v-reset: a chained render failed repeatedly, so this beat re-established the picture from text. */
  lane: 't2v' | 'i2v' | 't2v-reset';
  costUsd: number;
  at: string;
}

export type StreamStatus = 'idle' | 'writing' | 'rendering' | 'error';

export interface StreamManifest {
  version: number;
  episode: number;
  model: { t2v: string; i2v: string; writer: string };
  /** Family key for the current video lanes (stream-choices.ts). */
  videoFamily: string;
  resolution: string;
  duration: string;
  budgetUsd: number;
  unbounded: boolean;
  spendUsd: number;
  running: boolean;
  status: StreamStatus;
  lastError?: string;
  /** Beat number currently being written/rendered, when status is not idle. */
  inFlight?: number;
  direction?: string;
  startedAt: string;
  updatedAt: string;
  beats: StreamBeat[];
  /** Selectable writers and video families, so the UI can offer them with speed/cost hints. */
  choices?: {
    writers: ReadonlyArray<{ id: string; label: string; medianSec: number; reliability: string; privacy: string; note: string }>;
    video: ReadonlyArray<{ id: string; label: string; usdPer15s: number; renderSecApprox: number; speed: string; resolutions: string[]; note: string }>;
  };
}

/** Structural subset of the web EventHub — avoids a mini-drama → web import. */
export interface StreamBroadcaster {
  broadcast(event: string, data: unknown): void;
}

export interface StreamEngineOptions {
  client: VeniceClient;
  series: SeriesState;
  episode: number;
  /** Absolute project directory (series.outputDir). */
  projectDir: string;
  /** Absolute episode directory (getEpisodeDir). */
  episodeDir: string;
  /** Project slug used in SSE payloads / media URLs. Defaults to series.slug. */
  slug?: string;
  /** Model that writes beats. Defaults to STREAM_DEFAULT_WRITER (fast), not the project's intelligence model. */
  writerModel?: string;
  /** Video family key or lane model id (stream-choices.ts). Defaults to MiniMax H3 Max Turbo. */
  videoFamily?: string;
  resolution?: string;
  duration?: string;
  budgetUsd?: number;
  /** No budget cap — stream until stopped. */
  unbounded?: boolean;
  /** Standing direction folded into every beat's writer prompt. */
  direction?: string;
  /** Optional opening beat, used verbatim for beat 1 instead of asking the writer. */
  openingBeat?: AuthoredBeat;
  broadcaster?: StreamBroadcaster;
  log?: (line: string) => void;
  /** Override the render primitive (tests). Defaults to renderVideoFile. */
  render?: RenderFn;
  /** Override the writer (tests). Defaults to a chatJson call on the writer model. */
  author?: AuthorFn;
  errorBackoffMs?: number;
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/');
}

function durationSeconds(duration: string): number {
  const n = Number.parseInt(duration, 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

function beatKey(n: number): string {
  return String(n).padStart(5, '0');
}

// ---- Writer ---------------------------------------------------------------

function describeCast(series: SeriesState): string {
  if (series.characters.length === 0) return '(no locked cast — invent recurring characters and keep them consistent)';
  return series.characters.map(c => {
    const bits = [c.description, c.wardrobe ? `wears ${c.wardrobe}` : '', c.voiceDescription ? `voice: ${c.voiceDescription}` : '']
      .filter(Boolean).join('; ');
    return `- ${c.name}: ${bits}`;
  }).join('\n');
}

export function buildStreamSystemPrompt(series: SeriesState, direction?: string): string {
  const aesthetic = series.aesthetic
    ? `${series.aesthetic.style}. Palette: ${series.aesthetic.palette}. Lighting: ${series.aesthetic.lighting}.`
    : '(no locked aesthetic)';
  return [
    `You are the head writer of "${series.name}", a never-ending ${series.genre}. You write ONE beat at a time. The story never ends and never resets.`,
    '',
    `CONCEPT: ${series.concept}`,
    `SETTING: ${series.setting || '(unspecified)'}`,
    `LOOK: ${aesthetic}`,
    '',
    'CAST (use these exact names in `characters` and `dialogue.character`):',
    describeCast(series),
    '',
    direction ? `STANDING DIRECTION (applies to every beat): ${direction}\n` : '',
    'RULES',
    '- CAMERA, MANDATORY: every beat ENDS on a wide or medium-wide shot of the whole set. Never end on a close-up of a human face. If a human is the last thing on screen, they are small in frame or turned away. (The next beat starts from this frame, and the video model rejects a start frame filled by a human face.) State this ending in `cameraMovement`.',
    '- Each beat is one continuous shot of about 15 seconds. It begins EXACTLY where the previous beat ended: same place, same people in frame, same moment. The camera does not cut. Never restart the scene, never jump in time or place unless a character physically walks somewhere within the shot.',
    '- Move the story forward every beat. Something new happens. Callbacks to earlier beats are good. Repeating a beat is not.',
    '- Describe what happens on screen in present tense, in one or two sentences. Direct the action, the performance, and the sound. Do NOT re-describe what the characters look like — identity is locked elsewhere.',
    '- Dialogue is a single speaker per beat, one or two short sentences, in character. It is intent, not a script: the actor will improvise around it.',
    '- `sfx` is diegetic sound only (no music). Keep it to one sentence.',
    '- `summary` is one sentence of story memory: what changed in this beat.',
    '- Keep the whole beat under 120 words.',
    '',
    'Return ONE JSON object and nothing else:',
    '{"description": string, "characters": string[], "dialogue": {"character": string, "line": string, "delivery": string} | null, "sfx": string | null, "cameraMovement": string, "summary": string}',
  ].filter(l => l !== undefined).join('\n');
}

export function buildStreamUserPrompt(input: AuthorInput): string {
  const recent = input.recentBeats.length === 0
    ? '(none — this is the opening beat; establish the place, the people, and the first spark of the story)'
    : input.recentBeats.map(b => {
      const d = b.beat.dialogue ? ` ${b.beat.dialogue.character}: "${b.beat.dialogue.line}"` : '';
      return `Beat ${b.n}: ${b.beat.description}${d}`;
    }).join('\n');
  return [
    `STORY SO FAR (one line per beat, oldest first):`,
    input.storySoFar.trim() || '(nothing yet)',
    '',
    `MOST RECENT BEATS, VERBATIM (the next beat continues from the LAST one, mid-moment):`,
    recent,
    '',
    `Write beat ${input.beatNumber}.`,
  ].join('\n');
}

/** Coerce a writer's output to the locked cast's spelling and a complete beat. */
export function normalizeBeat(raw: Partial<AuthoredBeat>, series: SeriesState): AuthoredBeat {
  const characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .map(c => String(c).trim())
    .filter(Boolean)
    .map(c => {
      const hit = series.characters.find(k => k.name.toUpperCase() === c.toUpperCase());
      return hit ? hit.name : c;
    });
  let dialogue: AuthoredBeat['dialogue'] = null;
  if (raw.dialogue && typeof raw.dialogue === 'object' && typeof raw.dialogue.line === 'string' && raw.dialogue.line.trim()) {
    const speaker = String(raw.dialogue.character ?? '').trim();
    const hit = series.characters.find(k => k.name.toUpperCase() === speaker.toUpperCase());
    dialogue = {
      character: hit ? hit.name : speaker,
      line: raw.dialogue.line.trim(),
      delivery: typeof raw.dialogue.delivery === 'string' ? raw.dialogue.delivery.trim() : undefined,
    };
    // The speaker is on screen.
    if (dialogue.character && !characters.includes(dialogue.character)) characters.push(dialogue.character);
  }
  const description = String(raw.description ?? '').trim();
  if (!description) throw new Error('Writer returned a beat with no description.');
  return {
    description,
    characters,
    dialogue,
    sfx: typeof raw.sfx === 'string' && raw.sfx.trim() ? raw.sfx.trim() : null,
    cameraMovement: typeof raw.cameraMovement === 'string' && raw.cameraMovement.trim() ? raw.cameraMovement.trim() : 'static',
    summary: String(raw.summary ?? description).trim(),
  };
}

/** Default writer: one chatJson call on the intelligence model. */
export function makeChatAuthor(client: VeniceClient, model: string): AuthorFn {
  return async (input) => {
    const raw = await client.chatJson<Partial<AuthoredBeat>>({
      model,
      systemPrompt: buildStreamSystemPrompt(input.series, input.direction),
      userPrompt: buildStreamUserPrompt(input),
      maxTokens: 1500,
      temperature: 0.8,
      label: `stream beat ${input.beatNumber}`,
      // A beat is a quick, in-character paragraph, not a reasoning task. With
      // thinking on the same model takes 3-10x longer (bakeoff, 2026-09-05).
      disableThinking: writerDisablesThinking(model),
    });
    return raw as AuthoredBeat;
  };
}

// ---- Engine ---------------------------------------------------------------

/**
 * Serial worker: write beat N, render it off beat N-1's last frame, persist,
 * repeat. One beat in flight at a time — the chain is inherently serial.
 */
export class StreamEngine {
  private readonly client: VeniceClient;
  private readonly series: SeriesState;
  private readonly episode: number;
  private readonly projectDir: string;
  private readonly episodeDir: string;
  private readonly slug: string;
  private writerModel: string;
  private readonly streamDir: string;
  private video: StreamVideoChoice;
  private resolution: string;
  private duration: string;
  private readonly initialBudgetUsd: number;
  private readonly direction?: string;
  private readonly openingBeat?: AuthoredBeat;
  private readonly broadcaster?: StreamBroadcaster;
  private readonly log: (line: string) => void;
  private readonly render: RenderFn;
  private author: AuthorFn;
  private readonly authorOverride?: AuthorFn;
  private readonly explicitWriter: boolean;
  private readonly explicitVideo: boolean;
  private readonly errorBackoffMs: number;

  private unbounded: boolean;
  private budgetUsd: number;
  private beats: StreamBeat[] = [];
  private spendUsd = 0;
  private startedAt = new Date().toISOString();
  private running = false;
  private workerActive = false;
  private status: StreamStatus = 'idle';
  private lastError?: string;
  private inFlight?: number;
  private consecutiveErrors = 0;
  /** The beat written for the in-flight number, kept across render retries. */
  private pendingBeat?: { n: number; beat: AuthoredBeat };
  /** Resolves the worker's paused wait when Start is clicked. */
  private wake?: () => void;
  /** True while prime() renders beat 1 with the worker otherwise paused. */
  private priming = false;

  constructor(options: StreamEngineOptions) {
    this.client = options.client;
    this.series = options.series;
    this.episode = options.episode;
    this.projectDir = options.projectDir;
    this.episodeDir = options.episodeDir;
    this.slug = options.slug ?? options.series.slug;
    this.explicitWriter = options.writerModel !== undefined;
    this.explicitVideo = options.videoFamily !== undefined;
    this.writerModel = options.writerModel ?? STREAM_DEFAULT_WRITER;
    this.streamDir = join(options.episodeDir, 'stream');
    this.video = resolveStreamVideoFamily(options.videoFamily);
    this.resolution = options.resolution ?? this.video.resolution;
    this.duration = this.resolveDuration(options.duration ?? STREAM_DEFAULT_DURATION);
    this.unbounded = options.unbounded ?? false;
    this.initialBudgetUsd = options.budgetUsd ?? STREAM_DEFAULT_BUDGET_USD;
    this.budgetUsd = this.unbounded ? Infinity : this.initialBudgetUsd;
    this.direction = options.direction;
    this.openingBeat = options.openingBeat;
    this.broadcaster = options.broadcaster;
    this.log = options.log ?? ((line: string) => console.log(line));
    this.render = options.render ?? renderVideoFile;
    this.authorOverride = options.author;
    this.author = options.author ?? makeChatAuthor(this.client, this.writerModel);
    this.errorBackoffMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
  }

  private resolveDuration(requested: string): string {
    const sec = durationSeconds(requested);
    const snapped = closestValidDuration(this.video.t2v, sec);
    if (snapped && snapped !== `${sec}s`) {
      this.log(`  Stream duration ${requested} snapped to ${snapped} (H3 Max 5-15s ladder).`);
    }
    return snapped ?? requested;
  }

  private costPerBeat(): number {
    // Quote-derived per-15s price for the family, scaled to the beat length.
    return this.video.usdPer15s * (durationSeconds(this.duration) / 15);
  }

  /**
   * Switch the writer and/or the video family. Applies to the NEXT beat; the
   * beat in flight finishes on the models it started with. The i2v chain is
   * unaffected by a family change — the start frame is a PNG, so any i2v lane
   * can pick it up. Resolution snaps to the new family's draft tier unless the
   * caller passes one that the family supports.
   */
  async configure(config: { writer?: string; videoFamily?: string; resolution?: string }): Promise<StreamManifest> {
    const changes: string[] = [];
    if (config.writer && config.writer !== this.writerModel) {
      this.writerModel = config.writer;
      if (!this.authorOverride) this.author = makeChatAuthor(this.client, this.writerModel);
      changes.push(`writer -> ${this.writerModel}`);
    }
    if (config.videoFamily && config.videoFamily !== this.video.id) {
      const next = resolveStreamVideoFamily(config.videoFamily);
      this.video = next;
      this.resolution = next.resolution;
      this.duration = this.resolveDuration(this.duration);
      changes.push(`video -> ${next.id} (${next.t2v} / ${next.i2v}) @ ${next.resolution || 'model default'}, ~$${this.costPerBeat().toFixed(2)}/beat`);
    }
    if (config.resolution) {
      const r = config.resolution;
      if (this.video.resolutions.length === 0 || this.video.resolutions.includes(r)) {
        if (r !== this.resolution) { this.resolution = r; changes.push(`resolution -> ${r}`); }
      } else {
        this.log(`  ⚠ ${this.video.id} does not support ${r}; keeping ${this.resolution}.`);
      }
    }
    if (changes.length > 0) {
      this.log(`Stream reconfigured (applies from beat ${this.beats.length + 1}${this.inFlight ? `, after beat ${this.inFlight} finishes` : ''}): ${changes.join('; ')}.`);
      await this.persist();
      this.emit();
    }
    return this.snapshot();
  }

  private budgetExhausted(): boolean {
    if (this.unbounded) return false;
    return this.spendUsd + this.costPerBeat() > this.budgetUsd + 1e-9;
  }

  // ---- Public API ---------------------------------------------------------

  async init(): Promise<void> {
    await this.loadManifest();
  }

  /**
   * Render the opening beat, then wait. Nothing else is queued until start()
   * is called (the operator clicks Start in the UI). Resolves once beat 1 is on
   * disk, or immediately if a beat already exists on disk. A new session
   * therefore opens the browser with one beat ready and the stream paused.
   */
  async prime(): Promise<StreamManifest> {
    if (this.beats.length > 0 || this.running || this.priming) return this.snapshot();
    this.priming = true;
    this.log(`Priming: writing and rendering the opening beat, then waiting for Start. writer=${this.writerModel}, video=${this.video.t2v}, ${this.resolution}, ${this.duration}.`);
    try {
      let ok = false;
      while (!ok && this.consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
        ok = await this.nextBeat();
      }
      if (!ok) this.log(`Priming failed after ${this.consecutiveErrors} attempts. Last error: ${this.lastError}`);
      else this.log('Opening beat ready. The stream is paused — click Start in the browser to continue the story.');
    } finally {
      this.priming = false;
      this.status = 'idle';
      this.inFlight = undefined;
      await this.persist();
      this.emit();
      // Start was clicked while priming: carry straight on.
      if (this.running && this.consecutiveErrors < MAX_CONSECUTIVE_ERRORS) void this.runWorker();
    }
    return this.snapshot();
  }

  async start(config?: { budgetUsd?: number; unbounded?: boolean }): Promise<StreamManifest> {
    if (config?.unbounded !== undefined) this.unbounded = config.unbounded;
    if (config?.budgetUsd !== undefined) this.budgetUsd = config.budgetUsd;
    if (this.unbounded) this.budgetUsd = Infinity;
    // Resume after a budget stop: each Start authorizes one more budget.
    if (!this.unbounded && config?.budgetUsd === undefined && this.budgetExhausted()) {
      this.budgetUsd = this.spendUsd + this.initialBudgetUsd;
      this.log(`Stream budget raised to $${this.budgetUsd.toFixed(2)} (was reached at $${this.spendUsd.toFixed(2)}).`);
    }
    if (this.running) return this.snapshot();
    this.running = true;
    this.consecutiveErrors = 0;
    this.lastError = undefined;
    this.log(`Stream engine running: writer=${this.writerModel}, video=${this.video.t2v} then ${this.video.i2v} chained, ${this.resolution}, ${this.duration}/beat, budget=${this.unbounded ? 'unbounded' : `$${this.budgetUsd.toFixed(2)}`}.`);
    if (this.beats.length > 0) this.log(`  Continuing from beat ${this.beats.length}.`);
    // If prime() is still rendering beat 1, the worker starts when it finishes.
    if (!this.priming) void this.runWorker();
    await this.persist();
    this.emit();
    return this.snapshot();
  }

  async stop(): Promise<StreamManifest> {
    this.running = false;
    this.wake?.();
    await this.persist();
    this.log('Stream engine stopped. The beat in flight will finish; no new beats will start.');
    return this.snapshot();
  }

  state(): StreamManifest {
    return this.snapshot();
  }

  // ---- Worker -------------------------------------------------------------

  private async runWorker(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;
    try {
      while (this.running) {
        if (this.budgetExhausted()) {
          this.running = false;
          this.log(`Stream budget reached ($${this.spendUsd.toFixed(2)} of $${this.budgetUsd.toFixed(2)}). Stopping. Start again to authorize more.`);
          await this.persist();
          break;
        }
        const ok = await this.nextBeat();
        if (!ok && this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.running = false;
          this.log(`Stream stopped after ${this.consecutiveErrors} consecutive failures. Last error: ${this.lastError}`);
          await this.persist();
          break;
        }
      }
    } finally {
      this.workerActive = false;
      this.status = 'idle';
      this.inFlight = undefined;
      await this.persist();
      this.emit();
    }
  }

  /** Write and render one beat. Returns false on failure. */
  private async nextBeat(): Promise<boolean> {
    const n = this.beats.length + 1;
    const previous = this.beats[this.beats.length - 1];
    this.inFlight = n;

    // 1. Write — unless this is a retry of a beat that was already written.
    //    A render failure is (almost always) the start frame, not the text, so
    //    the text is kept and only the frame changes below.
    let beat: AuthoredBeat;
    if (this.pendingBeat && this.pendingBeat.n === n) {
      beat = this.pendingBeat.beat;
    } else {
      this.status = 'writing';
      this.emit();
      try {
        if (n === 1 && this.openingBeat) {
          beat = this.openingBeat;
        } else {
          beat = normalizeBeat(await this.author({
            series: this.series,
            beatNumber: n,
            storySoFar: await this.readStory(),
            recentBeats: this.beats.slice(-STREAM_RECENT_BEATS),
            direction: this.direction,
          }), this.series);
        }
      } catch (err) {
        return this.fail(n, 'write', err);
      }
      this.pendingBeat = { n, beat };
      this.log(`  [stream] beat ${n} written: ${beat.description.slice(0, 110)}${beat.description.length > 110 ? '…' : ''}`);
    }

    // 2. Budget check with this beat's real cost. Venice bills at queue time.
    const est = this.costPerBeat();
    if (!this.unbounded && this.spendUsd + est > this.budgetUsd + 1e-9) {
      this.status = 'idle';
      this.inFlight = undefined;
      return true; // the worker loop sees budgetExhausted() and stops cleanly
    }

    // 3. Render: t2v for the opening beat, i2v off the previous last frame after.
    this.status = 'rendering';
    this.emit();
    const key = beatKey(n);
    const outputPath = join(this.streamDir, `beat-${key}.mp4`);
    await mkdir(this.streamDir, { recursive: true });

    let lane: StreamBeat['lane'] = 't2v';
    let anchorImagePath: string | undefined;
    const resetChain = Boolean(previous) && this.consecutiveErrors >= STREAM_CHAIN_FAILURES_BEFORE_RESET;
    if (previous && resetChain) {
      // The chain has failed repeatedly on this beat. The start frame is the
      // usual cause (anti-pattern 31), and stepping back has not found a frame
      // the model accepts. Re-establish the picture from text instead of
      // stopping the stream: a one-beat identity drift beats a dead stream.
      lane = 't2v-reset';
      this.log(`  [stream] beat ${n} reset: ${this.consecutiveErrors} chained renders failed; rendering t2v from the beat text (identity may drift this beat).`);
    } else if (previous) {
      const prevPath = join(this.projectDir, previous.file);
      const startFrame = join(this.streamDir, `beat-${key}-start.png`);
      // Retry N steps back N-th offset into the previous clip.
      const stepBack = STREAM_CHAIN_STEP_BACK_SEC[Math.min(this.consecutiveErrors, STREAM_CHAIN_STEP_BACK_SEC.length - 1)];
      try {
        extractLastFrame(prevPath, startFrame, stepBack);
        lane = 'i2v';
        anchorImagePath = startFrame;
        if (stepBack > 0) this.log(`  [stream] beat ${n} retry: start frame stepped back ${stepBack}s into beat ${previous.n}.`);
      } catch (err) {
        // A stream cannot break its chain silently — that would be a hidden cut.
        return this.fail(n, 'chain', err);
      }
    }

    const shot = this.toShot(n, beat, lane === 't2v-reset' ? previous : undefined);
    const prompt = this.buildPrompt(shot, lane === 'i2v' ? this.video.i2v : this.video.t2v);
    this.spendUsd += est;
    this.log(`  [stream] beat ${n} rendering: ${lane} ${prompt.model} @ ${this.resolution}, ${this.duration}`);

    try {
      await this.render(this.client, {
        prompt,
        outputPath,
        anchorImagePath,
        resolution: this.resolution || undefined,
        aspectRatio: this.series.storyboardAspectRatio,
        project: this.projectDir,
        episode: this.episode,
        forceRequeue: true,
      });
    } catch (err) {
      return this.fail(n, 'render', err);
    }

    // 4. Persist the beat, its JSON, and the story memory.
    const record: StreamBeat = {
      n,
      file: toPosix(relative(this.projectDir, outputPath)),
      beat,
      lane,
      costUsd: est,
      at: new Date().toISOString(),
    };
    this.beats.push(record);
    this.pendingBeat = undefined;
    this.consecutiveErrors = 0;
    this.lastError = undefined;
    this.status = 'idle';
    this.inFlight = undefined;
    try {
      await writeFile(join(this.streamDir, `beat-${key}.json`), JSON.stringify(record, null, 2), 'utf-8');
      await appendFile(join(this.streamDir, STORY_FILE), `${n}. ${beat.summary}\n`, 'utf-8');
    } catch (err) {
      this.log(`  ⚠ Could not write beat sidecar: ${(err as Error).message}`);
    }
    await this.persist();
    this.emit(record);
    return true;
  }

  private async fail(n: number, stage: 'write' | 'chain' | 'render', err: unknown): Promise<boolean> {
    this.status = 'error';
    this.lastError = `${stage}: ${err instanceof Error ? err.message : String(err)}`;
    this.consecutiveErrors += 1;
    this.inFlight = undefined;
    this.log(`  [stream] beat ${n} failed at ${stage} (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${this.lastError}`);
    await this.persist();
    this.emit();
    await new Promise(r => setTimeout(r, this.errorBackoffMs));
    return false;
  }

  // ---- Prompt -------------------------------------------------------------

  private toShot(n: number, beat: AuthoredBeat, restateFrom?: StreamBeat): ShotScript {
    // A t2v reset has no start frame, so the prompt must carry the scene the
    // chain was holding: where we are and who is there, from the previous beat.
    const restatement = restateFrom
      ? `Continuing the same scene, same place, same people as before (${restateFrom.beat.summary}). `
      : '';
    return {
      shotNumber: n,
      type: beat.dialogue ? 'dialogue' : 'action',
      duration: this.duration,
      videoModel: 'action',
      description: `${restatement}${beat.description}`,
      characters: beat.characters,
      dialogue: beat.dialogue,
      sfx: beat.sfx,
      cameraMovement: beat.cameraMovement,
      transition: 'continuous',
      faceVisible: beat.characters.length > 0,
      mustStaySingle: true,
    };
  }

  /**
   * Lean prompt through the harness's own builder with every lane pinned to a
   * simple-prompt model, so the H3 Max branch runs (no directorial blocks, no
   * reference tags, dialogue as improv intent). Falls back to a minimal prompt
   * when the series has no aesthetic yet.
   */
  private buildPrompt(shot: ShotScript, model: string): MiniDramaVideoPrompt {
    try {
      const leanSeries: SeriesState = {
        ...this.series,
        videoDefaults: {
          ...this.series.videoDefaults,
          actionModel: this.video.t2v,
          atmosphereModel: this.video.t2v,
          characterConsistencyModel: this.video.t2v,
          lipSyncModel: undefined,
          audioStrategy: 'native',
          voiceReferenceForDialogue: false,
        },
      };
      const vp = buildVideoPrompt(shot, leanSeries);
      return { prompt: vp.prompt, model, duration: this.duration, audio: true };
    } catch {
      const style = this.series.aesthetic?.style ? `${this.series.aesthetic.style}. ` : '';
      const camera = shot.cameraMovement ? `${shot.cameraMovement}. ` : '';
      const line = shot.dialogue ? ` ${shot.dialogue.character} says, in character: "${shot.dialogue.line}".` : '';
      const sfx = shot.sfx ? ` Sound of ${shot.sfx}.` : '';
      return { prompt: `${style}${camera}${shot.description}${line}${sfx}`.slice(0, 1500), model, duration: this.duration, audio: true };
    }
  }

  // ---- Story memory + manifest -------------------------------------------

  private async readStory(): Promise<string> {
    const path = join(this.streamDir, STORY_FILE);
    if (!existsSync(path)) return '';
    try { return await readFile(path, 'utf-8'); } catch { return ''; }
  }

  private manifestPath(): string {
    return join(this.streamDir, MANIFEST_FILE);
  }

  private snapshot(): StreamManifest {
    return {
      version: MANIFEST_VERSION,
      episode: this.episode,
      model: { t2v: this.video.t2v, i2v: this.video.i2v, writer: this.writerModel },
      videoFamily: this.video.id,
      resolution: this.resolution,
      duration: this.duration,
      budgetUsd: this.unbounded ? Infinity : this.budgetUsd,
      unbounded: this.unbounded,
      spendUsd: Number(this.spendUsd.toFixed(4)),
      running: this.running,
      status: this.status,
      lastError: this.lastError,
      inFlight: this.inFlight,
      direction: this.direction,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      beats: this.beats,
      choices: {
        writers: STREAM_WRITER_CHOICES.map(w => ({ id: w.id, label: w.label, medianSec: w.medianSec, reliability: w.reliability, privacy: w.privacy, note: w.note })),
        video: STREAM_VIDEO_CHOICES.map(v => ({ id: v.id, label: v.label, usdPer15s: v.usdPer15s, renderSecApprox: v.renderSecApprox, speed: v.speed, resolutions: v.resolutions, note: v.note })),
      },
    };
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.streamDir, { recursive: true });
      const json = JSON.stringify(this.snapshot(), (_k, v) => (v === Infinity ? null : v), 2);
      await writeFile(this.manifestPath(), json, 'utf-8');
    } catch (err) {
      this.log(`  ⚠ Could not write stream manifest: ${(err as Error).message}`);
    }
  }

  private async loadManifest(): Promise<void> {
    const path = this.manifestPath();
    if (!existsSync(path)) return;
    try {
      const prior = JSON.parse(await readFile(path, 'utf-8')) as Partial<StreamManifest>;
      this.spendUsd = typeof prior.spendUsd === 'number' ? prior.spendUsd : 0;
      if (prior.startedAt) this.startedAt = prior.startedAt;
      // A resumed stream keeps the models it was last running with, unless the
      // caller set them explicitly on this run.
      if (!this.explicitWriter && prior.model?.writer) {
        this.writerModel = prior.model.writer;
        if (!this.authorOverride) this.author = makeChatAuthor(this.client, this.writerModel);
      }
      if (!this.explicitVideo && prior.videoFamily && getStreamVideoChoice(prior.videoFamily)) {
        this.video = getStreamVideoChoice(prior.videoFamily)!;
        this.resolution = prior.resolution || this.video.resolution;
      }
      // Trust only beats whose files exist, and only an unbroken prefix — the
      // chain cannot continue from a beat whose predecessor is gone.
      const beats: StreamBeat[] = [];
      for (const b of (prior.beats ?? []).sort((a, c) => a.n - c.n)) {
        if (b.n !== beats.length + 1) break;
        if (!existsSync(join(this.projectDir, b.file))) break;
        beats.push(b);
      }
      this.beats = beats;
      this.log(`Resumed stream from ${MANIFEST_FILE}: ${beats.length} beats, spend $${this.spendUsd.toFixed(2)}.`);
    } catch (err) {
      this.log(`  ⚠ Could not read stream manifest: ${(err as Error).message}`);
    }
  }

  private emit(newBeat?: StreamBeat): void {
    this.broadcaster?.broadcast('stream-updated', {
      project: this.slug,
      episode: this.episode,
      status: this.status,
      running: this.running,
      inFlight: this.inFlight,
      lastError: this.lastError,
      spendUsd: Number(this.spendUsd.toFixed(4)),
      beatCount: this.beats.length,
      beat: newBeat,
    });
  }
}
