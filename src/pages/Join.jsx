import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, HardDrive, Loader2, LogIn, UserPlus } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { Field } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { isDemoMode, participantApi } from '../backend/index.js';
import { SECTIONS, SECTION_LABELS } from '../lib/constants.js';
import { ERROR_MESSAGES, toQuizError } from '../lib/errors.js';
import { formatJoinCode, isJoinCode, normalizeJoinCode } from '../lib/joinCodes.js';
import { lastDeviceSession, loadDeviceSession, resumeLastSession, saveDeviceSession } from '../participant/deviceSession.js';

const message = (res) => {
  if (res.error === 'SECTION_MISMATCH' && res.section) return `This quiz is for ${res.section} teams. Choose ${res.section}.`;
  return res.message && res.error === 'VALIDATION' ? res.message : ERROR_MESSAGES[res.error] || 'Something went wrong. Ask an organizer for help.';
};
const deviceLabel = () => (navigator.userAgent.match(/\(([^)]+)\)/)?.[1] || 'Browser').slice(0, 60);
/** "Team 12 · Frost Bytes (Asha & Ravi)" — the team number keeps equal names distinguishable. */
const rosterLabel = (t) => `Team ${t.team_number} · ${t.team_name} (${t.participant_1} & ${t.participant_2})`;

export default function Join() {
  const navigate = useNavigate();
  const [step, setStep] = useState('code');
  const [code, setCode] = useState('');
  const [quiz, setQuiz] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = lastDeviceSession();

  if (loadDeviceSession()) return <Navigate to="/play" replace />;

  async function run(fn) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      const err = toQuizError(e);
      setError(err.code === 'NETWORK' ? 'Cannot reach the quiz server. Check the connection and try again.' : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const submitCode = (e) => {
    e.preventDefault();
    const c = normalizeJoinCode(code);
    if (!isJoinCode(c)) { setError('Enter the six-digit code shown by the organizer.'); return; }
    run(async () => {
      const res = await participantApi.lookup(c);
      if (!res.ok) { setError(message(res)); return; }
      setCode(c);
      setQuiz(res.quiz);
      setStep('team');
    });
  };

  const joined = (res) => {
    saveDeviceSession({ token: res.token, team: res.team, quiz_title: res.quiz_title, section: res.section, code });
    navigate('/play', { replace: true });
  };

  return (
    <div className="join-page">
      <FrostBackdrop />
      <main className="join-card glass">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Home</Link>
        <BrandLockup size="lg" />
        {isDemoMode && (
          <div className="inline-alert alert-warn small" role="note"><HardDrive size={16} /> Demo mode: joining works only in other tabs of this same browser. Nothing is shared with other devices.</div>
        )}

        {step === 'code' ? (
          <form onSubmit={submitCode} className="stack" noValidate>
            <h1>Join Quiz</h1>
            <label className="field" htmlFor="join-code">
              <span>Six-digit join code</span>
              <input
                id="join-code" className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*"
                maxLength={7} placeholder="000 000" value={code} autoFocus
                onChange={(e) => { setError(''); const d = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d); }}
                aria-invalid={!!error} aria-describedby={error ? 'join-error' : undefined}
              />
            </label>
            {error && <p id="join-error" className="inline-alert alert-danger" role="alert"><AlertTriangle size={16} /> {error}</p>}
            <button className="btn btn-primary btn-lg" disabled={busy || normalizeJoinCode(code).length !== 6}>
              {busy ? <><Loader2 size={18} className="spin" /> Checking…</> : <>Join <ArrowRight size={18} /></>}
            </button>
            {last && (
              <button type="button" className="btn btn-ghost" onClick={() => { resumeLastSession(); navigate('/play'); }}>
                Continue as Team {last.team?.team_number} ({last.team?.team_name})
              </button>
            )}
          </form>
        ) : (
          <TeamStep code={code} quiz={quiz} busy={busy} error={error} setError={setError} run={run} onJoined={joined} onBack={() => { setStep('code'); setError(''); }} />
        )}
      </main>
    </div>
  );
}

