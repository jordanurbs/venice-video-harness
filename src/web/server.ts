// ---------------------------------------------------------------------------
// venice-video web -- a local browser UI over the harness.
//
// Plain node:http, localhost only. Three surfaces:
//   /api/*    project list, per-project state, job control, SSE events
//   /media/*  read-only static serving out of the workspace (range-aware,
//             so <video> can scrub)
//   /*        the built SPA (src/web/ui/dist), with index.html fallback
//
// The server never mutates project state itself. Every write path is a spawn
// of the same CLI a terminal user runs, through the JobRunner whitelist.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from './events.js';
import { WorkspaceWatcher } from './watcher.js';
import { JobRunner, type JobRequest } from './jobs.js';
import { collectProjectState, listProjects } from './state.js';
import { getModelSettings, updateModelSettings, type ModelSettingsPatch } from './settings.js';
import type { LoopEngine } from '../mini-drama/loop-engine.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

/** Resolve a URL path inside a root dir, refusing traversal. */
function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath).replace(/\+/g, ' ');
  const full = normalize(join(root, decoded));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

/** Serve a file with HTTP range support so <video> seeking works. */
function serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!stats.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(Number.parseInt(match[2], 10), stats.size - 1) : stats.size - 1;
      if (start <= end && start < stats.size) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stats.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        createReadStream(path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(416, { 'Content-Range': 'bytes */' + stats.size });
      res.end();
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Accept-Ranges': 'bytes',
  });
  createReadStream(path).pipe(res);
}

function resolveCliEntry(options: WebServerOptions): { bin: string; baseArgs: string[] } {
  if (options.cliBin) return { bin: options.cliBin, baseArgs: options.cliBaseArgs ?? [] };

  const here = fileURLToPath(import.meta.url);
  const compiled = resolve(here, '..', '..', 'mini-drama', 'cli.js');
  if (existsSync(compiled)) return { bin: process.execPath, baseArgs: [compiled] };

  // tsx dev mode: src/web/server.ts → repo root is two levels up from src/.
  const repoRoot = resolve(here, '..', '..', '..');
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const cliTs = join(repoRoot, 'src', 'mini-drama', 'cli.ts');
  if (existsSync(tsxBin) && existsSync(cliTs)) return { bin: tsxBin, baseArgs: [cliTs] };

  // Last resort: assume a globally installed venice-video on PATH.
  return { bin: 'venice-video', baseArgs: [] };
}

export interface WebServerOptions {
  workspaceDir: string;
  port: number;
  host?: string;
  /** Path to the CLI entry the job runner spawns. */
  cliBin?: string;
  cliBaseArgs?: string[];
  /**
   * Reuse an existing SSE hub instead of creating one. The `loop` command
   * passes the hub it already handed to the LoopEngine so engine `loop-updated`
   * events reach the same browser tabs the watcher pushes to.
   */
  hub?: EventHub;
  /**
   * Loop-preview engine attached to one project/episode. When present, the
   * `/api/projects/:slug/loop/*` endpoints drive it (state/start/stop/pin/
   * regenerate). Only the matching slug is controllable.
   */
  loop?: { slug: string; episode: number; engine: LoopEngine };
}

