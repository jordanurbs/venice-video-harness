import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJobs, fetchProjects, fetchProjectState, subscribeEvents } from './api';
import type { JobRecord, ProjectListEntry, ProjectState } from './types';
import { NewProjectDialog } from './views/NewProjectDialog';
import { TreatmentView } from './views/TreatmentView';
import { ScriptView } from './views/ScriptView';
import { ShotsView } from './views/ShotsView';
import { DailiesView } from './views/DailiesView';
import { CastView } from './views/CastView';
import { PostView } from './views/PostView';
import { SettingsView } from './views/SettingsView';
import { LoopView } from './views/LoopView';
import { LogDrawer } from './views/LogDrawer';

const TABS = ['Treatment', 'Script', 'Shots', 'Dailies', 'Loop', 'Cast & Locations', 'Post', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** Deep-link support: `?project=<slug>&tab=Loop` (the `loop` command opens this). */
function readInitialTab(): Tab | null {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return null;
  const match = TABS.find(name => name.toLowerCase() === raw.toLowerCase());
  return match ?? null;
}
const INITIAL_PROJECT = new URLSearchParams(window.location.search).get('project');

export function App() {
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [tab, setTab] = useState<Tab>(() => readInitialTab() ?? 'Treatment');
  const [error, setError] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  const refreshState = useCallback((project: string) => {
    fetchProjectState(project)
      .then(next => {
        setState(next);
        setError(null);
      })
      .catch(err => setError(String(err)));
    fetchJobs(project).then(res => setJobs(res.jobs)).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetchProjects()
      .then(res => {
        setProjects(res.projects);
        setSlug(prev => {
          if (prev) return prev;
          const deepLinked = INITIAL_PROJECT && res.projects.find(p => p.slug === INITIAL_PROJECT)?.slug;
          return deepLinked || res.projects[0]?.slug || null;
        });
      })
      .catch(err => setError(String(err)));
  }, []);

  useEffect(() => {
    if (slug) refreshState(slug);
  }, [slug, refreshState]);

  // Live updates: refetch on watcher pushes, stream job output into the drawer.
  useEffect(() => {
    if (!slug) return;
    const unsubscribe = subscribeEvents((event, raw) => {
      const data = raw as { project?: string; id?: string; stream?: 'stdout' | 'stderr'; line?: string };
      if (data.project !== slug) return;
      if (event === 'state-changed') refreshState(slug);
      if (event === 'job-started' || event === 'job-finished') {
        fetchJobs(slug).then(res => setJobs(res.jobs)).catch(() => undefined);
        if (event === 'job-finished') refreshState(slug);
      }
      if (event === 'job-output' && data.id && data.line !== undefined) {
        setJobs(prev =>
          prev.map(job =>
            job.id === data.id
              ? { ...job, lines: [...job.lines, { stream: data.stream ?? 'stdout', line: data.line! }] }
              : job,
          ),
        );
      }
    });
    return unsubscribe;
  }, [slug, refreshState]);

  const activeJob = useMemo(() => jobs.find(job => job.status === 'running'), [jobs]);
  const busy = Boolean(activeJob);

  return (
    <>
      <header className="topbar">
        <span className="wordmark">Venice Video</span>
        <select value={slug ?? ''} onChange={ev => setSlug(ev.target.value)}>
          {projects.map(project => (
            <option key={project.slug} value={project.slug}>
              {project.name}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={() => setShowNewProject(true)}>
          + New project
        </button>
        <span className="spacer" />
        {state?.status && (
          <span className={busy ? 'stage-pill busy' : 'stage-pill'}>
            {busy
              ? `running: ${activeJob?.command}`
              : state.status.episodes[0]
                ? state.status.episodes[0].stage
                : 'no episodes'}
          </span>
        )}
      </header>

      <div className="layout">
        <main className="main">
          {error && <div className="error-banner">{error}</div>}
          {!slug && (
            <div className="empty">
              <p>No projects found in the workspace.</p>
              <button className="action" onClick={() => setShowNewProject(true)}>
                Start a new project
              </button>
            </div>
          )}
          {slug && state && (
            <>
              <h1>{state.series.name}</h1>
              <div className="dim small">
                {state.series.genre} · {state.series.setting}
              </div>
              <nav className="tabs">
                {TABS.map(name => (
                  <button
                    key={name}
                    className={tab === name ? 'active' : ''}
                    onClick={() => setTab(name)}
                  >
                    {name}
                  </button>
                ))}
              </nav>
              {tab === 'Treatment' && <TreatmentView slug={slug} state={state} busy={busy} />}
              {tab === 'Script' && <ScriptView slug={slug} state={state} busy={busy} />}
              {tab === 'Shots' && <ShotsView slug={slug} state={state} busy={busy} />}
              {tab === 'Dailies' && <DailiesView slug={slug} state={state} busy={busy} />}
              {tab === 'Loop' && <LoopView slug={slug} state={state} busy={busy} />}
              {tab === 'Cast & Locations' && <CastView slug={slug} state={state} busy={busy} />}
              {tab === 'Post' && <PostView slug={slug} state={state} busy={busy} />}
              {tab === 'Settings' && <SettingsView slug={slug} busy={busy} />}
            </>
          )}
        </main>
        <LogDrawer jobs={jobs} />
      </div>

      {showNewProject && (
        <NewProjectDialog
          onClose={() => setShowNewProject(false)}
          onCreated={createdName => {
            // Re-list and jump to the new project (matched by display name).
            fetchProjects()
              .then(res => {
                setProjects(res.projects);
                const created = res.projects.find(
                  project => project.name.toLowerCase() === createdName.toLowerCase(),
                );
                if (created) {
                  setSlug(created.slug);
                  setTab('Treatment');
                }
              })
              .catch(() => undefined);
          }}
        />
      )}
    </>
  );
}
