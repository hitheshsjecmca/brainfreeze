import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCheck, ChevronLeft, ChevronRight, Eye, EyeOff, Flag, History, LifeBuoy, Pause, Play,
  RefreshCw, ShieldCheck, Square, Trash2, Undo2,
} from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { StatusBadge } from '../components/Common.jsx';
import { OptionGrid } from '../components/QuizBits.jsx';
import { OPTION_STYLE } from '../components/optionStyle.js';
import { useRemaining } from '../lib/hooks.js';
import { EVENT_LABELS } from '../lib/constants.js';
import { optionLetters } from '../lib/options.js';
import { evaluateAnswer, marksFor, signedPoints } from '../lib/scoring.js';
import { quizReadinessIssues, quizReadinessWarnings } from '../lib/validation.js';
import { minutes } from '../lib/sets.js';
import ParticipantMonitor from '../components/ParticipantMonitor.jsx';

export default function LiveHost() {
  const { snap, quizQuestions: questions } = useQuiz();
  const { session, settings } = snap;
  const current = questions[session.current_index] || null;

  return (
    <div className="page live-page">
      <ControlBar />
      <p className="inline-alert alert-info small" role="note">
        Press <b>Go live</b> and the teams do the rest: each team presses Start on its own device, gets the set&rsquo;s questions in its own shuffled
        order and its own {minutes(settings.duration_seconds)}-minute timer (kept by the server). Answers save automatically, and each attempt is
        submitted when the team presses Submit Quiz or its time runs out.
      </p>
      {snap.session.published_at && <ParticipantMonitor />}
      <details className="panel glass live-fallback">
        <summary><LifeBuoy size={16} aria-hidden="true" /> Emergency &amp; paper answers <small className="muted">(pause all teams, record paper answer sheets, corrections)</small></summary>
        <Fallback current={current} />
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ controls
function ControlBar() {
  const { snap, act, pendingKeys, quizQuestions } = useQuiz();
  const { confirm } = useUI();
  const { session, settings } = snap;
  const s = session.status;
  const busy = (k) => pendingKeys.has(k);

  async function start() {
    if (!session.published_at) {
      await confirm({ title: 'Publish the set first', message: <p>Review and publish the set on the “Set setup &amp; join” tab. Only a published (frozen) set can go live.</p>, confirmLabel: 'OK' });
      return;
    }
    const issues = quizReadinessIssues({ questions: quizQuestions });
    const warnings = quizReadinessWarnings({ teams: snap.teams, questions: quizQuestions });
    if (issues.length) {
      await confirm({ title: 'Set is not ready', message: <ul className="issue-list">{issues.slice(0, 10).map((i) => <li key={i}>{i}</li>)}</ul>, confirmLabel: 'OK' });
      return;
    }
    const ok = await confirm({
      title: `Go live with “${session.name}”?`, confirmLabel: 'Go live',
      message: (
        <>
          <p>Joined {session.section} participants can now press <b>Start</b> (others can still join with the code). Each team gets its own {minutes(settings.duration_seconds)}-minute deadline, recorded by the server when it presses Start.</p>
          {warnings.length > 0 && <ul className="issue-list warn">{warnings.map((w) => <li key={w}><AlertTriangle size={14} /> {w}</li>)}</ul>}
        </>
      ),
    });
    if (ok) act('startQuiz', {}, { success: 'Set is live — participants can start' });
  }

  async function endQuiz() {
    const ok = await confirm({ title: 'End the set?', danger: true, confirmLabel: 'End set', message: <p>Teams still answering are finalized now (status “organizer-finalized”, counted at the full time limit); teams whose deadline already passed are timed out. The join code expires. After ending, answers can only be recorded if you explicitly authorize post-time entry.</p>, typeToConfirm: 'END' });
    if (ok) act('endQuiz', {}, { success: 'Set ended', successDetail: (r) => (r?.finalized ? `${r.finalized} running attempt(s) finalized.` : undefined) });
  }

  const view = session.projector_view;
  const setView = (v) => act('setProjectorView', { view: v }, { key: 'view' });

  return (
    <section className="control-bar glass" aria-label="Quiz controls">
      <div className="control-timer">
        <StatusBadge status={s} />
        <span className="muted small">{minutes(settings.duration_seconds)} min per team</span>
      </div>
      <div className="control-groups">
        <div className="control-group" role="group" aria-label="Set">
          {s === 'setup' && <button className="btn btn-primary btn-lg" onClick={start} disabled={busy('startQuiz')}><Play size={18} /> Go live</button>}
          {['running', 'paused'].includes(s) && <button className="btn btn-danger" onClick={endQuiz}><Square size={16} /> End set</button>}
        </div>
        <div className="control-group" role="group" aria-label="Projector view">
          <span className="muted small">Projector:</span>
          <div className="segmented">
            {[['standby', 'Standby'], ['question', 'Question'], ['leaderboard', 'Leaderboard']].map(([v, l]) => (
              <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => setView(v)} disabled={busy('view')}>{l}</button>
            ))}
            <button className={view === 'reveal' ? 'active' : ''} aria-pressed={view === 'reveal'} onClick={() => setView('reveal')} disabled={!session.results_revealed || busy('view')} title="Available after qualifiers are confirmed and revealed">Reveal</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Rarely needed: pause every team, record paper answer sheets by hand, authorize late corrections. */
function Fallback({ current }) {
  const { snap, act, pendingKeys } = useQuiz();
  const { confirm } = useUI();
  const { session, settings } = snap;
  const s = session.status;
  const busy = (k) => pendingKeys.has(k);
  const remaining = useRemaining(session, settings, snap.serverOffsetMs);
  const expired = s !== 'setup' && remaining <= 0;

  async function toggleCorrections() {
    if (session.corrections_enabled) {
      act('setCorrections', { enabled: false }, { success: 'Post-time entry/corrections disabled' });
      return;
    }
    const ok = await confirm({
      title: 'Authorize post-time entry & corrections', confirmLabel: 'Authorize', requireReason: true,
      message: <p>Allows recording and correcting answers even though time has expired or the quiz has ended (for example, entering paper answer sheets). The authorization and reason are recorded in the audit log.</p>,
    });
    if (ok) act('setCorrections', { enabled: true, reason: ok.reason }, { success: 'Post-time entry/corrections authorized' });
  }

  return (
    <div className="stack">
      <div className="row gap wrap" role="group" aria-label="Emergency controls">
        {s === 'running' && <button className="btn btn-amber" onClick={() => act('pauseQuiz', {}, { success: 'Paused — every team timer is frozen' })} disabled={busy('pauseQuiz')}><Pause size={18} /> Pause all teams</button>}
        {s === 'paused' && <button className="btn btn-primary" onClick={() => act('resumeQuiz', {}, { success: 'Resumed — team deadlines moved by the paused time' })} disabled={busy('resumeQuiz')}><Play size={18} /> Resume</button>}
        {['running', 'paused', 'ended'].includes(s) && (
          <button className={`btn ${session.corrections_enabled ? 'btn-purple' : 'btn-ghost'}`} onClick={toggleCorrections} aria-pressed={session.corrections_enabled}>
            <ShieldCheck size={16} /> {session.corrections_enabled ? 'Corrections ON' : 'Authorize corrections'}
          </button>
        )}
        {s === 'setup' && <span className="muted small">Pause and corrections become available once the set is live.</span>}
      </div>
      {expired && ['running', 'paused'].includes(s) && !session.corrections_enabled && (
        <div className="inline-alert alert-danger" role="alert">
          <AlertTriangle size={18} /> The paper-entry window has closed. Authorize post-time entry if you still need to record answer sheets.
        </div>
      )}
      <p className="muted small">Only for teams answering on paper or for corrections: record answers by hand below. The question navigator here does not move the teams.</p>
      <div className="live-grid">
        <HostQuestion question={current} />
        <AnswerPanel currentQuestion={current} />
      </div>
      <div className="live-grid">
        <ActivityLog />
        <Outbox />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ question (host view, shows key)
function HostQuestion({ question }) {
  const { snap, act, pendingKeys, quizQuestions: questions } = useQuiz();
  const [showKey, setShowKey] = useState(true);
  const { session } = snap;
  const i = session.current_index;
  const completed = question && session.completed_question_ids.includes(question.id);
  const go = (index) => act('goToQuestion', { index }, { key: 'nav' });

  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowRight' && i < questions.length - 1) { e.preventDefault(); go(i + 1); }
      if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); go(i - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!question) return <section className="panel glass"><p className="muted">No questions in this set. Select them on the Set setup &amp; join tab.</p></section>;

  return (
    <section className="panel glass host-question" aria-labelledby="hq-title">
      <div className="panel-head">
        <h2 id="hq-title">Q{i + 1} <span className="muted">/ {questions.length}</span> {completed && <span className="badge badge-ok badge-xs">Completed</span>} {question.is_sample && <span className="badge badge-amber badge-xs">SAMPLE</span>}</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
          {showKey ? <EyeOff size={16} /> : <Eye size={16} />} {showKey ? 'Hide key' : 'Show key'}
        </button>
      </div>
      <div className="progress-dots" aria-label="Question progress">
        {questions.map((q, idx) => (
          <button key={q.id} className={`dot ${idx === i ? 'current' : ''} ${session.completed_question_ids.includes(q.id) ? 'done' : ''}`} onClick={() => go(idx)} aria-label={`Go to question ${idx + 1}`} title={`Q${idx + 1}`} />
        ))}
      </div>
      <p className="hq-text">{question.question_text}</p>
      {question.image_url && <img className="hq-img" src={question.image_url} alt="Question illustration" />}
      <OptionGrid question={question} keyLetter={showKey ? question.correct_option : null} />
      {showKey && question.explanation && <p className="explanation"><b>Key {question.correct_option}:</b> {question.explanation}</p>}
      <div className="row gap wrap">
        <button className="btn btn-ghost" onClick={() => go(i - 1)} disabled={i === 0 || pendingKeys.has('nav')}><ChevronLeft size={18} /> Previous</button>
        <button className="btn btn-ghost" onClick={() => act('setQuestionCompleted', { question_id: question.id, completed: !completed }, { key: 'complete' })}>
          <Flag size={16} /> {completed ? 'Mark active' : 'Mark completed'}
        </button>
        <button className="btn btn-primary" onClick={async () => {
          if (!completed) await act('setQuestionCompleted', { question_id: question.id, completed: true }, { key: 'complete' });
          if (i < questions.length - 1) go(i + 1);
        }} disabled={pendingKeys.has('nav')}>
          <CheckCheck size={16} /> Complete & next
        </button>
        <button className="btn btn-ghost" onClick={() => go(i + 1)} disabled={i >= questions.length - 1 || pendingKeys.has('nav')}>Next <ChevronRight size={18} /></button>
      </div>
      <p className="muted small">Shortcuts: Alt+← / Alt+→ change question. The projector never shows the key or explanation.</p>
    </section>
  );
}

// ------------------------------------------------------------------ answer entry
function AnswerPanel({ currentQuestion }) {
  const [mode, setMode] = useState('question');
  return (
    <section className="panel glass answer-panel" aria-labelledby="ap-title">
      <div className="panel-head">
        <h2 id="ap-title">Record answers</h2>
        <div className="segmented" role="tablist" aria-label="Entry mode">
          <button role="tab" aria-selected={mode === 'question'} className={mode === 'question' ? 'active' : ''} onClick={() => setMode('question')}>By question</button>
          <button role="tab" aria-selected={mode === 'sheet'} className={mode === 'sheet' ? 'active' : ''} onClick={() => setMode('sheet')}>Team answer sheet</button>
        </div>
      </div>
      {mode === 'question' ? <ByQuestion currentQuestion={currentQuestion} /> : <TeamSheet />}
    </section>
  );
}

function usePreview(question, selectedLetter) {
  const { snap } = useQuiz();
  if (!question || selectedLetter === undefined) return null;
  return evaluateAnswer(selectedLetter, question.correct_option, marksFor(question, snap.settings));
}

const RESULT_TEXT = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Unanswered' };

function ByQuestion({ currentQuestion }) {
  const { snap, recordAnswer, quizQuestions: questions } = useQuiz();
  const { toast } = useUI();
  const { teams, answers } = snap;
  const num = (q) => questions.findIndex((x) => x.id === q.id) + 1;
  const [followCurrent, setFollowCurrent] = useState(true);
  const [questionId, setQuestionId] = useState(currentQuestion?.id || null);
  const [teamId, setTeamId] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(undefined); // 'A'–'D' | null (unanswered) | undefined (none)
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const searchRef = useRef(null);
  const confirmRef = useRef(null);

  const qid = followCurrent ? currentQuestion?.id : questionId;
  const question = questions.find((q) => q.id === qid) || null;
  const team = teams.find((t) => t.id === teamId) || null;
  const answerByTeam = useMemo(() => new Map(answers.filter((a) => a.question_id === qid).map((a) => [a.team_id, a])), [answers, qid]);
  const existing = team ? answerByTeam.get(team.id) : null;
  const isCorrection = !!existing;
  const preview = usePreview(question, selected);

  const visibleTeams = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return teams;
    return teams.filter((t) => String(t.team_number).startsWith(s.replace(/^t/, '')) || t.team_name.toLowerCase().includes(s));
  }, [teams, search]);

  const resetEntry = () => { setSelected(undefined); setReviewing(false); setReason(''); };
  const pickTeam = (id) => { setTeamId(id); resetEntry(); };

  function nextUnrecorded(fromId) {
    const order = teams.map((t) => t.id);
    const start = order.indexOf(fromId);
    for (let k = 1; k <= order.length; k++) {
      const id = order[(start + k) % order.length];
      if (!answerByTeam.has(id) && id !== fromId) return id;
    }
    return null;
  }

  async function submit() {
    if (!team || !question || selected === undefined || saving) return;
    if (!reviewing) { setReviewing(true); return; }
    if (isCorrection && !reason.trim()) { toast('error', 'Reason required', 'Corrections need a reason for the audit log.'); return; }
    setSaving(true);
    const label = `Team ${team.team_number} · Q${num(question)} · ${selected ?? 'Unanswered'}`;
    const res = await recordAnswer({ team_id: team.id, question_id: question.id, selected, correction: isCorrection, reason: isCorrection ? reason.trim() : null }, label);
    setSaving(false);
    if (res.ok) {
      const r = res.result;
      // Shown inline (not as a toast) so rapid entry is never covered.
      setLastResult({ text: `${label} — ${RESULT_TEXT[r.result]} ${signedPoints(r.points)}${r.duplicate_request ? ' (duplicate request ignored)' : ''}`, result: r.result });
      const nxt = nextUnrecorded(team.id);
      setTeamId(nxt);
      resetEntry();
      searchRef.current?.focus();
    } else if (res.queued) {
      setTeamId(nextUnrecorded(team.id));
      resetEntry();
    } else if (res.error) {
      toast('error', 'Not recorded', res.error.message);
      setReviewing(false);
    }
  }

  useEffect(() => { if (reviewing) confirmRef.current?.focus(); }, [reviewing]);
  // A new question (e.g. the projector moved on) starts a fresh entry.
  useEffect(() => { setSelected(undefined); setReviewing(false); setReason(''); }, [qid]);

  function onKeyDown(e) {
    if (e.target.closest('textarea') || (e.target.tagName === 'INPUT' && e.target.type !== 'radio')) {
      if (e.key === 'Enter' && e.target === searchRef.current && visibleTeams.length) { e.preventDefault(); pickTeam(visibleTeams[0].id); searchRef.current.blur(); }
      return;
    }
    const k = e.key.toUpperCase();
    if (optionLetters(question || {}).includes(k) && team) { e.preventDefault(); setSelected(k); setReviewing(false); }
    else if (k === 'U' && team) { e.preventDefault(); setSelected(null); setReviewing(false); }
    else if (e.key === 'Enter' && team && selected !== undefined) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); resetEntry(); }
    else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
  }

  if (!question) return <p className="muted">No question selected.</p>;
  const recordedCount = answerByTeam.size;

  return (
    <div className="by-question" onKeyDown={onKeyDown}>
      <div className="row gap wrap">
        <label className="check"><input type="checkbox" checked={followCurrent} onChange={(e) => { setFollowCurrent(e.target.checked); setQuestionId(currentQuestion?.id || null); resetEntry(); }} /> Follow projector question</label>
        {!followCurrent && (
          <select value={questionId || ''} onChange={(e) => { setQuestionId(e.target.value); resetEntry(); }} aria-label="Question to record">
            {questions.map((q) => <option key={q.id} value={q.id}>Q{num(q)}: {q.question_text.slice(0, 60)}</option>)}
          </select>
        )}
        <span className="badge badge-muted">Q{num(question)} · {recordedCount}/{teams.length} recorded</span>
      </div>

      {lastResult && <p className={`last-result res-${lastResult.result}`} role="status">Saved: {lastResult.text}</p>}
      <input ref={searchRef} type="search" className="team-search" placeholder="Type team number or name, Enter to pick  ( / )" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find team" />
      <div className="team-chips" role="listbox" aria-label="Teams">
        {visibleTeams.map((t) => {
          const a = answerByTeam.get(t.id);
          return (
            <button key={t.id} role="option" aria-selected={t.id === teamId}
              className={`team-chip ${t.id === teamId ? 'selected' : ''} ${a ? `rec-${a.result}` : ''} ${a?.source === 'participant' ? 'src-device' : ''}`}
              onClick={() => pickTeam(t.id)} title={`${t.team_name}${a ? ` — ${a.source === 'participant' ? 'submitted on device' : 'recorded'}: ${a.selected_option ?? 'unanswered'}` : ''}`}>
              <b>{t.team_number}</b>{a && <small>{a.selected_option ?? '–'}</small>}
            </button>
          );
        })}
      </div>

      {team ? (
        <div className="entry-box">
          <div className="entry-team">
            <strong>Team {team.team_number}</strong> <span className="muted">{team.team_name}</span>
            {existing && <span className="badge badge-amber">Recorded: {existing.selected_option ?? 'Unanswered'} ({RESULT_TEXT[existing.result]})</span>}
          </div>
          <div className="answer-buttons" role="radiogroup" aria-label="Team answer">
            {optionLetters(question).map((l) => {
              const { cls, Icon } = OPTION_STYLE[l];
              return (
                <button key={l} role="radio" aria-checked={selected === l} className={`answer-btn ${cls} ${selected === l ? 'selected' : ''}`} onClick={() => { setSelected(l); setReviewing(false); }}>
                  <Icon size={16} aria-hidden="true" /> {l}
                </button>
              );
            })}
            <button role="radio" aria-checked={selected === null} className={`answer-btn opt-u ${selected === null ? 'selected' : ''}`} onClick={() => { setSelected(null); setReviewing(false); }}>— Unanswered</button>
          </div>
          {isCorrection && selected !== undefined && (
            <label className="field">
              <span>Correction reason (required, audited)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. misread answer sheet" />
            </label>
          )}
          {preview && (
            <div className={`preview-result res-${preview.result}`} aria-live="polite">
              {selected ?? 'Unanswered'} → <strong>{RESULT_TEXT[preview.result]}</strong> {signedPoints(preview.points)}
              {isCorrection && <span className="muted"> (was {RESULT_TEXT[existing.result]} {signedPoints(existing.points)})</span>}
            </div>
          )}
          <div className="row gap">
            <button className="btn btn-ghost" onClick={resetEntry}>Clear (Esc)</button>
            {!reviewing ? (
              <button className="btn btn-primary" onClick={submit} disabled={selected === undefined}>{isCorrection ? 'Review correction' : 'Submit'} (Enter)</button>
            ) : (
              <button ref={confirmRef} className={`btn ${isCorrection ? 'btn-purple' : 'btn-primary'}`} onClick={submit} disabled={saving || (isCorrection && !reason.trim())}>
                {saving ? 'Saving…' : `Confirm ${isCorrection ? 'correction' : ''} (Enter)`}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Pick a team to record its answer. Keys: <kbd>A</kbd>–<kbd>{optionLetters(question).slice(-1)[0]}</kbd>, <kbd>U</kbd> unanswered, <kbd>Enter</kbd> submit → confirm, <kbd>Esc</kbd> clear.</p>
      )}
    </div>
  );
}

function TeamSheet() {
  const { snap, recordAnswer, refresh, quizQuestions: questions } = useQuiz();
  const { confirm, toast } = useUI();
  const { teams, answers } = snap;
  const num = (q) => questions.findIndex((x) => x.id === q.id) + 1;
  const [teamId, setTeamId] = useState(teams[0]?.id || '');
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const team = teams.find((t) => t.id === teamId);
  const recorded = useMemo(() => new Map(answers.filter((a) => a.team_id === teamId).map((a) => [a.question_id, a])), [answers, teamId]);
  const toSave = questions.filter((q) => !recorded.has(q.id) && q.id in draft);

  async function saveAll() {
    if (!toSave.length || saving) return;
    const ok = await confirm({
      title: `Record ${toSave.length} answer(s) for Team ${team.team_number}?`, confirmLabel: 'Record answers',
      message: <p>{toSave.map((q) => `Q${num(q)}: ${draft[q.id] ?? '—'}`).join(' · ')}</p>,
    });
    if (!ok) return;
    setSaving(true);
    let done = 0;
    for (const q of toSave) {
      const res = await recordAnswer({ team_id: team.id, question_id: q.id, selected: draft[q.id] }, `Team ${team.team_number} · Q${num(q)} · ${draft[q.id] ?? 'Unanswered'}`);
      if (res.ok || res.queued) done++;
      else if (res.error) { toast('error', `Stopped at Q${num(q)}`, res.error.message); break; }
    }
    setSaving(false);
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([qid]) => !toSave.slice(0, done).some((q) => q.id === qid))));
    if (done) toast('success', `${done} answer(s) recorded for Team ${team.team_number}`);
  }

  async function correct(q, a) {
    const choice = draft[q.id];
    if (choice === undefined || choice === a.selected_option) { toast('info', 'Pick a different answer first', `Select the corrected option for Q${num(q)}, then press Correct.`); return; }
    const ok = await confirm({ title: `Correct Team ${team.team_number}, Q${num(q)}?`, confirmLabel: 'Apply correction', requireReason: true, message: <p>{a.selected_option ?? 'Unanswered'} → {choice ?? 'Unanswered'}</p> });
    if (!ok) return;
    const res = await recordAnswer({ team_id: team.id, question_id: q.id, selected: choice, correction: true, reason: ok.reason }, `Correction Team ${team.team_number} · Q${num(q)}`);
    if (res.ok) { toast('success', 'Correction saved'); setDraft((d) => { const n = { ...d }; delete n[q.id]; return n; }); }
    else if (res.error) toast('error', 'Correction failed', res.error.message);
  }

  if (!teams.length) return <p className="muted">No teams registered.</p>;
  return (
    <div className="team-sheet">
      <div className="row gap wrap">
        <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setDraft({}); }} aria-label="Team">
          {teams.map((t) => <option key={t.id} value={t.id}>Team {t.team_number} — {t.team_name}</option>)}
        </select>
        <span className="badge badge-muted">{recorded.size}/{questions.length} recorded</span>
        <button className="btn btn-primary btn-sm" onClick={saveAll} disabled={!toSave.length || saving}>{saving ? 'Saving…' : `Record ${toSave.length} new`}</button>
        <button className="btn btn-ghost btn-sm" onClick={refresh} aria-label="Reload answers"><RefreshCw size={14} /></button>
      </div>
      <div className="sheet-rows">
        {questions.map((q) => {
          const a = recorded.get(q.id);
          const d = draft[q.id];
          return (
            <div key={q.id} className={`sheet-row ${a ? `rec-${a.result}` : ''}`}>
              <span className="sheet-q">Q{num(q)}</span>
              <div className="sheet-opts" role="radiogroup" aria-label={`Answer for Q${num(q)}`}>
                {[...optionLetters(q), null].map((l) => (
                  <button key={l ?? 'u'} role="radio" aria-checked={d === l || (d === undefined && a?.selected_option === l && !!a)}
                    className={`mini-opt ${l ? OPTION_STYLE[l].cls : 'opt-u'} ${d === l ? 'selected' : ''} ${d === undefined && a && a.selected_option === l ? 'recorded' : ''}`}
                    onClick={() => setDraft((x) => ({ ...x, [q.id]: l }))}>{l ?? '–'}</button>
                ))}
              </div>
              {a ? (
                <span className="sheet-status">{a.result === 'correct' ? '✓' : a.result === 'incorrect' ? '✗' : '–'} {signedPoints(a.points)}
                  <button className="btn btn-ghost btn-xs" onClick={() => correct(q, a)}>Correct</button></span>
              ) : <span className="sheet-status muted">{d !== undefined ? 'pending' : ''}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ activity + undo
const optLabel = (sel, result) => (result ? sel ?? 'Unanswered' : 'nothing');
function describeEvent(e) {
  const who = [e.team_number != null && `T${e.team_number}`, e.question_position != null && `Q${e.question_position}`].filter(Boolean).join(' ');
  if (!['record', 'correction', 'undo', 'rescore'].includes(e.action)) return who;
  const after = e.new_result ? ` (${e.new_result} ${signedPoints(e.new_points)})` : '';
  if (e.action === 'record') return `${who}: ${optLabel(e.new_selected, e.new_result)}${after}`;
  if (e.action === 'rescore') return `${who}: ${e.prev_result} → ${e.new_result} ${signedPoints(e.new_points)}`;
  return `${who}: ${optLabel(e.prev_selected, e.prev_result)} → ${optLabel(e.new_selected, e.new_result)}${after}`;
}

function ActivityLog() {
  const { snap, undoLast, pendingKeys } = useQuiz();
  const { confirm } = useUI();
  const events = [...snap.events].reverse().slice(0, 25);
  const lastUndoable = [...snap.events].reverse().find((e) => ['record', 'correction'].includes(e.action) && !e.undone);

  async function undo() {
    if (!lastUndoable) return;
    const ok = await confirm({
      title: 'Undo last score action?', confirmLabel: 'Undo', danger: true,
      message: <p>{EVENT_LABELS[lastUndoable.action]}: Team {lastUndoable.team_number}, Q{lastUndoable.question_position} — {lastUndoable.new_selected ?? 'Unanswered'} ({lastUndoable.new_result} {signedPoints(lastUndoable.new_points)}). The undo is recorded in the audit log.</p>,
    });
    if (ok) undoLast();
  }

  return (
    <section className="panel glass" aria-labelledby="log-title">
      <div className="panel-head">
        <h2 id="log-title"><History size={18} /> Recent activity</h2>
        <button className="btn btn-amber btn-sm" onClick={undo} disabled={!lastUndoable || pendingKeys.has('undo')}><Undo2 size={16} /> Undo last</button>
      </div>
      {events.length === 0 ? <p className="muted">No score actions yet.</p> : (
        <ul className="event-list">
          {events.map((e) => (
            <li key={e.id} className={`ev ev-${e.action} ${e.undone ? 'undone' : ''}`}>
              <span className="ev-time">{new Date(e.created_at).toLocaleTimeString()}</span>
              <span className="ev-what">{EVENT_LABELS[e.action] || e.action}</span>
              <span className="ev-detail">{describeEvent(e)}{e.reason && <em> · {e.reason}</em>}</span>
              {e.undone && <span className="badge badge-muted badge-xs">undone</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Outbox() {
  const { outbox, flushOutbox, discardOutboxItem, isDemo } = useQuiz();
  const { confirm } = useUI();
  if (isDemo) {
    return (
      <section className="panel glass">
        <h2>Sync</h2>
        <p className="muted">Demo mode saves every action to this browser immediately. Export a JSON backup regularly from Settings.</p>
      </section>
    );
  }
  return (
    <section className="panel glass" aria-labelledby="ob-title">
      <div className="panel-head">
        <h2 id="ob-title">Offline queue</h2>
        <button className="btn btn-ghost btn-sm" onClick={flushOutbox} disabled={!outbox.length}><RefreshCw size={14} /> Retry now</button>
      </div>
      {outbox.length === 0 ? <p className="muted">All recorded answers have reached the server.</p> : (
        <ul className="event-list">
          {outbox.map((x) => (
            <li key={x.payload.request_id} className={x.failed ? 'ev ev-failed' : 'ev'}>
              <span className="ev-what">{x.failed ? 'Rejected' : 'Pending'}</span>
              <span className="ev-detail">{x.label}{x.failed && <em> · {x.failed}</em>}</span>
              <button className="icon-btn danger" aria-label="Discard queued answer" onClick={async () => {
                if (await confirm({ title: 'Discard this queued answer?', danger: true, confirmLabel: 'Discard', message: <p>{x.label} will not be recorded. Re-enter it manually if needed.</p> })) discardOutboxItem(x.payload.request_id);
              }}><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
