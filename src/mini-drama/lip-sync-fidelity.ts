// Did a reference-audio lip-sync render follow the supplied clip, or re-perform it?
//
// When Wan 3.0 R2V follows the clip, the render's audio track IS the clip (waveform correlation
// ~0.96 at zero lag), so the mouth was driven by the file. Some takes of the identical request
// re-perform the line instead: words dropped or re-timed, correlation near zero over those
// seconds, and a mouth that no longer matches the file. Probed 2026-09-28: faithful takes scored
// 0.96 overall with every 1s window >= 0.84; re-performed takes scored 0.14-0.76 with at least
// one window near zero.
import { spawnSync } from 'node:child_process';

const SR = 16000;
const MAX_LAG_SEC = 0.3;
const LAG_STEP = 16;

export const LIP_SYNC_MIN_OVERALL_CORR = 0.9;
export const LIP_SYNC_MIN_WINDOW_CORR = 0.6;

export interface LipSyncFidelity {
  ok: boolean;
  corr: number;
  lagSec: number;
  minWindowCorr: number;
  windows: number[];
}

function decode(path: string): Float32Array {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 256 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`ffmpeg could not decode ${path}: ${out.stderr?.toString().trim()}`);
  const buf = out.stdout as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function corr(a: Float32Array, aOff: number, b: Float32Array, bOff: number, n: number): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[aOff + i]; sb += b[bOff + i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[aOff + i] - ma, y = b[bOff + i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function std(a: Float32Array, off: number, n: number): number {
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s += a[off + i]; s2 += a[off + i] * a[off + i]; }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/** Compare a render's audio against the clip it was asked to lip-sync to. */
export function measureLipSyncFidelity(renderPath: string, clipPath: string): LipSyncFidelity {
  const render = decode(renderPath);
  const clip = decode(clipPath);
  let best = { c: -1, lag: 0 };
  for (let lag = 0; lag <= MAX_LAG_SEC * SR; lag += LAG_STEP) {
    const n = Math.min(render.length - lag, clip.length);
    if (n < SR) break;
    const c = corr(render, lag, clip, 0, n);
    if (c > best.c) best = { c, lag };
  }
  const windows: number[] = [];
  for (let s = 0; (s + 1) * SR <= clip.length; s++) {
    if (best.lag + (s + 1) * SR > render.length) break;
    if (std(clip, s * SR, SR) < 1e-3) continue;
    windows.push(Math.round(corr(render, best.lag + s * SR, clip, s * SR, SR) * 100) / 100);
  }
  const minWindowCorr = windows.length > 0 ? Math.min(...windows) : 0;
  const c = Math.round(best.c * 1000) / 1000;
  return {
    ok: c >= LIP_SYNC_MIN_OVERALL_CORR && minWindowCorr >= LIP_SYNC_MIN_WINDOW_CORR,
    corr: c,
    lagSec: Math.round((best.lag / SR) * 1000) / 1000,
    minWindowCorr,
    windows,
  };
}
