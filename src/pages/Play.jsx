import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Flag, Hourglass, Loader2, LogOut, PauseCircle, Play as PlayIcon, Trophy, Wifi, WifiOff } from 'lucide-react';
import { BrandMark } from '../components/Brand.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { Modal } from '../components/Common.jsx';
import { OptionTile } from '../components/QuizBits.jsx';
import { isDemoMode, participantApi } from '../backend/index.js';
import { ERROR_MESSAGES, toQuizError } from '../lib/errors.js';
import { OPTION_FIELDS } from '../lib/constants.js';
import { optionLetters } from '../lib/options.js';
import { participantNames } from '../lib/teamSelection.js';
import { formatPoints } from '../lib/scoring.js';
import { useServerNow } from '../lib/hooks.js';
import { minutes } from '../lib/sets.js';
import { formatClock } from '../lib/timer.js';
import { clearDeviceSession, loadDeviceSession, loadPosition, savePosition } from '../participant/deviceSession.js';
import { useAnswerSaver } from '../participant/useAnswerSaver.js';
import { finishScreen, questionControls, submitQuiz, submitSummary } from '../participant/playFlow.js';

const POLL_MS = 2000;

export default function Play() {
  const device = loadDeviceSession();
  if (!device?.token) return <Navigate to="/join" replace />;
  return <PlayInner device={device} />;
}

function PlayInner({ device }) {
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(true);
  const [fatal, setFatal] = useState(null);
  const busy = useRef(false);
  const again = useRef(false);
  const lastFetch = useRef(0);
  // Self-paced: which question (position in THIS team's order) the team is viewing.
  // null = let the server pick the first unanswered question.
  const positionRef = useRef(loadPosition(device.token));

  const poll = useCallback(async () => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    lastFetch.current = Date.now();
    const asked = positionRef.current;
    const t0 = Date.now();
    try {
      const res = await participantApi.state(device.token, asked);
      const t1 = Date.now();
      if (!res.ok) {
        setFatal({ code: res.error, message: res.message });
      } else if (asked === positionRef.current) { // ignore answers to a superseded navigation
        setOffset(Date.parse(res.server_now) - (t0 + t1) / 2);
        setState(res);
        setOnline(true);
        // Stay on the question the server opened, so a confirmation is never replaced by the next question.
        if (asked === null && Number.isInteger(res.position)) {
          positionRef.current = res.position;
          savePosition(device.token, res.position);
        }
      } else {
        again.current = true;
      }
    } catch {
      setOnline(false); // keep showing the last state; keep polling
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; poll(); }
    }
  }, [device.token]);

  const goTo = useCallback((position) => {
    positionRef.current = position;
    savePosition(device.token, position);
    poll();
  }, [device.token, poll]);

  const saver = useAnswerSaver(device.token, poll);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    // Organizer "changed" nudges (throttled) make transitions feel instant.
    const off = participantApi.subscribe(() => { if (Date.now() - lastFetch.current > 400) poll(); });
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', poll);
    return () => { clearInterval(id); off(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', poll); };
  }, [poll]);

  async function leave() {
    if (!window.confirm('Sign this device out of the quiz? To come back, join again with the code and the same name and college (an organizer may need to release this device first).')) return;
    try { await participantApi.leave(device.token); } catch { /* sign out locally anyway */ }
    clearDeviceSession();
    navigate('/join', { replace: true });
  }

  if (fatal) {
    return (
      <Shell device={device} online={online}>
        <div className="play-center">
          <WifiOff size={40} aria-hidden="true" />
          <h1>Signed out</h1>
          <p>{fatal.message && fatal.code === 'SESSION_REVOKED' ? `${ERROR_MESSAGES.SESSION_REVOKED} (${fatal.message})` : ERROR_MESSAGES[fatal.code] || ERROR_MESSAGES.SESSION_INVALID}</p>
          <button className="btn btn-primary btn-lg" onClick={() => { clearDeviceSession(); navigate('/join', { replace: true }); }}>Join again</button>
        </div>
      </Shell>
    );
  }
  if (!state) {
    return <Shell device={device} online={online}><div className="play-center"><Loader2 className="spin" size={36} /><p>Connecting to the quiz…</p></div></Shell>;
  }

  const { quiz, team } = state;
  return (
    <Shell device={device} team={team} quizTitle={quiz.title} online={online} onLeave={leave}>
      <Screen state={state} offset={offset} device={device} refresh={poll} goTo={goTo} saver={saver} />
    </Shell>
  );
}

