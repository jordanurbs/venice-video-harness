import { useState } from 'react';
import { mediaUrl } from '../api';
import type { ProjectState } from '../types';
import { RunButton } from './shared';

/**
 * Post-production: assemble the episode, play the final cut, generate music,
 * and export an NLE timeline. Heavy editing stays in FCP/Resolve via the
 * harness's FCPXML export — this panel just drives the hand-off.
 */
export function PostView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  const [format, setFormat] = useState('fcpxml');
  const [musicPrompt, setMusicPrompt] = useState('');
  const episode = state.episodes.find(ep => ep.episode === episodeNumber) ?? state.episodes[0];

  if (!episode) return <div className="empty">No episodes yet.</div>;

  const status = state.status?.episodes.find(ep => ep.episode === episode.episode);

  return (
    <div>
      {state.episodes.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <select value={episode.episode} onChange={ev => setEpisodeNumber(Number.parseInt(ev.target.value, 10))}>
            {state.episodes.map(ep => (
              <option key={ep.episode} value={ep.episode}>Episode {ep.episode}</option>
            ))}
          </select>
        </div>
      )}

      <h2 style={{ marginTop: 0 }}>Final cut</h2>
      {episode.finalCut ? (
        <div className="card">
          <video
            src={mediaUrl(slug, episode.finalCut)}
            controls
            preload="metadata"
            style={{ width: '100%', borderRadius: 8, background: '#000' }}
          />
          <div style={{ marginTop: 8 }}>
            <a href={mediaUrl(slug, episode.finalCut)} download>
              Download final cut
            </a>
          </div>
        </div>
      ) : (
        <div className="card dim">Not assembled yet.</div>
      )}

      <h2>Assemble</h2>
      <div className="card">
        <div className="dim small" style={{ marginBottom: 10 }}>
          Stitches rendered clips, music, and subtitles into episode-{String(episode.episode).padStart(3, '0')}-final.mp4.
          {status && !status.videoQaReported && ' Video QA has not run yet — assemble will be blocked until it passes or you skip it.'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <RunButton
            slug={slug}
            disabled={busy}
            request={{ command: 'assemble-episode', episode: episode.episode }}
          >
            Assemble episode
          </RunButton>
          {status && !status.videoQaReported && (
            <RunButton
              slug={slug}
              disabled={busy}
              ghost
              confirm="Skip video QA and assemble anyway? You are vouching for the rendered units yourself."
              request={{ command: 'assemble-episode', episode: episode.episode, flags: ['skip-video-qa'] }}
            >
              Assemble (skip video QA)
            </RunButton>
          )}
        </div>
      </div>

      <h2>Music</h2>
      <div className="card">
        {episode.music ? (
          <audio src={mediaUrl(slug, episode.music)} controls style={{ width: '100%', marginBottom: 10 }} />
        ) : (
          <div className="dim small" style={{ marginBottom: 10 }}>No music track yet.</div>
        )}
        <div className="form-grid">
          <label>Music prompt</label>
          <input
            placeholder="Style / mood description (optional)"
            value={musicPrompt}
            onChange={ev => setMusicPrompt(ev.target.value)}
          />
        </div>
        <RunButton
          slug={slug}
          disabled={busy}
          confirm="generate-music runs a billed Venice audio job. Continue?"
          request={{
            command: 'generate-music',
            episode: episode.episode,
            ...(musicPrompt.trim() ? { options: { prompt: musicPrompt.trim() } } : {}),
          }}
        >
          Generate music
        </RunButton>
      </div>

      <h2>Export timeline</h2>
      <div className="card">
        <div className="dim small" style={{ marginBottom: 10 }}>
          Hands the episode to a real NLE for finishing. The exported file lands in the episode directory.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={format} onChange={ev => setFormat(ev.target.value)}>
            <option value="fcpxml">Final Cut Pro (fcpxml)</option>
            <option value="premiere">Premiere Pro</option>
            <option value="davinci">DaVinci Resolve</option>
          </select>
          <RunButton
            slug={slug}
            disabled={busy}
            request={{ command: 'export-timeline', episode: episode.episode, options: { format } }}
          >
            Export
          </RunButton>
        </div>
      </div>
    </div>
  );
}
