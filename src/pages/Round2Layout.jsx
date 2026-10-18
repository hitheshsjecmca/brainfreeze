import { NavLink, Outlet } from 'react-router-dom';
import { MonitorPlay } from 'lucide-react';
import { Round2Provider } from '../context/Round2Context.jsx';
import { openRound2Projector } from '../lib/projectorWindow.js';
import { ROUND2_TABS } from '../lib/rounds.js';

/** Round 2 area: its own data provider (separate from Round 1), one projector shortcut, tabs. */
export default function Round2Layout() {
  return (
    <Round2Provider>
      <div className="round-area">
        <div className="round-head glass">
          <div className="round-title">
            <small>ROUND 2</small>
            <b>MIND MELTDOWN</b>
            <span className="muted small">Trivia sets · host-controlled projector game</span>
          </div>
          <button className="btn btn-ghost btn-sm round-projector" onClick={() => openRound2Projector()} title="Shows the newest live game"><MonitorPlay size={16} /> Projector</button>
        </div>
        <nav className="round-tabs" aria-label="Round 2 sections">
          {ROUND2_TABS.map(({ to, end, label }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
        </nav>
        <Outlet />
      </div>
    </Round2Provider>
  );
}
