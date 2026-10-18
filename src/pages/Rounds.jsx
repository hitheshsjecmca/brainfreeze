import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useAppSettings } from '../context/AppSettingsContext.jsx';
import { PageHeader } from '../components/Common.jsx';
import { ROUND1_STATUS_LABELS, ROUNDS, round1NextAction, round1Summary, visibleRounds } from '../lib/rounds.js';

/** Rounds hub: one card per round. */
export default function Rounds() {
  const { round3Enabled } = useAppSettings();
  const flow = round3Enabled ? 'Round 1 → top 5 qualify → Round 2 → top 3 qualify → Round 3 → final winner.' : 'Round 1 → top 5 qualify → Round 2.';
  return (
    <div className="page">
      <PageHeader title="Rounds" subtitle={`${flow} Advancing teams always needs an explicit organizer confirmation.`} />
      <div className="round-grid">
        {visibleRounds(round3Enabled).map((r) => <RoundCard key={r.id} id={r.id} />)}
      </div>
    </div>
  );
}

/** `withAction` = show Round 1's next-step button (off on the dashboard, which already has one). */
export function RoundCard({ id, withAction = true }) {
  const r = ROUNDS.find((x) => x.id === id);
  if (r.id === 1) return <Round1Card r={r} withAction={withAction} />;
  return r.id === 2 ? <Round2Card r={r} /> : <Round3Card r={r} />;
}

function Round2Card({ r }) {
  return (
    <article className="round-card glass" aria-labelledby={`rc${r.id}`}>
      <header>
        <small>ROUND {r.id}</small>
        <h2 id={`rc${r.id}`}>{r.name}</h2>
        <p className="muted small">{r.subtitle}</p>
      </header>
      <p className="muted small">Trivia sets with any number of topics and point tiles, published with a six-digit code; a host-controlled projector game with an 18-second timer and Right / Wrong team confirmation. {r.advance}.</p>
      <div className="row gap wrap">
        <Link className="btn btn-ghost" to="/host/rounds/2">Open Round 2</Link>
        <Link className="btn btn-ghost btn-sm" to="/host/rounds/2/sets">Trivia Sets</Link>
        <Link className="btn btn-ghost btn-sm" to="/host/rounds/2/join">Join Round 2</Link>
      </div>
    </article>
  );
}

function Round3Card({ r }) {
  return (
    <article className="round-card glass" aria-labelledby={`rc${r.id}`}>
      <header>
        <small>ROUND {r.id}</small>
        <h2 id={`rc${r.id}`}>{r.name}</h2>
        <p className="muted small">{r.subtitle}</p>
      </header>
      <p className="muted small">Auction sets with Normal and Blind topics, published with a six-digit code; three teams bid from a public budget of 100 for the right to answer, and score privately. {r.advance}.</p>
      <div className="row gap wrap">
        <Link className="btn btn-ghost" to="/host/rounds/3">Open Round 3</Link>
        <Link className="btn btn-ghost btn-sm" to="/host/rounds/3/sets">Auction Sets</Link>
        <Link className="btn btn-ghost btn-sm" to="/host/rounds/3/join">Join Round 3</Link>
      </div>
    </article>
  );
}

function Round1Card({ r, withAction }) {
  const { sets, selectSet } = useQuiz();
  const navigate = useNavigate();
  const s = round1Summary(sets);
  const next = round1NextAction(sets);
  return (
    <article className="round-card glass" aria-labelledby="rc1">
      <header>
        <small>ROUND {r.id}</small>
        <h2 id="rc1">{r.name}</h2>
        <p className="muted small">{r.subtitle}</p>
      </header>
      <span className={`badge ${s.status === 'live' ? 'badge-ok' : s.status === 'qualified' ? 'badge-purple' : 'badge-ice'}`}>{ROUND1_STATUS_LABELS[s.status]}</span>
      <dl className="kv small">
        <dt>Quiz sets</dt><dd>{s.sets} ({s.drafts} draft · {s.published} published · {s.live} live · {s.completed} completed)</dd>
        <dt>Teams joined</dt><dd>{s.teamsJoined}{s.teamsJoined ? ` · ${s.teamsFinished} finished` : ''}</dd>
        <dt>Qualifiers</dt><dd>{s.finalized ? `${s.qualifiers} confirmed in ${s.finalized} set(s)` : 'None confirmed yet'}</dd>
      </dl>
      <p className="muted small">{r.advance}.</p>
      <div className="row gap wrap">
        {withAction && <button className="btn btn-primary" onClick={() => { if (next.setId) selectSet(next.setId); navigate(next.to); }}>{next.label} <ArrowRight size={16} /></button>}
        <Link className="btn btn-ghost" to="/host/rounds/1">Open Round 1</Link>
      </div>
    </article>
  );
}
