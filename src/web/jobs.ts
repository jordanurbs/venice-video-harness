// ---------------------------------------------------------------------------
// Job runner -- one whitelisted CLI command per project at a time.
//
// The web UI never re-implements harness behavior; it spawns the same CLI a
// terminal user runs, with flags only from a per-command whitelist. A mutex
// per project stops two pipeline commands from racing over series.json. Output
// lines stream to the browser over SSE, and the full transcript is kept for a
// late-joining tab.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventHub } from './events.js';

/** Spec for one command the web UI may invoke. */
interface CommandSpec {
  /** Options (by long flag name, no dashes) the UI may pass through. */
  options: string[];
  /** Boolean flags the UI may switch on. */
  flags: string[];
  /** Whether the command takes -e <episode>. */
  episode?: boolean;
}

// Keys are the literal CLI command names. Every invocation always gets
// -p <projectDir> appended by the runner; nothing here can point the CLI at
// another project or the shell.
export const COMMAND_WHITELIST: Record<string, CommandSpec> = {
  // Full project workshop: story, aesthetic, cast, locations, script, plan.
  // Non-interactive when spawned without a TTY — flags cover every prompt,
  // omitted ones fall back to the previous revision's inputs or defaults.
  'workshop': {
    options: ['outcome', 'duration', 'audience', 'must-include', 'avoid', 'references', 'delivery', 'feedback', 'model'],
    flags: ['approve'],
  },
  'workshop-script': { options: ['concept', 'model', 'part'], flags: [], episode: true },
  'approve-script': { options: ['notes'], flags: [], episode: true },
  'storyboard-episode': { options: ['shots'], flags: [], episode: true },
  'qa-storyboard': { options: ['model', 'shots'], flags: [], episode: true },
  'qa-approve': { options: ['notes'], flags: ['force'], episode: true },
  'fix-panel': { options: ['shot', 'characters', 'prompt', 'edit-model'], flags: [], episode: true },
  'fix-flagged': { options: ['severity', 'edit-model'], flags: ['requa'], episode: true },
  'generate-videos': { options: [], flags: ['skip-qa', 'no-montage', 'auto-edit', 'no-auto-edit'], episode: true },
  'qa-videos': { options: ['model'], flags: [], episode: true },
  'generate-music': { options: ['prompt', 'duration', 'model'], flags: [], episode: true },
  'assemble-episode': {
    options: ['ambient-volume', 'native-volume'],
    flags: ['no-subtitles', 'no-music', 'no-ambient', 'dialogue-replace', 'skip-video-qa'],
    episode: true,
  },
  'export-timeline': { options: ['format', 'fps', 'width', 'height'], flags: [], episode: true },
  'add-character': {
    options: ['name', 'gender', 'age', 'description', 'wardrobe', 'voice-desc', 'base-traits', 'angles', 'prompt'],
    flags: ['skip-images'],
  },
  'add-location': {
    options: ['name', 'description', 'lighting', 'spatial-anchors', 'model'],
    flags: ['skip-images'],
  },
  // Reference generation for entities that already exist in series.json
  // (the quick-script path creates the data but not the art).
  'generate-location-references': { options: ['location', 'model', 'angles', 'prompt'], flags: ['force'] },
  'generate-storyboard-refs': { options: ['slug', 'model'], flags: ['force'], episode: true },
  'validate-episode': { options: [], flags: [], episode: true },
  'status': { options: [], flags: [], episode: false },
};

export interface JobRequest {
  command: string;
  episode?: number;
  options?: Record<string, string>;
  flags?: string[];
}

export interface JobRecord {
  id: string;
  project: string;
  command: string;
  args: string[];
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  lines: Array<{ stream: 'stdout' | 'stderr'; line: string }>;
}

const MAX_LINES = 4000;
const MAX_HISTORY = 20;

/** Mutex key for workspace-level jobs (project creation). */
const WORKSPACE_SCOPE = '@workspace';

export class JobRunner {
  private running = new Map<string, JobRecord>();
  private history: JobRecord[] = [];

  constructor(
    private readonly cliEntry: { bin: string; baseArgs: string[] },
    private readonly hub: EventHub,
  ) {}

