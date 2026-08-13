import type { JobRecord, JobRequest, ProjectListEntry, ProjectState } from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchProjects(): Promise<{ workspaceDir: string; projects: ProjectListEntry[] }> {
  return getJson('/api/projects');
}

export function fetchProjectState(slug: string): Promise<ProjectState> {
  return getJson(`/api/projects/${encodeURIComponent(slug)}/state`);
}

export function fetchJobs(slug: string): Promise<{ jobs: JobRecord[] }> {
  return getJson(`/api/projects/${encodeURIComponent(slug)}/jobs`);
}

export async function runCommand(slug: string, req: JobRequest): Promise<{ id: string } | { error: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return res.json();
}

export async function archiveMedia(slug: string, path: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/media/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

export function mediaUrl(slug: string, rel: string): string {
  return `/media/${encodeURIComponent(slug)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export type SseHandler = (event: string, data: unknown) => void;

/** Subscribe to server events. Returns an unsubscribe function. */
export function subscribeEvents(handler: SseHandler): () => void {
  const source = new EventSource('/api/events');
  const names = ['state-changed', 'job-started', 'job-output', 'job-finished'];
  const listeners = names.map(name => {
    const fn = (ev: MessageEvent) => {
      try {
        handler(name, JSON.parse(ev.data));
      } catch {
        // Malformed event payloads are dropped.
      }
    };
    source.addEventListener(name, fn);
    return { name, fn };
  });
  return () => {
    for (const { name, fn } of listeners) source.removeEventListener(name, fn);
    source.close();
  };
}
