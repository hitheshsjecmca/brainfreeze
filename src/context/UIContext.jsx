import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

const UIContext = createContext(null);
let toastSeq = 0;

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((type, title, message, ms) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-2), { id, type, title, message }]);
    const life = ms ?? (type === 'error' ? 9000 : 4000);
    if (life > 0) setTimeout(() => dismiss(id), life);
    return id;
  }, [dismiss]);

  /**
   * confirm({ title, message, confirmLabel, danger, requireReason, reasonLabel, typeToConfirm })
   * resolves to false, or { reason } when confirmed.
   */
  const confirm = useCallback((opts) => new Promise((resolve) => setDialog({ ...opts, resolve })), []);

  const value = useMemo(() => ({ toast, confirm, dismiss }), [toast, confirm, dismiss]);

  return (
    <UIContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            {t.type === 'success' ? <CheckCircle2 size={18} /> : t.type === 'error' ? <XCircle size={18} /> : t.type === 'warn' ? <AlertTriangle size={18} /> : <Info size={18} />}
            <div>
              <strong>{t.title}</strong>
              {t.message && <p>{t.message}</p>}
            </div>
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss notification"><X size={16} /></button>
          </div>
        ))}
      </div>
      {dialog && <ConfirmDialog {...dialog} onClose={(v) => { dialog.resolve(v); setDialog(null); }} />}
    </UIContext.Provider>
  );
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, requireReason, reasonLabel = 'Reason (recorded in the audit log)', typeToConfirm, children, onClose }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const ok = (!requireReason || reason.trim()) && (!typeToConfirm || typed.trim() === typeToConfirm);

  useEffect(() => {
    const el = ref.current?.querySelector('input, textarea, button.btn-primary, button.btn-danger');
    el?.focus();
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal glass" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" ref={ref}>
        <h2 id="confirm-title" className={danger ? 'text-danger' : ''}>{danger && <AlertTriangle size={20} />} {title}</h2>
        {message && <div className="modal-message">{message}</div>}
        {children}
        <form onSubmit={(e) => { e.preventDefault(); if (ok) onClose({ reason: reason.trim() }); }}>
          {requireReason && (
            <label className="field">
              <span>{reasonLabel}</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
            </label>
          )}
          {typeToConfirm && (
            <label className="field">
              <span>Type <code>{typeToConfirm}</code> to confirm</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onClose(false)}>Cancel</button>
            <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={!ok}>{confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useUI = () => useContext(UIContext);
