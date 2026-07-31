// ---------------------------------------------------------------------------
// Background jobs for the interactive shell.
//
// Episode renders are sequential and I/O-bound -- they spend nearly all their
// time waiting on Venice's queue -- so running one "in the background" needs
// nothing more than not awaiting its promise. That is enough to let an operator
// keep workshopping episode 3 while episode 2 renders.
//
// Each job owns an AbortController (so it can be cancelled individually) and an
// output buffer (so its logs don't collide with the prompt).
// ---------------------------------------------------------------------------

import type { OperationProgress } from '../venice/operation-context.js';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundJob {
  id: number;
  /** The command line as typed, e.g. 'generate-videos -e 2'. */
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
  progress?: OperationProgress;
  /** Captured stdout/stderr, trimmed to the most recent lines. */
  log: string[];
  controller: AbortController;
  settled: Promise<void>;
}

/** Keep memory bounded on a long render that logs per poll. */
const MAX_LOG_LINES = 500;

export interface JobRunContext {
  signal: AbortSignal;
  onProgress: (update: OperationProgress) => void;
  appendLog: (chunk: string) => void;
}

export class JobManager {
  private readonly jobs = new Map<number, BackgroundJob>();
  private nextId = 1;

  /**
   * Start `run` detached. `onSettle` fires when it finishes so the shell can
   * print a completion notice above the prompt.
   */
  start(
    label: string,
    run: (context: JobRunContext) => Promise<number>,
    onSettle?: (job: BackgroundJob) => void,
  ): BackgroundJob {
    const controller = new AbortController();
    const id = this.nextId++;

    const job: BackgroundJob = {
      id,
      label,
      status: 'running',
      startedAt: Date.now(),
      log: [],
      controller,
      settled: Promise.resolve(),
    };

    let pending = '';
    const appendLog = (chunk: string): void => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) job.log.push(line);
      if (job.log.length > MAX_LOG_LINES) {
        job.log.splice(0, job.log.length - MAX_LOG_LINES);
      }
    };

    job.settled = run({
      signal: controller.signal,
      onProgress: update => { job.progress = update; },
      appendLog,
    }).then(
      exitCode => {
        if (pending) job.log.push(pending);
        job.exitCode = exitCode;
        job.status = exitCode === 0 ? 'done' : 'failed';
      },
      error => {
        if (pending) job.log.push(pending);
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      },
    ).then(() => {
      job.endedAt = Date.now();
      onSettle?.(job);
    });

    this.jobs.set(id, job);
    return job;
  }

  get(id: number): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()].sort((a, b) => a.id - b.id);
  }

  running(): BackgroundJob[] {
    return this.list().filter(job => job.status === 'running');
  }

  /** Signal cancellation. The job's own poll loop notices within a poll tick. */
  cancel(id: number): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const job of this.running()) job.controller.abort();
  }

  /** Drop finished jobs from the list. Returns how many were removed. */
  prune(): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running') {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Wait for every running job, e.g. before the shell exits. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.running().map(job => job.settled));
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
