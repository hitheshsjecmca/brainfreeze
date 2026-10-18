import { AlertTriangle } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';

/** Shown instead of the app when the build is misconfigured (never falls back to an open demo). */
export default function ConfigError({ problem }) {
  return (
    <div className="login-page">
      <FrostBackdrop snow={false} />
      <main className="login-card glass" role="alert">
        <BrandLockup size="lg" />
        <h1><AlertTriangle size={22} /> Configuration required</h1>
        <p>{problem}</p>
        <p className="muted small">Organizers: see README → “Vercel deployment” for the required environment variables. No quiz data is available until this is fixed.</p>
      </main>
    </div>
  );
}
