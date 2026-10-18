import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { backend, isDemoMode } from '../backend/index.js';
import { toQuizError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { computeQualification } from '../lib/scoring.js';
import { sessionQuestions } from '../lib/engine.js';
import { RECOVERY_NOTICE_KEY } from '../backend/localBackend.js';
import { useUI } from './UIContext.jsx';

const QuizContext = createContext(null);
const OUTBOX_KEY = 'brainfreze-cold-start:outbox:v1';
// The quiz set this tab manages. Per tab (sessionStorage), so one tab can host one set and another tab a different one.
const SET_KEY = 'brainfreze-cold-start:set';

function readSetId() {
  try { return sessionStorage.getItem(SET_KEY) || null; } catch { return null; }
}
function storeSetId(id) {
  try { if (id) sessionStorage.setItem(SET_KEY, id); } catch { /* per-tab preference only */ }
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeOutbox(items) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); } catch { /* surfaced via UI count */ }
}

export function QuizProvider({ children }) {
  const { toast } = useUI();
  const [setId, setSetIdState] = useState(readSetId);
  const setIdRef = useRef(setId);
  const [snap, setSnap] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [rtStatus, setRtStatus] = useState('CONNECTING');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [lastSync, setLastSync] = useState(null);
  const [pendingKeys, setPendingKeys] = useState(() => new Set());
  const [outbox, setOutbox] = useState(readOutbox);
  const pendingRef = useRef(new Set());
  const loadingRef = useRef(false);
  const againRef = useRef(false);
  const timerRef = useRef(null);
  const flushingRef = useRef(false);
  const undoReqRef = useRef(null);

  // Lightweight device-status refresh for the participant monitor.
  const refreshParticipants = useCallback(async () => {
    try {
      const id = setIdRef.current;
      if (!id) return;
      const rows = await backend.loadParticipants(id);
      setSnap((s) => (s && s.setId === id ? { ...s, participant_sessions: rows } : s));
    } catch { /* the main refresh surfaces connection problems */ }
  }, []);

  const refresh = useCallback(async () => {
    if (loadingRef.current) { againRef.current = true; return; }
    loadingRef.current = true;
    try {
      const id = setIdRef.current;
      const s = await backend.loadSnapshot(id);
      if (id !== setIdRef.current) { againRef.current = true; return; } // set switched meanwhile
      if (s.setId !== id) {
        // The remembered set no longer exists (or none was chosen): follow the one the backend picked.
        setIdRef.current = s.setId;
        storeSetId(s.setId);
        setSetIdState(s.setId);
      }
      setSnap(s);
      setLoadError(null);
      setLastSync(Date.now());
    } catch (e) {
      setLoadError(toQuizError(e));
    } finally {
      loadingRef.current = false;
      if (againRef.current) { againRef.current = false; refresh(); }
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refresh, 120);
  }, [refresh]);

  const updateOutbox = useCallback((fn) => {
    setOutbox((prev) => { const next = fn(prev); writeOutbox(next); return next; });
  }, []);

  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      for (const item of readOutbox()) {
        if (item.failed) continue;
        try {
          await backend.call('recordAnswer', item.payload, item.setId ? { setId: item.setId } : { section: item.section || 'UG' });
          updateOutbox((list) => list.filter((x) => x.payload.request_id !== item.payload.request_id));
          toast('success', 'Queued answer synced', item.label);
        } catch (e) {
          const err = toQuizError(e);
          if (err.code === 'NETWORK') break;
          updateOutbox((list) => list.map((x) => (x.payload.request_id === item.payload.request_id ? { ...x, failed: err.message } : x)));
          toast('error', 'Queued answer was rejected', `${item.label}: ${err.message}`);
        }
      }
    } finally {
      flushingRef.current = false;
      scheduleRefresh();
    }
  }, [scheduleRefresh, toast, updateOutbox]);

  useEffect(() => {
    refresh();
    backend.notifyParticipants(); // prepares the participant nudge channel
    try {
      const kept = localStorage.getItem(RECOVERY_NOTICE_KEY);
      if (kept) {
        localStorage.removeItem(RECOVERY_NOTICE_KEY);
        toast('warn', 'Demo data was unreadable', `It was kept in browser storage under "${kept}" and a fresh demo was loaded.`, 0);
      }
    } catch { /* storage unavailable */ }
    const off = backend.subscribe(scheduleRefresh, setRtStatus);
    const goOnline = () => { setOnline(true); refresh(); flushOutbox(); };
    const goOffline = () => setOnline(false);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', onVisible);
    // Safety net for missed realtime events and outbox retries.
    const poll = setInterval(() => {
      if (!isDemoMode) refresh();
      if (readOutbox().some((x) => !x.failed)) flushOutbox();
    }, isDemoMode ? 15000 : 20000);
    return () => {
      off();
      clearInterval(poll);
      clearTimeout(timerRef.current);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, scheduleRefresh, flushOutbox, toast]);

  const setPending = (key, on) => {
    if (on) pendingRef.current.add(key); else pendingRef.current.delete(key);
    setPendingKeys(new Set(pendingRef.current));
  };

  /** Run a backend action. Returns { ok, result } or { ok: false, error }. Never throws. */
  const act = useCallback(async (action, payload = {}, opts = {}) => {
    const key = opts.key ?? action;
    if (pendingRef.current.has(key)) return { ok: false, skipped: true };
    setPending(key, true);
    try {
      // opts.target ({ section }) acts on a section's newest set instead of the selected one (e.g. team import into the other section).
      const result = await backend.call(action, payload, opts.target || { setId: setIdRef.current });
      if (opts.success) toast('success', opts.success, typeof opts.successDetail === 'function' ? opts.successDetail(result) : opts.successDetail);
      backend.notifyParticipants();
      await refresh();
      return { ok: true, result };
    } catch (e) {
      const error = toQuizError(e);
      if (!opts.quietCodes?.includes(error.code)) toast('error', opts.errorTitle || 'Action failed', error.message);
      if (error.code === 'NETWORK') scheduleRefresh();
      return { ok: false, error };
    } finally {
      setPending(key, false);
    }
  }, [refresh, scheduleRefresh, toast]);

  /** Record (or correct) an answer. Network failures go to a persistent outbox and retry with the same request id. */
  const recordAnswer = useCallback(async (payload, label) => {
    const full = { ...payload, request_id: uuid() };
    const id = setIdRef.current;
    const key = `record:${payload.team_id}:${payload.question_id}`;
    if (pendingRef.current.has(key)) return { ok: false, skipped: true };
    setPending(key, true);
    try {
      const result = await backend.call('recordAnswer', full, { setId: id });
      await refresh();
      return { ok: true, result };
    } catch (e) {
      const error = toQuizError(e);
      if (error.code === 'NETWORK' && !isDemoMode) {
        updateOutbox((list) => [...list, { payload: full, setId: id, label, queued_at: new Date().toISOString() }]);
        toast('warn', 'Connection problem — answer queued', `${label} is saved on this device and will retry automatically. Do not re-enter it.`, 12000);
        return { ok: false, queued: true, error };
      }
      return { ok: false, error };
    } finally {
      setPending(key, false);
    }
  }, [refresh, toast, updateOutbox]);

  /** Undo the most recent score action. A retried undo after a network error reuses its request id, so it can never undo twice. */
  const undoLast = useCallback(async () => {
    if (!undoReqRef.current) undoReqRef.current = uuid();
    const res = await act('undoLast', { request_id: undoReqRef.current }, { key: 'undo', success: 'Last score action undone' });
    if (res.ok || res.error?.code !== 'NETWORK') undoReqRef.current = null;
    return res;
  }, [act]);

  const discardOutboxItem = useCallback((requestId) => {
    updateOutbox((list) => list.filter((x) => x.payload.request_id !== requestId));
  }, [updateOutbox]);

  /** Switch the quiz set this tab manages. */
  const selectSet = useCallback((next) => {
    if (!next || next === setIdRef.current) return;
    setIdRef.current = next;
    storeSetId(next);
    setSetIdState(next);
    setSnap(null);
    undoReqRef.current = null;
    refresh();
  }, [refresh]);

  /** Everything (every quiz set) for a JSON backup. */
  const loadBackupData = useCallback(() => backend.loadBackupData(), []);

  const quizQuestions = useMemo(() => (snap ? sessionQuestions(snap) : []), [snap]);
  // Ranked by the server (Supabase: get_set_results; demo: the engine's mirror of it).
  const standings = useMemo(() => snap?.results || [], [snap]);
  const qualification = useMemo(() => (snap ? computeQualification(standings, snap.settings.qualify_count) : null), [snap, standings]);

  const connection = !online ? 'offline'
    : isDemoMode ? 'local'
    : loadError?.code === 'NETWORK' ? 'offline'
    : rtStatus === 'SUBSCRIBED' ? 'live'
    : ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(rtStatus) ? 'degraded' : 'connecting';

  const value = {
    setId: snap?.setId ?? setId, section: snap?.section ?? 'UG', sets: snap?.sets || [], selectSet, loadBackupData,
    snap, quizQuestions, loadError, refresh, refreshParticipants, act, recordAnswer, undoLast, pendingKeys,
    outbox, flushOutbox, discardOutboxItem,
    standings, qualification, connection, lastSync, isDemo: isDemoMode, mode: backend.mode,
  };
  return <QuizContext.Provider value={value}>{children}</QuizContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useQuiz = () => useContext(QuizContext);