  /** Validate a request against the whitelist. Returns argv or an error. */
  buildArgs(projectDir: string, req: JobRequest): { args: string[] } | { error: string } {
    const spec = COMMAND_WHITELIST[req.command];
    if (!spec) return { error: 'Command not allowed: ' + req.command };

    const args: string[] = [req.command, '-p', projectDir];
    if (spec.episode) {
      if (req.episode === undefined || !Number.isFinite(req.episode)) {
        return { error: 'Command ' + req.command + ' requires an episode number.' };
      }
      args.push('-e', String(req.episode));
    }
    for (const [key, value] of Object.entries(req.options ?? {})) {
      if (!spec.options.includes(key)) return { error: 'Option not allowed: --' + key };
      if (typeof value !== 'string' || value.length > 4000) {
        return { error: 'Invalid value for --' + key };
      }
      args.push('--' + key, value);
    }
    for (const flag of req.flags ?? []) {
      if (!spec.flags.includes(flag)) return { error: 'Flag not allowed: --' + flag };
      args.push('--' + flag);
    }
    return { args };
  }

  isBusy(project: string): boolean {
    return this.running.has(project);
  }

  /**
   * Create a fresh project via `new-series`. Workspace-scoped (the command
   * takes no -p flag), so it runs under a reserved mutex key. Value whitelists
   * mirror the CLI's own validation; the spawn is non-TTY so the command's
   * interactive prompts never fire and the harness defaults apply.
   */
  startNewSeries(
    workspaceDir: string,
    opts: {
      name: string;
      concept: string;
      genre?: string;
      setting?: string;
      route?: string;
      videoFamily?: string;
      audioStrategy?: string;
    },
  ): JobRecord | { error: string } {
    const name = (opts.name ?? '').trim();
    const concept = (opts.concept ?? '').trim();
    if (!name || name.length > 200) return { error: 'A project name is required.' };
    if (!concept || concept.length > 4000) return { error: 'A concept is required.' };

    const ROUTES = new Set(['montage', 'standard']);
    const FAMILIES = new Set(['auto', 'seedance', 'wan-3-0', 'happyhorse', 'minimax-h3', 'grok-imagine', 'kling-o3']);
    const AUDIO = new Set(['native', 'lip-sync', 'narrator-vo']);
    if (opts.route && !ROUTES.has(opts.route)) return { error: 'Invalid route.' };
    if (opts.videoFamily && !FAMILIES.has(opts.videoFamily)) return { error: 'Invalid video family.' };
    if (opts.audioStrategy && !AUDIO.has(opts.audioStrategy)) return { error: 'Invalid audio strategy.' };

    const args = ['new-series', '-n', name, '--concept', concept];
    if (opts.genre?.trim()) args.push('-g', opts.genre.trim().slice(0, 100));
    if (opts.setting?.trim()) args.push('--setting', opts.setting.trim().slice(0, 1000));
    if (opts.route) args.push('--route', opts.route);
    if (opts.videoFamily) args.push('--video-family', opts.videoFamily);
    if (opts.audioStrategy) args.push('--audio-strategy', opts.audioStrategy);

    return this.launch(WORKSPACE_SCOPE, workspaceDir, 'new-series', args);
  }

  activeJob(project: string): JobRecord | undefined {
    return this.running.get(project);
  }

  recentJobs(project: string): JobRecord[] {
    const active = this.running.get(project);
    const past = this.history.filter(job => job.project === project);
    return active ? [active, ...past] : past;
  }

  start(project: string, projectDir: string, req: JobRequest): JobRecord | { error: string } {
    const built = this.buildArgs(projectDir, req);
    if ('error' in built) return built;
    return this.launch(project, projectDir, req.command, built.args);
  }

  private launch(scope: string, cwd: string, command: string, args: string[]): JobRecord | { error: string } {
    if (this.running.has(scope)) {
      return { error: 'A job is already running for this project.' };
    }

    const job: JobRecord = {
      id: randomUUID(),
      project: scope,
      command,
      args,
      status: 'running',
      startedAt: new Date().toISOString(),
      lines: [],
    };
    this.running.set(scope, job);
    this.hub.broadcast('job-started', { project: scope, id: job.id, command: job.command });

    const child = spawn(this.cliEntry.bin, [...this.cliEntry.baseArgs, ...args], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const push = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (job.lines.length < MAX_LINES) job.lines.push({ stream, line });
          this.hub.broadcast('job-output', { project: scope, id: job.id, stream, line });
        }
      };
    };
    child.stdout.on('data', push('stdout'));
    child.stderr.on('data', push('stderr'));

    child.on('error', (err) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.lines.push({ stream: 'stderr', line: 'spawn error: ' + err.message });
      this.finish(scope, job);
    });
    child.on('close', (code) => {
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      this.finish(scope, job);
    });

    return job;
  }

  private finish(project: string, job: JobRecord): void {
    if (this.running.get(project)?.id === job.id) this.running.delete(project);
    this.history.unshift(job);
    if (this.history.length > MAX_HISTORY) this.history.pop();
    this.hub.broadcast('job-finished', {
      project,
      id: job.id,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode ?? null,
    });
  }
}
