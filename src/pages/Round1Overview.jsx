import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, Circle } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { SET_STAGE_LABELS } from '../lib/constants.js';
import { setStage } from '../lib/engine.js';
import { formatJoinCode } from '../lib/joinCodes.js';
import { formatPoints } from '../lib/scoring.js';
import { formatElapsed, minutes, publishIssues } from '../lib/sets.js';
import { setProgress } from '../lib/rounds.js';

const ACTION = {
  draft: { label: 'Continue setup', to: '/host/rounds/1/setup' },
  published: { label: 'Go live', to: '/host/rounds/1/live' },
  live: { label: 'Open Live Host', to: '/host/rounds/1/live' },
  completed: { label: 'Review results', to: '/host/results' },
  archived: { label: 'View results', to: '/host/results' },
};

/** Round 1 home: the selected set's progress and its one next action, plus all sets at a glance. */
export default function Round1Overview() {
  const { snap, quizQuestions, standings, sets } = useQuiz();
  const s = snap.session;
  const stage = setStage(s);
  const issues = s.published_at ? [] : publishIssues({ questions: quizQuestions, settings: snap.settings });
  const steps = setProgress(s, quizQuestions.length);
  const action = stage === 'completed' && s.status === 'finalized' ? { label: 'View results', to: '/host/results' } : ACTION[stage];
  const hasResults = snap.answers.length > 0;
  const active = sets.filter((x) => x.stage !== 'archived');

  return (
    <div className="page">
      <section className="panel glass set-focus" aria-labelledby="sf-title">
        <div className="set-focus-head">
          <div>
            <h1 id="sf-title">{s.name}</h1>
            <p className="muted">
              {s.section} · {SET_STAGE_LABELS[stage]} · {quizQuestions.length} questions · {minutes(snap.settings.duration_seconds)} min per team
              {s.join_code_active && <> · code <b>{formatJoinCode(s.join_code)}</b></>}
            </p>
          </div>
          <Link className="btn btn-primary btn-lg" to={action.to}>{action.label} <ArrowRight size={18} /></Link>
        </div>
        <ol className="progress-steps" aria-label="Set progress">
          {steps.map((st) => (
            <li key={st.key} className={st.done ? 'done' : ''}>
              {st.done ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />} {st.label}
              <span className="sr-only">{st.done ? ' — done' : ' — not yet'}</span>
            </li>
          ))}
        </ol>
        {issues.length > 0 && (
          <div className="inline-alert alert-warn" role="alert">
            <AlertTriangle size={18} />
            <div>
              <b>This draft cannot be published yet.</b>
              <ul className="small">{issues.slice(0, 4).map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          </div>
        )}
      </section>

      <div className="two-col">
        <section className="panel glass" aria-labelledby="as-title">
          <div className="panel-head">
            <h2 id="as-title">All Round 1 sets</h2>
            <Link className="btn btn-ghost btn-sm" to="/host/rounds/1/new">New quiz set</Link>
            <Link className="btn btn-ghost btn-sm" to="/host/rounds/1/sets">Manage sets</Link>
          </div>
          {active.length === 0 ? <p className="muted">No quiz sets yet.</p> : (
            <ul className="set-list">
              {active.map((x) => (
                <li key={x.id} className={x.id === s.id ? 'current' : ''}>
                  <span><b>{x.name}</b> <span className="muted small">{x.section}</span></span>
                  <span className="small">{SET_STAGE_LABELS[x.stage]}{x.status === 'finalized' ? ' · qualifiers confirmed' : ''} · {x.attempts} joined</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel glass" aria-labelledby="top-title">
          <div className="panel-head">
            <h2 id="top-title">Standings — {s.name}</h2>
            {hasResults && <Link className="btn btn-ghost btn-sm" to="/host/rounds/1/leaderboard">Full leaderboard</Link>}
          </div>
          {!hasResults ? <p className="muted">No answers recorded in this set yet.</p> : (
            <ol className="mini-board">
              {standings.slice(0, Math.max(snap.settings.qualify_count, 5)).map((r) => (
                <li key={r.team_id} className={r.tie_review ? 'tied' : ''}>
                  <span className="rank">#{r.rank}</span>
                  <span className="tno">T{r.team_number}</span>
                  <span className="tname">{r.team_name}</span>
                  <strong>{formatPoints(r.points)}</strong>
                  <small className="muted">{formatElapsed(r.elapsed_ms)}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
