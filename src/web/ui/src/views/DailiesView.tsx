import { useState } from 'react';
import { mediaUrl } from '../api';
import type { ProjectState } from '../types';
import { RunButton } from './shared';

/**
 * Review the rendered generation units (montages) with their prompts, then
 * run video QA. This is the "watch the dailies" pass before assembly.
 */
export function DailiesView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  const episode = state.episodes.find(ep => ep.episode === episodeNumber) ?? state.episodes[0];

  if (!episode) return <div className="empty">No episodes yet.</div>;

  const status = state.status?.episodes.find(ep => ep.episode === episode.episode);
  const rendered = episode.units.filter(unit => unit.file);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        {state.episodes.length > 1 && (
          <select value={episode.episode} onChange={ev => setEpisodeNumber(Number.parseInt(ev.target.value, 10))}>
            {state.episodes.map(ep => (
              <option key={ep.episode} value={ep.episode}>Episode {ep.episode}</option>
            ))}
          </select>
        )}
        <span className="dim small">
          {rendered.length}/{episode.units.length} generation units rendered
        </span>
        <span style={{ flex: 1 }} />
        {status && status.videoCount >= status.shotCount && status.shotCount > 0 && !status.videoQaReported && (
          <RunButton slug={slug} disabled={busy} request={{ command: 'qa-videos', episode: episode.episode }}>
            Run video QA
          </RunButton>
        )}
      </div>

      {episode.units.length === 0 && (
        <div className="empty">No generation plan yet — render videos from the Shots tab first.</div>
      )}

      <div className="unit-list">
        {episode.units.map(unit => (
          <div className="unit" key={unit.unitId}>
            {unit.file ? (
              <video src={mediaUrl(slug, unit.file)} controls preload="metadata" />
            ) : (
              <div style={{ width: 320, aspectRatio: '16/9', background: 'var(--panel-2)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                not rendered
              </div>
            )}
            <div className="unit-meta">
              <strong>{unit.unitId}</strong>
              <div className="dim small">
                shots {unit.shotNumbers.join(', ')}{unit.model ? ` · ${unit.model}` : ''}
              </div>
              {unit.prompt && <div className="prompt">{unit.prompt}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
