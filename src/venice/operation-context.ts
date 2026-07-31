// ---------------------------------------------------------------------------
// Ambient operation context -- cancellation and progress for long operations.
//
// Venice generations are queue-and-poll affairs that run for minutes. The CLI
// historically had no way to stop one short of killing the process, which is
// fine for `venice-video generate-videos` in a terminal but useless inside the
// interactive shell, where Ctrl-C has to cancel the *operation* and keep the
// session alive.
//
// Rather than thread an AbortSignal parameter through ~40 call sites, the
// signal travels in AsyncLocalStorage. `runInOperation()` establishes it, and
// VeniceClient / the poll loops read it via `currentSignal()`. AsyncLocalStorage
// propagates across await boundaries, so anything the handler calls -- however
// deep -- becomes cancellable without changing its signature.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationProgress {
  /** Coarse stage, e.g. 'queue', 'poll', 'download', 'encode'. */
  phase: string;
  /** Human-readable detail line, e.g. 'shot 3/12 PROCESSING 41s'. */
  detail?: string;
  /** Completed units, when the operation has countable work. */
  current?: number;
  /** Total units, when known. */
  total?: number;
}

export interface OperationContext {
  /** Aborted when the operator cancels (Ctrl-C in the shell, kill in MCP). */
  signal?: AbortSignal;
  /** Short label for status output, e.g. 'generate-videos ep 2'. */
  label?: string;
  /** Sink for progress updates; the shell renders these on a status line. */
  onProgress?: (update: OperationProgress) => void;
}

const storage = new AsyncLocalStorage<OperationContext>();

/**
 * Thrown when an operation is cancelled. Distinct from a Venice API failure so
 * callers can report "cancelled" instead of "failed" and skip retries.
 */
export class OperationAbortedError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'OperationAbortedError';
  }
}

/** Run `fn` with `context` visible to every async descendant. */
export function runInOperation<T>(context: OperationContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentOperation(): OperationContext | undefined {
  return storage.getStore();
}

export function currentSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/** True when the ambient operation has been cancelled. */
export function isAborted(): boolean {
  return storage.getStore()?.signal?.aborted === true;
}

/** Bail out of a loop as soon as the operator cancels. */
export function throwIfAborted(): void {
  if (isAborted()) throw new OperationAbortedError();
}

/**
 * Recognise both our own abort error and the DOMException that `fetch` raises
 * when its signal fires, so retry logic can tell cancellation from failure.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof OperationAbortedError) return true;
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Sleep that resolves early -- by rejecting -- when the operation is cancelled.
 * Poll loops wait 5-10s between attempts; without this, cancelling would take
 * up to a full poll interval to be noticed.
 */
export function abortableSleep(ms: number, signal = currentSignal()): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OperationAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OperationAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Emit a progress update if anything is listening. */
export function reportProgress(update: OperationProgress): void {
  storage.getStore()?.onProgress?.(update);
}