export async function startWebServer(options: WebServerOptions): Promise<{ close: () => Promise<void>; port: number; hub: EventHub }> {
  const host = options.host ?? '127.0.0.1';
  const workspaceDir = resolve(options.workspaceDir);
  // The UI bundle lives in the SOURCE tree (src/web/ui/dist) — tsc does not
  // copy it into dist/. Try next to this module first (tsx dev mode), then
  // the source location relative to the repo root (compiled mode).
  const here = fileURLToPath(import.meta.url);
  const uiCandidates = [
    resolve(here, '..', 'ui', 'dist'),
    resolve(here, '..', '..', '..', 'src', 'web', 'ui', 'dist'),
  ];
  const uiDist = uiCandidates.find(candidate => existsSync(join(candidate, 'index.html')))
    ?? uiCandidates[0];

  const hub = options.hub ?? new EventHub();
  const watcher = new WorkspaceWatcher(workspaceDir, hub);
  watcher.start();

  // Default: spawn this same installation's CLI via the current node binary.
  // When the server itself runs from TypeScript sources (tsx dev mode) the
  // compiled cli.js does not exist next to this module, so fall back to the
  // repo's local tsx binary against cli.ts.
  const cliEntry = resolveCliEntry(options);
  const jobs = new JobRunner(cliEntry, hub);

  async function resolveProject(slug: string): Promise<{ slug: string; dir: string } | null> {
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return null;
    const dir = join(workspaceDir, slug);
    if (existsSync(join(dir, 'series.json'))) return { slug, dir };
    const all = await listProjects(workspaceDir);
    const match = all.find(p => p.slug === slug);
    return match ? { slug: match.slug, dir: match.dir } : null;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/api/events' && req.method === 'GET') {
      hub.attach(res);
      return;
    }
    if (pathname === '/api/projects' && req.method === 'GET') {
      sendJson(res, 200, { workspaceDir, projects: await listProjects(workspaceDir) });
      return;
    }

    // Create a fresh project (new-series). Workspace-level; the watcher's
    // state-changed push plus job-finished tells the client to re-list.
    if (pathname === '/api/projects' && req.method === 'POST') {
      let body: {
        name?: string; concept?: string; genre?: string; setting?: string;
        route?: string; videoFamily?: string; audioStrategy?: string;
      };
      try {
        body = await readBody(req) as typeof body;
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        return;
      }
      const result = jobs.startNewSeries(workspaceDir, {
        name: body.name ?? '',
        concept: body.concept ?? '',
        genre: body.genre,
        setting: body.setting,
        route: body.route,
        videoFamily: body.videoFamily,
        audioStrategy: body.audioStrategy,
      });
      if ('error' in result) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 202, { id: result.id, command: result.command });
      return;
    }

    const stateMatch = /^\/api\/projects\/([^/]+)\/state$/.exec(pathname);
    if (stateMatch && req.method === 'GET') {
      const project = await resolveProject(stateMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      const state = await collectProjectState(project.dir);
      if (!state) {
        sendJson(res, 404, { error: 'No series.json in project' });
        return;
      }
      sendJson(res, 200, state);
      return;
    }

    const settingsMatch = /^\/api\/projects\/([^/]+)\/settings\/models$/.exec(pathname);
    if (settingsMatch) {
      const project = await resolveProject(settingsMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      if (req.method === 'GET') {
        const settings = await getModelSettings(project.dir);
        if (!settings) {
          sendJson(res, 404, { error: 'No series.json in project' });
          return;
        }
        sendJson(res, 200, settings);
        return;
      }
      if (req.method === 'PUT') {
        // Refuse to edit series.json while a pipeline command is running —
        // the job would clobber the change (or vice versa) on its own save.
        if (jobs.isBusy(project.slug)) {
          sendJson(res, 409, { error: 'A job is running for this project; change models when it finishes.' });
          return;
        }
        let patch: ModelSettingsPatch;
        try {
          patch = await readBody(req) as ModelSettingsPatch;
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
          return;
        }
        const result = await updateModelSettings(project.dir, patch);
        if ('error' in result) {
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // Archive (soft-delete) one reference image. Never destructive: the file
    // is renamed to <name>-archive-<ts>.png in place, exactly the convention
    // regeneration uses, so it stops feeding the reference pipeline but stays
    // recoverable. Sidecars (.prompt.json etc.) are left as history.
    const archiveMatch = /^\/api\/projects\/([^/]+)\/media\/archive$/.exec(pathname);
    if (archiveMatch && req.method === 'POST') {
      const project = await resolveProject(archiveMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      if (jobs.isBusy(project.slug)) {
        sendJson(res, 409, { error: 'A job is running for this project; archive media when it finishes.' });
        return;
      }
      let body: { path?: string };
      try {
        body = await readBody(req) as { path?: string };
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        return;
      }
      if (!body.path || typeof body.path !== 'string') {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      const target = safeJoin(project.dir, body.path);
      // Only reference art may be archived from the UI: images inside the
      // characters/ or locations/ trees. Renders, scripts, and everything
      // else stay CLI-managed.
      const rel = target ? target.slice(project.dir.length).replace(/^[/\\]+/, '') : '';
      const allowed = target
        && /\.(png|webp|jpg|jpeg)$/i.test(target)
        && (rel.startsWith('characters/') || rel.startsWith('locations/'))
        && !basename(target).includes('archive');
      if (!allowed || !existsSync(target)) {
        sendJson(res, allowed ? 404 : 403, { error: allowed ? 'File not found' : 'Only character/location reference images can be archived' });
        return;
      }
      // Reference generation writes paired .png/.webp variants of each angle;
      // archive every sibling variant or the leftover one keeps feeding the
      // pipeline and the UI.
      const stamp = Date.now();
      const withoutExt = target.replace(/\.[a-z0-9]+$/i, '');
      const variants = ['.png', '.webp', '.jpg', '.jpeg']
        .map(ext => withoutExt + ext)
        .filter(candidate => existsSync(candidate));
      try {
        for (const variant of variants) {
          const stamped = join(
            dirname(variant),
            basename(variant).replace(/(\.[a-z0-9]+)$/i, `-archive-${stamp}$1`),
          );
          await rename(variant, stamped);
        }
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Archive failed' });
        return;
      }
      sendJson(res, 200, { ok: true, archived: variants.length });
      return;
    }

    const jobsMatch = /^\/api\/projects\/([^/]+)\/jobs$/.exec(pathname);
    if (jobsMatch && req.method === 'GET') {
      const project = await resolveProject(jobsMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      sendJson(res, 200, { jobs: jobs.recentJobs(project.slug) });
      return;
    }

    // Loop-preview control. The engine (if any) is attached to exactly one
    // project/episode; only that slug is controllable. `state` is readable even
    // without an attached engine (the on-disk manifest is served via project
    // state), so it returns { attached:false } rather than an error.
    const loopMatch = /^\/api\/projects\/([^/]+)\/loop\/(state|start|stop|pin|regenerate)$/.exec(pathname);
    if (loopMatch) {
      const action = loopMatch[2];
      const project = await resolveProject(loopMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      const engine = options.loop && options.loop.slug === project.slug ? options.loop.engine : undefined;

      if (action === 'state') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
        sendJson(res, 200, engine ? { attached: true, ...engine.status() } : { attached: false });
        return;
      }

      if (!engine) {
        sendJson(res, 409, { error: 'Loop is not running for this project. Start it with `venice-video loop`.' });
        return;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

      let body: { shotNumber?: number; pinned?: boolean; budget?: number; maxTakes?: number; unbounded?: boolean };
      try {
        body = await readBody(req) as typeof body;
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        return;
      }

      try {
        if (action === 'start') {
          const config: { budgetUsd?: number; maxTakes?: number; unbounded?: boolean } = {};
          if (typeof body.budget === 'number' && Number.isFinite(body.budget)) config.budgetUsd = body.budget;
          if (typeof body.maxTakes === 'number' && Number.isFinite(body.maxTakes)) config.maxTakes = body.maxTakes;
          if (typeof body.unbounded === 'boolean') config.unbounded = body.unbounded;
          sendJson(res, 200, await engine.start(config));
          return;
        }
        if (action === 'stop') {
          sendJson(res, 200, await engine.stop());
          return;
        }
        if (typeof body.shotNumber !== 'number' || !Number.isFinite(body.shotNumber)) {
          sendJson(res, 400, { error: 'shotNumber is required.' });
          return;
        }
        if (action === 'pin') {
          sendJson(res, 200, body.pinned === false ? await engine.unpin(body.shotNumber) : await engine.pin(body.shotNumber));
          return;
        }
        if (action === 'regenerate') {
          sendJson(res, 200, await engine.regenerate(body.shotNumber));
          return;
        }
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Loop control failed' });
        return;
      }
    }

    const runMatch = /^\/api\/projects\/([^/]+)\/run$/.exec(pathname);
    if (runMatch && req.method === 'POST') {
      const project = await resolveProject(runMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: 'Unknown project' });
        return;
      }
      let body: JobRequest;
      try {
        body = await readBody(req) as JobRequest;
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        return;
      }
      const result = jobs.start(project.slug, project.dir, body);
      if ('error' in result) {
        sendJson(res, 409, result);
        return;
      }
      sendJson(res, 202, { id: result.id, command: result.command, args: result.args });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(err => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      });
      return;
    }

    if (pathname.startsWith('/media/')) {
      const target = safeJoin(workspaceDir, pathname.slice('/media/'.length));
      if (!target) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      serveFile(req, res, target);
      return;
    }

    // SPA static files with index.html fallback for client-side routing.
    if (existsSync(uiDist)) {
      const candidate = pathname === '/' ? null : safeJoin(uiDist, pathname.slice(1));
      if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
        serveFile(req, res, candidate);
        return;
      }
      const index = join(uiDist, 'index.html');
      if (existsSync(index)) {
        serveFile(req, res, index);
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>venice-video web</title><p>UI bundle not built. Run <code>npm run web:build</code> in the harness repo, then restart <code>venice-video web</code>.</p>');
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolvePromise());
  });

  return {
    port: options.port,
    hub,
    close: async () => {
      await watcher.stop();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    },
  };
}
