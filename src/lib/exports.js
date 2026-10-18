import { toCSV } from './csv.js';
import { ATTEMPT_STATUS_LABELS, EVENT_LABELS, OPTIONS } from './constants.js';
import { EVENT_TIMEZONE, formatElapsed, formatStamp } from './sets.js';

// Organizer-only CSV exports. Timestamps are written twice: ISO 8601 UTC (exact,
// machine-readable) and in the event timezone (for people).

/** Set context columns repeated on every row so files stay self-describing. */
const setCols = (set) => [set?.name ?? '', set?.section ?? '', set?.join_code ?? '', set?.id ?? ''];
const SET_HEAD = ['set_name', 'section', 'join_code', 'set_id'];

export function standingsCSV(standings, { qualifiers = null, provisional = true, qualification = null, set = null, teams = [], settings = null } = {}) {
  const q = new Set(qualifiers || []);
  const tied = new Set(qualification?.tied || []);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const limit = settings ? settings.duration_seconds * 1000 : null;
  return toCSV(
    [...SET_HEAD, 'rank', 'team_number', 'team_name', 'participant_1', 'participant_2', 'college', 'total_score', 'correct', 'incorrect', 'unanswered',
      'attempt_status', 'started_at_utc', 'finished_at_utc', 'elapsed_ms', 'elapsed', 'time_limit', 'tie_review', 'tiebreak_result', 'status'],
    standings.map((r) => {
      const t = byId.get(r.team_id);
      return [
        ...setCols(set), r.rank, r.team_number, r.team_name, t?.participant_1 ?? '', t?.participant_2 ?? '', t?.college_name ?? '',
        r.points, r.correct, r.incorrect, r.unanswered,
        ATTEMPT_STATUS_LABELS[r.attempt_status || 'none'] || r.attempt_status || '', r.started_at ?? '', r.finished_at ?? '',
        r.elapsed_ms ?? '', formatElapsed(r.elapsed_ms), limit ? formatElapsed(limit) : '',
        r.tie_review || r.tied ? 'yes' : 'no', r.tiebreak ?? '',
        qualifiers ? (q.has(r.team_id) ? 'QUALIFIED' : 'eliminated') : tied.has(r.team_id) ? 'TIE AT CUT-OFF (unresolved)' : provisional ? 'provisional' : '',
      ];
    }),
  );
}

/** Team registrations (no PINs — PIN slips are a separate, private export). */
export function registrationsCSV(teams) {
  return toCSV(
    ['section', 'team_number', 'team_name', 'participant_1', 'participant_2', 'college', 'self_registered', 'registered_at_utc'],
    teams.map((t) => [t.section, t.team_number, t.team_name, t.participant_1, t.participant_2, t.college_name ?? '', t.self_registered ? 'yes' : 'no', t.created_at ?? '']),
  );
}

/** Start, final submission and elapsed time per team (server times). */
export function completionCSV(results, { set = null, settings }) {
  const limit = settings.duration_seconds * 1000;
  return toCSV(
    [...SET_HEAD, 'team_number', 'team_name', 'attempt_status', 'started_at_utc', `started_at_${EVENT_TIMEZONE}`, 'finished_at_utc',
      `finished_at_${EVENT_TIMEZONE}`, 'elapsed_ms', 'elapsed', 'time_limit_ms', 'time_limit', 'rank', 'tie_review'],
    [...results].sort((a, b) => a.team_number - b.team_number).map((r) => [
      ...setCols(set), r.team_number, r.team_name, ATTEMPT_STATUS_LABELS[r.attempt_status || 'none'] || r.attempt_status,
      r.started_at ?? '', formatStamp(r.started_at), r.finished_at ?? '', formatStamp(r.finished_at),
      r.elapsed_ms, formatElapsed(r.elapsed_ms), limit, formatElapsed(limit), r.rank, r.tie_review ? 'yes' : 'no',
    ]),
  );
}

/**
 * Every accepted answer with its server timestamp, deadline check and request id.
 * `questions` are the set's questions (keys included — organizer export only).
 */
