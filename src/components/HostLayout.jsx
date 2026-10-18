import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Gauge, Layers, LogOut, Menu, Settings, Trophy, Users, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuiz } from '../context/QuizContext.jsx';
import { BrandLockup } from './Brand.jsx';
import { ConnectionBadge, ErrorState, Loading, ModeBadge } from './Common.jsx';
import { FrostBackdrop } from './Snowfall.jsx';
import { HOST_NAV } from '../lib/rounds.js';

const ICONS = { dashboard: Gauge, rounds: Layers, teams: Users, results: Trophy, settings: Settings };

/** Organizer shell: five sections in the sidebar; round-specific controls live inside each round's area. */
export default function HostLayout() {
  const { user, signOut } = useAuth();
  const { snap, loadError, refresh, connection, isDemo, outbox } = useQuiz();
  const [navOpen, setNavOpen] = useState(false);
  const queued = outbox.filter((x) => !x.failed).length;
  const failed = outbox.filter((x) => x.failed).length;

  return (
    <div className="host-shell">
      <FrostBackdrop snow={false} />
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className={`sidebar glass ${navOpen ? 'open' : ''}`} aria-label="Organizer navigation">
        <div className="sidebar-head">
          <BrandLockup size="sm" />
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>
        <nav>
          {HOST_NAV.map(({ to, end, label, key }) => {
            const Icon = ICONS[key];
            return (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setNavOpen(false)}>
                <Icon size={18} /> {label}
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <small className="muted" title={user?.email}>{user?.email}</small>
          <button className="btn btn-ghost btn-sm" onClick={signOut}><LogOut size={16} /> Sign out</button>
        </div>
      </aside>

      <div className="host-main">
        <header className="topbar glass">
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Open menu"><Menu size={22} /></button>
          <div className="topbar-badges">
            <span className="topbar-event">JOSHIANA 15.0 · WINTER ARC</span>
            <ModeBadge isDemo={isDemo} />
            <ConnectionBadge connection={connection} />
            {snap?.session.corrections_enabled && <span className="badge badge-purple">Corrections authorized · {snap.session.name}</span>}
            {queued > 0 && <span className="badge badge-amber" role="status">{queued} answer(s) queued offline</span>}
            {failed > 0 && <NavLink to="/host/rounds/1/live" className="badge badge-danger">{failed} queued answer(s) need review</NavLink>}
          </div>
        </header>
        {isDemo && (
          <div className="demo-banner" role="note">
            DEMO MODE — data is stored only in this browser. No login, no cloud sync, no server-side protection. Configure Supabase for the live event.
          </div>
        )}
        <main id="main" className="host-content" tabIndex={-1}>
          {!snap && !loadError && <Loading label="Loading quiz data…" />}
          {!snap && loadError && <ErrorState title="Could not load quiz data" error={loadError} onRetry={refresh} />}
          {snap && loadError && (
            <div className="inline-alert alert-warn" role="alert">
              Showing the last loaded data — refresh failed: {loadError.message} <button className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button>
            </div>
          )}
          {snap && <Outlet />}
        </main>
      </div>
    </div>
  );
}
