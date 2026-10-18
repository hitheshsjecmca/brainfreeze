// LOCAL DEMO MODE — data lives only in this browser (IndexedDB).
// No authentication, no cloud sync. Clearly labeled in the UI. Participant
// pages work only in other tabs/windows of the SAME browser.
//
// Every action runs inside ONE IndexedDB readwrite transaction (read → apply →
// write). The browser serializes such transactions across tabs, so the
// organizer tab and participant tabs can never overwrite each other's changes.
// (localStorage cannot guarantee that: tabs see each other's writes late.)
import { applyAction, backupData, createDemoState, normalizeState, resolveSetId, setResults, setSummaries, setView } from '../lib/engine.js';
import { QuizError, toQuizError } from '../lib/errors.js';
import { buildPublicSnapshot } from './publicView.js';
import { applyRound2, round2EligibleTeams, round2Lookup, round2Overview, round2SessionBoard, round2SetDetail } from '../lib/round2Engine.js';

const DB_NAME = 'brainfreze-cold-start-demo';
const STORE = 'kv';
const STATE_KEY = 'state';
const LEGACY_LS_KEY = 'brainfreze-cold-start:demo-state:v1'; // pre-IndexedDB demo data
const AUTH_KEY = 'brainfreze-cold-start:demo-auth';
const CHANNEL = 'brainfreze-cold-start:demo';
export const RECOVERY_NOTICE_KEY = 'brainfreze-cold-start:demo-recovered';

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new QuizError('STORAGE', 'This browser has no IndexedDB; demo mode cannot store data.')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new QuizError('STORAGE', `Cannot open browser storage (${req.error?.name || 'error'}).`));
      req.onblocked = () => reject(new QuizError('STORAGE', 'Browser storage is blocked by another tab. Close other BRAINFREZE tabs and retry.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

let legacyMigrated = false;

/** Initial state: migrate legacy localStorage data once, else fresh demo data. */
function initialState() {
  let raw = null;
  try { raw = localStorage.getItem(LEGACY_LS_KEY); } catch { raw = null; }
  if (raw) {
    try {
      const st = normalizeState(JSON.parse(raw));
      legacyMigrated = true; // removed from localStorage only after the IndexedDB write commits
      return st;
    } catch {
      // Never discard data silently: keep the unreadable copy and tell the organizer.
      const keep = `${LEGACY_LS_KEY}:unreadable-${Date.now()}`;
      try { localStorage.setItem(keep, raw); localStorage.removeItem(LEGACY_LS_KEY); localStorage.setItem(RECOVERY_NOTICE_KEY, keep); } catch { /* storage full */ }
    }
  }
  return createDemoState();
}

// Compare states ignoring the "last touched" timestamps.
const comparable = (st) => JSON.stringify({
  ...st,
  updated_at: null,
  sets: (st.sets || []).map((v) => ({ ...v, session: { ...v.session, updated_at: null } })),
});

/**
 * Atomically read → transform → write. `fn(state)` returns { state, result }.
 * Writes only when something actually changed (participant polling mostly changes nothing).
 */
async function transact(fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let out;
    let failure = null;
    let changed = false;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(STATE_KEY);
    get.onsuccess = () => {
      try {
        const stored = get.result;
        const before = stored ? normalizeState(stored) : initialState();
        const { state, result } = fn(before);
        out = result;
        changed = !stored || comparable(state) !== comparable(stored);
        if (changed) store.put(state, STATE_KEY);
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      if (legacyMigrated) { legacyMigrated = false; try { localStorage.removeItem(LEGACY_LS_KEY); } catch { /* ignore */ } }
      if (changed) notify();
      resolve(out);
    };
    tx.onabort = () => reject(failure ? toQuizError(failure) : new QuizError('STORAGE', `Could not save to browser storage (${tx.error?.name || 'aborted'}). Export a backup now.`));
    tx.onerror = () => { /* reported through onabort */ };
  });
}

const read = () => transact((st) => ({ state: st, result: st }));

const listeners = new Set();
let bc = null;
function notify(remote = false) {
  for (const l of listeners) l();
  if (!remote) bc?.postMessage('changed');
}
if (typeof window !== 'undefined') {
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => notify(true);
  } catch { bc = null; }
}

const apply = (action, payload, ctx = {}) => transact((st) => applyAction(st, action, payload, ctx));
const stripToken = ({ token_hash: _t, ...p }) => p;
// The organizer's target: { setId } (or { section } for the newest active set of a section).
const target = (t) => (typeof t === 'string' ? { setId: t } : t || {});

