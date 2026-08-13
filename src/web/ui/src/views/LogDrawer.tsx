import { useEffect, useRef, useState } from 'react';
import type { JobRecord } from '../types';

/**
 * Right-hand jobs pane: streams the selected job's CLI output with the
 * recent-jobs list above it. Auto-opens when a job starts; collapses to a
 * slim rail so the status dot stays visible while you work.
 */
export function LogPane({ jobs }: { jobs: JobRecord[] }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const latest = jobs[0];
  const job = jobs.find(item => item.id === selectedId) ?? latest;

  // Auto-open and follow a new run.
  useEffect(() => {
    if (latest?.status === 'running') {
      setOpen(true);
      setSelectedId(latest.id);
    }
  }, [latest?.id, latest?.status]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [job?.id, job?.lines.length]);

  if (!latest) return null;

  if (!open) {
    return (
      <button
        className="log-rail"
        title={`${latest.command} · ${latest.status} — open jobs pane`}
        onClick={() => setOpen(true)}
      >
        <span className={`dot ${latest.status}`} />
        <span className="log-rail-label">jobs</span>
      </button>
    );
  }

  return (
    <aside className="log-pane">
      <div className="log-pane-head">
        <b className="small">Jobs</b>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setOpen(false)}>collapse</button>
      </div>

      <div className="log-pane-jobs">
        {jobs.map(item => (
          <button
            key={item.id}
            className={item.id === job?.id ? 'log-job selected' : 'log-job'}
            onClick={() => setSelectedId(item.id)}
          >
            <span className={`dot ${item.status}`} />
            <span className="log-job-name">{item.command}</span>
            <span className="dim log-job-meta">
              {item.status === 'running'
                ? 'running'
                : `exit ${item.exitCode ?? '?'}`}
            </span>
          </button>
        ))}
      </div>

      {job && (
        <pre ref={preRef} className="log-pane-output">
          {job.lines.map((entry, index) => (
            <div key={index} className={entry.stream === 'stderr' ? 'err' : undefined}>
              {entry.line}
            </div>
          ))}
          {job.lines.length === 0 && <div className="dim">No output yet…</div>}
        </pre>
      )}
    </aside>
  );
}

/** Back-compat alias so existing imports keep working. */
export { LogPane as LogDrawer };
