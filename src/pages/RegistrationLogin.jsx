import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, HardDrive, LogIn } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { Field } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { isDemoMode } from '../backend/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { toQuizError } from '../lib/errors.js';

// Registration staff sign in here. Separate from the organizer login: a staff
// account opens only the registration desk, never the quiz console.
export default function RegistrationLogin() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!auth.loading && auth.user && auth.registrar) return <Navigate to="/registration" replace />;

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await auth.signIn(email.trim(), password);
      navigate('/registration', { replace: true });
    } catch (err) {
      setError(toQuizError(err).message);
    } finally {
      setBusy(false);
    }
  }

  const notStaff = auth.user && !auth.loading && !auth.registrar;

  return (
    <div className="login-page">
      <FrostBackdrop />
      <div className="login-card glass">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <BrandLockup size="lg" />
        <h1>Registration desk</h1>
        <p className="muted small">For registration staff: register UG and PG teams before their quiz starts. Quiz control stays with the organizers.</p>

        {isDemoMode ? (
          <>
            <div className="inline-alert alert-warn" role="note">
              <HardDrive size={18} />
              <div><strong>Local demo mode.</strong> No authentication and no cloud sync — data stays in this browser only.</div>
            </div>
            <button className="btn btn-primary btn-lg w-full" disabled={busy} onClick={submit}><LogIn size={18} /> Enter demo registration desk</button>
          </>
        ) : (
          <form onSubmit={submit} className="stack">
            <Field label="Staff email">
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {(error || notStaff) && (
              <div className="inline-alert alert-danger" role="alert"><AlertTriangle size={18} /> {error || 'This account is not authorized for the registration desk.'}</div>
            )}
            {notStaff && <button type="button" className="btn btn-ghost" onClick={auth.signOut}>Sign out of {auth.user.email}</button>}
            <button className="btn btn-primary btn-lg" disabled={busy}><LogIn size={18} /> {busy ? 'Signing in…' : 'Sign in'}</button>
            <p className="muted small">Only accounts added to <code>registration_staff</code> (or organizers) can open the desk. Organizers use the <Link to="/login">organizer login</Link>.</p>
          </form>
        )}
      </div>
    </div>
  );
}
