// ---------------------------------------------------------------------------
// Output routing for background shell jobs.
//
// Handlers log with console.log/console.warn, which write straight to the real
// stdout. That is fine for a foreground command but unusable for a backgrounded
// render: a 20-minute job would spray lines over the prompt while the operator
// is typing the next command.
//
// So stdout/stderr are patched once and routed by async context. A job started
// with runWithSink() has all of its output -- however deep in the call stack --
// captured into its own buffer, retrievable with `/jobs log`. Anything outside a
// sink (the shell's own UI, foreground commands) writes through untouched.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

type Sink = (chunk: string) => void;

const storage = new AsyncLocalStorage<{ sink: Sink }>();

type WriteFn = typeof process.stdout.write;

let installed = false;
let realStdoutWrite: WriteFn | undefined;
let realStderrWrite: WriteFn | undefined;

function patched(real: WriteFn, stream: NodeJS.WriteStream): WriteFn {
  return function write(
    this: unknown,
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const store = storage.getStore();
    if (!store) {
      return (real as (...args: unknown[]) => boolean).call(stream, chunk, encoding, callback);
    }

    const done = typeof encoding === 'function' ? encoding : callback;
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf-8');
    store.sink(text);
    done?.();
    return true;
  } as WriteFn;
}

/** Patch stdout/stderr. Idempotent; only the shell calls this. */
export function installOutputRouter(): void {
  if (installed) return;
  installed = true;
  realStdoutWrite = process.stdout.write.bind(process.stdout) as WriteFn;
  realStderrWrite = process.stderr.write.bind(process.stderr) as WriteFn;
  process.stdout.write = patched(realStdoutWrite, process.stdout);
  process.stderr.write = patched(realStderrWrite, process.stderr);
}

export function uninstallOutputRouter(): void {
  if (!installed) return;
  if (realStdoutWrite) process.stdout.write = realStdoutWrite;
  if (realStderrWrite) process.stderr.write = realStderrWrite;
  installed = false;
}

/** Run `fn` with all of its console output captured by `sink`. */
export function runWithSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return storage.run({ sink }, fn);
}

/**
 * Write to the terminal even from inside a sink. The shell's own chrome
 * (prompt, job notices) must never be captured into a job's log.
 */
export function writeDirect(text: string): void {
  if (realStdoutWrite) realStdoutWrite.call(process.stdout, text);
  else process.stdout.write(text);
}
