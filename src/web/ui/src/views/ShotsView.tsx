import { useState } from 'react';
import { mediaUrl } from '../api';
import type { EpisodeState, ProjectState, Shot, ShotMedia } from '../types';
import { RunButton, VerdictBadge } from './shared';

/**
 * Reference-usage badge: green "refs n/n" when every identity in the panel
 * came from real reference bytes; amber "refs n/m + names" when any character
 * fell back to text-only identity (missing sheet, dropped by the 2-layer
 * budget); nothing when the panel has no recorded usage (legacy drafts).
 */
function RefUsageBadge({ refUsage }: { refUsage?: ShotMedia['refUsage'] }) {
  if (!refUsage) return null;
  const total = refUsage.anchored.length + refUsage.textOnly.length;
  if (total === 0) return null;
  const ok = refUsage.textOnly.length === 0;
  const title = ok
    ? `All identities anchored to reference images (base: ${refUsage.base})`
    : `Text-only identity for: ${refUsage.textOnly.join(', ')} — reference image missing or over the 2-layer budget`;
  return (
    <span
      className="small"
      title={title}
      style={{
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        whiteSpace: 'nowrap',
        color: ok ? 'var(--ok, #7dc98f)' : 'var(--warn, #d9a44a)',
        border: `1px solid ${ok ? 'var(--ok, #7dc98f)' : 'var(--warn, #d9a44a)'}`,
        opacity: 0.9,
      }}
    >
      refs {refUsage.anchored.length}/{total}{ok ? '' : ` · ${refUsage.textOnly.join(', ').toLowerCase()}`}
    </span>
  );
}

/**
 * Amber "refs removed" badge on a panel whose recipe references a
 * character/location image that no longer exists on disk — the operator
 * archived it after the panel was drafted, so the panel still depicts the
 * old reference. Regenerating rebuilds it from the current reference set.
 */
function StaleRefsBadge({ staleRefs }: { staleRefs?: string[] }) {
  if (!staleRefs || staleRefs.length === 0) return null;
  return (
    <span
      className="small"
      title={`Built on removed reference${staleRefs.length === 1 ? '' : 's'}: ${staleRefs.join(', ')} — regenerate to rebuild this panel from the current reference set.`}
      style={{
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        whiteSpace: 'nowrap',
        color: 'var(--warn, #d9a44a)',
        border: '1px solid var(--warn, #d9a44a)',
        opacity: 0.9,
      }}
    >
      refs removed
    </span>
  );
}

function EpisodePicker({
  episodes,
  value,
  onChange,
}: {
  episodes: EpisodeState[];
  value: number;
  onChange: (episode: number) => void;
}) {
  if (episodes.length <= 1) return null;
  return (
    <select value={value} onChange={ev => onChange(Number.parseInt(ev.target.value, 10))}>
      {episodes.map(ep => (
        <option key={ep.episode} value={ep.episode}>
          Episode {ep.episode}
        </option>
      ))}
    </select>
  );
}

function FixPanelDialog({
  slug,
  episode,
  shot,
  busy,
  onClose,
}: {
  slug: string;
  episode: number;
  shot: Shot;
  busy: boolean;
  onClose: () => void;
}) {
  const [characters, setCharacters] = useState(shot.characters.join(', '));
  const [prompt, setPrompt] = useState('');
  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" onClick={ev => ev.stopPropagation()}>
        <h3>Fix panel — shot {shot.shotNumber}</h3>
        <div className="form-grid">
          <label>Characters</label>
          <input value={characters} onChange={ev => setCharacters(ev.target.value)} />
          <label>Custom prompt</label>
          <textarea
            placeholder="Optional — overrides the auto-generated edit prompt"
            value={prompt}
            onChange={ev => setPrompt(ev.target.value)}
          />
        </div>
        <div className="actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <RunButton
            slug={slug}
            disabled={busy}
            confirm="fix-panel runs a billed multi-edit pass. Continue?"
            request={{
              command: 'fix-panel',
              episode,
              options: {
                shot: String(shot.shotNumber),
                ...(characters.trim() ? { characters: characters.trim() } : {}),
                ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
              },
            }}
          >
            Run fix-panel
          </RunButton>
        </div>
      </div>
    </div>
  );
}

