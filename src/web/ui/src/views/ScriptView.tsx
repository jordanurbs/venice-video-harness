import { useState } from 'react';
import type { ProjectState } from '../types';
import { RunButton } from './shared';

/**
 * The readable script: workshop treatment material (logline, synopsis,
 * structure) followed by the episode's shots rendered screenplay-style —
 * the thing you actually review before hitting Approve.
 */
export function ScriptView({ slug, state, busy }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  const episode = state.episodes.find(ep => ep.episode === episodeNumber) ?? state.episodes[0];
  const workshop = state.workshop;
  const status = state.status?.episodes.find(ep => ep.episode === episode?.episode);

  // Before approval the shot script lives only inside the workshop draft —
  // no episodes/episode-NNN/script.json exists yet. Render the draft's
  // script so the operator can actually READ what they're approving.
  const isDraftOnly = !episode?.script && Boolean(workshop?.script?.shots?.length);
  const script = episode?.script ?? workshop?.script ?? null;

  if (!script) {
    return (
      <div className="empty">
        No script yet — draft one from the Treatment tab and it will appear here.
      </div>
    );
  }

  return (
    <div>
      {isDraftOnly && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <b>Workshop draft — not yet approved.</b>
          <span className="dim small" style={{ marginLeft: 6 }}>
            This is the draft the workshop proposed (rev {workshop?.revision ?? 1}).
            Approving on the Treatment tab materializes it into production state
            and generates all cast and location references.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        {state.episodes.length > 1 && episode && (
          <select value={episode.episode} onChange={ev => setEpisodeNumber(Number.parseInt(ev.target.value, 10))}>
            {state.episodes.map(ep => (
              <option key={ep.episode} value={ep.episode}>Episode {ep.episode}</option>
            ))}
          </select>
        )}
        <span className="dim small">
          {script.shots.length} shots · {script.totalDuration}
          {script.status ? ` · ${script.status}` : ''}
          {episode && episode.scriptVersions.length > 0 ? ` · v${episode.scriptVersions[episode.scriptVersions.length - 1] + 1}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {!isDraftOnly && episode && status && !status.scriptApproved && script.shots.length > 0 && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm="Approve this script? Storyboarding (billed) is unblocked afterward."
            request={{ command: 'approve-script', episode: episode.episode }}
          >
            Approve script
          </RunButton>
        )}
        {isDraftOnly && (
          <RunButton
            slug={slug}
            disabled={busy}
            confirm="Approve the workshop? The aesthetic, cast, locations, and this script become production state, and all reference images are generated (billed)."
            request={{ command: 'workshop', flags: ['approve'] }}
          >
            Approve workshop
          </RunButton>
        )}
      </div>

      {workshop && (workshop.logline || workshop.synopsis) && (
        <div className="card">
          {workshop.logline && (
            <>
              <h2 style={{ marginTop: 0 }}>Logline</h2>
              <p style={{ margin: 0 }}>{workshop.logline}</p>
            </>
          )}
          {workshop.synopsis && (
            <>
              <h2>Synopsis</h2>
              <p style={{ margin: 0 }} className="dim">{workshop.synopsis}</p>
            </>
          )}
          {workshop.themes && workshop.themes.length > 0 && (
            <div className="dim small" style={{ marginTop: 10 }}>
              Themes: {workshop.themes.join(' · ')}
            </div>
          )}
        </div>
      )}

      {workshop?.structure && workshop.structure.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Structure</h2>
          {workshop.structure.map((act, index) => (
            <div key={index} style={{ marginBottom: 12 }}>
              <strong>{act.name}</strong>
              <span className="dim small"> — {act.purpose}</span>
              <ul className="qa-issues" style={{ marginTop: 4 }}>
                {act.beats.map((beat, beatIndex) => (
                  <li key={beatIndex}>{beat}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {workshop?.aesthetic?.style && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Aesthetic</h2>
          <p style={{ margin: 0 }}>{workshop.aesthetic.style}</p>
          <div className="dim small" style={{ marginTop: 8 }}>
            {[workshop.aesthetic.palette, workshop.aesthetic.lighting, workshop.aesthetic.lensCharacteristics, workshop.aesthetic.filmStock]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      )}

      {isDraftOnly && workshop?.characters && workshop.characters.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Proposed cast</h2>
          {workshop.characters.map((character, index) => (
            <div key={index} style={{ marginBottom: 10 }}>
              <b>{character.name}</b>
              <span className="dim small">
                {character.gender && character.gender !== 'other' ? ` · ${character.gender}` : ''}
                {character.age && character.age !== 'n/a' ? ` · ${character.age}` : ''}
              </span>
              {character.description && (
                <div className="small" style={{ marginTop: 2 }}>{character.description}</div>
              )}
            </div>
          ))}
          {workshop.locations && workshop.locations.length > 0 && (
            <>
              <h2>Proposed locations</h2>
              {workshop.locations.map((location, index) => (
                <div key={index} style={{ marginBottom: 10 }}>
                  <b>{location.name}</b>
                  {location.description && (
                    <div className="small" style={{ marginTop: 2 }}>{location.description}</div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <h2>
        {String(script.episode ?? episode?.episode ?? 1).padStart(2, '0')} · {script.title}
      </h2>
      <div className="screenplay">
        {script.shots.map(shot => (
          <div className="sp-shot" key={`${shot.shotNumber}${shot.shotIdSuffix ?? ''}`}>
            <div className="sp-head">
              <span className="shot-num">
                #{String(shot.shotNumber).padStart(3, '0')}{shot.shotIdSuffix ?? ''}
              </span>
              <span className="sp-slug">
                {[shot.type.toUpperCase(), shot.location?.toUpperCase(), shot.duration]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {shot.transition && <span className="sp-transition">{shot.transition}</span>}
            </div>
            <p className="sp-action">{shot.description}</p>
            {shot.blocking && (
              <p className="sp-blocking">
                <span className="dim">Blocking — </span>{shot.blocking}
              </p>
            )}
            {shot.characters.length > 0 && (
              <div className="dim small">Cast: {shot.characters.join(', ')}</div>
            )}
            {shot.dialogue?.line && (
              <div className="sp-dialogue">
                <div className="sp-speaker">{shot.dialogue.character}</div>
                <div className="sp-line">“{shot.dialogue.line}”</div>
              </div>
            )}
            {shot.sfx && <div className="dim small sp-sfx">SFX: {shot.sfx}</div>}
            {shot.cameraMovement && (
              <div className="dim small">Camera: {shot.cameraMovement}</div>
            )}
          </div>
        ))}
      </div>

      {workshop?.productionNotes && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Production notes</h2>
          {workshop.productionNotes.audioApproach && (
            <p className="small" style={{ margin: '0 0 8px' }}>
              <span className="dim">Audio — </span>{workshop.productionNotes.audioApproach}
            </p>
          )}
          {(workshop.productionNotes.continuityPriorities ?? []).length > 0 && (
            <>
              <div className="small"><b>Continuity priorities</b></div>
              <ul className="qa-issues">
                {workshop.productionNotes.continuityPriorities!.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {(workshop.productionNotes.risks ?? []).length > 0 && (
            <>
              <div className="small" style={{ marginTop: 8 }}><b>Risks</b></div>
              <ul className="qa-issues">
                {workshop.productionNotes.risks!.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
