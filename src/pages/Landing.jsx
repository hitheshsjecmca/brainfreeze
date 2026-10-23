import { Link } from 'react-router-dom';
import { GraduationCap, Lock, LogIn, Monitor, UserRound, Users, UsersRound } from 'lucide-react';
import { BrandMark } from '../components/Brand.jsx';
import { ModeBadge } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { isDemoMode } from '../backend/index.js';

const FACTS = [
  { icon: Users, title: 'UG & PG', text: 'Teams participate in Undergraduate (UG) and Postgraduate (PG) sections.' },
  { icon: UsersRound, title: 'Join With a Code', text: 'Enter the six-digit code, your name and your college — no pre-registration.' },
  { icon: Monitor, title: 'Official Devices', text: 'One organizer-provided device per team — or answers on paper.' },
];

const COORDINATION = [
  { icon: GraduationCap, title: 'Faculty Coordinator', people: [], empty: 'Not Assigned', tone: 'faculty' },
  { icon: Users, title: 'Event Heads', people: ['Hithesh Y. Salian', 'Meghashree'], tone: 'ice' },
  { icon: Users, title: 'Co-Heads', people: ['Bhavith A. Shetty', 'Sharon Carmine'], tone: 'purple' },
];

export default function Landing() {
  return (
    <div className="landing">
      <FrostBackdrop />
      <IceMountains />
      <header className="landing-top">
        <span className="event-chip">JOSHIANA 15.0 • WINTER ARC</span>
        <ModeBadge isDemo={isDemoMode} />
      </header>

      <main className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <BrandMark size={128} className="landing-mark" />
          <h1 id="landing-title" className="brand-word landing-title">BRAIN<span>FREZE</span></h1>
          <p className="tagline">THINK. <span>DECODE.</span> COMPETE.</p>
          <nav className="landing-cta" aria-label="Get started">
            <Link to="/join" className="btn btn-primary btn-lg"><LogIn size={18} /> Join Quiz</Link>
            <Link to="/login" className="btn btn-ghost btn-lg landing-btn-dark"><Lock size={18} /> Organizer Login</Link>
          </nav>
        </section>

        <section className="fact-grid" aria-label="Event format">
          {FACTS.map(({ icon: Icon, title, text }) => (
            <article key={title} className="fact-card glass">
              <span className="fact-icon"><Icon size={26} aria-hidden="true" /></span>
              <h2>{title}</h2>
              <p>{text}</p>
            </article>
          ))}
        </section>

        <section className="organizers" aria-labelledby="org-title">
          <div className="org-divider" aria-hidden="true"><span /><BrandMark size={34} /><span /></div>
          <p className="org-kicker">ORGANIZED BY</p>
          <h2 id="org-title" className="org-name">THE TECHNOCRATS</h2>
          <p className="org-dept">Department of Computer Applications (MCA)</p>
          <p className="org-college">St Joseph Engineering College, Mangaluru</p>

          <h3 className="coord-title">EVENT COORDINATION</h3>
          <div className="coord-grid">
            {COORDINATION.map(({ icon: Icon, title, people, empty, tone }) => (
              <article key={title} className={`coord-card coord-${tone} glass`}>
                <span className="coord-icon"><Icon size={24} aria-hidden="true" /></span>
                <h4>{title}</h4>
                {people.length ? (
                  <ul>
                    {people.map((name) => (
                      <li key={name}><span className="coord-avatar" aria-hidden="true"><UserRound size={16} /></span>{name}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="coord-empty"><span className="coord-avatar" aria-hidden="true"><UserRound size={16} /></span>{empty}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-foot muted small">BRAINFREZE · JOSHIANA 15.0</footer>
    </div>
  );
}

/** Decorative icy mountain ranges on both sides of the homepage (inline SVG, no image assets). */
function IceMountains() {
  const range = (
    <svg viewBox="0 0 600 320" preserveAspectRatio="xMidYMax slice" focusable="false">
      <path d="M0 320 L0 150 L70 90 L120 130 L190 40 L260 120 L320 85 L400 170 L470 140 L600 250 L600 320 Z" fill="url(#mtn-far)" opacity=".75" />
      <path d="M190 40 L172 64 L184 60 L196 74 L206 58 L218 66 Z M70 90 L58 101 L70 98 L80 106 Z M320 85 L306 98 L318 96 L330 104 Z" fill="#cdefff" opacity=".55" />
      <path d="M0 320 L0 210 L60 170 L130 220 L200 150 L280 230 L360 200 L450 260 L520 240 L600 290 L600 320 Z" fill="url(#mtn-near)" />
      <path d="M200 150 L184 168 L198 164 L210 176 L222 163 Z M60 170 L48 180 L60 178 L70 184 Z" fill="#bfe9ff" opacity=".45" />
      <path d="M190 40 L260 120 L320 85 M200 150 L280 230" stroke="#7fe7ff" strokeWidth="1.2" fill="none" opacity=".35" />
    </svg>
  );
  return (
    <div className="ice-mountains" aria-hidden="true">
      <svg width="0" height="0" className="ice-mountains-defs" focusable="false">
        <defs>
          <linearGradient id="mtn-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1e3a5f" />
            <stop offset="1" stopColor="#06101f" />
          </linearGradient>
          <linearGradient id="mtn-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#12294a" />
            <stop offset="1" stopColor="#030914" />
          </linearGradient>
        </defs>
      </svg>
      <div className="ice-mountains-left">{range}</div>
      <div className="ice-mountains-right">{range}</div>
    </div>
  );
}
