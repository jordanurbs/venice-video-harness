// ---------------------------------------------------------------------------
// Loop preview engine -- the "infinite loop" mode.
//
// After a plan exists (an approved EpisodeScript), this renders each shot into a
// dedicated `loop/` directory and keeps regenerating fresh takes forever
// (bounded by a budget / max-takes / --once), so the browser can watch the
// whole plan on repeat while new takes hot-swap in as they finish. Two modes:
//
//   watch  (enjoyment / creative flow, default) — MiniMax H3 Max **Turbo** at
//     480P: the first generation is t2v, every shot after it chains i2v off the
//     previous shot's last frame, and it NEVER uses R2V (too slow for a loop).
//     The cheapest, fastest lane; renders faster than it plays. Identity is not
//     locked — it is a fun continuous loop, not a production render.
//   create (gather good shots for a project) — MiniMax H3 Max (non-Turbo) at
//     768P, using the SAME reference-first routing as the real pipeline:
//     character shots render on `minimax-h3-max-reference-to-video` with the
//     full @Image reference stack (character sheets, location angles, blocking
//     plate) + voice-donor audio, so identity IS locked and the takes are
//     usable. Renders each shot independently (no chaining — R2V and a start
//     frame can't combine on MiniMax). Shots with no references degrade to
//     i2v (off a panel) or t2v.
//
// Both modes SKIP the storyboard/QA gates and write ONLY under `loop/`;
// canonical `scene-001/shot-NNN.mp4` renders and series.json are never touched.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { VeniceClient } from '../venice/client.js';
import type { EpisodeScript, SeriesState, ShotScript, VideoElement } from '../series/types.js';
import { getVideoModel, closestValidDuration, i2vRejectsFaceStartFrame } from '../venice/models.js';
import { buildVideoPrompt, type MiniDramaVideoPrompt } from './prompt-builder.js';
import {
  renderVideoFile,
  resolveShotReferenceInputs,
  ensureVoiceReferenceForShot,
  extractLastFrame,
  type RenderVideoOptions,
} from './video-generator.js';
import { shotKey } from './treatment.js';

/** The render primitive, injectable so tests can drive the scheduler offline. */
export type RenderFn = (client: VeniceClient, options: RenderVideoOptions) => Promise<string>;

/** watch = fast disposable Turbo draft; create = identity-locked Max R2V. */
export type LoopMode = 'watch' | 'create';

// MiniMax H3 Max Turbo lanes (watch mode). Turbo has NO reference-to-video
// model, so identity shots fall back to text-to-video here.
export const LOOP_MODEL_T2V = 'minimax-h3-max-turbo-text-to-video';
export const LOOP_MODEL_I2V = 'minimax-h3-max-turbo-image-to-video';
// MiniMax H3 Max (non-Turbo) lanes (create mode). The R2V lane locks identity
// from the reference stack; i2v/t2v are the atmosphere / no-reference fallbacks.
export const CREATE_MODEL_R2V = 'minimax-h3-max-reference-to-video';
export const CREATE_MODEL_I2V = 'minimax-h3-max-image-to-video';
export const CREATE_MODEL_T2V = 'minimax-h3-max-text-to-video';
// Always render the model's full length. MiniMax H3 Max tops out at 15s, and a
// longer clip means more usable footage per render and more playback per render
// (the loop plays longer between regenerations).
export const LOOP_DEFAULT_DURATION = '15s';
export const LOOP_DEFAULT_BUDGET_USD = 2.0;
// Candidate takes KEPT per shot (a ring buffer, not a stop condition): the loop
// regenerates forever until budget/stop; older non-current takes are pruned.
export const LOOP_DEFAULT_MAX_TAKES = 3;

/** The i2v lane for a mode — used when chaining a shot off the previous frame. */
function i2vModelFor(mode: LoopMode): string {
  return mode === 'create' ? CREATE_MODEL_I2V : LOOP_MODEL_I2V;
}

/** Default draft resolution per mode: 480P for watch, 768P (finish) for create. */
export function defaultLoopResolution(mode: LoopMode): string {
  return mode === 'create' ? '768P' : '480P';
}

// Per-second prices at 480P/768P (README "MiniMax H3 Max" rows). The video
// registry carries no price field, so these are pinned here for the budget
// guard's spend estimate: Turbo $0.012/s (watch), Max $0.024/s (create).
const TURBO_USD_PER_SEC = 0.012;
const MAX_USD_PER_SEC = 0.024;

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'loop-manifest.json';
/** Backoff after a failed take so a persistent error can't spin the worker. */
const ERROR_BACKOFF_MS = 5_000;
/**
 * Give up on a shot after this many CONSECUTIVE render failures and stop
 * re-selecting it, so a server-side-doomed shot (e.g. a MiniMax i2v start frame
 * with a face — see AGENTS.md anti-pattern 31) can't be re-queued and re-billed
 * every cycle until the whole budget is burned. A manual `regenerate` clears it.
 */
