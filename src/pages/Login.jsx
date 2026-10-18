import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, HardDrive, LogIn } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { Field } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { configProblem, isDemoMode } from '../backend/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { toQuizError } from '../lib/errors.js';

export default function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dest = location.state?.from || '/host';

  if (!auth.loading && auth.user && auth.organizer) return <Navigate to={dest} replace />;

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await auth.signIn(email.trim(), password);
      navigate(dest, { replace: true });
    } catch (err) {
      setError(toQuizError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <FrostBackdrop />
      <div className="login-card glass">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <BrandLockup size="lg" />
        <h1>Organizer access</h1>

        {configProblem && (
          <div className="inline-alert alert-danger" role="alert"><AlertTriangle size={18} /> {configProblem}</div>
        )}

        {isDemoMode ? (
          <>
            <div className="inline-alert alert-warn" role="note">
              <HardDrive size={18} />
              <div>
                <strong>Local demo mode.</strong> Supabase is not configured, so there is <em>no authentication</em>, no cloud sync and no server-side protection.
                Data is saved only in this browser. Use it for rehearsal; configure Supabase for the live event.
              </div>
            </div>
            <button className="btn btn-primary btn-lg w-full" disabled={busy} onClick={submit}>
              <LogIn size={18} /> Enter demo console
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="stack">
            <Field label="Organizer email">
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {(error || auth.error) && <div className="inline-alert alert-danger" role="alert"><AlertTriangle size={18} /> {error || auth.error}</div>}
            {auth.user && !auth.organizer && (
              <button type="button" className="btn btn-ghost" onClick={auth.signOut}>Sign out of {auth.user.email}</button>
            )}
            <button className="btn btn-primary btn-lg" disabled={busy}><LogIn size={18} /> {busy ? 'Signing in…' : 'Sign in'}</button>
            <p className="muted small">Only accounts added to the <code>organizers</code> table can open the console.</p>
          </form>
        )}
      </div>
    </div>
  );
}
