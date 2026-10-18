import { OPTIONS, RESULT } from './constants.js';
import { fail } from './errors.js';

const NO_TB = -1e12; // finite sentinel: (-Infinity) - (-Infinity) would be NaN

export const round2 =(n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function formatPoints(n) {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
}

export function signedPoints(n) {
  const v = round2(n);
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${formatPoints(Math.abs(v))}`;
}

/** Returns 'A'–'D' or null (unanswered). Throws INVALID_OPTION otherwise. */
export function normalizeOption(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  if (s === '' || s === 'U' || s === '-' || s === 'UNANSWERED' || s === 'NONE') return null;
  if (OPTIONS.includes(s)) return s;
  return fail('INVALID_OPTION');
}

export function marksFor(question, settings) {
  return {
    correct: question?.marks_correct ?? settings.marks_correct,
    incorrect: question?.marks_incorrect ?? settings.marks_incorrect,
    unanswered: settings.marks_unanswered,
  };
}

/** Compare a recorded option with the private answer key. */
export function evaluateAnswer(selected, correctOption, marks) {
  if (selected === null) return { result: RESULT.UNANSWERED, points: round2(marks.unanswered) };
  if (!OPTIONS.includes(correctOption)) fail('NO_ANSWER_KEY');
  return selected === correctOption
    ? { result: RESULT.CORRECT, points: round2(marks.correct) }
    : { result: RESULT.INCORRECT, points: round2(marks.incorrect) };
}

/**
 * A team's elapsed completion time for ranking (mirrors public._set_standings):
 * submitted attempts use final submission − start − paused time (capped at the
 * limit); timed-out, organizer-finalized, unstarted and paper-only teams use
 * the full time limit, so leaving a quiz unfinished is never rewarded.
 * An in-progress attempt past its deadline counts as timed out.
 */
export function attemptTiming(attempt, settings, nowMs = Date.now()) {
  const limit = Number(settings?.duration_seconds || 1800) * 1000;
  if (!attempt) return { elapsed_ms: limit, attempt_status: null, started_at: null, finished_at: null };
  let status = attempt.status;
  let finished = attempt.finished_at;
  if (status === 'in_progress' && Date.parse(attempt.deadline_at) <= nowMs) { status = 'timed_out'; finished = attempt.deadline_at; }
  const elapsed = status === 'submitted'
    ? Math.min(limit, Math.max(0, Date.parse(finished) - Date.parse(attempt.started_at) - Number(attempt.paused_ms || 0)))
    : limit;
  return { elapsed_ms: elapsed, attempt_status: status, started_at: attempt.started_at, finished_at: finished };
}

/**
 * Ranking policy (mirrored exactly by public._set_standings in SQL):
 *   1. Higher total points.
 *   2. Shorter elapsed completion time (see attemptTiming).
 *   3. Higher tie-break result — applied only when EVERY team in the tied
 *      group has a tie-break result, so a team is never ranked below others
 *      just because its result was not entered.
 *   4. Otherwise teams share the same (competition-style) rank and the tie is
 *      flagged for organizer review (tie_review).
 * Team number only orders the display of tied teams; it never decides rank.
 * Questions never recorded for a team count as unanswered.
 * `attempts` are the set's attempts (reset ones are ignored); `nowMs` is the set clock.
 */
export function computeStandings({ teams, questions, answers, tiebreaks = [], settings, attempts = [], nowMs = Date.now() }) {
  const totalQuestions = questions.length;
  const attemptByTeam = new Map(attempts.filter((a) => a.status !== 'reset').map((a) => [a.team_id, a]));
  const tbByTeam = new Map(tiebreaks.map((t) => [t.team_id, t]));
  const agg = new Map(teams.map((t) => [t.id, { recorded: 0, points: 0, correct: 0, incorrect: 0 }]));
  for (const a of answers) {
    const s = agg.get(a.team_id);
    if (!s) continue;
    s.recorded += 1;
    s.points += Number(a.points);
    if (a.result === RESULT.CORRECT) s.correct += 1;
    else if (a.result === RESULT.INCORRECT) s.incorrect += 1;
  }

  const rows = teams.map((t) => {
    const s = agg.get(t.id);
    const unrecorded = Math.max(0, totalQuestions - s.recorded);
    const points = round2(s.points + unrecorded * Number(settings.marks_unanswered || 0));
    const tb = tbByTeam.get(t.id);
    return {
      team_id: t.id,
      team_number: t.team_number,
      team_name: t.team_name,
      is_demo: !!t.is_demo,
      points,
      correct: s.correct,
      incorrect: s.incorrect,
      unanswered: Math.max(0, totalQuestions - s.correct - s.incorrect),
      recorded: s.recorded,
      tiebreak: tb ? Number(tb.score) : null,
      tiebreak_note: tb?.note || '',
      ...attemptTiming(attemptByTeam.get(t.id), settings, nowMs),
    };
  });

  // Decide per score-group whether the tie-break result applies.
  const groupKey = (r) => `${r.points}|${r.elapsed_ms}`;
  const groups = new Map();
  for (const r of rows) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    const applies = g.length > 1 && g.every((r) => r.tiebreak !== null);
    for (const r of g) {
      r.tiedGroupSize = g.length;
      r.effTb = applies ? r.tiebreak : null;
    }
  }

  const cmp = (a, b) =>
    b.points - a.points ||
    a.elapsed_ms - b.elapsed_ms ||
    (b.effTb ?? NO_TB) - (a.effTb ?? NO_TB);

  rows.sort((a, b) => cmp(a, b) || a.team_number - b.team_number);
  rows.forEach((r, i) => {
    r.rank = i > 0 && cmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1;
  });
  for (const r of rows) {
    r.tied = rows.filter((o) => o.rank === r.rank).length > 1;
    r.tie_review = r.tied;
    delete r.effTb;
  }
  return rows;
}

/**
 * Determine qualifiers from ranked standings.
 * Never silently eliminates a team tied at the cut-off: such a tie is
 * reported as `unresolved` with the tied teams listed.
 */
export function computeQualification(standings, qualifyCount) {
  const target = Math.min(qualifyCount, standings.length);
  if (target === 0) {
    return { target: 0, certain: [], tied: [], slots: 0, unresolved: false, proposed: [], boundaryRank: null };
  }
  const boundaryRank = standings[target - 1].rank;
  const certain = standings.filter((r) => r.rank < boundaryRank);
  const tiedGroup = standings.filter((r) => r.rank === boundaryRank);
  const slots = target - certain.length;
  const unresolved = tiedGroup.length > slots;
  return {
    target,
    boundaryRank,
    certain: certain.map((r) => r.team_id),
    tied: unresolved ? tiedGroup.map((r) => r.team_id) : [],
    slots,
    unresolved,
    proposed: unresolved ? certain.map((r) => r.team_id) : [...certain, ...tiedGroup].map((r) => r.team_id),
  };
}

/** Server-side style validation of a confirm-qualifiers request. */
export function validateQualifierSelection(standings, qualifyCount, teamIds, overrideReason) {
  const q = computeQualification(standings, qualifyCount);
  const ids = [...new Set(teamIds)];
  if (ids.length !== q.target || ids.length !== teamIds.length) fail('QUALIFIER_COUNT', `Select exactly ${q.target} distinct teams.`);
  const set = new Set(ids);
  if (!q.unresolved) {
    if (!q.proposed.every((id) => set.has(id))) fail('QUALIFIERS_MISMATCH');
    return { ...q, override: false };
  }
  if (!overrideReason || !overrideReason.trim()) fail('TIE_UNRESOLVED');
  const allowed = new Set([...q.certain, ...q.tied]);
  if (!q.certain.every((id) => set.has(id)) || !ids.every((id) => allowed.has(id))) fail('QUALIFIERS_MISMATCH');
  return { ...q, override: true };
}