function TeamStep({ code, quiz, busy, error, setError, run, onJoined, onBack }) {
  const [walkIn, setWalkIn] = useState(false);
  const [section, setSection] = useState(null);
  const [roster, setRoster] = useState(null); // registered teams of the chosen section (null = not loaded)
  const [teamNumber, setTeamNumber] = useState('');
  const [name, setName] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [college, setCollege] = useState('');

  const chooseSection = (sec) => {
    setSection(sec);
    setRoster(null);
    setTeamNumber('');
    run(async () => {
      const res = await participantApi.roster({ code, section: sec });
      if (!res.ok) { setError(message(res)); return; }
      setRoster(res.teams);
    });
  };
  const signIn = (e) => {
    e.preventDefault();
    if (!section) { setError('Choose your section (UG or PG).'); return; }
    if (!teamNumber) { setError('Choose your team from the list.'); return; }
    run(async () => {
      const res = await participantApi.joinRegistered({ code, section, team_number: Number(teamNumber), device_label: deviceLabel() });
      if (!res.ok) {
        setError(message(res));
        if (res.error === 'TEAM_ALREADY_JOINED') chooseSection(section); // refresh the "already joined" marks
        return;
      }
      onJoined(res);
    });
  };
  const register = (e) => {
    e.preventDefault();
    if (!name.trim() || !p1.trim() || !p2.trim() || !college.trim()) { setError('Team name, both participant names and the college name are required.'); return; }
    run(async () => {
      const res = await participantApi.registerTeam({ code, team_name: name, participant_1: p1, participant_2: p2, college_name: college, device_label: deviceLabel() });
      if (!res.ok) { setError(message(res)); return; }
      onJoined(res);
    });
  };

  return (
    <section className="stack" aria-labelledby="team-title">
      <div>
        <p className="muted small">Code {formatJoinCode(code)} <button className="btn btn-ghost btn-xs" onClick={onBack}>Change</button></p>
        <h1 id="team-title">{quiz.title}</h1>
        {quiz.description && <p className="muted">{quiz.description}</p>}
        {!quiz.registration_open && <p className="inline-alert alert-warn small" role="note">Registration is closed — only teams that already joined can come back.</p>}
      </div>
      {walkIn ? (
        <form onSubmit={register} className="stack" noValidate>
          <Field label="Team name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
          <Field label="Participant 1"><input value={p1} onChange={(e) => setP1(e.target.value)} maxLength={80} /></Field>
          <Field label="Participant 2"><input value={p2} onChange={(e) => setP2(e.target.value)} maxLength={80} /></Field>
          <Field label="College name"><input value={college} onChange={(e) => setCollege(e.target.value)} maxLength={120} /></Field>
          {error && <p className="inline-alert alert-danger" role="alert"><AlertTriangle size={16} /> {error}</p>}
          <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? <><Loader2 size={18} className="spin" /> Registering…</> : <><UserPlus size={18} /> Register team</>}</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setWalkIn(false); setError(''); }}>Back to registered teams</button>
        </form>
      ) : (
        <form onSubmit={signIn} className="stack" noValidate>
          <fieldset className="wz-fieldset">
            <legend>Your section</legend>
            <div className="segmented" role="radiogroup" aria-label="Section">
              {SECTIONS.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={section === s} className={section === s ? 'active' : ''}
                  onClick={() => chooseSection(s)} disabled={busy}>{SECTION_LABELS[s]}</button>
              ))}
            </div>
          </fieldset>
          {section && roster && (
            roster.length ? (
              <Field label="Your registered team" hint="Choose your own team. Each team can join on one device only.">
                <select value={teamNumber} onChange={(e) => { setTeamNumber(e.target.value); setError(''); }} autoFocus>
                  <option value="">Choose your team…</option>
                  {roster.map((t) => (
                    <option key={t.team_number} value={t.team_number} disabled={t.joined}>{rosterLabel(t)}{t.joined ? ' — already joined' : ''}</option>
                  ))}
                </select>
              </Field>
            ) : <p className="inline-alert alert-warn small" role="status">No {section} teams can join this quiz right now. Ask an organizer.</p>
          )}
          {section && !roster && busy && <p className="muted small" role="status"><Loader2 size={14} className="spin" /> Loading registered teams…</p>}
          {error && <p className="inline-alert alert-danger" role="alert"><AlertTriangle size={16} /> {error}</p>}
          <button className="btn btn-primary btn-lg" disabled={busy || !section || !teamNumber}>{busy ? <><Loader2 size={18} className="spin" /> Joining…</> : <><LogIn size={18} /> Join quiz</>}</button>
          {quiz.self_registration && (
            <button type="button" className="btn btn-ghost" onClick={() => { setWalkIn(true); setError(''); }}>Team not listed? Register a new team</button>
          )}
        </form>
      )}
    </section>
  );
}