function Shell({ device, team, quizTitle, online, onLeave, children }) {
  const t = team || device.team;
  return (
    <div className="play-page">
      <FrostBackdrop snow={false} />
      <header className="play-head glass">
        <div className="play-brand"><BrandMark size={34} /><div><b>BRAIN<span>FREZE</span></b><small>{quizTitle || device.quiz_title || 'COLD START'}</small></div></div>
        <div className="play-team">
          <b>{t?.self_joined ? t?.participant_1 : `Team ${t?.team_number}`}</b>
          <span>{t?.self_joined ? `${t?.college_name || ''}${t?.section ? ` · ${t.section}` : ''}` : t?.team_name}</span>
        </div>
        <span className={`badge ${online ? 'badge-ok' : 'badge-danger'}`} role="status" aria-live="polite">
          {online ? <><Wifi size={13} /> Connected</> : <><WifiOff size={13} /> Reconnecting…</>}
        </span>
        {onLeave && <button className="icon-btn" onClick={onLeave} aria-label="Sign this device out" title="Sign out"><LogOut size={18} /></button>}
      </header>
      {isDemoMode && <div className="demo-banner">DEMO MODE — this browser only; nothing is shared with other devices.</div>}
      <main className="play-main">{children}</main>
    </div>
  );
}

/** Remaining time from the server deadline (never the device clock alone): deadline − (device time + measured offset). */
function useAttemptRemaining(attempt, offset) {
  const now = useServerNow(offset, 250);
  if (attempt.status !== 'in_progress') return null;
  if (attempt.paused) return attempt.remaining_ms;
  // Never show more than the time left at the last server read (guards against clock-offset jitter).
  return Math.max(0, Math.min(attempt.remaining_ms ?? Infinity, Date.parse(attempt.deadline_at) - now));
}

