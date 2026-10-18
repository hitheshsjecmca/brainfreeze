import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, Eye, EyeOff, Lock, RotateCcw, Sparkles, Trophy } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useAppSettings } from '../context/AppSettingsContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { PageHeader } from '../components/Common.jsx';
import SetResults from '../components/SetResults.jsx';
import { SetPicker } from '../components/Round1Layout.jsx';
import { ROUNDS, resultsStatus, visibleRounds } from '../lib/rounds.js';
import { formatElapsed } from '../lib/sets.js';
import { formatPoints } from '../lib/scoring.js';
import { standingsCSV } from '../lib/exports.js';
import { downloadText, stamp } from '../lib/download.js';
import { TIEBREAK_QUESTIONS } from '../data/tiebreakQuestions.js';

const STATUS_CLASS = { finalized: 'badge-ok', review: 'badge-amber', provisional: 'badge-ice', none: 'badge-muted' };

/** Results for every round: Round 1 per quiz set here; Rounds 2 and 3 link to their own result pages. */
export default function Results() {
  const [picked, setRound] = useState(1);
  const { round3Enabled } = useAppSettings();
  const rounds = visibleRounds(round3Enabled);
  const round = rounds.some((r) => r.id === picked) ? picked : 1;
  return (
    <div className="page">
      <div className="segmented results-rounds" role="tablist" aria-label="Round">
        {rounds.map((r) => (
          <button key={r.id} role="tab" aria-selected={round === r.id} className={round === r.id ? 'active' : ''} onClick={() => setRound(r.id)}>
            Round {r.id}{r.implemented ? '' : ' (not implemented)'}
          </button>
        ))}
      </div>
      {round === 1 ? <Round1Results /> : (
        <section className="panel glass">
          <h2>Round {round} — {ROUNDS[round - 1].name}</h2>
          {round === 2
            ? <p className="muted">Round 2 scores and score logs are kept per game on the <Link to="/host/rounds/2">Round 2 Dashboard</Link>.</p>
            : <p className="muted">Final rankings, per-team summaries and CSV export for every auction are on <Link to="/host/rounds/3/results">Round 3 Results</Link>.</p>}
        </section>
      )}
    </div>
  );
}

