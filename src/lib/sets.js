// Quiz-set display helpers shared by the organizer pages and exports.
import { formatPoints } from './scoring.js';
import { DURATION_ERROR, isValidDurationSeconds } from './validation.js';

// All timestamps are stored as PostgreSQL timestamptz (UTC) and shown in the
// event's timezone (VITE_EVENT_TIMEZONE, default Asia/Kolkata).
const configured = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_EVENT_TIMEZONE) || 'Asia/Kolkata';
export const EVENT_TIMEZONE = (() => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: configured }).format(0);
    return configured;
  } catch {
    return 'UTC';
  }
})();

const stampFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: EVENT_TIMEZONE, year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: EVENT_TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** "14 Oct 2026, 10:03:07" in the event timezone ('' for no value). */
export function formatStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : stampFmt.format(d);
}

/** "10:03:07" in the event timezone. */
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

/** Elapsed duration as "mm:ss.s" (or "h:mm:ss.s"); tenths keep close finishes distinguishable. */
export function formatElapsed(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '';
  const total = Math.max(0, Number(ms));
  const tenths = Math.floor((total % 1000) / 100);
  const s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}.${tenths}` : `${String(m).padStart(2, '0')}:${sec}.${tenths}`;
}

/** Seconds → minutes for display: 1800 → 30, 750 → 12.5 (up to two decimals, never rounded to a misleading whole minute). */
export const minutes = (seconds) => Math.round((Number(seconds || 0) / 60) * 100) / 100;

/** The ranking rules, shown before publishing and on the leaderboard/results (mirrors public._set_standings). */
export function rankingPolicy(settings) {
  return [
    `Highest total score ranks first (correct ${formatPoints(settings.marks_correct)}, incorrect ${formatPoints(settings.marks_incorrect)}, unanswered ${formatPoints(settings.marks_unanswered)}; questions a team never answered count as unanswered).`,
    'Equal scores: the shorter elapsed completion time ranks higher. Elapsed time = the server time of the team\'s final submission − the server time it pressed Start, excluding time the set was paused.',
    `Teams that time out, are finalized by an organizer, never start, or are scored on paper are counted at the full time limit (${minutes(settings.duration_seconds)} min) — leaving a quiz unfinished is never rewarded.`,
    'Equal score and equal time: the tie is flagged for organizer review. A higher organizer-entered tie-break result then decides — applied only when every team in that tie has a result. Otherwise the teams share the rank.',
    'Scores, submission times and ranks are never changed silently: every correction is recorded in the audit log.',
  ];
}

/** Problems that block publishing a set (mirrors public.publish_quiz). */
export function publishIssues({ questions, settings }) {
  const issues = [];
  const n = questions.length;
  if (n === 0) issues.push('Add at least one question.');
  const ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) issues.push('A question is selected more than once.');
  questions.forEach((q, i) => {
    if (!['A', 'B', 'C', 'D'].includes(q.correct_option)) issues.push(`Q${i + 1} has no valid answer key.`);
    const mc = q.marks_correct ?? settings.marks_correct;
    const mi = q.marks_incorrect ?? settings.marks_incorrect;
    if (!(mc >= 0) || !(mi <= 0)) issues.push(`Q${i + 1} has invalid marks (correct must be ≥ 0, incorrect ≤ 0).`);
  });
  if (!isValidDurationSeconds(Number(settings.duration_seconds))) issues.push(DURATION_ERROR);
  return issues;
}
