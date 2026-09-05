import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStreamState, mediaUrl, streamControl, subscribeEvents } from '../api';
import type { ProjectState, StreamBeat, StreamManifest, StreamStatus } from '../types';

/**
 * Stream tab: an infinite, live-authored story. The writer model authors one
 * beat at a time; each beat renders i2v off the previous beat's last frame.
 * Nothing repeats. The player plays forward from beat 1 and, when it reaches
 * the newest beat before the next one is ready, holds on the last frame.
 */
export function StreamView({ slug, state }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  // A stream may run under an episode that is not registered in series.json yet
  // (the `stream` command needs only series.json). Fall back to a synthetic
  // episode so the view — and the Start button — render regardless.
  const episode = state.episodes.find(ep => ep.episode === episodeNumber)
    ?? state.episodes[0]
    ?? ({ episode: episodeNumber } as unknown as ProjectState['episodes'][number]);

  const [stream, setStream] = useState<StreamManifest | null>(episode?.stream ?? null);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Player: index into beats. `waiting` is true when the player has finished the
  // newest beat and the next is not ready yet.
  const [index, setIndex] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const beats = useMemo(() => stream?.beats ?? [], [stream]);
  const current = beats[index];

  useEffect(() => {
    let cancelled = false;
    fetchStreamState(slug)
      .then(res => {
        if (cancelled) return;
        setAttached(Boolean(res.attached));
        if (res.beats) setStream(res as StreamManifest);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [slug, episodeNumber]);

  // The disk manifest (re-read on every `state-changed`) is a FALLBACK, not the
  // truth. The engine's `stream-updated` events are the truth. Merging by beat
  // number means a stale on-disk snapshot can never remove a beat the SSE
  // already delivered — the race that made new beats vanish until a reload.
  useEffect(() => {
    const disk = episode?.stream;
    if (!disk) return;
    setStream(prev => {
      if (!prev) return disk;
      const byN = new Map<number, StreamBeat>();
      for (const b of prev.beats) byN.set(b.n, b);
      for (const b of disk.beats) if (!byN.has(b.n)) byN.set(b.n, b);
      const beats = [...byN.values()].sort((a, b) => a.n - b.n);
      return { ...disk, ...prev, beats, spendUsd: Math.max(prev.spendUsd ?? 0, disk.spendUsd ?? 0) };
    });
  }, [episode?.stream]);

  useEffect(() => {
    return subscribeEvents((event, raw) => {
      if (event !== 'stream-updated') return;
      const d = raw as {
        project?: string; episode?: number; status?: StreamStatus; running?: boolean;
        inFlight?: number; lastError?: string; spendUsd?: number; beat?: StreamBeat;
      };
      if (d.project !== slug || (d.episode !== undefined && d.episode !== episodeNumber)) return;
      setAttached(true);
      setStream(prev => {
        // First event before the initial fetch resolved: pull the full state
        // once instead of dropping the beat on the floor.
        if (!prev) {
          fetchStreamState(slug).then(res => { if (res.beats) setStream(res as StreamManifest); }).catch(() => undefined);
          return prev;
        }
        const nextBeats = d.beat && !prev.beats.some(b => b.n === d.beat!.n)
          ? [...prev.beats, d.beat].sort((a, b) => a.n - b.n)
          : prev.beats;
        return {
          ...prev,
          beats: nextBeats,
          status: d.status ?? prev.status,
          running: d.running ?? prev.running,
          inFlight: d.inFlight,
          lastError: d.lastError,
          spendUsd: d.spendUsd ?? prev.spendUsd,
        };
      });
    });
  }, [slug, episodeNumber]);

  // When a new beat lands while we are waiting on the newest one, advance.
  useEffect(() => {
    if (waiting && beats.length > index + 1) {
      setIndex(index + 1);
      setWaiting(false);
    }
  }, [beats.length, waiting, index]);

  // Only the <video> element swaps source (keyed by file); the page never
  // reloads. Kick playback explicitly after a swap — `autoPlay` alone is
  // ignored by some browsers once the previous clip has ended.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  }, [current?.file]);

  const advance = useCallback(() => {
    if (index + 1 < beats.length) {
      setIndex(index + 1);
    } else {
      // Hold on the last frame until the next beat is ready.
      setWaiting(true);
    }
  }, [index, beats.length]);

  const control = async (action: 'start' | 'stop') => {
    setError(null);
    const res = await streamControl(slug, action);
    if ('error' in res) setError(res.error);
    else { setStream(res); setAttached(true); }
  };

  if (!episode) return <div className="empty">No episodes yet.</div>;

  const running = Boolean(stream?.running);
  const status = stream?.status ?? 'idle';
  const spend = stream?.spendUsd ?? 0;
  const budget = stream?.budgetUsd;
  const budgetReached = Boolean(stream) && !running && budget != null && Number.isFinite(budget) && spend + 0.01 >= budget;
  const newest = beats[beats.length - 1];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        {state.episodes.length > 1 && (
          <select value={episode.episode} onChange={ev => setEpisodeNumber(Number.parseInt(ev.target.value, 10))}>
            {state.episodes.map(ep => (
              <option key={ep.episode} value={ep.episode}>Episode {ep.episode}</option>
            ))}
          </select>
        )}
        <span className={`badge ${running ? 'pass' : 'none'}`}>{running ? 'streaming' : attached ? (beats.length > 0 ? 'paused — ready to continue' : 'preparing opening beat') : 'not attached'}</span>
        {running && (status === 'writing' || status === 'rendering') && (
          <span className="badge low">
            {status === 'writing' ? `writing beat ${stream?.inFlight ?? beats.length + 1}` : `rendering beat ${stream?.inFlight ?? beats.length + 1}`}
          </span>
        )}
        <span className="dim small">{beats.length} beat{beats.length === 1 ? '' : 's'} so far</span>
        <span style={{ flex: 1 }} />
        {stream && (
          <span className="dim small loop-meter">
            {stream.resolution} · {stream.duration}/beat · spend ${spend.toFixed(2)}{budget != null && Number.isFinite(budget) ? ` / $${budget.toFixed(2)}` : ' (unbounded)'}
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {stream?.lastError && (
        <div className="error-banner">
          Beat {stream.inFlight ?? beats.length + 1} failed and is retrying: {stream.lastError}
          {' '}(the engine steps the start frame back, then falls back to a text-to-video reset; it stops after 3 failures in a row).
        </div>
      )}

      <div className="card dim small">
        An infinite story. The writer ({stream?.model.writer ?? 'intelligence model'}) authors one beat at a time.
        Beat 1 renders text-to-video; every later beat renders image-to-video from the previous beat's last frame.
        Nothing repeats, nothing re-renders, no re-anchoring — the picture evolves the way one very long take would.
        {stream?.direction ? <> Standing direction: <em>{stream.direction}</em>.</> : null}
      </div>

      {!attached && (
        <div className="card dim small">
          The stream engine is not attached to this project. Start it from a terminal with{' '}
          <code>venice-video stream -p &lt;project&gt; -e {episode.episode}</code>, then this tab drives it live.
        </div>
      )}

      <div className="loop-stage card">
        {current ? (
          <video
            key={current.file}
            ref={videoRef}
            src={mediaUrl(slug, current.file)}
            autoPlay
            playsInline
            controls
            onEnded={advance}
            style={{ width: '100%', borderRadius: 8, background: '#000' }}
          />
        ) : (
          <div className="loop-placeholder">
            {running ? (status === 'writing' ? 'Writing the opening beat…' : 'Rendering the opening beat…') : 'No beats yet. Start the stream to begin.'}
          </div>
        )}
        {current && (
          <div className="dim small" style={{ marginTop: 8 }}>
            Beat {current.n} of {beats.length}
            {waiting ? ' · waiting for the next beat…' : ''}
            {current.beat.dialogue ? <> · <strong>{current.beat.dialogue.character}:</strong> “{current.beat.dialogue.line}”</> : null}
          </div>
        )}
        {current && <div className="small" style={{ marginTop: 4 }}>{current.beat.description}</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0 20px' }}>
        {running ? (
          <button className="ghost" onClick={() => control('stop')} disabled={!attached}>Pause stream</button>
        ) : (
          <button
            className="action"
            onClick={() => control('start')}
            disabled={!attached}
            title={attached ? 'Continue the story (authorizes another budget if the cap was reached)' : 'Run `venice-video stream` first'}
          >
            {budgetReached ? 'Continue (authorize more budget)' : beats.length > 1 ? 'Continue stream' : 'Start stream'}
          </button>
        )}
        {budgetReached && (
          <span className="dim small" style={{ color: '#e5b567' }}>
            Budget of ${Number(budget).toFixed(2)} reached — Continue authorizes another budget.
          </span>
        )}
        {current && newest && current.n !== newest.n && (
          <button className="ghost" onClick={() => { setIndex(beats.length - 1); setWaiting(false); }}>Jump to newest</button>
        )}
        {running && <span className="dim small">Streaming — Pause to stop spending. The beat in flight will finish.</span>}
        {!running && attached && beats.length > 0 && !budgetReached && (
          <span className="dim small">Paused. Start renders the next beat immediately and keeps going.</span>
        )}
      </div>

      <h2 style={{ marginTop: 0 }}>Story So Far</h2>
      <div className="loop-shot-list">
        {beats.length === 0 && <div className="empty">No beats yet.</div>}
        {[...beats].reverse().map(b => (
          <div
            className={`loop-shot-row${b.n === current?.n ? ' current' : ''}`}
            key={b.n}
            role="button"
            tabIndex={0}
            title="Play this beat"
            style={{ cursor: 'pointer' }}
            onClick={() => { setIndex(b.n - 1); setWaiting(false); }}
            onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setIndex(b.n - 1); setWaiting(false); } }}
          >
            <button className="loop-shot-open" onClick={ev => { ev.stopPropagation(); setIndex(b.n - 1); setWaiting(false); }} title="Play this beat">
              <span className="shot-num">{b.n}</span>
            </button>
            <span className="dot succeeded" />
            <span className="small" style={{ flex: 1 }}>
              {b.beat.summary}
              {b.beat.dialogue ? <span className="dim"> — {b.beat.dialogue.character}: “{b.beat.dialogue.line}”</span> : null}
            </span>
            <span
              className={b.lane === 't2v-reset' ? 'badge low' : 'dim small'}
              title={b.lane === 't2v' ? 'Opening beat, text-to-video' : b.lane === 't2v-reset' ? 'Chained render failed repeatedly; this beat re-established the picture from text (identity may drift here)' : 'Chained image-to-video off the previous beat'}
            >{b.lane}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