function Round1Results() {
  const { snap, standings, qualification: qual, act } = useQuiz();
  const { confirm } = useUI();
  const { session, settings, teams } = snap;
  const ended = session.status === 'ended';
  const finalized = session.status === 'finalized';
  const byId = useMemo(() => new Map(standings.map((r) => [r.team_id, r])), [standings]);

  const [picked, setPicked] = useState([]);
  const [override, setOverride] = useState('');
  const tiedPicked = picked.filter((id) => qual.tied.includes(id));
  const selection = qual.unresolved ? [...qual.certain, ...tiedPicked] : qual.proposed;
  const canConfirm = ended && (qual.unresolved ? tiedPicked.length === qual.slots && override.trim() : qual.proposed.length === qual.target);

  async function confirmQualifiers() {
    const names = selection.map((id) => byId.get(id)).map((r) => `T${r.team_number} ${r.team_name}`);
    const ok = await confirm({
      title: `Confirm the top ${qual.target}?`, confirmLabel: 'Confirm qualifiers',
      message: (
        <>
          <ol>{names.map((n) => <li key={n}>{n}</li>)}</ol>
          {qual.unresolved && <p className="warn-text">Tie override reason: “{override.trim()}”</p>}
          <p>This finalizes Round 1: score changes are locked until results are reopened. Nothing is shown on the projector until you press Reveal.</p>
        </>
      ),
      typeToConfirm: 'CONFIRM',
    });
    if (!ok) return;
    await act('confirmQualifiers', { team_ids: selection, override_reason: qual.unresolved ? override.trim() : null }, { success: 'Qualifiers confirmed' });
  }

  async function reveal(on) {
    if (on) {
      const ok = await confirm({ title: 'Reveal qualifiers on the projector?', confirmLabel: 'Reveal now', message: <p>The Winter Arc qualification reveal starts immediately on the projector.</p> });
      if (!ok) return;
    }
    await act('revealResults', { reveal: on }, { success: on ? 'Results revealed on projector' : 'Reveal hidden' });
  }

  async function reopen() {
    const ok = await confirm({ title: 'Reopen results?', danger: true, requireReason: true, confirmLabel: 'Reopen', message: <p>Clears the confirmed qualifiers and hides the reveal so scores or tie-breaks can be changed.</p> });
    if (ok) act('reopenResults', { reason: ok.reason }, { success: 'Results reopened' });
  }

  const exportFinal = () => downloadText(
    `brainfreze-final-rankings-${stamp()}.csv`,
    standingsCSV(standings, { qualifiers: finalized ? session.qualifiers : null, provisional: !finalized, qualification: qual, set: session, teams, settings }),
    'text/csv',
  );

  const status = resultsStatus(session, standings);
  return (
    <>
      <div className="results-head">
        <SetPicker label="Round 1 quiz set" />
        <span className={`badge ${STATUS_CLASS[status.key]}`} role="status">{status.label}</span>
      </div>
      <PageHeader title={`Results — ${session.name}`} subtitle={`${session.section} set · top ${settings.qualify_count} teams of this set advance to Round 2. Nothing is published until you confirm and reveal.`}>
        <button className="btn btn-ghost" onClick={exportFinal}><Download size={16} /> {finalized ? 'Export final rankings' : 'Export provisional rankings'}</button>
      </PageHeader>

      {!ended && !finalized && (
        <div className="inline-alert alert-info"><Lock size={18} /> The set is {session.status}. End the set on the Live Host page before confirming qualifiers. The analysis below is provisional.</div>
      )}

      <SetResults />

      {finalized ? (
        <section className="panel glass" aria-labelledby="final-title">
          <h2 id="final-title"><CheckCircle2 size={20} /> Qualifiers confirmed {session.qualifiers_confirmed_at && <small className="muted">· {new Date(session.qualifiers_confirmed_at).toLocaleString()}</small>}</h2>
          <ol className="qualifier-list">
            {session.qualifiers.map((id) => {
              const r = byId.get(id);
              return <li key={id}><Trophy size={18} /> <b>T{r?.team_number}</b> {r?.team_name ?? teams.find((t) => t.id === id)?.team_name} <span className="muted">· {r ? formatPoints(r.points) : '—'} pts</span></li>;
            })}
          </ol>
          {session.qualification_note && <p className="warn-text">Tie override: {session.qualification_note}</p>}
          <div className="row gap wrap">
            {!session.results_revealed
              ? <button className="btn btn-primary btn-lg" onClick={() => reveal(true)}><Sparkles size={18} /> Reveal on projector</button>
              : <button className="btn btn-ghost" onClick={() => reveal(false)}><EyeOff size={16} /> Hide reveal</button>}
            {session.results_revealed && session.projector_view !== 'reveal' && (
              <button className="btn btn-ghost" onClick={() => act('setProjectorView', { view: 'reveal' })}><Eye size={16} /> Show reveal again</button>
            )}
            <button className="btn btn-ghost" onClick={reopen}><RotateCcw size={16} /> Reopen results</button>
          </div>
        </section>
      ) : (
        <div className="two-col">
          <section className="panel glass" aria-labelledby="qual-title">
            <h2 id="qual-title">Qualification analysis</h2>
            {qual.target === 0 ? <p className="muted">No teams.</p> : (
              <>
                <p>Certain qualifiers ({qual.certain.length}):</p>
                <ol className="qualifier-list">
                  {qual.certain.map((id) => <QualRow key={id} r={byId.get(id)} />)}
                  {!qual.unresolved && qual.proposed.filter((id) => !qual.certain.includes(id)).map((id) => <QualRow key={id} r={byId.get(id)} />)}
                </ol>
                {qual.unresolved ? (
                  <div className="tie-box" role="alert">
                    <h3><AlertTriangle size={18} /> Unresolved tie at the cut-off</h3>
                    <p>{qual.tied.length} teams share rank {qual.boundaryRank} for <b>{qual.slots}</b> remaining slot(s). No team is eliminated automatically.</p>
                    <p className="muted small">Preferred: run a tie-breaker and enter results (right). Otherwise select {qual.slots} team(s) below and record why.</p>
                    <fieldset className="tie-pick" disabled={!ended}>
                      <legend className="sr-only">Choose tied teams to qualify</legend>
                      {qual.tied.map((id) => {
                        const r = byId.get(id);
                        return (
                          <label key={id} className="check">
                            <input type="checkbox" checked={picked.includes(id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, id] : p.filter((x) => x !== id)))} />
                            T{r.team_number} {r.team_name} · {formatPoints(r.points)} pts · {formatElapsed(r.elapsed_ms)}{r.tiebreak !== null ? ` · TB ${r.tiebreak}` : ''}
                          </label>
                        );
                      })}
                      <label className="field">
                        <span>Override reason (required, audited)</span>
                        <input value={override} onChange={(e) => setOverride(e.target.value)} maxLength={300} placeholder="e.g. Won buzzer tie-break question 2" />
                      </label>
                    </fieldset>
                  </div>
                ) : (
                  <p className="ok-text"><CheckCircle2 size={16} /> No unresolved tie at the cut-off.</p>
                )}
                <button className="btn btn-primary btn-lg" disabled={!canConfirm} onClick={confirmQualifiers}><Trophy size={18} /> Review & confirm top {qual.target}</button>
              </>
            )}
          </section>
          <TieBreakPanel />
        </div>
      )}
    </>
  );
}

