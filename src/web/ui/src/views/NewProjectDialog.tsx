import { useEffect, useState } from 'react';
import { subscribeEvents } from '../api';

const FAMILIES = [
  { value: '', label: 'Ask me later (harness default)' },
  { value: 'auto', label: 'Auto (Seedance default)' },
  { value: 'seedance', label: 'Seedance' },
  { value: 'wan-3-0', label: 'Wan 3.0' },
  { value: 'happyhorse', label: 'HappyHorse' },
  { value: 'minimax-h3', label: 'MiniMax H3' },
  { value: 'grok-imagine', label: 'Grok Imagine' },
  { value: 'kling-o3', label: 'Kling O3' },
];

const ROUTES = [
  { value: 'montage', label: 'Montage — single pass per scene, cut for editing (strongest continuity)' },
  { value: 'standard', label: 'Standard — per-shot, more automated' },
];

const AUDIO = [
  { value: '', label: 'Default' },
  { value: 'native', label: 'Native — the video model speaks in-frame' },
  { value: 'lip-sync', label: 'Lip-sync — Venice speech drives the mouth' },
  { value: 'narrator-vo', label: 'Narrator VO — voice-over only, model audio muted' },
];

/**
 * Start over on a fresh project: collects the new-series essentials and runs
 * the workspace-level create job. On success the server pushes job-finished
 * and the app re-lists projects; we auto-select the new one by name match.
 */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [concept, setConcept] = useState('');
  const [genre, setGenre] = useState('');
  const [setting, setSetting] = useState('');
  const [route, setRoute] = useState('montage');
  const [family, setFamily] = useState('');
  const [audio, setAudio] = useState('');
  const [state, setState] = useState<'idle' | 'creating' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [logTail, setLogTail] = useState<string[]>([]);

  // Watch our create job (workspace scope): stream its output into the
  // dialog and close on success. The main log drawer only tracks the
  // selected project, so this job's transcript lives here.
  useEffect(() => {
    if (!jobId) return;
    const unsubscribe = subscribeEvents((event, raw) => {
      const data = raw as { id?: string; status?: string; line?: string };
      if (data.id !== jobId) return;
      if (event === 'job-output' && data.line) {
        setLogTail(prev => [...prev.slice(-11), data.line!]);
      }
      if (event === 'job-finished') {
        if (data.status === 'succeeded') {
          onCreated(name.trim());
          onClose();
        } else {
          setState('error');
          setError('Project creation failed — details below.');
        }
      }
    });
    return unsubscribe;
  }, [jobId, name, onClose, onCreated]);

  const submit = async () => {
    setState('creating');
    setError(null);
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        concept: concept.trim(),
        ...(genre.trim() ? { genre: genre.trim() } : {}),
        ...(setting.trim() ? { setting: setting.trim() } : {}),
        ...(route ? { route } : {}),
        ...(family ? { videoFamily: family } : {}),
        ...(audio ? { audioStrategy: audio } : {}),
      }),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      setState('error');
      setError(body.error ?? `Request failed (${res.status})`);
      return;
    }
    setJobId(body.id);
  };

  return (
    <div className="dialog-scrim" onClick={state === 'creating' ? undefined : onClose}>
      <div className="dialog" onClick={ev => ev.stopPropagation()}>
        <h3>New project</h3>
        <div className="dim small" style={{ marginBottom: 10 }}>
          Creates a fresh series in the workspace. Nothing is billed until you
          generate references or renders.
        </div>
        <div className="form-grid">
          <label>Name</label>
          <input autoFocus value={name} onChange={ev => setName(ev.target.value)} placeholder="e.g. Canopy Run" />
          <label>Concept</label>
          <textarea
            value={concept}
            onChange={ev => setConcept(ev.target.value)}
            placeholder="Premise, tone, and target duration"
          />
          <label>Genre</label>
          <input value={genre} onChange={ev => setGenre(ev.target.value)} placeholder="drama" />
          <label>Setting</label>
          <input value={setting} onChange={ev => setSetting(ev.target.value)} placeholder="Optional" />
          <label>Render route</label>
          <select value={route} onChange={ev => setRoute(ev.target.value)}>
            {ROUTES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <label>Video family</label>
          <select value={family} onChange={ev => setFamily(ev.target.value)}>
            {FAMILIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <label>Audio strategy</label>
          <select value={audio} onChange={ev => setAudio(ev.target.value)}>
            {AUDIO.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {logTail.length > 0 && (
          <pre
            style={{
              fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6,
              color: 'var(--text-dim)', background: 'var(--panel-2)',
              borderRadius: 6, padding: '8px 10px', maxHeight: 140,
              overflowY: 'auto', margin: '10px 0 0',
            }}
          >
            {logTail.join('\n')}
          </pre>
        )}
        <div className="actions">
          <button className="ghost" onClick={onClose} disabled={state === 'creating'}>Cancel</button>
          <button
            className="action"
            disabled={state === 'creating' || !name.trim() || !concept.trim()}
            onClick={submit}
          >
            {state === 'creating' ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
