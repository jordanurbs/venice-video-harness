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
import { DEFAULT_INTELLIGENCE_MODEL } from '../venice/text-models.js';
import { buildVideoPrompt, type MiniDramaVideoPrompt } from './prompt-builder.js';
import { renderVideoFile, extractLastFrame, type RenderVideoOptions } from './video-generator.js';

/** The render primitive, injectable so tests can drive the engine offline. */
export type RenderFn = (client: VeniceClient, options: RenderVideoOptions) => Promise<string>;

/** The writer primitive, injectable so tests can author beats offline. */
export type AuthorFn = (input: AuthorInput) => Promise<AuthoredBeat>;

// MiniMax H3 Max Turbo lanes: the cheapest, fastest i2v chain in the registry.
export const STREAM_MODEL_T2V = 'minimax-h3-max-turbo-text-to-video';
export const STREAM_MODEL_I2V = 'minimax-h3-max-turbo-image-to-video';
export const STREAM_DEFAULT_DURATION = '15s';
export const STREAM_DEFAULT_BUDGET_USD = 2.0;
export const STREAM_DEFAULT_RESOLUTION = '480P';
/** How many recent beats the writer sees verbatim; older ones live in the summary. */
export const STREAM_RECENT_BEATS = 6;

const TURBO_USD_PER_SEC = 0.012;
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
  lane: 't2v' | 'i2v';
  costUsd: number;
  at: string;
}

export type StreamStatus = 'idle' | 'writing' | 'rendering' | 'error';

export interface StreamManifest {
  version: number;
  episode: number;
  model: { t2v: string; i2v: string; writer: string };
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
  /** Intelligence model that writes beats. Defaults to series.intelligence or the harness default. */
  writerModel?: string;
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
  private readonly writerModel: string;
  private readonly streamDir: string;
  private readonly resolution: string;
  private readonly duration: string;
  private readonly initialBudgetUsd: number;
  private readonly direction?: string;
  private readonly openingBeat?: AuthoredBeat;
  private readonly broadcaster?: StreamBroadcaster;
  private readonly log: (line: string) => void;
  private readonly render: RenderFn;
  private readonly author: AuthorFn;
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
    this.writerModel = options.writerModel ?? options.series.intelligence?.model ?? DEFAULT_INTELLIGENCE_MODEL;
    this.streamDir = join(options.episodeDir, 'stream');
    this.resolution = options.resolution ?? STREAM_DEFAULT_RESOLUTION;
    this.duration = this.resolveDuration(options.duration ?? STREAM_DEFAULT_DURATION);
    this.unbounded = options.unbounded ?? false;
    this.initialBudgetUsd = options.budgetUsd ?? STREAM_DEFAULT_BUDGET_USD;
    this.budgetUsd = this.unbounded ? Infinity : this.initialBudgetUsd;
    this.direction = options.direction;
    this.openingBeat = options.openingBeat;
    this.broadcaster = options.broadcaster;
    this.log = options.log ?? ((line: string) => console.log(line));
    this.render = options.render ?? renderVideoFile;
    this.author = options.author ?? makeChatAuthor(this.client, this.writerModel);
    this.errorBackoffMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
  }

  private resolveDuration(requested: string): string {
    const sec = durationSeconds(requested);
    const snapped = closestValidDuration(STREAM_MODEL_T2V, sec);
    if (snapped && snapped !== `${sec}s`) {
      this.log(`  Stream duration ${requested} snapped to ${snapped} (H3 Max 5-15s ladder).`);
    }
    return snapped ?? requested;
  }

  private costPerBeat(): number {
    return TURBO_USD_PER_SEC * durationSeconds(this.duration);
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
    this.log(`Priming: writing and rendering the opening beat, then waiting for Start. writer=${this.writerModel}, video=${STREAM_MODEL_T2V}, ${this.resolution}, ${this.duration}.`);
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
    this.log(`Stream engine running: writer=${this.writerModel}, video=${STREAM_MODEL_T2V} then ${STREAM_MODEL_I2V} chained, ${this.resolution}, ${this.duration}/beat, budget=${this.unbounded ? 'unbounded' : `$${this.budgetUsd.toFixed(2)}`}.`);
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

    let lane: 't2v' | 'i2v' = 't2v';
    let anchorImagePath: string | undefined;
    if (previous) {
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

    const shot = this.toShot(n, beat);
    const prompt = this.buildPrompt(shot, lane === 'i2v' ? STREAM_MODEL_I2V : STREAM_MODEL_T2V);
    this.spendUsd += est;
    this.log(`  [stream] beat ${n} rendering: ${lane} ${prompt.model} @ ${this.resolution}, ${this.duration}`);

    try {
      await this.render(this.client, {
        prompt,
        outputPath,
        anchorImagePath,
        resolution: this.resolution,
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

  private toShot(n: number, beat: AuthoredBeat): ShotScript {
    return {
      shotNumber: n,
      type: beat.dialogue ? 'dialogue' : 'action',
      duration: this.duration,
      videoModel: 'action',
      description: beat.description,
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
          actionModel: STREAM_MODEL_T2V,
          atmosphereModel: STREAM_MODEL_T2V,
          characterConsistencyModel: STREAM_MODEL_T2V,
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
      model: { t2v: STREAM_MODEL_T2V, i2v: STREAM_MODEL_I2V, writer: this.writerModel },
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
