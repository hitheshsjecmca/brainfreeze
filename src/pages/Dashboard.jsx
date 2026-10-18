import { useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronRight, MonitorPlay } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { PageHeader } from '../components/Common.jsx';
import { RoundCard } from './Rounds.jsx';
import { openProjector } from '../lib/projectorWindow.js';
import { ROUND1_STATUS_LABELS, round1NextAction, round1Summary } from '../lib/rounds.js';
import { SECTIONS } from '../lib/constants.js';

/** Event-level overview: next recommended step, a few accurate counts, the event flow and the round cards. */
export default function Dashboard() {
  const { snap, sets, selectSet } = useQuiz();
  const navigate = useNavigate();
  const r1 = round1Summary(sets);
  const next = round1NextAction(sets);
  const teams = snap.allTeams || snap.teams;
  const liveSets = sets.filter((x) => x.stage === 'live');
  const go = (a) => { if (a.setId) selectSet(a.setId); navigate(a.to); };

  return (
    <div className="page">
      <PageHeader title="Organizer dashboard" subtitle={`Round 1 — COLD START: ${ROUND1_STATUS_LABELS[r1.status]}`}>
        {liveSets.length === 1 && <button className="btn btn-ghost" onClick={() => openProjector(liveSets[0].id)}><MonitorPlay size={18} /> Projector</button>}
      </PageHeader>

      <section className="panel glass next-step" aria-labelledby="next-title">
        <div>
          <h2 id="next-title">Next step</h2>
          <p className="muted">{next.hint}</p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => go(next)}>{next.label} <ArrowRight size={18} /></button>
      </section>

      <section className="summary-row" aria-label="Event summary">
        <Stat label="Registered teams" value={teams.length} detail={SECTIONS.map((sec) => `${sec} ${teams.filter((t) => t.section === sec).length}`).join(' · ')} />
        <Stat label="Current round" value="Round 1" detail="COLD START" />
        <Stat label="Live now" value={liveSets.length ? liveSets.map((x) => x.name).join(', ') : 'Nothing live'} small />
        <Stat label="Finished submissions" value={r1.teamsJoined ? `${r1.teamsFinished}/${r1.teamsJoined}` : '—'} detail={r1.teamsJoined ? `${r1.teamsAnswering} team(s) still answering` : 'No team has joined a set yet'} />
        <Stat label="Qualification" value={r1.completed ? `${r1.finalized}/${r1.completed}` : '—'} detail={r1.completed ? 'completed sets with confirmed qualifiers' : 'No completed sets yet'} />
      </section>

      <EventFlow r1={r1} />

      <div className="round-grid">
        <RoundCard id={1} withAction={false} />
        <RoundCard id={2} />
      </div>
    </div>
  );
}

function Stat({ label, value, detail, small }) {
  return (
    <div className="mini-stat glass">
      <span className="muted small">{label}</span>
      <strong className={small ? 'mini-stat-text' : ''}>{value}</strong>
      {detail && <small className="muted">{detail}</small>}
    </div>
  );
}

/** The intended event sequence. Only the Round 1 steps reflect real data; Round 2 is run from its own area. */
function EventFlow({ r1 }) {
  const steps = [
    { label: 'Round 1', state: r1.status === 'qualified' ? 'done' : ['live', 'review', 'ready'].includes(r1.status) ? 'current' : 'todo' },
    { label: 'Top 5 confirmed', state: r1.status === 'qualified' ? 'done' : r1.completed ? 'current' : 'todo', note: r1.completed ? `${r1.finalized}/${r1.completed} sets` : null },
    { label: 'Round 2', state: 'todo', note: 'trivia board' },
    { label: 'Round 2 results', state: 'todo' },
  ];
  return (
    <ol className="event-flow" aria-label="Event flow">
      {steps.map((s, i) => (
        <li key={s.label} className={`flow-${s.state}`}>
          <span>{s.label}</span>
          {s.note && <small>{s.note}</small>}
          {s.state === 'na' && <small>not implemented</small>}
          {i < steps.length - 1 && <ChevronRight size={14} aria-hidden="true" className="flow-arrow" />}
        </li>
      ))}
    </ol>
  );
}
