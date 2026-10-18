import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Maximize, Minimize, MousePointerClick, MonitorOff, WifiOff } from 'lucide-react';
import { backend } from '../backend/index.js';
import { BrandMark } from '../components/Brand.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { R2Countdown, TriviaBoard } from '../components/Round2Bits.jsx';
import { R2QuestionActions, R2SelectedActions, R2TeamModal, useR2Gameplay } from '../components/Round2Controls.jsx';
import { Round2Provider, useR2Data } from '../context/Round2Context.jsx';
import { formatScore } from '../lib/round2.js';

/**
 * Round 2 PUBLIC projector for one game (?session=…; without it, the newest live game).
 *
 * It loads only the projector board (r2s_board with p_host = false): tiles, used marks, the open
 * question after Reveal Question, the timer and the answer after Answer — never scores, rankings,
 * the score log or the join code. The organiser can play the game right here: click a tile →
 * Reveal Question / Cancel → Right / Wrong (→ team popup → Confirm Score) / Answer. Every action is
 * an organizer-only, server-validated function, shared with the private host screen and kept in sync
 * with it. `?view=display` (or "Display only") hides the controls for a separate audience screen
 * driven from the host screen.
 */
export default function ProjectorRound2() {
  return (
    <Round2Provider projector>
      <ProjectorScreen />
    </Round2Provider>
  );
}

async function loadProjector(wanted) {
  let id = wanted;
  if (!id) id = (await backend.round2.overview()).sessions.find((g) => g.status === 'live')?.id ?? null;
  return { sessionId: id, board: id ? await backend.round2.board(id, { host: false }) : null };
}

function ProjectorScreen() {
  const [params] = useSearchParams();
  const wanted = params.get('session');
  const [controls, setControls] = useState(params.get('view') !== 'display');
  const [online, setOnline] = useState(navigator.onLine);
  const { data, error } = useR2Data(() => loadProjector(wanted), wanted ?? '');
  const board = data?.board ?? null;
  const sessionId = data?.sessionId ?? wanted;

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  return (
    <div className={`projector r2-projector ${controls ? 'r2-proj-interactive' : ''}`}>
      <FrostBackdrop />
      <Chrome sessionId={sessionId} controls={controls} setControls={setControls} />
      {(!online || error?.code === 'NETWORK') && <div className="proj-conn" role="status"><WifiOff size={16} /> Reconnecting…</div>}
      {!data && !error && <div className="proj-center"><BrandMark size={140} className="pulse" /></div>}
      {data && !board && <div className="proj-center r2-proj-wait"><BrandMark size={140} className="pulse" /><p className="proj-msg">MIND MELTDOWN — waiting for the host to start Round 2…</p></div>}
      {!board && error && <div className="proj-center"><p className="proj-error">Projector cannot load Round 2: {error.message}</p></div>}
      {board && <BoardScreen data={board} controls={controls} />}
    </div>
  );
}

function BoardScreen({ data, controls }) {
  const { game, settings, topics, session } = data;
  const play = useR2Gameplay(data);
  const live = session.status === 'live';
  const interactive = controls && live;
  return (
    <div className="r2-proj">
      <header className="r2-proj-head">
        <div className="proj-brand">
          <BrandMark size={44} />
          <div><b>BRAIN<span>FREZE</span> IT</b><small>ROUND 2</small></div>
        </div>
        <h1 className="r2-proj-title">MIND MELTDOWN</h1>
        <span className="r2-proj-tag">{live ? `${session.title} · ${session.section}` : 'GAME OVER'}</span>
      </header>
      <div className="r2-proj-body r2-proj-solo">
        <div className="r2-proj-board">
          <TriviaBoard topics={topics} activeId={game.question_id} size="xl"
            onPick={interactive ? play.pick : undefined} disabled={game.phase !== 'idle' || play.busy('r2-select')} />
        </div>
      </div>
      {game.phase === 'selected' && (
        <div className="proj-overlay r2-overlay" role={interactive ? 'dialog' : undefined} aria-label={interactive ? 'Question selected' : undefined}>
          <p className="r2-ov-topic">{game.topic}</p>
          <strong className="r2-ov-points">{formatScore(game.points)}<small> POINTS</small></strong>
          <p className="proj-msg">Get ready…</p>
          {interactive && <R2SelectedActions play={play} className="r2-ov-actions" />}
        </div>
      )}
      {game.phase === 'revealed' && (
        <div className="proj-overlay r2-overlay r2-overlay-q">
          <div className="r2-ov-head">
            <p className="r2-ov-topic">{game.topic} · {formatScore(game.points)} POINTS</p>
            <R2Countdown game={game} settings={settings} offsetMs={data.serverOffsetMs} size="xl" />
          </div>
          <p className={`proj-q-text ${(game.question_text || '').length > 160 ? 'long' : ''}`}>{game.question_text}</p>
          {game.answer_revealed
            ? <p className="r2-ov-answer"><small>ANSWER</small>{game.answer_text}</p>
            : <p className="r2-ov-hidden">Answer hidden</p>}
          {interactive && <div className="r2-ov-controls"><R2QuestionActions game={game} play={play} closeButton /></div>}
        </div>
      )}
      {interactive && <R2TeamModal data={data} play={play} />}
    </div>
  );
}

function Chrome({ sessionId, controls, setControls }) {
  const [full, setFull] = useState(!!document.fullscreenElement);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    const fs = () => setFull(!!document.fullscreenElement);
    const key = (e) => { if ((e.key === 'f' || e.key === 'F') && !e.target.closest?.('input, textarea')) toggle(); };
    wake();
    window.addEventListener('mousemove', wake);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); document.removeEventListener('fullscreenchange', fs); window.removeEventListener('keydown', key); };
  }, []);
  return (
    <div className={`proj-chrome ${idle ? 'idle' : ''}`}>
      <Link to={sessionId ? `/host/rounds/2/session/${sessionId}` : '/host/rounds/2'} className="btn btn-ghost btn-sm">← Host screen</Link>
      <button className="btn btn-ghost btn-sm" onClick={() => setControls((c) => !c)} aria-pressed={!controls}>
        {controls ? <><MonitorOff size={16} /> Display only</> : <><MousePointerClick size={16} /> Show controls</>}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={toggle} aria-label="Toggle fullscreen (F)">{full ? <Minimize size={16} /> : <Maximize size={16} />} {full ? 'Exit' : 'Fullscreen'} (F)</button>
    </div>
  );
}

function toggle() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
