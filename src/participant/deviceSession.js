// The participant's device session (token) lives in sessionStorage (per tab, survives
// refresh). A copy in localStorage offers "Continue as Team N" after the browser
// was closed. The token is only a capability for THIS team in THIS quiz session;
// the server validates it on every call.
const TAB_KEY = 'brainfreze-cold-start:participant';
const LAST_KEY = 'brainfreze-cold-start:participant-last';
const PENDING_KEY = 'brainfreze-cold-start:participant-pending';
const POSITION_KEY = 'brainfreze-cold-start:participant-position';

const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const write = (store, key, v) => { try { if (v === null) store.removeItem(key); else store.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } };

export const loadDeviceSession = () => read(sessionStorage, TAB_KEY);
export const lastDeviceSession = () => read(localStorage, LAST_KEY);
export function saveDeviceSession(s) {
  write(sessionStorage, TAB_KEY, s);
  write(localStorage, LAST_KEY, s);
}
export function resumeLastSession() {
  const s = lastDeviceSession();
  if (s) write(sessionStorage, TAB_KEY, s);
  return s;
}
export function clearDeviceSession() {
  write(sessionStorage, TAB_KEY, null);
  write(localStorage, LAST_KEY, null);
  write(sessionStorage, PENDING_KEY, null);
  write(sessionStorage, POSITION_KEY, null);
}

/** Self-paced: the question position this tab was looking at (survives refresh). */
export const loadPosition = (token) => {
  const p = read(sessionStorage, POSITION_KEY);
  return p && p.token === token && Number.isInteger(p.position) ? p.position : null;
};
export const savePosition = (token, position) => write(sessionStorage, POSITION_KEY, position === null ? null : { token, position });

/**
 * Answers waiting for server confirmation, keyed by question id: { [question_id]: { request_id, option } }.
 * Each is retried with the SAME request id, so a retry can never count twice. (An older single
 * pending submission { request_id, question_id, option } is read as a one-entry map.)
 */
export function loadPending(token) {
  const v = read(sessionStorage, PENDING_KEY);
  if (!v || typeof v !== 'object') return {};
  if (v.question_id) return { [v.question_id]: { request_id: v.request_id, option: v.option } };
  return v.token === token && v.answers && typeof v.answers === 'object' ? v.answers : {};
}
export const savePending = (token, answers) => write(sessionStorage, PENDING_KEY, Object.keys(answers || {}).length ? { token, answers } : null);