export const localBackend = {
  mode: 'demo',

  async getUser() {
    return sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY) ? { id: 'demo', email: 'Demo organizer (no authentication)' } : null;
  },
  async signIn() {
    localStorage.setItem(AUTH_KEY, '1');
    return { id: 'demo', email: 'Demo organizer (no authentication)' };
  },
  async signOut() {
    localStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(AUTH_KEY);
  },
  onAuthChange() { return () => {}; },
  async isOrganizer() { return true; },

  /** One quiz set's data for the organizer console (the newest UG set when setId is unknown). */
  async loadSnapshot(setId = null) {
    const s = await read();
    const id = resolveSetId(s, setId);
    const v = setView(s, id);
    const ids = new Set(v.teams.map((t) => t.id));
    return {
      setId: id,
      section: v.section,
      sets: setSummaries(s),
      teams: v.teams,
      allTeams: s.teams, // every team, both sections (Teams page and dashboard)
      questions: s.questions,
      session: v.session,
      settings: v.settings,
      set_questions: v.set_questions,
      attempts: v.attempts,
      answers: v.answers,
      events: v.events,
      tiebreaks: v.tiebreaks,
      results: setResults(s, id),
      credentials: Object.entries(s.credentials).filter(([tid]) => ids.has(tid)).map(([team_id, pin]) => ({ team_id, pin })),
      participant_sessions: s.participant_sessions.filter((p) => p.session_id === id).map(stripToken),
      serverOffsetMs: 0,
      loadedAt: Date.now(),
    };
  },

  async loadParticipants(setId) {
    const s = await read();
    return s.participant_sessions.filter((p) => p.session_id === setId).map(stripToken);
  },

  /** Projector data for one set: no answer keys, no per-answer rows. */
  async loadPublicSnapshot(setId = null) {
    const s = await read();
    const id = resolveSetId(s, setId);
    return { ...buildPublicSnapshot(setView(s, id), setResults(s, id)), serverOffsetMs: 0 };
  },

  /** Everything (every quiz set) for a JSON backup. */
  async loadBackupData() {
    return backupData(await read());
  },

  subscribe(onChange, onStatus) {
    listeners.add(onChange);
    onStatus?.('SUBSCRIBED');
    return () => listeners.delete(onChange);
  },

  async call(action, payload = {}, to = null) {
    return apply(action, payload, target(to));
  },

  /** No-op in demo: other tabs are notified through BroadcastChannel. */
  notifyParticipants() {},

  /** Reset to fresh demo data. */
  async resetDemo() {
    await transact(() => ({ state: createDemoState(), result: true }));
  },

  // Round 2 trivia sets and sessions (same shapes as the Supabase r2s_* functions).
  round2: {
    overview: async () => round2Overview(await read()),
    setDetail: async (id) => round2SetDetail(await read(), id),
    lookup: async (code) => round2Lookup(await read(), code),
    eligible: async (code, section) => round2EligibleTeams(await read(), code, section),
    board: async (sessionId, { host = false } = {}) => ({ ...round2SessionBoard(await read(), sessionId, { host, nowMs: Date.now() }), serverOffsetMs: 0 }),
    call: (action, payload = {}) => transact((st) => applyRound2(st, action, payload, { now: Date.now() })),
    subscribe(onChange, onStatus) {
      listeners.add(onChange);
      onStatus?.('SUBSCRIBED');
      return () => listeners.delete(onChange);
    },
  },

  // Registration desk (demo: no accounts, so the desk is always available here).
  registration: {
    access: async () => ({ staff: true, organizer: true }),
    overview: () => apply('regOverview', {}),
    saveTeam: (p) => apply('regSaveTeam', p, { role: 'registration' }),
  },

  // Participant API (same shapes as the Supabase participant functions).
  participant: {
    lookup: (code) => apply('joinLookup', { code }),
    roster: (p) => apply('joinRoster', p),
    joinRegistered: (p) => apply('joinRegisteredTeam', p),
    joinTeam: (p) => apply('joinTeam', p),
    registerTeam: (p) => apply('registerTeam', p),
    state: (token, position = null) => apply('participantState', { token, position }),
    start: (token) => apply('participantStart', { token }),
    submit: (p) => apply('participantSubmit', p),
    finish: (token) => apply('participantFinish', { token }),
    leave: (token) => apply('participantLeave', { token }),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  },
};
