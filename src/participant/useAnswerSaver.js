import { useCallback, useEffect, useRef, useState } from 'react';
import { participantApi } from '../backend/index.js';
import { ERROR_MESSAGES, toQuizError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { loadPending, savePending } from './deviceSession.js';

// Rejections after which retrying can never succeed: the choice is dropped and the reason shown.
const FINAL = {
  TIME_EXPIRED: 'Time is up — this answer reached the server after your deadline and was not saved.',
  ATTEMPT_FINISHED: 'Your quiz is already submitted. Answers can no longer change.',
  ALREADY_SUBMITTED: 'This answer was recorded by an organizer and cannot be changed here.',
};

/**
 * Autosave for the team's answers. `choose(questionId, letter)` saves at once; the server keeps
 * the LAST choice until the quiz is submitted or the deadline passes. Unconfirmed choices survive
 * a refresh (sessionStorage) and are retried with the same request id after network errors.
 */
export function useAnswerSaver(token, onSaved) {
  const [pending, setPending] = useState(() => loadPending(token)); // { [qid]: { request_id, option } }
  const [saved, setSaved] = useState({}); // { [qid]: letter } confirmed since the last server read
  const [message, setMessage] = useState('');
  const pendingRef = useRef(pending);
  const running = useRef(false);
  const retryTimer = useRef(null);
  const failures = useRef(0);
  const savedCb = useRef(onSaved);
  useEffect(() => { savedCb.current = onSaved; }, [onSaved]);

  const update = useCallback((fn) => {
    pendingRef.current = fn(pendingRef.current);
    savePending(token, pendingRef.current);
    setPending(pendingRef.current);
  }, [token]);

  const flush = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    clearTimeout(retryTimer.current);
    try {
      for (;;) {
        const [qid, item] = Object.entries(pendingRef.current)[0] || [];
        if (!qid) break;
        let res;
        try {
          res = await participantApi.submit({ token, request_id: item.request_id, question_id: qid, option: item.option });
        } catch (e) {
          // Network problem: keep the choice and retry later with the SAME request id.
          failures.current++;
          if (toQuizError(e).code !== 'NETWORK' && failures.current > 4) setMessage('An answer could not be saved. Check the connection.');
          retryTimer.current = setTimeout(() => flush(), Math.min(8000, 1000 * 2 ** Math.min(failures.current, 3)));
          return;
        }
        failures.current = 0;
        const current = pendingRef.current[qid];
        if (res.ok) {
          setSaved((m) => ({ ...m, [qid]: res.selected }));
          setMessage('');
        } else {
          setMessage(FINAL[res.error] || ERROR_MESSAGES[res.error] || 'The answer was not saved.');
          if (res.selected) setSaved((m) => ({ ...m, [qid]: res.selected }));
        }
        // A newer choice made while this one was in flight stays queued and is sent next.
        if (current?.request_id === item.request_id) update((p) => { const n = { ...p }; delete n[qid]; return n; });
      }
      savedCb.current?.();
    } finally {
      running.current = false;
    }
  }, [token, update]);

  // Resume unconfirmed answers after a refresh or reconnect.
  useEffect(() => {
    if (Object.keys(pendingRef.current).length) flush();
    const onOnline = () => flush();
    window.addEventListener('online', onOnline);
    return () => { window.removeEventListener('online', onOnline); clearTimeout(retryTimer.current); };
  }, [flush]);

  const choose = useCallback((questionId, option) => {
    setMessage('');
    update((p) => ({ ...p, [questionId]: { request_id: uuid(), option } }));
    flush();
  }, [update, flush]);

  /** Wait (up to `ms`) until every choice is confirmed. Resolves true when nothing is left unsaved. */
  const settle = useCallback(async (ms = 8000) => {
    const end = Date.now() + ms;
    flush();
    while (Object.keys(pendingRef.current).length && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    return Object.keys(pendingRef.current).length === 0;
  }, [flush]);

  return { pending, saved, message, choose, settle, saving: Object.keys(pending).length > 0 };
}
