import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Eye, EyeOff, Lock, Trophy } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useR3Data, useRound3 } from '../context/Round3Context.jsx';
import { EmptyState, ErrorState, Loading } from '../components/Common.jsx';
import { downloadText, stamp } from '../lib/download.js';
import { round3CSV } from '../lib/exports.js';
import { R3_RESULT_LABELS } from '../lib/round3.js';
import { formatStamp } from '../lib/sets.js';

/** Round 3 Results tab: every auction (finished first) with a link to its summary. */
export default function Round3Results() {
  const { data, error, reload } = useR3Data(() => backend.round3.overview(), 'overview');
  if (error && !data) return <ErrorState title="Round 3 results could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading Round 3 results…" />;
  const sessions = [...data.sessions].sort((a, b) => (a.status === 'ended') === (b.status === 'ended') ? b.started_at.localeCompare(a.started_at) : a.status === 'ended' ? -1 : 1);
  return (
    <section className="panel glass" aria-labelledby="r3-res-title">
      <h2 id="r3-res-title"><Trophy size={18} /> Round 3 results</h2>
      {sessions.length === 0 ? <EmptyState title="No auctions yet"><p className="muted">Results appear here once an auction has been started.</p></EmptyState> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Auction</th><th scope="col">Section</th><th scope="col">Teams</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {sessions.map((g) => (
                <tr key={g.id}>
                  <td><b>{g.title}</b> <span className="badge badge-muted badge-xs">v{g.version}</span></td>
                  <td>{g.section}</td>
                  <td className="small">{(g.teams || []).map((t) => `T${t.team_number} ${t.team_name}`).join(' · ')}</td>
                  <td>{g.status === 'ended' ? <span className="badge badge-ok">Final{g.results_revealed ? ' · revealed' : ''}</span> : <span className="badge badge-ice">Live — provisional</span>}</td>
                  <td className="small">{formatStamp(g.started_at)}</td>
                  <td className="actions"><Link className="btn btn-ghost btn-sm" to={`/host/rounds/3/results/${g.id}`}>Summary</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One auction's summary: final ranking from the private scores, per-team totals, question log, CSV export, reveal. */
export function Round3ResultDetail() {
  const { sessionId } = useParams();
  const { act, pendingKeys } = useRound3();
  const { data, error, reload } = useR3Data(() => backend.round3.results(sessionId), `res-${sessionId}`);
  if (error && !data) return <ErrorState title="These results could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading results…" />;
  const s = data.session;
  const ended = s.status === 'ended';
  const byTeam = new Map(data.summary.map((x) => [x.team_id, x]));
  const exportCSV = () => downloadText(`round3-${s.section}-${stamp()}.csv`, round3CSV(data), 'text/csv');

  return (
    <div className="stack">
      <Link to="/host/rounds/3/results" className="back-link"><ArrowLeft size={16} /> All Round 3 results</Link>
      <section className="panel glass" aria-labelledby="r3-sum-title">
        <div className="panel-head">
          <div>
            <h2 id="r3-sum-title">{s.title} — {s.section} <span className={`badge ${ended ? 'badge-ok' : 'badge-ice'}`}>{ended ? 'Final' : 'Live — provisional'}</span></h2>
            <p className="muted small">Started {formatStamp(s.started_at)}{s.ended_at && <> · ended {formatStamp(s.ended_at)}</>} · <Lock size={11} /> private organiser view</p>
          </div>
          <div className="row gap wrap">
            <button className="btn btn-ghost btn-sm" onClick={exportCSV}><Download size={14} /> Export CSV</button>
            {ended && (
              <button className="btn btn-primary btn-sm" disabled={pendingKeys.has('r3-reveal')} onClick={() => act('r3sRevealResults', { session_id: s.id, reveal: !s.results_revealed }, { key: 'r3-reveal', success: s.results_revealed ? 'Results hidden from the projector' : 'Final results shown on the projector' })}>
                {s.results_revealed ? <><EyeOff size={14} /> Hide on projector</> : <><Eye size={14} /> Reveal on projector</>}
              </button>
            )}
          </div>
        </div>
        {!ended && <p className="warn-text small">The auction is still live — these rankings are provisional and are not shown on the projector.</p>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Rank</th><th scope="col">Team</th><th scope="col">Final score</th><th scope="col">Final budget</th><th scope="col">Correct</th><th scope="col">Wrong</th><th scope="col">Pass / time out</th><th scope="col">Points awarded</th><th scope="col">Budget deducted</th></tr></thead>
            <tbody>
              {data.ranking.map((r) => {
                const x = byTeam.get(r.team_id) || {};
                return (
                  <tr key={r.team_id}>
                    <td className="num"><b>{r.rank}</b>{r.tied && <span className="badge badge-amber badge-xs">tied</span>}</td>
                    <td>T{r.team_number} {r.team_name}</td>
                    <td className="num"><b>{r.score}</b></td>
                    <td className="num">{r.budget}</td>
                    <td className="num">{x.correct}</td>
                    <td className="num">{x.wrong}</td>
                    <td className="num">{x.passes}</td>
                    <td className="num">{x.points_awarded}</td>
                    <td className="num">{x.budget_deducted}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.ranking.some((r) => r.tied) && <p className="warn-text small">Equal final scores share a rank. Any tie-break is decided openly by the organisers; the system never breaks it on its own.</p>}
      </section>

      <section className="panel glass" aria-labelledby="r3-qlog">
        <h2 id="r3-qlog">Questions played</h2>
        {data.questions.length === 0 ? <p className="muted">No questions completed yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">#</th><th scope="col">Topic</th><th scope="col">Mode</th><th scope="col">Highest bid</th><th scope="col">Result</th><th scope="col">Completed</th></tr></thead>
              <tbody>
                {data.questions.map((q) => (
                  <tr key={q.question_id}>
                    <td className="num">{q.seq}</td>
                    <td>{q.topic_name}</td>
                    <td>{q.mode}</td>
                    <td>{q.top_name ? `${q.top_name} (${q.top_bid})` : '—'}</td>
                    <td>{R3_RESULT_LABELS[q.result]}{q.winner_name ? ` — ${q.winner_name}` : ''}</td>
                    <td className="small">{formatStamp(q.completed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