function QualRow({ r }) {
  if (!r) return null;
  return <li><b>#{r.rank}</b> T{r.team_number} {r.team_name} <span className="muted">· {formatPoints(r.points)} pts · {formatElapsed(r.elapsed_ms)}</span></li>;
}

function TieBreakPanel() {
  const { snap, standings, qualification: qual, act } = useQuiz();
  const ended = snap.session.status === 'ended';
  const [extra, setExtra] = useState('');
  const shown = standings.filter((r) => qual.tied.includes(r.team_id) || r.tiebreak !== null || r.team_id === extra);

  return (
    <section className="panel glass" aria-labelledby="tb-title">
      <h2 id="tb-title">Tie-break results</h2>
      <p className="muted small">Used only for teams with equal score AND equal elapsed time (flagged “Review”). Higher result wins. Applies only when every team in the tied group has a result. Enter e.g. 1 for the winner and 0 for others, or −|difference| for closest-answer questions.</p>
      {shown.length === 0 && <p className="muted">No ties need resolving.</p>}
      {shown.map((r) => <TieRow key={r.team_id} r={r} disabled={!ended} act={act} />)}
      <label className="field">
        <span>Add another team</span>
        <select value={extra} onChange={(e) => setExtra(e.target.value)} disabled={!ended}>
          <option value="">—</option>
          {standings.filter((r) => !shown.includes(r)).map((r) => <option key={r.team_id} value={r.team_id}>T{r.team_number} {r.team_name}</option>)}
        </select>
      </label>
      <details className="tb-questions">
        <summary>Reserve tie-breaker questions (host only)</summary>
        <ol>{TIEBREAK_QUESTIONS.map((t) => <li key={t.q}>{t.q} <span className="muted">Answer: {t.a}</span></li>)}</ol>
      </details>
    </section>
  );
}

function TieRow({ r, disabled, act }) {
  const [score, setScore] = useState(r.tiebreak ?? '');
  const [note, setNote] = useState(r.tiebreak_note || '');
  return (
    <form className="tie-row" onSubmit={(e) => { e.preventDefault(); act('setTiebreak', { team_id: r.team_id, score: score === '' ? null : Number(score), note }, { key: `tb:${r.team_id}`, success: `Tie-break saved for T${r.team_number}` }); }}>
      <span className="tie-team">T{r.team_number} · {formatPoints(r.points)}</span>
      <input type="number" step="any" value={score} onChange={(e) => setScore(e.target.value)} placeholder="result" aria-label={`Tie-break result for team ${r.team_number}`} disabled={disabled} />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note" aria-label={`Tie-break note for team ${r.team_number}`} disabled={disabled} maxLength={300} />
      <button className="btn btn-ghost btn-sm" disabled={disabled}>Save</button>
    </form>
  );
}
