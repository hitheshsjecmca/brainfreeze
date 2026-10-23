import { useMemo } from 'react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useServerNow } from './hooks.js';

const CONNECTED_MS = 20_000;

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/**
 * Per-team device status; derived from participant_sessions + team_answers.
 * Organizer-paced: whether each team answered the current question.
 * Self-paced: how many of the quiz's questions each team has answered.
 */
export function useParticipantStatus() {
  const { snap, quizQuestions } = useQuiz();
  const now = useServerNow(snap.serverOffsetMs, 1000);
  const selfPaced = snap.session.self_paced !== false;
  const current = snap.session.status === 'setup' || selfPaced ? null : quizQuestions[snap.session.current_index];
  return useMemo(() => {
    const sessions = snap.participant_sessions || [];
    const answers = current ? new Map(snap.answers.filter((a) => a.question_id === current.id).map((a) => [a.team_id, a])) : new Map();
    const inQuiz = new Set(quizQuestions.map((q) => q.id));
    const counts = new Map();
    const attempts = new Map((snap.attempts || []).filter((a) => a.status !== 'reset').map((a) => [a.team_id, a]));
    // Teams in this set's results; the others take part in another set of the section.
    const result = new Set((snap.results || []).map((r) => r.team_id));
    for (const a of snap.answers) if (inQuiz.has(a.question_id)) counts.set(a.team_id, (counts.get(a.team_id) || 0) + 1);
    // A participant who joined ANOTHER set with its code belongs only to that set.
    const rows = snap.teams.filter((t) => !t.join_session_id || t.join_session_id === snap.session.id).map((t) => {
      const mine = sessions.filter((p) => p.team_id === t.id);
      const active = mine.find((p) => !p.revoked_at);
      const seenMs = active ? now - Date.parse(active.last_seen_at) : null;
      const device = active ? (seenMs < CONNECTED_MS ? 'connected' : 'stale') : mine.length ? 'signed-out' : 'not-joined';
      const attempt = attempts.get(t.id) || null;
      // An in-progress attempt past its deadline is timed out (the server finalizes it on its next read).
      const frozenNow = snap.session.status === 'paused' && snap.session.paused_at ? Math.min(Date.parse(snap.session.paused_at), now) : now;
      const expired = attempt?.status === 'in_progress' && Date.parse(attempt.deadline_at) <= frozenNow;
      return {
        team: t, active, lastRevoked: mine.filter((p) => p.revoked_at).at(-1), device, seenMs,
        answer: answers.get(t.id) || null, answered: counts.get(t.id) || 0,
        attempt, attemptStatus: expired ? 'timed_out' : attempt?.status || 'none',
        remainingMs: attempt?.status === 'in_progress' && !expired ? Date.parse(attempt.deadline_at) - frozenNow : null,
        otherSet: !result.has(t.id),
      };
    });
    return {
      rows,
      current,
      selfPaced,
      total: quizQuestions.length,
      joined: rows.filter((r) => r.active).length,
      connected: rows.filter((r) => r.device === 'connected').length,
      submitted: rows.filter((r) => r.answer).length,
      finished: rows.filter((r) => ['submitted', 'timed_out', 'organizer_finalized'].includes(r.attemptStatus)).length,
      started: rows.filter((r) => r.attemptStatus === 'in_progress').length,
    };
  }, [snap, now, current, quizQuestions, selfPaced]);
}
