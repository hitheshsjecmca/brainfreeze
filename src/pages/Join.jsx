import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, BadgeCheck, HardDrive, Loader2, LogIn } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { Field } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { isDemoMode, participantApi } from '../backend/index.js';
import { SECTION_LABELS } from '../lib/constants.js';
import { ERROR_MESSAGES, toQuizError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { formatJoinCode, isJoinCode, normalizeJoinCode } from '../lib/joinCodes.js';
import { joinDetailsErrors, normalizeJoinDetails } from '../lib/joinDetails.js';
import { lastDeviceSession, loadDeviceSession, resumeLastSession, saveDeviceSession } from '../participant/deviceSession.js';

const message = (res) => {
  if (res.error === 'SECTION_MISMATCH') return 'This code belongs to a different section. Go back and check the code.';
  return res.message && res.error === 'VALIDATION' ? res.message : ERROR_MESSAGES[res.error] || 'Something went wrong. Ask an organizer for help.';
};
const deviceLabel = () => (navigator.userAgent.match(/\(([^)]+)\)/)?.[1] || 'Browser').slice(0, 60);

/**
 * Participant join: (1) the six-digit code, checked by the server; (2) the set's UG/PG section, shown as verified
 * (it comes from the code and cannot be changed here); (3) full name and college; (4) join → waiting room / quiz.
 */
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
      setStep('details');
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
              {busy ? <><Loader2 size={18} className="spin" /> Checking…</> : <>Continue <ArrowRight size={18} /></>}
            </button>
            {last && (
              <button type="button" className="btn btn-ghost" onClick={() => { resumeLastSession(); navigate('/play'); }}>
                Continue as {last.team?.participant_1 || last.team?.team_name}
              </button>
            )}
          </form>
        ) : (
          <DetailsStep code={code} quiz={quiz} busy={busy} error={error} setError={setError} run={run} onJoined={joined}
            onBack={() => { setStep('code'); setQuiz(null); setError(''); }} />
        )}
      </main>
    </div>
  );
}

function DetailsStep({ code, quiz, busy, error, setError, run, onJoined, onBack }) {
  const [form, setForm] = useState({ full_name: '', college_name: '' });
  const [touched, setTouched] = useState(false);
  // One request id per join attempt: a retry after a lost answer (or a double tap) can never create a second entry.
  const [requestId, setRequestId] = useState(uuid);
  const errors = touched ? joinDetailsErrors(form) : {};
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setError(''); };

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(joinDetailsErrors(form)).length) return;
    const details = normalizeJoinDetails(form);
    run(async () => {
      const res = await participantApi.joinQuiz({ code, ...details, request_id: requestId, section: quiz.section, device_label: deviceLabel() });
      if (!res.ok) {
        setError(message(res));
        // Details changed after a refused request: the next press is a new request.
        if (res.error !== 'RATE_LIMITED') setRequestId(uuid());
        return;
      }
      onJoined(res);
    });
  };

  return (
    <form onSubmit={submit} className="stack" noValidate aria-labelledby="join-details-title">
      <div>
        <p className="muted small">Code {formatJoinCode(code)} <button type="button" className="btn btn-ghost btn-xs" onClick={onBack} disabled={busy}>Change</button></p>
        <h1 id="join-details-title">{quiz.title}</h1>
        <p className="inline-alert alert-ok small verified-section" role="status">
          <BadgeCheck size={16} aria-hidden="true" /> Verified section: <b>{quiz.section}</b> <span className="muted">({SECTION_LABELS[quiz.section] || quiz.section})</span>
        </p>
        {quiz.description && <p className="muted">{quiz.description}</p>}
        {!quiz.registration_open && <p className="inline-alert alert-warn small" role="note">Joining is closed — only participants who already joined can come back.</p>}
      </div>
      <Field label="Full name" error={errors.full_name}>
        <input value={form.full_name} onChange={set('full_name')} maxLength={80} autoComplete="name" autoFocus required aria-required="true" />
      </Field>
      <Field label="College name" error={errors.college_name}>
        <input value={form.college_name} onChange={set('college_name')} maxLength={120} autoComplete="organization" required aria-required="true" />
      </Field>
      {error && <p className="inline-alert alert-danger" role="alert"><AlertTriangle size={16} /> {error}</p>}
      <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? <><Loader2 size={18} className="spin" /> Joining…</> : <><LogIn size={18} /> Join quiz</>}</button>
      <p className="muted small">Enter your own details. You can join on one device at a time; if your device stops working, ask an organizer to release it.</p>
    </form>
  );
}
