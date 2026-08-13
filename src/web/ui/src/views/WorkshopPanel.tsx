import { useState } from 'react';
import type { ProjectState } from '../types';
import { RunButton } from './shared';

/**
 * The full-workshop flow: develop the complete project (story, aesthetic,
 * cast, locations, script, production plan) in one billed LLM pass, iterate
 * with feedback, then approve to materialize production state.
 *
 * Maps 1:1 onto `venice-video workshop` flags; spawned non-TTY, so omitted
 * fields fall back to the previous revision's answers.
 */
export function WorkshopPanel({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const workshop = state.workshop;
  const [outcome, setOutcome] = useState('');
  const [duration, setDuration] = useState('');
  const [audience, setAudience] = useState('');
  const [mustInclude, setMustInclude] = useState('');
  const [avoid, setAvoid] = useState('');
  const [delivery, setDelivery] = useState('standard');
  const [feedback, setFeedback] = useState('');

  const options: Record<string, string> = {};
  if (outcome.trim()) options.outcome = outcome.trim();
  if (duration.trim()) options.duration = duration.trim();
  if (audience.trim()) options.audience = audience.trim();
  if (mustInclude.trim()) options['must-include'] = mustInclude.trim();
  if (avoid.trim()) options.avoid = avoid.trim();
  options.delivery = delivery;

  if (!workshop) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Full workshop</h2>
        <div className="dim small" style={{ marginBottom: 10 }}>
          Develops the complete project in one pass: logline, structure,
          aesthetic, cast, locations, and a full script. All fields optional —
          leave one blank and the workshop decides.
        </div>
        <div className="form-grid">
          <label>Intended outcome</label>
          <textarea
            placeholder="What should the audience feel or do after watching?"
            value={outcome}
            onChange={ev => setOutcome(ev.target.value)}
          />
          <label>Target runtime</label>
          <input placeholder='e.g. "90 seconds"' value={duration} onChange={ev => setDuration(ev.target.value)} />
          <label>Audience</label>
          <input value={audience} onChange={ev => setAudience(ev.target.value)} />
          <label>Must include</label>
          <input
            placeholder="Required story, visual, character, or product elements"
            value={mustInclude}
            onChange={ev => setMustInclude(ev.target.value)}
          />
          <label>Avoid</label>
          <input value={avoid} onChange={ev => setAvoid(ev.target.value)} />
          <label>Delivery</label>
          <select value={delivery} onChange={ev => setDelivery(ev.target.value)}>
            <option value="standard">Standard master</option>
            <option value="4k">4K master (upscaled after assembly)</option>
          </select>
        </div>
        <RunButton
          slug={slug}
          disabled={busy}
          confirm="Develop the full workshop? This runs a billed Venice LLM pass."
          request={{ command: 'workshop', options }}
        >
          Develop workshop
        </RunButton>
      </div>
    );
  }

  const approved = workshop.status === 'approved';

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Workshop</h2>
        <span className={`badge ${approved ? 'pass' : 'none'}`}>
          {approved ? 'approved' : `draft · rev ${workshop.revision ?? 1}`}
        </span>
      </div>
      {workshop.logline && <p style={{ margin: '10px 0 0' }}>{workshop.logline}</p>}
      <div className="dim small" style={{ margin: '6px 0 12px' }}>
        Read the full draft — synopsis, structure, aesthetic, proposed cast,
        and the complete shot script — on the <b>Script</b> tab before approving.
      </div>

      <div className="form-grid">
        <label>Revision feedback</label>
        <textarea
          placeholder='e.g. "Make act two funnier; the drone chase should end on the skybridge"'
          value={feedback}
          onChange={ev => setFeedback(ev.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <RunButton
          slug={slug}
          disabled={busy || !feedback.trim()}
          confirm="Revise the workshop? This runs a billed Venice LLM pass."
          request={{ command: 'workshop', options: { feedback: feedback.trim() } }}
        >
          Revise workshop
        </RunButton>
        {!approved && (
          <RunButton
            slug={slug}
            disabled={busy}
            ghost
            confirm="Approve the workshop? Aesthetic, cast, locations, and script become production state."
            request={{ command: 'workshop', flags: ['approve'] }}
          >
            Approve workshop
          </RunButton>
        )}
      </div>
    </div>
  );
}
