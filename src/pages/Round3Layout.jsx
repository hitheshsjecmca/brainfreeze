import { NavLink, Outlet } from 'react-router-dom';
import { MonitorPlay } from 'lucide-react';
import { Round3Provider } from '../context/Round3Context.jsx';
import { openRound3Projector } from '../lib/projectorWindow.js';
import { ROUND3_TABS } from '../lib/rounds.js';

/** Round 3 area: its own data provider (separate from Rounds 1 and 2), one projector shortcut, tabs. */
export default function Round3Layout() {
  return (
    <Round3Provider>
      <div className="round-area">
        <div className="round-head glass">
          <div className="round-title">
            <small>ROUND 3</small>
            <b>THE KNOWLEDGE AUCTION</b>
            <span className="muted small">THINK. BID. RISK. WIN. · auction sets · organiser-run open bidding</span>
          </div>
          <button className="btn btn-ghost btn-sm round-projector" onClick={() => openRound3Projector()} title="Shows the newest live auction"><MonitorPlay size={16} /> Projector</button>
        </div>
        <nav className="round-tabs" aria-label="Round 3 sections">
          {ROUND3_TABS.map(({ to, end, label }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
        </nav>
        <Outlet />
      </div>
    </Round3Provider>
  );
}