const MAX_CONSECUTIVE_SHOT_ERRORS = 3;
/**
 * Appended to a chained shot's prompt so it ENDS on the character's face, which
 * makes the next clip's i2v continuation smoother. Suppressed automatically when
 * the chain i2v model rejects face start frames (MiniMax — it would kill the
 * next render; see `i2vRejectsFaceStartFrame`).
 */
const FACE_CONTINUITY_NOTE =
  'End the shot with the main character\'s face clearly visible and facing camera, '
  + 'so the next clip can continue smoothly from that frame.';

export interface LoopTake {
  n: number;
  /** Project-relative path to the take mp4 (for /media URLs). */
  file: string;
  costUsd: number;
  at: string;
}

export type LoopShotStatus = 'idle' | 'rendering' | 'ready' | 'error';

export interface LoopShotState {
  shotNumber: number;
  key: string;
  status: LoopShotStatus;
  /** 1-based take number currently promoted for playback, or null if none yet. */
  currentTake: number | null;
  pinned: boolean;
  lastError?: string;
  /** Given up on after MAX_CONSECUTIVE_SHOT_ERRORS failures; no longer scheduled. */
  failed?: boolean;
  takes: LoopTake[];
}

export interface LoopManifest {
  version: number;
  episode: number;
  mode: LoopMode;
  chain: boolean;
  /** Whether shots are prompted to end on the character's face (chained loops). */
  faceContinuity: boolean;
  model: { t2v: string; i2v: string; r2v?: string };
  resolution: string;
  duration: string;
  budgetUsd: number;
  maxTakes: number;
  unbounded: boolean;
  once: boolean;
  spendUsd: number;
  running: boolean;
  startedAt: string;
  updatedAt: string;
  shots: LoopShotState[];
}

/** Structural subset of the web EventHub — avoids a mini-drama → web import. */
export interface LoopBroadcaster {
  broadcast(event: string, data: unknown): void;
}

export interface LoopEngineOptions {
  client: VeniceClient;
  series: SeriesState;
  script: EpisodeScript;
  episode: number;
  /** Absolute project directory (series.outputDir). */
  projectDir: string;
  /** Absolute episode directory (getEpisodeDir). */
  episodeDir: string;
  /** Project slug used in SSE payloads / media URLs. Defaults to series.slug. */
  slug?: string;
  /** watch = Turbo draft (default); create = identity-locked Max R2V. */
  mode?: LoopMode;
  resolution?: string;
  duration?: string;
  budgetUsd?: number;
  maxTakes?: number;
  /** Render one take per shot, then stop scheduling. */
  once?: boolean;
  /** Ignore the take-buffer cap AND budget — regenerate forever until stopped. */
  unbounded?: boolean;
  /**
   * Chain clips for continuous playback (default true): shot 1 renders normally,
   * every later shot renders i2v off the previous shot's current-take LAST frame
   * so the loop flows as one piece. Turn off (`--no-chain`) to render each shot
   * independently (in create mode that keeps per-shot R2V identity locking).
   */
  chain?: boolean;
  /**
   * When chaining, prompt each shot to end on the character's face for smoother
   * i2v continuations (default true). Automatically suppressed when the chain
   * i2v model rejects face start frames (MiniMax), where a face frame would kill
   * the next render — see `i2vRejectsFaceStartFrame` / AGENTS.md anti-pattern 31.
   */
  faceContinuity?: boolean;
  broadcaster?: LoopBroadcaster;
  /** Optional log sink (defaults to console.log). */
  log?: (line: string) => void;
  /** Override the render primitive (tests). Defaults to renderVideoFile. */
  render?: RenderFn;
  /** Backoff after a failed take (ms). Injectable for tests; defaults to 5s. */
  errorBackoffMs?: number;
}

interface InternalShot extends LoopShotState {
  shot: ShotScript;
  nextTake: number;
  forceNext: boolean;
  /** Consecutive render failures; resets to 0 on a successful take. */
  consecutiveErrors: number;
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/');
}

