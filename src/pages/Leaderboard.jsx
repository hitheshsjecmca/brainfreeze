import { useState } from 'react';
import { Download, Info, MonitorPlay, Search } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { EmptyState, PageHeader } from '../components/Common.jsx';
import { formatPoints } from '../lib/scoring.js';
import { formatElapsed, rankingPolicy } from '../lib/sets.js';
import { standingsCSV } from '../lib/exports.js';
import { downloadText, stamp } from '../lib/download.js';

export default function Leaderboard() {
  const { snap, standings, qualification, act, connection, lastSync } = useQuiz();
  const [query, setQuery] = useState('');
  const { settings, session } = snap;
  const onProjector = session.projector_view === 'leaderboard';
  const tied = new Set(qualification?.tied || []);
  const s = query.trim().toLowerCase();
  const rows = s ? standings.filter((r) => String(r.team_number) === s.replace(/^t/, '') || r.team_name.toLowerCase().includes(s)) : standings;

  return (
    <div className="page">
      <PageHeader title={`Live leaderboard — ${session.name}`} subtitle={`${standings.length} teams · updates after every recorded answer${lastSync ? ` · last sync ${new Date(lastSync).toLocaleTimeString()}` : ''}`}>
        <button className={`btn ${onProjector ? 'btn-ice' : 'btn-ghost'}`} aria-pressed={onProjector}
          onClick={() => act('setProjectorView', { view: onProjector ? 'question' : 'leaderboard' }, { key: 'view', success: onProjector ? 'Leaderboard hidden from projector' : 'Leaderboard shown on projector' })}>
          <MonitorPlay size={16} /> {onProjector ? 'Hide from projector' : 'Show on projector'}
        </button>
        <button className="btn btn-ghost" onClick={() => downloadText(`brainfreze-standings-${stamp()}.csv`, standingsCSV(standings, { qualification, set: session, teams: snap.teams, settings }), 'text/csv')} disabled={!standings.length}>
          <Download size={16} /> Export CSV
        </button>
      </PageHeader>

      {(connection === 'offline' || connection === 'degraded') && (
        <div className="inline-alert alert-warn" role="status">
          {connection === 'offline' ? 'You are offline — the leaderboard shows the last data received.' : 'Realtime connection lost — refreshing by polling every 20 seconds.'}
        </div>
      )}

      <details className="policy glass">
        <summary><Info size={16} /> Ranking & tie-breaking policy</summary>
        <ol>{rankingPolicy(settings).map((t) => <li key={t}>{t}</li>)}</ol>
      </details>

      <div className="toolbar">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder="Find team…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search leaderboard" />
        </label>
        {qualification?.unresolved && <span className="badge badge-danger">Tie at cut-off: {qualification.tied.length} teams for {qualification.slots} slot(s)</span>}
      </div>

      {standings.length === 0 ? <EmptyState title="No teams registered" /> : (
        <div className="table-wrap glass">
          <table className="table leaderboard-table">
            <thead>
              <tr><th scope="col">Rank</th><th scope="col">Team no.</th><th scope="col">Team name</th><th scope="col">Score</th><th scope="col">Correct</th><th scope="col">Incorrect</th><th scope="col">Unanswered</th><th scope="col">Elapsed</th><th scope="col">Tie</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.team_id} className={`${r.rank <= settings.qualify_count ? 'zone' : ''} ${tied.has(r.team_id) ? 'tie-flag' : ''}`}>
                  <td className="num"><b>{r.rank}</b>{r.tied && <span className="tie-mark" title="Shared rank">=</span>}</td>
                  <td className="num">{r.team_number}</td>
                  <td>{r.team_name} {r.is_demo && <span className="badge badge-amber badge-xs">DEMO</span>}</td>
                  <td className="num score">{formatPoints(r.points)}</td>
                  <td className="num ok-text">{r.correct}</td>
                  <td className="num danger-text">{r.incorrect}</td>
                  <td className="num muted">{r.unanswered}</td>
                  <td className="num">{formatElapsed(r.elapsed_ms)}</td>
                  <td className="num">{r.tie_review ? <span className="badge badge-danger badge-xs">Review</span> : ''}{r.tiebreak ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