export function submissionAuditCSV({ set = null, teams, questions, answers, attempts = [], events = [] }) {
  const t = new Map(teams.map((x) => [x.id, x]));
  const qIndex = new Map(questions.map((x, i) => [x.id, i + 1]));
  const att = new Map(attempts.map((a) => [a.id, a]));
  const reqOf = new Map(events.filter((e) => e.action === 'record').map((e) => [`${e.team_id}|${e.question_id}`, e.request_id]));
  const rows = answers
    .map((a) => ({ a, team: t.get(a.team_id), n: qIndex.get(a.question_id) }))
    .filter((x) => x.team && x.n)
    .sort((x, y) => x.team.team_number - y.team.team_number || Date.parse(x.a.created_at) - Date.parse(y.a.created_at));
  return toCSV(
    [...SET_HEAD, 'attempt_id', 'team_number', 'team_name', 'set_question_no', 'team_question_no', 'question_id', 'displayed_option', 'selected_option',
      'result', 'points', 'source', 'submitted_at_utc', `submitted_at_${EVENT_TIMEZONE}`, 'on_time', 'request_id', 'updated_at_utc'],
    rows.map(({ a, team, n }) => {
      const order = att.get(a.attempt_id)?.question_order;
      const teamNo = order ? order.indexOf(a.question_id) + 1 : '';
      return [
        ...setCols(set), a.attempt_id ?? '', team.team_number, team.team_name, n, teamNo || '', a.question_id,
        OPTIONS.includes(a.displayed_option) ? a.displayed_option : '', a.selected_option ?? 'UNANSWERED', a.result, a.points, a.source ?? '',
        a.created_at ?? '', formatStamp(a.created_at), a.on_time === null || a.on_time === undefined ? '' : a.on_time ? 'yes' : 'no',
        reqOf.get(`${a.team_id}|${a.question_id}`) ?? '', a.updated_at ?? '',
      ];
    }),
  );
}

export function answersCSV({ teams, questions, answers }) {
  const t = new Map(teams.map((x) => [x.id, x]));
  const qm = new Map(questions.map((x, i) => [x.id, { ...x, n: i + 1 }]));
  const rows = answers
    .map((a) => ({ a, team: t.get(a.team_id), q: qm.get(a.question_id) }))
    .filter((x) => x.team && x.q)
    .sort((x, y) => x.team.team_number - y.team.team_number || x.q.n - y.q.n);
  return toCSV(
    ['team_number', 'team_name', 'question_no', 'selected_option', 'result', 'points', 'recorded_at', 'updated_at'],
    rows.map(({ a, team, q }) => [team.team_number, team.team_name, q.n, a.selected_option ?? 'UNANSWERED', a.result, a.points, a.created_at, a.updated_at]),
  );
}

export function auditCSV(events) {
  return toCSV(
    ['id', 'time', 'action', 'team_number', 'question_no', 'prev_option', 'prev_result', 'prev_points', 'new_option', 'new_result', 'new_points', 'undone', 'undo_of', 'reason', 'request_id'],
    events.map((e) => [
      e.id, e.created_at, EVENT_LABELS[e.action] || e.action, e.team_number ?? '', e.question_position ?? '',
      e.prev_selected ?? '', e.prev_result ?? '', e.prev_points ?? '', e.new_selected ?? '', e.new_result ?? '', e.new_points ?? '',
      e.undone ? 'yes' : '', e.undo_of ?? '', e.reason ?? '', e.request_id ?? '',
    ]),
  );
}

/** Round 3 auction summary (organizer only): one row per team, final rank first. */
export function round3CSV(results) {
  const byTeam = new Map(results.summary.map((x) => [x.team_id, x]));
  const s = results.session;
  return toCSV(
    ['auction', 'section', 'status', 'rank', 'tied', 'team_number', 'team_name', 'final_score', 'final_budget', 'answered_correctly', 'answered_wrong', 'passes_or_timeouts', 'points_awarded', 'budget_deducted'],
    results.ranking.map((r) => {
      const x = byTeam.get(r.team_id) || {};
      return [s.title, s.section, s.status, r.rank, r.tied ? 'yes' : 'no', r.team_number, r.team_name, r.score, r.budget, x.correct ?? 0, x.wrong ?? 0, x.passes ?? 0, x.points_awarded ?? 0, x.budget_deducted ?? 0];
    }),
  );
}
