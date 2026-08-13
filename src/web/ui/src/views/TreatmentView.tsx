import { useState } from 'react';
import type { ProjectState } from '../types';
import { CopyButton, RunButton } from './shared';
import { WorkshopPanel } from './WorkshopPanel';

/**
 * Pre-production overview: concept, aesthetic, pipeline stage per episode,
 * the copy-pasteable next command, and the workshop-script form.
 */
export function TreatmentView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const status = state.status;
  const [concept, setConcept] = useState('');
  const [episodeNumber, setEpisodeNumber] = useState(
    () => state.episodes[state.episodes.length - 1]?.episode ?? 1,
  );
  // Storyboarding is gated server-side on reference art existing for every
  // character and location; surface that gate here instead of letting the
  // button fail after the fact.
  const missingRefs =
    state.characters.filter(character => character.art.length === 0).map(character => character.name)
      .concat(state.locations.filter(location => location.art.length === 0).map(location => location.name));

  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Concept</h2>
        <p style={{ margin: 0 }}>{state.series.concept}</p>
        {state.series.aesthetic?.style && (
          <>
            <h2>Aesthetic</h2>
            <p className="dim" style={{ margin: 0 }}>{state.series.aesthetic.style}</p>
          </>
        )}
      </div>

      {status?.nextCommand && (
        <div className="next-command">
          <span style={{ flex: 1 }}>{status.nextCommand}</span>
          <CopyButton text={status.nextCommand} />
        </div>
      )}

      <WorkshopPanel slug={slug} state={state} busy={busy} />

      <h2>Episodes</h2>
      {status?.episodes.map(episode => (
        <div className="card" key={episode.episode}>
          <strong>
            {String(episode.episode).padStart(2, '0')} {episode.title ?? ''}
          </strong>
          <span className="badge none" style={{ marginLeft: 10 }}>{episode.stage}</span>
          <div className="progress-row">
            <span><b>{episode.shotCount}</b> shots</span>
            <span><b>{episode.panelCount}</b> panels</span>
            <span><b>{episode.videoCount}</b> clips</span>
            <span><b>{episode.dialogueCount}</b> dialogue</span>
            <span>{episode.hasMusic ? 'music ✓' : 'no music'}</span>
            <span>{episode.hasFinalCut ? 'FINAL CUT ✓' : 'not assembled'}</span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!episode.scriptApproved && episode.shotCount > 0 && (
              <RunButton
                slug={slug}
                disabled={busy}
                request={{ command: 'approve-script', episode: episode.episode }}
              >
                Approve script
              </RunButton>
            )}
            {episode.scriptApproved && episode.panelCount < episode.shotCount && (
              missingRefs.length > 0 ? (
                <span className="dim small">
                  Storyboard blocked — missing references for{' '}
                  <b>{missingRefs.join(', ')}</b>. Generate them on the
                  Cast &amp; Locations tab first.
                </span>
              ) : (
                <RunButton
                  slug={slug}
                  disabled={busy}
                  confirm="Storyboarding generates images via the Venice API (billed). Continue?"
                  request={{ command: 'storyboard-episode', episode: episode.episode }}
                >
                  Generate storyboard
                </RunButton>
              )
            )}
          </div>
        </div>
      ))}

      <h2>Quick script draft</h2>
      <div className="card">
        <div className="dim small" style={{ marginBottom: 10 }}>
          Script only — skips the full workshop's treatment, aesthetic, and cast
          development. Use the workshop above for the complete flow.
        </div>
        <div className="form-grid">
          <label>Episode / part</label>
          <input
            type="number"
            min={1}
            value={episodeNumber}
            onChange={ev => setEpisodeNumber(Number.parseInt(ev.target.value, 10) || 1)}
          />
          <label>Concept</label>
          <textarea
            placeholder="What happens in this episode, including target duration"
            value={concept}
            onChange={ev => setConcept(ev.target.value)}
          />
        </div>
        <RunButton
          slug={slug}
          disabled={busy || concept.trim().length === 0}
          request={{
            command: 'workshop-script',
            episode: episodeNumber,
            options: { concept: concept.trim() },
          }}
        >
          Draft script with Venice
        </RunButton>
      </div>
    </div>
  );
}