function AttemptTimer({ remaining, total, paused, size = 'sm' }) {
  const pct = Math.max(0, Math.min(1, remaining / total));
  const urgent = remaining <= 5 * 60 * 1000;
  return (
    <div className={`timer timer-${size} ${remaining <= 0 ? 'timer-expired' : urgent ? 'timer-urgent' : ''} ${paused ? 'timer-paused' : ''}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="52" className="timer-track" />
        <circle cx="60" cy="60" r="52" className="timer-arc" strokeDasharray={`${(pct * 326.7).toFixed(1)} 326.7`} transform="rotate(-90 60 60)" />
      </svg>
      <div className="timer-text" role="timer" aria-live="off" aria-label={`Time remaining ${formatClock(remaining)}`}>
        <strong>{remaining <= 0 ? "TIME'S UP" : formatClock(remaining)}</strong>
        <small>{paused ? 'PAUSED' : 'REMAINING'}</small>
      </div>
    </div>
  );
}

/** The team's countdown, always visible while answering (server deadline; refreshing never resets it). */
function TimeBar({ remaining, total, durationSeconds }) {
  const urgent = remaining <= 60 * 1000;
  const pct = Math.max(0, Math.min(1, remaining / total)) * 100;
  return (
    <div className={`play-timebar glass ${urgent ? 'play-timebar-urgent' : ''}`}>
      <div className="play-timebar-row">
        <Clock3 size={22} aria-hidden="true" />
        <strong role="timer" aria-live="off" aria-label={`Time remaining ${formatClock(remaining)}`}>{formatClock(remaining)}</strong>
        <span>left of {minutes(durationSeconds)} min</span>
      </div>
      <div className="play-timebar-track" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      <small className="muted">Your quiz is submitted automatically when the time runs out. Refreshing does not reset the timer.</small>
    </div>
  );
}

function Screen({ state, offset, device, refresh, goTo, saver }) {
  const { quiz, team } = state;
  const attempt = state.attempt || { status: 'none' };
  const total = quiz.duration_seconds * 1000;
  const remaining = useAttemptRemaining(attempt, offset);
  const expired = remaining !== null && remaining <= 0;
  // Set once the server confirmed this device's Submit, so the thank-you screen never waits for the next poll.
  const [confirmed, setConfirmed] = useState(false);

  // The server finalizes an expired attempt on its next read: re-check right after the deadline.
  useEffect(() => {
    if (!expired) return undefined;
    const id = setTimeout(refresh, 600);
    return () => clearTimeout(id);
  }, [expired, refresh]);

  if (quiz.status === 'finalized' && state.result) return <ResultScreen result={state.result} team={team} />;
  const done = finishScreen(attempt.status, { confirmed });
  if (done) {
    return (
      <div className="play-center play-finished" data-finish={done.kind}>
        {done.kind === 'thank_you' ? <CheckCircle2 size={44} aria-hidden="true" /> : <Hourglass size={44} aria-hidden="true" />}
        <h1 className="play-big">{done.title}</h1>
        {done.timedOut && <p className="muted small">Time is up — your quiz was submitted automatically with every answer you selected.</p>}
        <p>{done.message}</p>
        <p className="muted small">{done.note}</p>
      </div>
    );
  }
  if (['ended', 'finalized'].includes(quiz.status)) {
    return (
      <div className="play-center">
        <Hourglass size={44} aria-hidden="true" />
        <h1 className="play-big">Set closed</h1>
        <p>This quiz set has ended. You may now wait for further instructions from the organizers.</p>
      </div>
    );
  }
  if (attempt.status !== 'in_progress') return <Instructions state={state} device={device} refresh={refresh} />;
  if (expired) {
    return (
      <div className="play-center">
        <Hourglass size={44} aria-hidden="true" />
        <h1 className="play-big">TIME&rsquo;S UP</h1>
        <p role="status">Time is up. Submitting your quiz…</p>
        <p className="muted small"><Loader2 size={14} className="spin" /> Confirming with the server… Every answer you selected before the deadline is saved.</p>
      </div>
    );
  }
  if (attempt.paused || quiz.status === 'paused') {
    return (
      <div className="play-center">
        <AttemptTimer remaining={remaining} total={total} paused size="md" />
        <PauseCircle size={40} aria-hidden="true" />
        <h1>Paused</h1>
        <p>The organizer paused the quiz. Your timer is frozen and resumes where it stopped.</p>
      </div>
    );
  }
  if (!state.question) return <div className="play-center"><Loader2 className="spin" size={32} /><p>Loading your question…</p></div>;
  const controls = questionControls(state.position ?? 0, state.progress?.length || quiz.total_questions);
  return (
    <>
      <TimeBar remaining={remaining} total={total} durationSeconds={quiz.duration_seconds} />
      <Navigator state={state} goTo={goTo} controls={controls} />
      <QuestionView key={state.question.id} state={state} saver={saver} />
      {/* Only on the last question; viewing it never submits anything — the participant must confirm. */}
      {controls.showSubmit && <SubmitQuiz state={state} device={device} refresh={refresh} saver={saver} onSubmitted={() => setConfirmed(true)} />}
    </>
  );
}

/** Before the attempt starts: instructions, rules and the Start button (enabled once the organizer goes live). */
function Instructions({ state, device, refresh }) {
  const { quiz, team } = state;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const live = quiz.status === 'running';

  async function start() {
    setBusy(true);
    setMsg('');
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await participantApi.start(device.token); // idempotent: retrying never moves the start time
        if (!res.ok) setMsg(ERROR_MESSAGES[res.error] || 'Could not start.');
        break;
      } catch (e) {
        if (toQuizError(e).code !== 'NETWORK' || attempt === 5) { setMsg('Could not reach the server. Check the connection and try again.'); break; }
        await new Promise((r) => setTimeout(r, Math.min(4000, 500 * 2 ** attempt)));
      }
    }
    setBusy(false);
    refresh();
  }

  return (
    <div className="play-center lobby">
      <h1>{quiz.title}</h1>
      <div className="lobby-team glass">
        <b>{team.self_joined ? team.participant_1 : `Team ${team.team_number} · ${team.team_name}`}</b>
        <span>{team.self_joined ? `${team.college_name || ''}${team.section ? ` · Verified section: ${team.section}` : ''}` : participantNames(team)}</span>
      </div>
      {quiz.description && <p className="instructions-text">{quiz.description}</p>}
      <ul className="rules glass">
        <li>{quiz.section ? `${quiz.section} section · ` : ''}<b>{quiz.total_questions} question{quiz.total_questions === 1 ? '' : 's'}</b> · <b>{minutes(quiz.duration_seconds)} minutes</b></li>
        {quiz.marks && <li>Correct {formatPoints(quiz.marks.correct)} · wrong {formatPoints(quiz.marks.incorrect)} · unanswered {formatPoints(quiz.marks.unanswered)}</li>}
        <li>Your timer starts when you press <b>Start</b>. The deadline is kept by the server: refreshing, reconnecting or switching tabs never pauses or restarts it.</li>
        <li>You get your own question and option order. Answer in any order: tapping an option saves it, and you can change it until you submit.</li>
        <li>Press <b>Submit Quiz</b> on the last question when you are done — equal scores are ranked by the faster completion time. When time runs out, your quiz is submitted automatically with every answer you selected.</li>
      </ul>
      {live ? (
        <button className="btn btn-primary btn-lg" onClick={start} disabled={busy}>{busy ? <Loader2 size={18} className="spin" /> : <PlayIcon size={18} />} Start the quiz</button>
      ) : (
        <p className="lobby-wait"><Loader2 size={18} className="spin" /> Waiting for the organizer to open the quiz. The Start button appears here.</p>
      )}
      {msg && <p className="play-status warn" role="alert">{msg}</p>}
    </div>
  );
}

/** Submit the whole quiz, after a confirmation that shows answered / unanswered counts (idempotent; safe to retry). */
function SubmitQuiz({ state, device, refresh, saver, onSubmitted }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const total = state.progress?.length || state.quiz.total_questions;
  // Answers being saved right now count as answered for the confirmation.
  const current = state.question?.id;
  const done = (state.progress || []).filter((answered, i) => answered || (i === state.position && current && saver.pending[current])).length;
  const summary = submitSummary(done, total);

  async function finish() {
    setBusy(true);
    setMsg('');
    const res = await submitQuiz({ finish: () => participantApi.finish(device.token), settle: saver.settle });
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      onSubmitted();
    } else {
      setMsg(res.message); // the dialog stays open: retrying is safe and saved answers are kept
    }
    refresh();
  }

  return (
    <div className="play-finish">
      <button className="btn btn-amber btn-lg" onClick={() => { setMsg(''); setOpen(true); }}><Flag size={18} /> Submit Quiz</button>
      {open && (
        <Modal title="Submit your quiz?" onClose={() => !busy && setOpen(false)} labelledBy="submit-quiz-title">
          <div className="submit-summary">
            <div><b>{done}</b><small>answered</small></div>
            <div className={summary.unanswered ? 'warn-text' : ''}><b>{summary.unanswered}</b><small>unanswered</small></div>
          </div>
          <p>{summary.text}</p>
          {msg && <p className="play-status warn" role="alert">{msg}</p>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel — keep answering</button>
            <button className="btn btn-amber" onClick={finish} disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : <Flag size={16} />} Submit now</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Self-paced: jump between this team's questions; answered ones are marked (never right/wrong). */
function Navigator({ state, goTo, controls }) {
  const { progress = [], position = 0 } = state;
  const done = progress.filter(Boolean).length;
  const nextOpen = (from) => {
    for (let i = 1; i <= progress.length; i++) {
      const p = (from + i) % progress.length;
      if (!progress[p]) return p;
    }
    return null;
  };
  const next = nextOpen(position);
  return (
    <nav className="play-nav" aria-label="Questions">
      <div className="play-nav-row">
        <button className="btn btn-ghost btn-sm" onClick={() => goTo(position - 1)} disabled={!controls.canPrevious}><ArrowLeft size={14} /> Previous</button>
        <span className="muted small" role="status">{done} of {progress.length} answered</span>
        {controls.showNext
          ? <button className="btn btn-ghost btn-sm" onClick={() => goTo(position + 1)}>Next <ArrowRight size={14} /></button>
          : <span className="muted small">Last question</span>}
      </div>
      <ol className="play-palette">
        {progress.map((answered, i) => (
          <li key={i}>
            <button className={`${answered ? 'done' : ''} ${i === position ? 'here' : ''}`} onClick={() => goTo(i)}
              aria-current={i === position ? 'step' : undefined} aria-label={`Question ${i + 1}${answered ? ', answered' : ''}`}>{i + 1}</button>
          </li>
        ))}
      </ol>
      {progress[position] && next !== null && (
        <button className="btn btn-primary btn-sm" onClick={() => goTo(next)}>Next unanswered question (#{next + 1}) <ArrowRight size={14} /></button>
      )}
    </nav>
  );
}

/** One question. Tapping an option saves it immediately; the team can change it until the quiz is submitted. */
function QuestionView({ state, saver }) {
  const { question, quiz, my_answer: mine } = state;
  const locked = mine?.source === 'organizer';
  const queued = saver.pending[question.id]?.option;
  const shown = queued ?? saver.saved[question.id] ?? mine?.selected ?? null;
  const pick = (letter) => { if (!locked && letter !== shown) saver.choose(question.id, letter); };

  return (
    <div className="play-question">
      <div className="play-q-head">
        <span className="play-qnum">Question <b>{question.number}</b> / {quiz.total_questions}</span>
      </div>
      <h1 className="play-q-text">{question.question_text}</h1>
      {question.image_url && <img src={question.image_url} alt="" className="play-img" />}
      <div className="play-options" role="radiogroup" aria-label="Answer options">
        {optionLetters(question).map((l) => (
          <OptionTile key={l} letter={l} text={question[OPTION_FIELDS[l]]} size="lg"
            onClick={() => pick(l)} pressed={shown === l}
            disabled={locked || state.question_closed}
            state={shown && shown !== l ? 'dim' : shown === l ? 'chosen' : null} />
        ))}
      </div>
      {locked ? (
        <p className="play-status ok" role="status"><CheckCircle2 size={20} /> Answer {mine.selected ?? '—'} was recorded by the organizer and is locked.</p>
      ) : queued ? (
        <p className="play-status" role="status"><Loader2 size={18} className="spin" /> Saving {queued}… (kept on this device until the server confirms)</p>
      ) : shown ? (
        <p className="play-status ok" role="status"><CheckCircle2 size={20} /> Answer {shown} saved. You can change it until you submit the quiz.</p>
      ) : (
        <p className="play-status" role="status">Tap an option to answer. It is saved automatically.</p>
      )}
      {saver.message && <p className="play-status warn" role="alert">{saver.message}</p>}
    </div>
  );
}

function ResultScreen({ result, team }) {
  return (
    <div className="play-center">
      <Trophy size={48} aria-hidden="true" className={result.qualified ? 'gold' : ''} />
      <h1 className="play-big">{result.qualified ? 'QUALIFIED!' : 'Round complete'}</h1>
      <p>{team.self_joined ? team.participant_1 : `Team ${team.team_number} · ${team.team_name}`}</p>
      <div className="result-stats glass">
        <div><small>Rank</small><b>#{result.rank}</b></div>
        <div><small>Score</small><b>{formatPoints(result.points)}</b></div>
      </div>
      <p>{result.qualified ? 'Your team advances to Round 2.' : 'Thank you for competing in COLD START.'}</p>
    </div>
  );
}
