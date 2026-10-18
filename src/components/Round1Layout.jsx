import { NavLink, Outlet } from 'react-router-dom';
import { MonitorPlay } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { SECTIONS, SET_STAGE_LABELS } from '../lib/constants.js';
import { setStage } from '../lib/engine.js';
import { formatJoinCode } from '../lib/joinCodes.js';
import { openProjector } from '../lib/projectorWindow.js';
import { ROUND1_TABS } from '../lib/rounds.js';

const STAGE_CLASS = { draft: 'badge-muted', published: 'badge-ice', live: 'badge-ok', completed: 'badge-purple', archived: 'badge-muted' };

/** The quiz set every Round 1 page acts on (per browser tab). */
export function SetPicker({ label = 'Quiz set' }) {
  const { setId, sets, selectSet } = useQuiz();
  const active = sets.filter((x) => x.stage !== 'archived');
  const archived = sets.filter((x) => x.stage === 'archived');
  const text = (x) => `${x.name} · ${SET_STAGE_LABELS[x.stage]}${x.join_code_active ? ` · ${x.join_code}` : ''}`;
  return (
    <label className="set-picker">
      <span>{label}</span>
      <select value={setId || ''} onChange={(e) => selectSet(e.target.value)} aria-label="Selected quiz set">
        {!sets.length && <option value="">Loading…</option>}
        {SECTIONS.map((sec) => (
          <optgroup key={sec} label={`${sec} sets`}>
            {active.filter((x) => x.section === sec).map((x) => <option key={x.id} value={x.id}>{text(x)}</option>)}
          </optgroup>
        ))}
        {archived.length > 0 && (
          <optgroup label="Archived">
            {archived.map((x) => <option key={x.id} value={x.id}>{x.section} · {text(x)}</option>)}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Small identity line for the selected set: section, stage, join code. */
export function SetBadges() {
  const { snap } = useQuiz();
  const s = snap.session;
  const stage = setStage(s);
  return (
    <span className="row gap wrap">
      <span className="badge badge-section">{s.section}</span>
      <span className={`badge ${STAGE_CLASS[stage]}`}>{SET_STAGE_LABELS[stage]}</span>
      {s.join_code_active && <span className="badge badge-ice" title="Join code">Code {formatJoinCode(s.join_code)}{s.registration_open ? '' : ' · registration closed'}</span>}
    </span>
  );
}

/** Round 1 management area: set picker, one projector shortcut, and tabs over the existing Round 1 pages. */
export default function Round1Layout() {
  const { setId } = useQuiz();
  return (
    <div className="round-area">
      <div className="round-head glass">
        <div className="round-title">
          <small>ROUND 1</small>
          <b>COLD START</b>
          <span className="muted small">MCQ Elimination Round</span>
        </div>
        <SetPicker />
        <SetBadges />
        <button className="btn btn-ghost btn-sm round-projector" onClick={() => openProjector(setId)}><MonitorPlay size={16} /> Projector</button>
      </div>
      <nav className="round-tabs" aria-label="Round 1 sections">
        {ROUND1_TABS.map(({ to, end, label }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
