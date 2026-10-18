import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { backend, isDemoMode } from '../backend/index.js';
import { toQuizError } from '../lib/errors.js';
import { useUI } from './UIContext.jsx';

const Round2Context = createContext(null);

/**
 * Round 2 (trivia sets, Join Round 2, sessions): one change signal for every Round 2 page
 * (Realtime nudges, a polling safety net, every action) and the action runner. Separate from Round 1's QuizContext.
 */
export function Round2Provider({ children, projector = false }) {
  const { toast } = useUI();
  const [tick, setTick] = useState(0);
  const [pendingKeys, setPendingKeys] = useState(() => new Set());
  const pendingRef = useRef(new Set());
  const bump = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    let t;
    // The projector listens to session rows only (never score rows) and polls faster, so several screens stay in step.
    const off = backend.round2.subscribe(() => { clearTimeout(t); t = setTimeout(bump, projector ? 80 : 100); }, null, { host: !projector });
    const poll = setInterval(bump, projector ? (isDemoMode ? 5000 : 4000) : (isDemoMode ? 15000 : 10000)); // safety net for missed realtime events
    const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); clearInterval(poll); clearTimeout(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [bump, projector]);

  const setPending = (key, on) => {
    if (on) pendingRef.current.add(key); else pendingRef.current.delete(key);
    setPendingKeys(new Set(pendingRef.current));
  };

  /** Run a Round 2 action. Returns { ok, result } or { ok: false, error }; never throws. A key already running is skipped (double clicks). */
  const act = useCallback(async (action, payload = {}, opts = {}) => {
    const key = opts.key ?? action;
    if (pendingRef.current.has(key)) return { ok: false, skipped: true };
    setPending(key, true);
    try {
      const result = await backend.round2.call(action, payload);
      if (opts.success) toast('success', opts.success, typeof opts.successDetail === 'function' ? opts.successDetail(result) : opts.successDetail);
      return { ok: true, result };
    } catch (e) {
      const error = toQuizError(e);
      if (!opts.quietCodes?.includes(error.code)) toast('error', opts.errorTitle || 'Action failed', error.message);
      return { ok: false, error };
    } finally {
      setPending(key, false);
      bump();
    }
  }, [bump, toast]);

  return <Round2Context.Provider value={{ tick, bump, act, pendingKeys }}>{children}</Round2Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useRound2 = () => useContext(Round2Context);

/**
 * Load Round 2 data with `loader` and reload it on every Round 2 change. `key` identifies what is
 * loaded (e.g. a session id): data of another key is never shown. Returns { data, error, reload }.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useR2Data(loader, key = '') {
  const { tick, bump } = useRound2();
  const [state, setState] = useState({ key: null, data: null, error: null });
  const loaderRef = useRef(loader);
  useEffect(() => { loaderRef.current = loader; });
  useEffect(() => {
    let alive = true;
    loaderRef.current().then(
      (data) => { if (alive) setState({ key, data, error: null }); },
      (e) => { if (alive) setState((s) => ({ key, data: s.key === key ? s.data : null, error: toQuizError(e) })); },
    );
    return () => { alive = false; };
  }, [tick, key]);
  const mine = state.key === key;
  return { data: mine ? state.data : null, error: mine ? state.error : null, reload: bump };
}
