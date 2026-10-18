import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CloudOff, HardDrive, Loader2, Radio, Wifi, WifiOff, X } from 'lucide-react';
import { STATUS_LABELS } from '../lib/constants.js';

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="state-box" role="status">
      <Loader2 className="spin" size={28} />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, onRetry }) {
  return (
    <div className="state-box state-error" role="alert">
      <AlertTriangle size={28} />
      <h3>{title}</h3>
      {error && <p>{error.message || String(error)}</p>}
      {onRetry && <button className="btn btn-primary" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="state-box">
      {Icon && <Icon size={28} />}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function ModeBadge({ isDemo }) {
  return isDemo ? (
    <span className="badge badge-amber" title="Local demo mode: data is stored only in this browser. No authentication or cloud sync.">
      <HardDrive size={14} /> DEMO MODE · LOCAL ONLY
    </span>
  ) : (
    <span className="badge badge-ice" title="Connected to Supabase"><Radio size={14} /> CLOUD</span>
  );
}

const CONN = {
  live: { cls: 'badge-ok', icon: Wifi, label: 'Live sync' },
  local: { cls: 'badge-muted', icon: HardDrive, label: 'Saved locally' },
  connecting: { cls: 'badge-muted', icon: Loader2, label: 'Connecting…' },
  degraded: { cls: 'badge-amber', icon: CloudOff, label: 'Realtime lost · polling' },
  offline: { cls: 'badge-danger', icon: WifiOff, label: 'OFFLINE' },
};
export function ConnectionBadge({ connection }) {
  const c = CONN[connection] || CONN.connecting;
  const Icon = c.icon;
  return (
    <span className={`badge ${c.cls}`} role="status" aria-live="polite">
      <Icon size={14} className={connection === 'connecting' ? 'spin' : ''} /> {c.label}
    </span>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

export function Modal({ title, onClose, children, wide = false, labelledBy = 'modal-title' }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input, select, textarea, button:not(.icon-btn)')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  // Portaled to <body>: a glass panel's backdrop-filter would otherwise trap the fixed backdrop inside it.
  return createPortal(
    <div className="modal-backdrop">
      <div className={`modal glass ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <div className="modal-head">
          <h2 id={labelledBy}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, error, hint, children, className = '' }) {
  return (
    <label className={`field ${error ? 'field-error' : ''} ${className}`}>
      <span>{label}</span>
      {children}
      {hint && !error && <small className="hint">{hint}</small>}
      {error && <small className="error-text" role="alert">{error}</small>}
    </label>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
