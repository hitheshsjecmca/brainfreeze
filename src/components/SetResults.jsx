import { useMemo, useState } from 'react';
import { AlertTriangle, Download, FileText, Search } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { Modal } from './Common.jsx';
import { ATTEMPT_STATUS_LABELS, OPTIONS, OPTION_FIELDS } from '../lib/constants.js';
import { participantNames } from '../lib/teamSelection.js';
import { formatPoints, signedPoints } from '../lib/scoring.js';
import { EVENT_TIMEZONE, formatElapsed, formatStamp } from '../lib/sets.js';
import { completionCSV, registrationsCSV, standingsCSV, submissionAuditCSV } from '../lib/exports.js';
import { downloadText, stamp } from '../lib/download.js';
import { formatJoinCode } from '../lib/joinCodes.js';

/** Per-set results: score, counts, server times, completion status, rank, tie review, attempt detail and CSV exports. */
export default function SetResults() {
  const { snap, standings, qualification, quizQuestions } = useQuiz();
  const { session, settings, teams } = snap;
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const set = { id: session.id, name: session.name, section: session.section, join_code: session.join_code };
  const q = query.trim().toLowerCase();
  const rows = q ? standings.filter((r) => String(r.team_number) === q.replace(/^t/, '') || r.team_name.toLowerCase().includes(q)
    || (teamById.get(r.team_id)?.college_name || '').toLowerCase().includes(q)) : standings;
  const finalized = session.status === 'finalized';
  const file = (what) => `brainfreze-${what}-${session.section}-${session.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${stamp()}.csv`;
  const reviews = standings.filter((r) => r.tie_review).length;

  return (
    <section className="panel glass" aria-labelledby="sr-title">
      <div className="panel-head">
        <h2 id="sr-title">{session.name} <span className="badge badge-section">{session.section}</span> {session.join_code && <span className="badge badge-muted">Code {formatJoinCode(session.join_code)}{session.join_code_active ? '' : ' (inactive)'}</span>}</h2>
        <span className="muted small">Time limit {formatElapsed(settings.duration_seconds * 1000)} · times in {EVENT_TIMEZONE}</span>
      </div>
      <div className="row gap wrap">
        <button className="btn btn-ghost btn-sm" onClick={() => downloadText(file('registrations'), registrationsCSV(teams), 'text/csv')}><Download size={14} /> Registrations</button>
        <button className="btn btn-ghost btn-sm" onClick={() => downloadText(file('scores'), standingsCSV(standings, { set, teams, settings, qualification, qualifiers: finalized ? session.qualifiers : null, provisional: !finalized }), 'text/csv')}><Download size={14} /> Scores & ranks</button>
        <button className="btn btn-ghost btn-sm" onClick={() => downloadText(file('completion-times'), completionCSV(standings, { set, settings }), 'text/csv')}><Download size={14} /> Completion times</button>
        <button className="btn btn-ghost btn-sm" onClick={() => downloadText(file('submission-audit'), submissionAuditCSV({ set, teams, questions: quizQuestions, answers: snap.answers, attempts: snap.attempts || [], events: snap.events }), 'text/csv')}><Download size={14} /> Submission audit</button>
      </div>
      {reviews > 0 && <p className="warn-text" role="status"><AlertTriangle size={14} /> {reviews} team(s) share score and elapsed time — flagged for tie review. Enter tie-break results after the set ends.</p>}
      <div className="toolbar">
        <label className="search"><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find team or college…" aria-label="Find team in results" /></label>
      </div>
      <div className="table-wrap">
        <table className="table table-compact results-table">
          <thead>
            <tr>
              <th scope="col">Rank</th><th scope="col">Team</th><th scope="col">Participant(s) · college · section</th><th scope="col">Score</th>
              <th scope="col">✓</th><th scope="col">✗</th><th scope="col">—</th><th scope="col">Started</th><th scope="col">Final submission</th>
              <th scope="col">Elapsed</th><th scope="col">Status</th><th scope="col">Tie</th><th scope="col"><span className="sr-only">Detail</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = teamById.get(r.team_id);
              return (
                <tr key={r.team_id} className={`${r.rank <= settings.qualify_count ? 'zone' : ''} ${r.tie_review ? 'tie-flag' : ''}`}>
                  <td className="num"><b>{r.rank}</b>{r.tied && <span className="tie-mark" title="Shared rank">=</span>}</td>
                  <td><b>T{r.team_number}</b> {r.team_name}</td>
                  <td className="small">{t ? participantNames(t) : ''} {t?.join_session_id && <span className="badge badge-muted badge-xs">self-joined</span>}<br /><span className="muted">{t?.college_name || ''}</span> <span className="badge badge-section badge-xs">{t?.section || session.section}</span></td>
                  <td className="num score">{formatPoints(r.points)}</td>
                  <td className="num ok-text">{r.correct}</td>
                  <td className="num danger-text">{r.incorrect}</td>
                  <td className="num muted">{r.unanswered}</td>
                  <td className="small">{formatStamp(r.started_at) || <span className="muted">—</span>}</td>
                  <td className="small">{formatStamp(r.finished_at) || <span className="muted">—</span>}</td>
                  <td className="num">{formatElapsed(r.elapsed_ms)}{r.attempt_status !== 'submitted' && <small className="muted" title="Counted at the full time limit"> (limit)</small>}</td>
                  <td className="small">{ATTEMPT_STATUS_LABELS[r.attempt_status || 'none']}</td>
                  <td>{r.tie_review ? <span className="badge badge-danger badge-xs">Review</span> : ''}{r.tiebreak !== null && r.tiebreak !== undefined ? <small> TB {r.tiebreak}</small> : ''}</td>
                  <td><button className="icon-btn" onClick={() => setDetail(r)} aria-label={`Attempt detail for team ${r.team_number}`} title="Attempt detail"><FileText size={15} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail && <AttemptDetail row={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

/** One team's attempt: its question order, the option letters it saw, accepted answers and server timestamps. */
function AttemptDetail({ row, onClose }) {
  const { snap, quizQuestions } = useQuiz();
  const attempt = (snap.attempts || []).find((a) => a.team_id === row.team_id && a.status !== 'reset');
  const resets = (snap.attempts || []).filter((a) => a.team_id === row.team_id && a.status === 'reset');
  const byId = new Map(quizQuestions.map((q, i) => [q.id, { ...q, n: i + 1 }]));
  const answers = new Map(snap.answers.filter((a) => a.team_id === row.team_id).map((a) => [a.question_id, a]));
  const order = attempt ? attempt.question_order : quizQuestions.map((q) => q.id);
  return (
    <Modal title={`T${row.team_number} ${row.team_name} — attempt detail`} onClose={onClose} wide labelledBy="ad-title">
      <dl className="kv small">
        <dt>Status</dt><dd>{ATTEMPT_STATUS_LABELS[row.attempt_status || 'none']}{attempt?.finalize_reason ? ` — ${attempt.finalize_reason}` : ''}</dd>
        <dt>Started</dt><dd>{formatStamp(row.started_at) || '—'}</dd>
        <dt>Deadline</dt><dd>{formatStamp(attempt?.deadline_at) || '—'}</dd>
        <dt>Final submission</dt><dd>{formatStamp(row.finished_at) || '—'}</dd>
        <dt>Paused time</dt><dd>{formatElapsed(attempt?.paused_ms || 0)}</dd>
        <dt>Elapsed (ranking)</dt><dd>{formatElapsed(row.elapsed_ms)}</dd>
        <dt>Score</dt><dd>{formatPoints(row.points)} · {row.correct} correct · {row.incorrect} incorrect · {row.unanswered} unanswered</dd>
        {resets.length > 0 && <><dt>Resets</dt><dd>{resets.map((a) => `${formatStamp(a.reset_at)}: ${a.reset_reason}`).join(' · ')}</dd></>}
      </dl>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead><tr><th scope="col">Team Q#</th><th scope="col">Set Q#</th><th scope="col">Question</th><th scope="col">Shown as</th><th scope="col">Answer (original)</th><th scope="col">Key</th><th scope="col">Points</th><th scope="col">Accepted at (server)</th><th scope="col">On time</th></tr></thead>
          <tbody>
            {order.map((qid, i) => {
              const q = byId.get(qid);
              const a = answers.get(qid);
              return (
                <tr key={qid}>
                  <td className="num">{i + 1}</td>
                  <td className="num">{q?.n ?? ''}</td>
                  <td className="small">{q?.question_text}</td>
                  <td className="num">{a?.displayed_option || (a ? '—' : '')}</td>
                  <td>{a ? `${a.selected_option ?? 'Unanswered'}${a.selected_option && q ? ` · ${q[OPTION_FIELDS[a.selected_option]]}` : ''}` : <span className="muted">not answered</span>}</td>
                  <td className="num">{q && OPTIONS.includes(q.correct_option) ? q.correct_option : ''}</td>
                  <td className="num">{a ? signedPoints(a.points) : ''}</td>
                  <td className="small">{a ? formatStamp(a.created_at) : ''}{a?.source === 'organizer' ? <span className="muted"> (host)</span> : ''}</td>
                  <td>{a ? (a.on_time === false ? <span className="danger-text">late</span> : a.on_time ? 'yes' : '—') : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
