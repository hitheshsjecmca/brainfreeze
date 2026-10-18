import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Maximize, Minimize, WifiOff } from 'lucide-react';
import { backend, isDemoMode } from '../backend/index.js';
import { BrandLockup, BrandMark } from '../components/Brand.jsx';
import { OptionGrid, TimerDisplay } from '../components/QuizBits.jsx';
import { useRemaining } from '../lib/hooks.js';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { toQuizError } from '../lib/errors.js';
import { formatPoints } from '../lib/scoring.js';
import { formatJoinCode, joinUrl } from '../lib/joinCodes.js';

// The projector NEVER receives answer keys: it loads a public snapshot
// (questions without keys/explanations + aggregate standings only).
export default function Projector() {
  const [params] = useSearchParams();
  const setId = params.get('set') || null;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [rt, setRt] = useState('CONNECTING');
  const [online, setOnline] = useState(navigator.onLine);
  const busy = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try {
      setData(await backend.loadPublicSnapshot(setId));
      setError(null);
    } catch (e) {
      setError(toQuizError(e));
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; load(); }
    }
  }, [setId]);

  useEffect(() => {
    load();
    let t;
    const off = backend.subscribe(() => { clearTimeout(t); t = setTimeout(load, 100); }, setRt, { includePrivate: false });
    const poll = setInterval(load, isDemoMode ? 10000 : 15000);
    const up = () => { setOnline(true); load(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { off(); clearInterval(poll); clearTimeout(t); window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [load]);

  const disconnected = !online || (error && error.code === 'NETWORK') || (!isDemoMode && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(rt));

  return (
    <div className="projector">
      <FrostBackdrop />
      <ProjectorChrome />
      {disconnected && <div className="proj-conn" role="status"><WifiOff size={16} /> Reconnecting…</div>}
      {!data && !error && <div className="proj-center"><BrandMark size={140} className="pulse" /></div>}
      {!data && error && <div className="proj-center"><p className="proj-error">Projector cannot load quiz data: {error.message}</p></div>}
      {data && <ProjectorView data={data} />}
    </div>
  );
}

function ProjectorChrome() {
  const [full, setFull] = useState(!!document.fullscreenElement);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    const fs = () => setFull(!!document.fullscreenElement);
    const key = (e) => { if (e.key === 'f' || e.key === 'F') toggle(); };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', key);
    document.addEventListener('fullscreenchange', fs);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', key); document.removeEventListener('fullscreenchange', fs); };
  }, []);
  return (
    <div className={`proj-chrome ${idle ? 'idle' : ''}`}>
      <Link to="/host/rounds/1/live" className="btn btn-ghost btn-sm">← Host controls</Link>
      <button className="btn btn-ghost btn-sm" onClick={toggle} aria-label="Toggle fullscreen (F)">{full ? <Minimize size={16} /> : <Maximize size={16} />} {full ? 'Exit' : 'Fullscreen'} (F)</button>
    </div>
  );
}

function toggle() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function ProjectorView({ data }) {
  const { session } = data;
  if (session.projector_view === 'reveal' && session.results_revealed && session.status === 'finalized') return <Reveal data={data} />;
  if (session.projector_view === 'leaderboard') return <Board data={data} />;
  if (session.projector_view === 'question' && session.status !== 'setup' && data.questions.length) {
    return session.self_paced ? <SelfPacedScreen data={data} /> : <QuestionScreen data={data} />;
  }
  return <Standby data={data} />;
}

function Standby({ data }) {
  const { session } = data;
  const msg = session.status === 'setup' ? 'The round begins shortly'
    : ['ended', 'finalized'].includes(session.status) ? 'Round complete · Results after review'
    : session.status === 'paused' ? 'Paused' : 'Stand by';
  return (
    <div className="proj-standby">
      <p className="event-chip">JOSHIANA 15.0 · WINTER ARC</p>
      <BrandLockup size="xl" />
      <p className="proj-subtitle">MCQ ELIMINATION ROUND · {data.section} SECTION · {data.session.name}</p>
      <p className="tagline proj-tagline">THINK. <span>DECODE.</span> COMPETE.</p>
      {session.join_code_active && session.registration_open && (
        <div className="proj-join" aria-label="How to join">
          <span>Join at <b>{joinUrl().replace(/^https?:\/\//, '')}</b></span>
          <strong>{formatJoinCode(session.join_code)}</strong>
        </div>
      )}
      <p className="proj-msg">{msg}</p>
      <ul className="proj-rules">
        <li>{data.teams.length} teams · 2 per team</li>
        <li>{Math.round(data.settings.duration_seconds / 60)} minutes</li>
        <li>Top {data.settings.qualify_count} advance</li>
        <li>No electronic devices</li>
      </ul>
    </div>
  );
}

/** Self-paced: every team has its own question order, so the projector shows the clock and overall progress only. */
function SelfPacedScreen({ data }) {
  const { session, settings, questions, teams } = data;
  const remaining = useRemaining(session, settings, data.serverOffsetMs);
  const expired = remaining <= 0;
  const total = questions.length * teams.length;
  const pct = total ? Math.min(100, Math.round(((data.submitted || 0) / total) * 100)) : 0;
  return (
    <div className="proj-question proj-selfpaced">
      <header className="proj-head">
        <div className="proj-brand"><BrandMark size={44} /><div><b>BRAIN<span>FREZE</span></b><small>COLD START · {data.section}</small></div></div>
        <TimerDisplay session={session} settings={settings} offsetMs={data.serverOffsetMs} size="proj" />
      </header>
      <main className="proj-body proj-center">
        <h1 className="proj-q-text">Answer on your team device</h1>
        <p className="proj-msg">{questions.length} questions · each team has its own order · answers lock when submitted</p>
        <div className="proj-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Answers submitted">
          <span style={{ width: `${pct}%` }} />
          <small>{pct}% of all answers submitted</small>
        </div>
      </main>
      {session.status === 'paused' && !expired && <div className="proj-overlay paused">PAUSED</div>}
      {expired && <div className="proj-overlay timesup"><BrandMark size={120} /><strong>TIME&rsquo;S UP</strong><span>Answers are locked</span></div>}
    </div>
  );
}

function QuestionScreen({ data }) {
  const { session, settings, questions } = data;
  const idx = Math.min(session.current_index, questions.length - 1);
  const q = questions[idx];
  const number = idx + 1;
  const remaining = useRemaining(session, settings, data.serverOffsetMs);
  const expired = remaining <= 0;
  const done = session.completed_question_ids.length;
  return (
    <div className="proj-question">
      <header className="proj-head">
        <div className="proj-brand"><BrandMark size={44} /><div><b>BRAIN<span>FREZE</span></b><small>COLD START</small></div></div>
        <div className="proj-qnum" aria-label={`Question ${number} of ${questions.length}`}>
          QUESTION <strong>{number}</strong><span>/ {questions.length}</span>
        </div>
        <TimerDisplay session={session} settings={settings} offsetMs={data.serverOffsetMs} size="proj" />
      </header>
      <div className="proj-progress" role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={number} aria-label="Question progress">
        <span style={{ width: `${(number / questions.length) * 100}%` }} />
        <small>{done} of {questions.length} completed</small>
      </div>
      <main className="proj-body" key={q.id}>
        <h1 className={`proj-q-text ${q.question_text.length > 160 ? 'long' : ''}`}>{q.question_text}</h1>
        {q.image_url && <img className="proj-img" src={q.image_url} alt="" />}
        <OptionGrid question={q} size="xl" />
      </main>
      {session.status === 'paused' && !expired && <div className="proj-overlay paused">PAUSED</div>}
      {expired && <div className="proj-overlay timesup"><BrandMark size={120} /><strong>TIME&rsquo;S UP</strong><span>Pens down · Hand in your answer sheets</span></div>}
    </div>
  );
}

function Board({ data }) {
  const { standings, settings } = data;
  const cols = standings.length > 30 ? 3 : standings.length > 12 ? 2 : 1;
  return (
    <div className="proj-board">
      <header className="proj-board-head">
        <BrandMark size={56} />
        <div><h1>LIVE STANDINGS · {data.section}</h1><p>BRAINFREZE · COLD START — top {settings.qualify_count} advance</p></div>
      </header>
      <ol className={`board-cols cols-${cols}`}>
        {standings.map((r, i) => (
          <li key={r.team_id} className={`board-row ${r.rank <= settings.qualify_count ? 'zone' : ''}`} style={{ '--i': i }}>
            <span className="b-rank">{r.rank}</span>
            <span className="b-no">T{r.team_number}</span>
            <span className="b-name">{r.team_name}</span>
            <span className="b-score">{formatPoints(r.points)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Reveal({ data }) {
  const { session, standings, teams } = data;
  const ids = session.qualifiers || [];
  const rows = ids
    .map((id) => standings.find((s) => s.team_id === id) || { ...teams.find((t) => t.id === id), team_id: id, points: null, rank: null })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.team_number - b.team_number);
  return (
    <div className="proj-reveal">
      <div className="reveal-burst" aria-hidden="true" />
      <p className="event-chip">WINTER ARC · ROUND 1 RESULTS · {data.section}</p>
      <h1 className="reveal-title">QUALIFIED FOR <span>ROUND 2</span></h1>
      <ol className="reveal-list">
        {/* #1 sits on top; cards appear bottom-up so the winner is revealed last. */}
        {rows.map((r, i) => (
          <li key={r.team_id} className="reveal-card glass" style={{ '--d': `${0.8 + (rows.length - 1 - i) * 1.1}s` }}>
            <span className="r-rank">#{i + 1}</span>
            <span className="r-no">TEAM {r.team_number}</span>
            <span className="r-name">{r.team_name}</span>
            {r.points !== null && <span className="r-score">{formatPoints(r.points)} {r.points === 1 ? 'pt' : 'pts'}</span>}
          </li>
        ))}
      </ol>
      <p className="reveal-foot">BRAINFREZE · THINK. DECODE. COMPETE.</p>
    </div>
  );
}
