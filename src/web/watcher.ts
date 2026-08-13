// ---------------------------------------------------------------------------
// Workspace watcher -- turn filesystem churn into debounced SSE pushes.
//
// Production commands write dozens of files in bursts (panels, sidecars,
// thumbnails, treatment re-renders). The browser only needs to know "project X
// changed, re-fetch state", so events are coalesced per project with a short
// debounce instead of forwarding every write.
// ---------------------------------------------------------------------------

import { watch, type FSWatcher } from 'chokidar';
import { sep } from 'node:path';
import type { EventHub } from './events.js';

const DEBOUNCE_MS = 750;

/** Files whose churn means nothing to the UI. */
const IGNORED = [
  /(^|[/\\])\../,          // dotfiles (.DS_Store, .thumbnail-cache dirs)
  /\.tmp$/i,
  /~$/,
];

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly workspaceDir: string,
    private readonly hub: EventHub,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.workspaceDir, {
      ignored: IGNORED,
      ignoreInitial: true,
      // Renders are large; wait for writes to settle before reporting.
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
      depth: 8,
    });
    const onChange = (path: string) => this.handle(path);
    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('unlink', onChange);
    this.watcher.on('addDir', onChange);
    this.watcher.on('unlinkDir', onChange);
    this.watcher.on('error', () => {
      // A watcher error (e.g. EMFILE) degrades to manual refresh; never fatal.
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  /** Map an absolute path to the project slug (first dir under the workspace). */
  private projectOf(path: string): string | null {
    if (!path.startsWith(this.workspaceDir)) return null;
    const rel = path.slice(this.workspaceDir.length).replace(/^[/\\]+/, '');
    const first = rel.split(sep)[0];
    return first || null;
  }

  private handle(path: string): void {
    const project = this.projectOf(path);
    if (!project) return;
    const existing = this.pending.get(project);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(project);
      this.hub.broadcast('state-changed', { project, at: new Date().toISOString() });
    }, DEBOUNCE_MS);
    timer.unref();
    this.pending.set(project, timer);
  }
}
