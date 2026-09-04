import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLoopState, loopControl, mediaUrl, subscribeEvents } from '../api';
import type { LoopManifest, LoopShotState, ProjectState } from '../types';

/**
 * Loop-preview tab: play the whole plan on repeat and hot-swap each shot in as
 * its Turbo/480P take finishes. Because Turbo renders faster than the loop
 * plays, the video keeps evolving while the browser plays. The player reads the
 * current best take per shot; a shot's take is only swapped into the running
 * player when the loop next reaches that shot, so playback is never interrupted.
 */
export function LoopView({ slug, state }: { slug: string; state: ProjectState; busy: boolean }) {
  const [episodeNumber, setEpisodeNumber] = useState(state.episodes[0]?.episode ?? 1);
  const episode = state.episodes.find(ep => ep.episode === episodeNumber) ?? state.episodes[0];

  const [loop, setLoop] = useState<LoopManifest | null>(episode?.loop ?? null);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Player position: which shot is on screen, and the exact clip it's playing.
  // `playingClip` is set only when a shot starts, so a fresh take of the
  // currently-playing shot is deferred to its next cycle (no mid-play reload).
  const [index, setIndex] = useState(0);
  const [playingClip, setPlayingClip] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const clipOf = useCallback((shot: LoopShotState | undefined): string | undefined => {
    if (!shot || shot.currentTake == null) return undefined;
    return shot.takes.find(t => t.n === shot.currentTake)?.file;
  }, []);

  const shots = useMemo(() => loop?.shots ?? [], [loop]);

  // Initial + episode-change load of live engine status.
  useEffect(() => {
    let cancelled = false;
    fetchLoopState(slug)
      .then(res => {
        if (cancelled) return;
        setAttached(Boolean(res.attached));
        if (res.shots) setLoop(res as LoopManifest);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [slug, episodeNumber]);

  // Disk manifest carried in project state (refreshed on watcher pushes).
  useEffect(() => {
    if (episode?.loop) setLoop(episode.loop);
  }, [episode?.loop]);

  // Live per-take updates for instant hot-swap.
  useEffect(() => {
    return subscribeEvents((event, raw) => {
      if (event !== 'loop-updated') return;
      const d = raw as {
        project?: string; episode?: number; shotNumber?: number;
        status?: LoopShotState['status']; currentTake?: number | null; pinned?: boolean;
        clip?: string; spendUsd?: number; running?: boolean;
      };
      if (d.project !== slug || (d.episode !== undefined && d.episode !== episodeNumber)) return;
      setAttached(true);
      setLoop(prev => {
        if (!prev) return prev;
        const nextShots = prev.shots.map(s => {
          if (s.shotNumber !== d.shotNumber) return s;
          const takes = [...s.takes];
          if (d.clip && d.currentTake != null && !takes.some(t => t.n === d.currentTake)) {
            takes.push({ n: d.currentTake, file: d.clip, costUsd: 0, at: new Date().toISOString() });
          }
          return {
            ...s,
            takes,
            status: d.status ?? s.status,
            currentTake: d.currentTake !== undefined ? d.currentTake : s.currentTake,
            pinned: d.pinned ?? s.pinned,
          };
        });
        return {
          ...prev,
          shots: nextShots,
          spendUsd: d.spendUsd ?? prev.spendUsd,
          running: d.running ?? prev.running,
        };
      });
    });
  }, [slug, episodeNumber]);

  // Start the player as soon as any shot has a clip.
  useEffect(() => {
    if (playingClip) return;
    const firstPlayable = shots.findIndex(s => clipOf(s));
    if (firstPlayable >= 0) {
      setIndex(firstPlayable);
      setPlayingClip(clipOf(shots[firstPlayable]) ?? null);
    }
  }, [shots, playingClip, clipOf]);

  const advance = useCallback(() => {
    if (shots.length === 0) return;
    for (let step = 1; step <= shots.length; step++) {
      const next = (index + step) % shots.length;
      const clip = clipOf(shots[next]);
      if (clip) {
        setIndex(next);
        setPlayingClip(clip);
        return;
      }
    }
    // No other shot is playable — keep looping this one.
    const same = clipOf(shots[index]);
    if (same && videoRef.current) { videoRef.current.currentTime = 0; void videoRef.current.play(); }
  }, [shots, index, clipOf]);

  const jumpTo = (i: number) => {
    const clip = clipOf(shots[i]);
    if (!clip) return;
    setIndex(i);
    setPlayingClip(clip);
  };

  const control = async (
    action: 'start' | 'stop' | 'pin' | 'regenerate',
    payload?: { shotNumber?: number; pinned?: boolean },
  ) => {
    setError(null);
    const res = await loopControl(slug, action, payload);
    if ('error' in res) setError(res.error);
    else { setLoop(res); setAttached(true); }
  };

  if (!episode) return <div className="empty">No episodes yet.</div>;

  const running = loop?.running ?? false;
  const mode = loop?.mode ?? 'watch';
  const budget = loop?.budgetUsd ?? null;
  const spend = loop?.spendUsd ?? 0;
  const budgetReached = !running && attached && budget != null && Number.isFinite(budget) && spend >= budget - 1e-6;
  const readyCount = shots.filter(s => clipOf(s)).length;
  const currentShot = shots[index];

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
        <span className={`badge ${running ? 'pass' : 'none'}`}>{running ? 'running' : attached ? 'paused' : 'not started'}</span>
        {loop && (
          <span className="badge low" title={mode === 'create' ? 'Production — Max R2V + references, higher quality, takes are usable' : 'Looping — Turbo draft, lower quality, identity not locked'}>
            {mode === 'create' ? 'production' : 'looping'}
          </span>
        )}
        <span className="dim small">{readyCount}/{shots.length || (episode.script?.shots.length ?? 0)} shots have a take</span>
        <span style={{ flex: 1 }} />
        {loop && (
          <span className="dim small loop-meter">
            {loop.resolution} · spend ${spend.toFixed(2)}{budget != null && Number.isFinite(budget) ? ` / $${budget.toFixed(2)}` : ' (unbounded)'}
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loop && (
        <div className="card dim small">
          {mode === 'create'
            ? 'Production loop: gather usable shots — MiniMax H3 Max R2V + references at 768P, identity locked per shot (slower, higher quality). '
            : 'Looping: creative flow — fast MiniMax H3 Max Turbo at 480P, lower quality, identity not locked. Started with --mode production to gather usable shots instead. '}
          {loop.chain
            ? `Chaining is on — the first shot renders t2v and every shot after it renders i2v off the previous shot's last frame, so the loop plays as one continuous piece. Each take is ${loop.duration}.`
            : `Chaining is off — each shot is rendered independently. Each take is ${loop.duration}.`}
        </div>
      )}

      {!attached && (
        <div className="card dim small">
          The loop engine is not attached to this project. Start it from a terminal with{' '}
          <code>venice-video loop -p &lt;project&gt; -e {episode.episode} --mode {mode === 'create' ? 'production' : 'looping'}</code>, then this tab drives it live.
        </div>
      )}

      <div className="loop-stage card">
        {playingClip ? (
          <video
            ref={videoRef}
            src={mediaUrl(slug, playingClip)}
            autoPlay
            muted
            playsInline
            controls
            onEnded={advance}
            style={{ width: '100%', borderRadius: 8, background: '#000' }}
          />
        ) : (
          <div className="loop-placeholder">
            {running ? 'Rendering the first takes…' : 'No takes yet. Start the loop to begin rendering.'}
          </div>
        )}
        {currentShot && (
          <div className="dim small" style={{ marginTop: 8 }}>
            Now playing shot {currentShot.key}
            {currentShot.currentTake != null ? ` · take ${currentShot.currentTake}` : ''}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0 20px' }}>
        {running ? (
          <button className="ghost" onClick={() => control('stop')} disabled={!attached}>Pause loop</button>
        ) : (
          <button
            className="action"
            onClick={() => control('start')}
            disabled={!attached}
            title={attached ? 'Resume rendering (authorizes another budget if the cap was reached)' : 'Run `venice-video loop` first'}
          >
            {budgetReached ? 'Resume (authorize more budget)' : 'Start loop'}
          </button>
        )}
        {budgetReached && (
          <span className="dim small" style={{ color: '#e5b567' }}>
            Budget of ${Number(budget).toFixed(2)} reached — Resume authorizes another ${Number(budget).toFixed(2)}.
          </span>
        )}
        {running && <span className="dim small">Rendering continuously — Pause to stop spending.</span>}
      </div>

      <h2 style={{ marginTop: 0 }}>Shots</h2>
      <div className="loop-shot-list">
        {shots.length === 0 && (
          <div className="empty">No loop takes yet. Start the loop to render the plan.</div>
        )}
        {shots.map((s, i) => {
          const clip = clipOf(s);
          return (
            <div className={`loop-shot-row${i === index ? ' current' : ''}`} key={s.shotNumber}>
              <button className="loop-shot-open" onClick={() => jumpTo(i)} disabled={!clip} title={clip ? 'Play from here' : 'No take yet'}>
                <span className="shot-num">{s.key}</span>
              </button>
              <span className={`dot ${s.status === 'rendering' ? 'running' : s.status === 'error' ? 'failed' : clip ? 'succeeded' : ''}`} />
              <span
                className="dim small"
                style={{ minWidth: 96 }}
                title={clip ? `Playing take #${s.currentTake}. ${s.takes.length} of the latest takes are kept on disk (the --max-takes ring buffer); older ones are pruned as new takes render.` : undefined}
              >
                {s.status === 'rendering' ? 'rendering…' : s.status === 'error' ? 'error' : clip ? `take #${s.currentTake} · ${s.takes.length} kept` : 'queued'}
              </span>
              {s.pinned && <span className="badge pass">pinned</span>}
              <span style={{ flex: 1 }} />
              <button
                className="ghost"
                disabled={!attached || s.currentTake == null}
                onClick={() => control('pin', { shotNumber: s.shotNumber, pinned: !s.pinned })}
              >
                {s.pinned ? 'unpin' : 'pin'}
              </button>
              <button
                className="ghost"
                disabled={!attached}
                onClick={() => control('regenerate', { shotNumber: s.shotNumber })}
              >
                regenerate
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