/** Shot table with panels/clips, QA badges, per-shot retake actions. */
export function ShotsView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  const [fixShot, setFixShot] = useState<Shot | null>(null);
  const episode = state.episodes.find(ep => ep.episode === episodeNumber) ?? state.episodes[0];

  if (!episode?.script) {
    return <div className="empty">No script yet — draft one from the Treatment tab.</div>;
  }

  const status = state.status?.episodes.find(ep => ep.episode === episode.episode);
  const qaSummary = episode.qaReport?.summary;

  // Panels built on a reference image that has since been removed from disk.
  const affectedShots = episode.shots.filter(media => (media.staleRefs?.length ?? 0) > 0);
  const affectedList = affectedShots.map(media => media.shotNumber).join(',');
  const removedRefLabels = [...new Set(affectedShots.flatMap(media => media.staleRefs ?? []))].sort();

  return (
    <div>
      {affectedShots.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn, #b98a2e)', marginBottom: 14 }}>
          <b>
            {affectedShots.length} panel{affectedShots.length === 1 ? '' : 's'} built on removed reference
            {removedRefLabels.length === 1 ? '' : 's'}.
          </b>
          <span className="dim small" style={{ marginLeft: 6 }}>
            Shots {affectedShots.map(media => media.shotNumber).join(', ')} were drafted from{' '}
            {removedRefLabels.join(', ')}, which {removedRefLabels.length === 1 ? 'is' : 'are'} no
            longer on disk. Regenerate to rebuild them from the current reference set — each panel is
            archived first (recoverable), and only these shots are touched.
          </span>
          <div style={{ marginTop: 10 }}>
            <RunButton
              slug={slug}
              disabled={busy}
              confirm={
                `Regenerate ${affectedShots.length} panel${affectedShots.length === 1 ? '' : 's'} built on removed references ` +
                `(shots ${affectedList})? Existing panels are archived and rebuilt from the current references. ` +
                `This runs billed image passes. Continue?`
              }
              request={{
                command: 'storyboard-episode',
                episode: episode.episode,
                options: { shots: affectedList },
              }}
            >
              Regenerate affected panels ({affectedShots.length})
            </RunButton>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <EpisodePicker episodes={state.episodes} value={episode.episode} onChange={setEpisodeNumber} />
        {qaSummary && (
          <span className="dim small">
            QA: {qaSummary.pass ?? 0}/{qaSummary.total ?? 0} pass
            {qaSummary.flagCritical ? ` · ${qaSummary.flagCritical} critical` : ''}
            {qaSummary.flagModerate ? ` · ${qaSummary.flagModerate} moderate` : ''}
            {qaSummary.errored ? ` · ${qaSummary.errored} unchecked` : ''}
          </span>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {((qaSummary?.flagCritical ?? 0) + (qaSummary?.flagModerate ?? 0)) > 0 && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm={`fix-flagged runs a billed multi-edit pass on every critical/moderate panel (${(qaSummary?.flagCritical ?? 0) + (qaSummary?.flagModerate ?? 0)} shot${((qaSummary?.flagCritical ?? 0) + (qaSummary?.flagModerate ?? 0)) === 1 ? '' : 's'}), then re-runs QA on them. Continue?`}
            request={{
              command: 'fix-flagged',
              episode: episode.episode,
              options: {},
              flags: ['requa'],
            }}
          >
            Fix all flagged
          </RunButton>
        )}
        {status && !status.qaReported && status.panelCount >= status.shotCount && status.shotCount > 0 && (
          <RunButton
            slug={slug}
            disabled={busy}
            request={{ command: 'qa-storyboard', episode: episode.episode }}
          >
            Run storyboard QA
          </RunButton>
        )}
        {status?.qaReported && !status.qaApproved && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm="Approve the storyboard QA gate? This unblocks billed video rendering."
            request={{ command: 'qa-approve', episode: episode.episode }}
          >
            Approve QA gate
          </RunButton>
        )}
        {status?.qaApproved && status.videoCount < status.shotCount && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm="generate-videos queues billed renders with the Venice API. Continue?"
            request={{ command: 'generate-videos', episode: episode.episode }}
          >
            Generate videos
          </RunButton>
        )}
        {status && !status.qaApproved && status.shotCount > 0 && status.videoCount < status.shotCount && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm={
              'Skip storyboarding and render straight from references? ' +
              'Character sheets, blocking plates, and location angles carry consistency (pure reference mode on Seedance R2V); ' +
              'no panels or storyboard QA are used. Shots with no references at all will be skipped. ' +
              'This queues billed renders with the Venice API. Continue?'
            }
            request={{ command: 'generate-videos', episode: episode.episode, flags: ['skip-qa'] }}
          >
            Generate videos — skip storyboard
          </RunButton>
        )}
      </div>

      <div className="shot-grid">
        {episode.script.shots.map(shot => {
          const media = episode.shots.find(item => item.shotNumber === shot.shotNumber);
          return (
            <div className="shot-card" key={`${shot.shotNumber}`}>
              {media?.clip ? (
                <video className="media" src={mediaUrl(slug, media.clip)} controls preload="metadata" />
              ) : media?.panel ? (
                <img className="media" src={mediaUrl(slug, media.panel)} loading="lazy" />
              ) : (
                <div className="media" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                  not rendered
                </div>
              )}
              <div className="body">
                <div className="head">
                  <span className="shot-num">#{String(shot.shotNumber).padStart(3, '0')}</span>
                  <span className="dim small">{shot.type} · {shot.duration}</span>
                  <span style={{ flex: 1 }} />
                  <StaleRefsBadge staleRefs={media?.staleRefs} />
                  <RefUsageBadge refUsage={media?.refUsage} />
                  <VerdictBadge verdict={media?.qaVerdict} />
                </div>
                <div className="small">{shot.panelDescription ?? shot.description}</div>
                {shot.dialogue && (
                  <div className="small dim" style={{ marginTop: 4 }}>
                    {shot.dialogue.character}: “{shot.dialogue.line}”
                  </div>
                )}
                {media?.qaIssues && media.qaIssues.length > 0 && (
                  <ul className="qa-issues">
                    {media.qaIssues.map((issue, index) => (
                      <li key={index}>{issue}</li>
                    ))}
                  </ul>
                )}
                {media?.panel && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="ghost" disabled={busy} onClick={() => setFixShot(shot)}>
                      Fix panel…
                    </button>
                    <RunButton
                      slug={slug}
                      ghost
                      disabled={busy}
                      confirm={
                        `Regenerate the panel for shot ${shot.shotNumber}? ` +
                        `The current panel is archived and rebuilt from the current references ` +
                        `(billed image pass). Continue?`
                      }
                      request={{
                        command: 'storyboard-episode',
                        episode: episode.episode,
                        options: { shots: String(shot.shotNumber) },
                      }}
                    >
                      {(media.staleRefs?.length ?? 0) > 0 ? 'Regenerate panel (refs removed)' : 'Regenerate panel'}
                    </RunButton>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {fixShot && (
        <FixPanelDialog
          slug={slug}
          episode={episode.episode}
          shot={fixShot}
          busy={busy}
          onClose={() => setFixShot(null)}
        />
      )}
    </div>
  );
}