function durationSeconds(duration: string): number {
  const n = Number.parseInt(duration, 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * Continuous, in-process render worker for one project/episode. One take in
 * flight at a time (serial): Turbo is fast enough that a serial loop still
 * outruns playback, and it keeps the Venice client's rate limiter happy.
 */
export class LoopEngine {
  private readonly client: VeniceClient;
  private readonly series: SeriesState;
  private readonly script: EpisodeScript;
  private readonly episode: number;
  private readonly projectDir: string;
  private readonly episodeDir: string;
  private readonly slug: string;
  private readonly mode: LoopMode;
  private readonly chain: boolean;
  private readonly faceContinuity: boolean;
  private readonly usdPerSec: number;
  private readonly initialBudgetUsd: number;
  private readonly sceneDir: string;
  private readonly loopDir: string;
  private readonly resolution: string;
  private readonly duration: string;
  private readonly once: boolean;
  private unbounded: boolean;
  private budgetUsd: number;
  private maxTakes: number;
  private readonly broadcaster?: LoopBroadcaster;
  private readonly log: (line: string) => void;
  private readonly render: RenderFn;
  private readonly errorBackoffMs: number;

  private shots: InternalShot[] = [];
  private spendUsd = 0;
  private startedAt = new Date().toISOString();
  private running = false;
  private workerActive = false;
  /** Resolves the worker's idle wait early when new work is requested. */
  private wake?: () => void;

  constructor(options: LoopEngineOptions) {
    this.client = options.client;
    this.series = options.series;
    this.script = options.script;
    this.episode = options.episode;
    this.projectDir = options.projectDir;
    this.episodeDir = options.episodeDir;
    this.slug = options.slug ?? options.series.slug;
    this.mode = options.mode ?? 'watch';
    // The fun loop (watch) chains by default; the project loop (create) renders
    // each shot independently on R2V (chaining and R2V can't combine on MiniMax).
    this.chain = options.chain ?? (this.mode !== 'create');
    this.faceContinuity = options.faceContinuity ?? true;
    this.usdPerSec = this.mode === 'create' ? MAX_USD_PER_SEC : TURBO_USD_PER_SEC;
    this.sceneDir = join(options.episodeDir, 'scene-001');
    this.loopDir = join(options.episodeDir, 'loop');
    this.resolution = options.resolution ?? defaultLoopResolution(this.mode);
    this.duration = this.resolveDuration(options.duration ?? LOOP_DEFAULT_DURATION);
    this.once = options.once ?? false;
    this.unbounded = options.unbounded ?? false;
    this.initialBudgetUsd = options.budgetUsd ?? LOOP_DEFAULT_BUDGET_USD;
    this.budgetUsd = this.unbounded ? Infinity : this.initialBudgetUsd;
    // maxTakes is a ring-buffer cap (candidates kept per shot), always finite so
    // an infinite run can't fill the disk; `unbounded` only lifts the budget.
    this.maxTakes = Math.max(1, options.maxTakes ?? LOOP_DEFAULT_MAX_TAKES);
    this.broadcaster = options.broadcaster;
    this.log = options.log ?? ((line: string) => console.log(line));
    this.render = options.render ?? renderVideoFile;
    this.errorBackoffMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;

    this.shots = (options.script.shots ?? []).map((shot): InternalShot => ({
      shot,
      shotNumber: shot.shotNumber,
      key: shotKey(shot),
      status: 'idle',
      currentTake: null,
      pinned: false,
      takes: [],
      nextTake: 1,
      forceNext: false,
      consecutiveErrors: 0,
    }));
  }

  /**
   * Whether to append the "end on the character's face" note to chained shot
   * prompts: requested (faceContinuity) AND chaining AND the chain i2v model
   * accepts face start frames. On MiniMax i2v a face-bearing start frame kills
   * the next render, so it is suppressed there (AGENTS.md anti-pattern 31).
   */
  private faceContinuityActive(): boolean {
    return this.faceContinuity && this.chain && !i2vRejectsFaceStartFrame(i2vModelFor(this.mode));
  }

  private resolveDuration(requested: string): string {
    const sec = durationSeconds(requested);
    const snapped = closestValidDuration(LOOP_MODEL_T2V, sec);
    if (snapped && snapped !== `${sec}s`) {
      this.log(`  Loop duration ${requested} snapped to ${snapped} (H3 Max 5-15s ladder).`);
    }
    return snapped ?? requested;
  }

  /** Every take renders the full loop length (default 15s), both modes. */
  private durationForShot(_shot: ShotScript): string {
    return this.duration;
  }

  /** Estimated cost of one take, for the budget guard. */
  private costPerTake(): number {
    return this.usdPerSec * durationSeconds(this.duration);
  }

  private budgetExhausted(): boolean {
    if (this.unbounded) return false;
    return this.spendUsd + this.costPerTake() > this.budgetUsd + 1e-9;
  }

  private allSettled(): boolean {
    // The loop settles when every shot is pinned or given-up-on (nothing left to
    // regenerate) or, in --once mode, every shot has its single take (or failed).
    if (this.once) return this.shots.every(s => s.pinned || s.failed || s.takes.length >= 1);
    return this.shots.every(s => s.pinned || s.failed);
  }

  // ---- Public API (called by the CLI and the web endpoints) ---------------

  /** Load any prior manifest so takes / pins / spend survive a restart. */
  async init(): Promise<void> {
    await this.loadManifest();
  }

  async start(config?: { budgetUsd?: number; maxTakes?: number; unbounded?: boolean }): Promise<LoopManifest> {
    if (config?.unbounded !== undefined) this.unbounded = config.unbounded;
    if (config?.budgetUsd !== undefined) this.budgetUsd = config.budgetUsd;
    if (config?.maxTakes !== undefined) this.maxTakes = Math.max(1, config.maxTakes);
    if (this.unbounded) this.budgetUsd = Infinity;

    // Resuming after the budget cap was hit: grant one more budget's worth so
    // the "Start loop" button always does something (each click authorizes more
    // spend). Explicit config.budgetUsd above still wins.
    if (!this.unbounded && config?.budgetUsd === undefined && this.spendUsd + this.costPerTake() > this.budgetUsd + 1e-9) {
      this.budgetUsd = this.spendUsd + this.initialBudgetUsd;
      this.log(`Loop budget raised to $${this.budgetUsd.toFixed(2)} (was reached at $${this.spendUsd.toFixed(2)}).`);
    }

    if (this.running) return this.snapshot();
    this.running = true;
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    const models = this.mode === 'create'
      ? `${CREATE_MODEL_R2V} (identity) / ${CREATE_MODEL_I2V} (chained) / ${CREATE_MODEL_T2V}`
      : `${LOOP_MODEL_T2V}/${LOOP_MODEL_I2V}`;
    this.log(`Loop engine running [${this.mode}${this.chain ? ', chained' : ''}]: model=${models}, ${this.resolution}, ${this.duration}, budget=${this.unbounded ? 'unbounded' : `$${this.budgetUsd.toFixed(2)}`}.`);
    if (this.chain && this.faceContinuity) {
      this.log(this.faceContinuityActive()
        ? '  Face-continuity on: shots are prompted to end on the character\'s face for smoother transitions.'
        : `  Face-continuity requested but suppressed: ${i2vModelFor(this.mode)} rejects face start frames (a face-ending frame would kill the next chained render — AGENTS.md anti-pattern 31).`);
    }
    void this.runWorker();
    await this.persist();
    return this.snapshot();
  }

  async stop(): Promise<LoopManifest> {
    this.running = false;
    this.wake?.();
    await this.persist();
    this.log('Loop engine stopped scheduling new takes.');
    return this.snapshot();
  }

  async pin(shotNumber: number): Promise<LoopManifest> {
    const shot = this.shots.find(s => s.shotNumber === shotNumber);
    if (shot && shot.currentTake !== null) {
      shot.pinned = true;
      await this.persist();
      this.emit(shot);
    }
    return this.snapshot();
  }

  async unpin(shotNumber: number): Promise<LoopManifest> {
    const shot = this.shots.find(s => s.shotNumber === shotNumber);
    if (shot) {
      shot.pinned = false;
      await this.persist();
      this.emit(shot);
      this.wake?.();
      if (!this.workerActive && this.running) void this.runWorker();
    }
    return this.snapshot();
  }

  /** Force a fresh take of one shot next. */
  async regenerate(shotNumber: number): Promise<LoopManifest> {
    const shot = this.shots.find(s => s.shotNumber === shotNumber);
    if (shot) {
      shot.forceNext = true;
      // A manual regenerate revives a given-up-on shot and resets its error count.
      shot.failed = false;
      shot.consecutiveErrors = 0;
      // A manual regenerate re-authorizes spend if the budget cap was reached.
      if (!this.unbounded && this.spendUsd + this.costPerTake() > this.budgetUsd + 1e-9) {
        this.budgetUsd = this.spendUsd + this.initialBudgetUsd;
      }
      if (!this.running) this.running = true;
      this.wake?.();
      if (!this.workerActive) void this.runWorker();
    }
    return this.snapshot();
  }

  status(): LoopManifest {
    return this.snapshot();
  }

  // ---- Worker -------------------------------------------------------------

  private async runWorker(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;
    try {
      while (this.running) {
        const shot = this.pickNext();
        if (!shot) {
          // Nothing to render right now. One-pass done, budget hit, or every
          // shot pinned -> stop; otherwise idle until a pin/regenerate wakes us.
          if (this.once || this.budgetExhausted() || this.allSettled()) {
            this.running = false;
            await this.persist();
            break;
          }
          await this.idle();
          continue;
        }
        await this.renderTake(shot);
      }
    } finally {
      this.workerActive = false;
    }
  }

  private pickNext(): InternalShot | undefined {
    // Manual "regenerate now" jumps the queue.
    const forced = this.shots.find(s => s.forceNext && s.status !== 'rendering');
    if (forced) {
      forced.forceNext = false;
      return forced;
    }
    // Skip pinned, in-flight, and given-up-on (failed) shots — a failed shot is
    // server-side-doomed, and re-selecting it just re-queues and re-bills it.
    const eligible = this.shots.filter(s => !s.pinned && !s.failed && s.status !== 'rendering');
    if (eligible.length === 0) return undefined;

    // Fill the loop first: shots with no take yet, in shot order — this also
    // guarantees a predecessor exists before a chained shot renders.
    const zero = eligible
      .filter(s => s.takes.length === 0)
      .sort((a, b) => a.shotNumber - b.shotNumber);
    if (zero.length > 0) return zero[0];

    // One-pass mode never regenerates; it stops once every shot has a take.
    if (this.once) return undefined;

    // Then regenerate forever (until budget/stop): fewest RENDERS first so every
    // shot keeps refreshing evenly, then shot order. Sort on `nextTake` (the
    // lifetime render count), NOT `takes.length` — the ring buffer caps every
    // shot at `maxTakes` files on disk, so once the loop is full every shot ties
    // on `takes.length` and the shot-number tiebreak re-renders shot 1 forever
    // while the rest never refresh.
    eligible.sort((a, b) => a.nextTake - b.nextTake || a.shotNumber - b.shotNumber);
    return eligible[0];
  }

  /** Index of a shot in playback (shot) order. */
  private indexOf(shot: InternalShot): number {
    return this.shots.findIndex(s => s.shotNumber === shot.shotNumber);
  }

  /** Absolute path to a shot's current-take mp4, if it has one. */
  private currentClipPath(shot: InternalShot): string | undefined {
    if (shot.currentTake == null) return undefined;
    const take = shot.takes.find(t => t.n === shot.currentTake);
    return take ? join(this.projectDir, take.file) : undefined;
  }

  private async idle(): Promise<void> {
    await new Promise<void>(resolvePromise => {
      const timer = setTimeout(() => { this.wake = undefined; resolvePromise(); }, 60_000);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolvePromise(); };
    });
  }

  private async renderTake(shot: InternalShot): Promise<void> {
    const takeN = shot.nextTake;
    const durationLabel = this.durationForShot(shot.shot);
    const est = this.usdPerSec * durationSeconds(durationLabel);

    // Authoritative budget check with this take's real cost (create-mode takes
    // vary in length). Venice bills at queue time, so stop BEFORE queuing.
    if (!this.unbounded && this.spendUsd + est > this.budgetUsd + 1e-9) {
      this.running = false;
      await this.persist();
      this.log(`Loop budget reached ($${this.spendUsd.toFixed(2)} of $${this.budgetUsd.toFixed(2)}). Stopping.`);
      return;
    }

    const outputPath = join(this.loopDir, `shot-${shot.key}--take${takeN}.mp4`);

    // Chaining: every shot after the first renders i2v off the previous shot's
    // current-take LAST frame, so the loop plays as one continuous piece.
    const index = this.indexOf(shot);
    const predecessor = index > 0 ? this.shots[index - 1] : undefined;
    const chainFromClip = this.chain && predecessor ? this.currentClipPath(predecessor) : undefined;

    shot.status = 'rendering';
    this.emit(shot);

    // Count spend at queue time — Venice bills when the render is queued, so
    // the budget guard errs toward over-counting rather than over-spending.
    this.spendUsd += est;
    shot.nextTake += 1;

    try {
      const spec = await this.resolveTake(shot.shot, durationLabel, chainFromClip, outputPath);
      this.log(`  [loop] shot ${shot.key} take ${takeN} [${this.mode}]: ${spec.lane} ${spec.prompt.model} @ ${this.resolution}, ${durationLabel}`);
      await this.render(this.client, {
        prompt: spec.prompt,
        outputPath,
        anchorImagePath: spec.anchorImagePath,
        referenceImagePaths: spec.referenceImagePaths,
        sceneImagePaths: spec.sceneImagePaths,
        voiceReferencePaths: spec.voiceReferencePaths,
        elements: spec.elements,
        resolution: this.resolution,
        aspectRatio: this.series.storyboardAspectRatio,
        project: this.projectDir,
        episode: this.episode,
        forceRequeue: true,
      });

      const take: LoopTake = {
        n: takeN,
        file: toPosix(relative(this.projectDir, outputPath)),
        costUsd: est,
        at: new Date().toISOString(),
      };
      shot.takes.push(take);
      shot.status = 'ready';
      shot.lastError = undefined;
      shot.consecutiveErrors = 0;
      // Non-pinned shots always promote the newest take (hot-swap). A pinned
      // shot keeps its frozen take; new takes stay recorded as candidates.
      if (!shot.pinned) shot.currentTake = takeN;
      await this.pruneTakes(shot);
      await this.persist();
      this.emit(shot);
    } catch (err) {
      shot.status = 'error';
      shot.lastError = err instanceof Error ? err.message : String(err);
      shot.consecutiveErrors += 1;
      // Give up on a persistently-failing shot instead of re-queueing (and
      // re-billing) it every cycle. Venice bills at queue time, so a
      // server-side-doomed shot (e.g. a MiniMax i2v face start frame) would
      // otherwise burn the whole budget one failed take at a time. A manual
      // `regenerate` clears `failed` and lets it try again.
      if (shot.consecutiveErrors >= MAX_CONSECUTIVE_SHOT_ERRORS) {
        shot.failed = true;
        this.log(`  [loop] shot ${shot.key} failed ${shot.consecutiveErrors}x in a row — giving up on it (regenerate to retry). Last error: ${shot.lastError}`);
      } else {
        this.log(`  [loop] shot ${shot.key} take ${takeN} failed (${shot.consecutiveErrors}/${MAX_CONSECUTIVE_SHOT_ERRORS}): ${shot.lastError}`);
      }
      await this.persist();
      this.emit(shot);
      await new Promise(r => setTimeout(r, this.errorBackoffMs));
    }
  }

  /** The render spec for one take: prompt, chosen lane, and any reference bytes. */
  private async resolveTake(
    shot: ShotScript,
    durationLabel: string,
    chainFromClip: string | undefined,
    outputPath: string,
  ): Promise<{
    prompt: MiniDramaVideoPrompt;
    lane: 'r2v' | 'i2v' | 't2v';
    anchorImagePath?: string;
    referenceImagePaths?: string[];
    sceneImagePaths?: string[];
    voiceReferencePaths?: string[];
    elements?: VideoElement[];
  }> {
    const panelPath = join(this.sceneDir, `shot-${shotKey(shot)}.png`);
    const panelExists = existsSync(panelPath);

    // Chaining: render i2v off the previous shot's last frame so the loop plays
    // continuously. Applies to every shot after the first, in both modes — it
    // is the only way to make the clips flow, and it carries identity forward
    // from the (R2V-anchored, in create mode) opening shot. A lean prompt is
    // used because the start frame, not a reference stack, drives this render.
    if (chainFromClip && existsSync(chainFromClip)) {
      const startFrame = outputPath.replace(/\.mp4$/, '-chain.png');
      try {
        extractLastFrame(chainFromClip, startFrame);
        const model = i2vModelFor(this.mode);
        return {
          prompt: this.buildLeanPrompt(shot, model, durationLabel),
          lane: 'i2v',
          anchorImagePath: startFrame,
        };
      } catch (err) {
        this.log(`  [loop] last-frame chain failed (${(err as Error).message}); rendering shot ${shotKey(shot)} unchained.`);
      }
    }

    // watch mode (the fun loop): the first generation is ALWAYS t2v, and every
    // shot after it chains i2v off the previous last frame (handled above).
    // Never i2v-off-a-panel, never R2V — R2V renders are too slow for a loop.
    if (this.mode !== 'create') {
      return {
        prompt: this.buildLeanPrompt(shot, LOOP_MODEL_T2V, durationLabel),
        lane: 't2v',
      };
    }

    // create mode: the real reference-first routing on the H3 Max family. Build
    // the prompt through the harness's own resolver so character shots land on
    // Max R2V with the @Image slot plan, and resolve that plan to real bytes.
    const createSeries = this.createSeries();
    let vp: MiniDramaVideoPrompt;
    try {
      await ensureVoiceReferenceForShot(this.client, createSeries, shot, undefined);
      vp = buildVideoPrompt(shot, createSeries, undefined, this.script.audioMix);
      vp.duration = durationLabel;
    } catch {
      // A character panel likely shows a face, and MiniMax i2v dies server-side
      // on a face start frame (anti-pattern 31) — so degrade a face-reject i2v
      // to t2v for character shots rather than queue a doomed render.
      const canI2v = panelExists && !(i2vRejectsFaceStartFrame(CREATE_MODEL_I2V) && (shot.characters?.length ?? 0) > 0);
      const model = canI2v ? CREATE_MODEL_I2V : CREATE_MODEL_T2V;
      return {
        prompt: { prompt: this.fallbackPrompt(shot), model, duration: durationLabel, audio: true },
        lane: canI2v ? 'i2v' : 't2v',
        anchorImagePath: canI2v ? panelPath : undefined,
      };
    }

    if (vp.model.includes('reference-to-video')) {
      const refs = resolveShotReferenceInputs(createSeries, shot, vp);
      if ((refs.referenceImagePaths?.length ?? 0) > 0) {
        // Pure reference mode — the slot plan carries all consistency; no start
        // frame (renderVideoFile drops it because referenceSlots + refs exist).
        return {
          prompt: vp,
          lane: 'r2v',
          referenceImagePaths: refs.referenceImagePaths,
          sceneImagePaths: refs.sceneImagePaths,
          voiceReferencePaths: refs.voiceReferencePaths,
          elements: refs.elements,
        };
      }
      // A character shot with no references on disk can't anchor R2V — degrade
      // to i2v off a panel, else t2v, so the loop still renders something. But a
      // character panel almost certainly shows a face, and MiniMax i2v dies
      // server-side on a face start frame (anti-pattern 31) — so on a
      // face-rejecting i2v model, degrade to t2v instead of a doomed i2v.
      const canI2v = panelExists && !i2vRejectsFaceStartFrame(CREATE_MODEL_I2V);
      const model = canI2v ? CREATE_MODEL_I2V : CREATE_MODEL_T2V;
      return {
        prompt: { ...vp, model, referenceSlots: undefined },
        lane: canI2v ? 'i2v' : 't2v',
        anchorImagePath: canI2v ? panelPath : undefined,
      };
    }

    // Atmosphere / no-character lane. Upgrade to i2v when a panel exists.
    if (panelExists) {
      return { prompt: { ...vp, model: CREATE_MODEL_I2V }, lane: 'i2v', anchorImagePath: panelPath };
    }
    return { prompt: { ...vp, model: CREATE_MODEL_T2V }, lane: 't2v' };
  }

  /**
   * Lean prompt for one shot (watch draft, or any chained i2v shot). Reuses
   * buildVideoPrompt with a cloned series whose video lanes all point at a
   * simple-prompt model, so the resolver takes the `promptStyle: 'simple'`
   * branch (no directorial blocks, no reference tags, no lip-sync routing) and
   * the H3 Max dialogue-improv path. Model + duration are overridden for the
   * actual t2v/i2v lane. Falls back to a minimal prompt if the series has no
   * aesthetic yet.
   */
  private buildLeanPrompt(shot: ShotScript, model: string, durationLabel: string): MiniDramaVideoPrompt {
    try {
      const loopSeries: SeriesState = {
        ...this.series,
        videoDefaults: {
          ...this.series.videoDefaults,
          actionModel: LOOP_MODEL_T2V,
          atmosphereModel: LOOP_MODEL_T2V,
          characterConsistencyModel: LOOP_MODEL_T2V,
          lipSyncModel: undefined,
          audioStrategy: 'native',
          voiceReferenceForDialogue: false,
        },
      };
      const vp = buildVideoPrompt(shot, loopSeries);
      return { prompt: this.withFaceContinuity(vp.prompt, shot), model, duration: durationLabel, audio: true };
    } catch {
      return { prompt: this.withFaceContinuity(this.fallbackPrompt(shot), shot), model, duration: durationLabel, audio: true };
    }
  }

  /**
   * Append the face-continuity note so the shot ends on the character's face and
   * the next chained i2v continues smoothly. Applied only when active for this
   * loop (see `faceContinuityActive`) AND the shot actually has a character —
   * telling a pure-atmosphere shot to "end on the character's face" is noise.
   */
  private withFaceContinuity(prompt: string, shot: ShotScript): string {
    if (!this.faceContinuityActive()) return prompt;
    if ((shot.characters?.length ?? 0) === 0) return prompt;
    return `${prompt} ${FACE_CONTINUITY_NOTE}`;
  }

  /** Series clone whose video lanes target the H3 Max (non-Turbo) family. */
  private createSeries(): SeriesState {
    return {
      ...this.series,
      videoDefaults: {
        ...this.series.videoDefaults,
        actionModel: CREATE_MODEL_T2V,
        atmosphereModel: CREATE_MODEL_T2V,
        characterConsistencyModel: CREATE_MODEL_R2V,
        lipSyncModel: undefined,
        // Native dialogue with voice-donor references (no exact-lip-sync
        // keyframe pipeline in loop mode); keeps a single render per take.
        audioStrategy: 'native',
      },
    };
  }

  private fallbackPrompt(shot: ShotScript): string {
    const style = this.series.aesthetic?.style ? `${this.series.aesthetic.style}. ` : '';
    const camera = shot.cameraMovement ? `${shot.cameraMovement}. ` : '';
    return `${style}${camera}${shot.description}`.slice(0, 1500);
  }

  /**
   * Ring buffer: keep at most `maxTakes` candidate takes per shot so an infinite
   * loop can't fill the disk. Drops the oldest take that is neither the current
   * one nor pinned, deleting its file. The current take is never pruned.
   */
  private async pruneTakes(shot: InternalShot): Promise<void> {
    while (shot.takes.length > this.maxTakes) {
      const idx = shot.takes.findIndex(t => t.n !== shot.currentTake);
      if (idx < 0) break; // only the current take remains
      const [dropped] = shot.takes.splice(idx, 1);
      try { await rm(join(this.projectDir, dropped.file), { force: true }); } catch { /* best effort */ }
    }
  }

  // ---- Manifest -----------------------------------------------------------

  private manifestPath(): string {
    return join(this.loopDir, MANIFEST_FILE);
  }

  private snapshot(): LoopManifest {
    return {
      version: MANIFEST_VERSION,
      episode: this.episode,
      mode: this.mode,
      model: this.mode === 'create'
        ? { t2v: CREATE_MODEL_T2V, i2v: CREATE_MODEL_I2V, r2v: CREATE_MODEL_R2V }
        : { t2v: LOOP_MODEL_T2V, i2v: LOOP_MODEL_I2V },
      resolution: this.resolution,
      duration: this.duration,
      chain: this.chain,
      faceContinuity: this.faceContinuityActive(),
      budgetUsd: this.unbounded ? Infinity : this.budgetUsd,
      maxTakes: this.maxTakes,
      unbounded: this.unbounded,
      once: this.once,
      spendUsd: Number(this.spendUsd.toFixed(4)),
      running: this.running,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      shots: this.shots.map(s => ({
        shotNumber: s.shotNumber,
        key: s.key,
        status: s.status,
        currentTake: s.currentTake,
        pinned: s.pinned,
        failed: s.failed,
        lastError: s.lastError,
        takes: s.takes,
      })),
    };
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.loopDir, { recursive: true });
      // Infinity is not valid JSON — serialize the unbounded caps as null.
      const manifest = this.snapshot();
      const json = JSON.stringify(manifest, (_k, v) => (v === Infinity ? null : v), 2);
      await writeFile(this.manifestPath(), json, 'utf-8');
    } catch (err) {
      this.log(`  ⚠ Could not write loop manifest: ${(err as Error).message}`);
    }
  }

  private async loadManifest(): Promise<void> {
    const path = this.manifestPath();
    if (!existsSync(path)) return;
    try {
      const prior = JSON.parse(await readFile(path, 'utf-8')) as Partial<LoopManifest>;
      this.spendUsd = typeof prior.spendUsd === 'number' ? prior.spendUsd : 0;
      if (prior.startedAt) this.startedAt = prior.startedAt;
      for (const priorShot of prior.shots ?? []) {
        const shot = this.shots.find(s => s.shotNumber === priorShot.shotNumber);
        if (!shot) continue;
        // Only trust takes whose files still exist on disk.
        const takes = (priorShot.takes ?? []).filter(t =>
          existsSync(join(this.projectDir, t.file)),
        );
        shot.takes = takes;
        shot.pinned = Boolean(priorShot.pinned);
        shot.nextTake = takes.reduce((max, t) => Math.max(max, t.n), 0) + 1;
        const current = priorShot.currentTake;
        shot.currentTake = current && takes.some(t => t.n === current)
          ? current
          : (takes.length > 0 ? takes[takes.length - 1].n : null);
        shot.status = shot.currentTake !== null ? 'ready' : 'idle';
      }
      this.log(`Resumed loop state from ${MANIFEST_FILE} (spend $${this.spendUsd.toFixed(2)}).`);
    } catch (err) {
      this.log(`  ⚠ Could not read loop manifest: ${(err as Error).message}`);
    }
  }

  private emit(shot: InternalShot): void {
    const current = shot.currentTake
      ? shot.takes.find(t => t.n === shot.currentTake)
      : undefined;
    this.broadcaster?.broadcast('loop-updated', {
      project: this.slug,
      episode: this.episode,
      shotNumber: shot.shotNumber,
      key: shot.key,
      status: shot.status,
      currentTake: shot.currentTake,
      pinned: shot.pinned,
      failed: shot.failed,
      lastError: shot.lastError,
      takeCount: shot.takes.length,
      clip: current?.file,
      spendUsd: Number(this.spendUsd.toFixed(4)),
      running: this.running,
    });
  }
}
