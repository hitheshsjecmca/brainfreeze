// Demo-mode mirror of quiz sets, attempts, per-team timers and ranking
// (src/lib/engine.js ↔ supabase/migrations/20261016000100_quiz_sets_attempts.sql),
// plus the registration desk and UG/PG team rules.
import { describe, expect, it } from 'vitest';
import {
  applyAction, backupData, createDemoState, createEmptyState, normalizeState, sessionQuestions, setResults, setStage, setSummaries, setView,
} from '../src/lib/engine.js';
import { buildPublicSnapshot } from '../src/backend/publicView.js';
import { buildBackup, validateBackup } from '../src/lib/backup.js';
import { OPTIONS } from '../src/lib/constants.js';
import { completionCSV, registrationsCSV, standingsCSV, submissionAuditCSV } from '../src/lib/exports.js';
import { parseCSV } from '../src/lib/csv.js';
import { selectTeams } from './helpers/engine.js';

const T0 = Date.parse('2026-10-16T09:00:00Z');
let r = 0;
const req = () => `dddddddd-0000-4000-8000-${String(++r).padStart(12, '0')}`;
/** ctx: a set id string, or { section } for the newest set of a section. */
const call = (s, name, p = {}, to = 'UG', now = T0, extra = {}) => applyAction(s, name, p, { now, ...(typeof to === 'string' && to.length > 2 ? { setId: to } : { section: to }), ...extra });
const run = (...a) => call(...a).state;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const team = (n, extra = {}) => ({ team_number: n, team_name: `Team ${n}${extra.section || ''}`, participant_1: 'A', participant_2: 'B', college_name: 'MCA College', ...extra });
const find = (s, sec, n) => s.teams.find((t) => t.section === sec && t.team_number === n);
const LEAK = /correct_option|explanation|"result"|"points"|SECRET/;
const iso = (ms) => new Date(ms).toISOString();

function bank(s, n = 64) {
  const items = Array.from({ length: n }, (_, i) => ({ question_text: `Q${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'ABCD'[i % 4], explanation: `SECRET-${i}` }));
  return run(s, 'importQuestions', { items });
}
/** Create a draft set with `count` bank questions starting at `from`; returns [state, setId]. */
function draft(s, name, section, count = 30, from = 0, settings = null) {
  const c = call(s, 'createSet', { name, section });
  let st = c.state;
  const id = c.result.id;
  st = run(st, 'updateQuizDetails', { question_ids: st.questions.slice(from, from + count).map((q) => q.id) }, id);
  if (settings) st = run(st, 'updateSettings', settings, id);
  return [st, id];
}
function publish(s, id, numbers = null) {
  const c = call(s, 'publishQuiz', {}, id);
  // The organiser selects the set's participants (every free team of the section unless numbers are given).
  return [selectTeams(c.state, id, numbers, T0, { free: true }), c.result.join_code];
}
function world() {
  let s = bank(createEmptyState(T0));
  s = run(s, 'importTeams', { rows: [1, 2, 3, 4].map((n) => team(n)) }, 'UG');
  s = run(s, 'importTeams', { rows: [1, 2].map((n) => team(n)) }, 'PG');
  return s;
}
const pin = (s, sec, n) => s.credentials[find(s, sec, n).id];
const join = (s, c, sec, n, now = T0) => call(s, 'joinTeam', { code: c, team_number: n, pin: pin(s, sec, n) }, 'UG', now);
const attempt = (s, setId, teamId) => s.attempts.find((a) => a.session_id === setId && a.team_id === teamId && a.status !== 'reset');
const shownFor = (s, setId, teamId, qid, original) => {
  const a = attempt(s, setId, teamId);
  return OPTIONS[a.option_orders[a.question_order.indexOf(qid)].indexOf(original)];
};
const keyOf = (s, setId, qid) => sessionQuestions(setView(s, setId)).find((q) => q.id === qid).correct_option;

/** UG set (10-minute limit) live with teams 1–3 joined and started at T0. */
function liveSet() {
  let s = world();
  let id;
  [s, id] = draft(s, 'UG Final', 'UG', 40, 5, { duration_seconds: 600 });
  let c;
  [s, c] = publish(s, id);
  const tok = {};
  for (const n of [1, 2, 3]) { const j = join(s, c, 'UG', n); s = j.state; tok[n] = j.result.token; }
  s = run(s, 'startQuiz', {}, id);
  for (const n of [1, 2, 3]) s = call(s, 'participantStart', { token: tok[n] }).state;
  return { s, id, code: c, tok, tid: (n) => find(s, 'UG', n).id };
}

describe('quiz sets: lifecycle and validation', () => {
  it('starts with one draft per section; any number of UG and PG sets may be added', () => {
    let s = world();
    expect(setSummaries(s).map((x) => [x.section, x.stage])).toEqual([['UG', 'draft'], ['PG', 'draft']]);
    let a; let b; let p;
    [s, a] = draft(s, 'UG A', 'UG');
    [s, b] = draft(s, 'UG B', 'UG', 30, 30);
    [s, p] = draft(s, 'PG A', 'PG');
    expect(setSummaries(s).filter((x) => x.section === 'UG')).toHaveLength(3);
    expect(new Set([a, b, p]).size).toBe(3);
    expect(code(() => run(s, 'createSet', { name: '', section: 'UG' }))).toBe('VALIDATION');
    expect(code(() => run(s, 'createSet', { name: 'X', section: 'MBA' }))).toBe('VALIDATION');
  });

  it('publishes with any number of questions (1, 29, 64); refuses none and duplicates', () => {
    let s = world();
    let id;
    [s, id] = draft(s, 'One', 'UG', 1);
    expect(publish(s, id)[1]).toMatch(/^\d{6}$/);
    [s, id] = draft(s, 'Small', 'UG', 29);
    expect(publish(s, id)[1]).toMatch(/^\d{6}$/);
    [s, id] = draft(s, 'Whole bank', 'UG', 64);
    expect(sessionQuestions(setView(s, id))).toHaveLength(64);
    expect(publish(s, id)[1]).toMatch(/^\d{6}$/);
    expect(code(() => run(s, 'updateQuizDetails', { question_ids: [] }, id))).toBe('VALIDATION');
    const q = s.questions[0].id;
    expect(code(() => run(s, 'updateQuizDetails', { question_ids: [q, q, ...s.questions.slice(1, 30).map((x) => x.id)] }, id))).toBe('VALIDATION');
  });

  it('any positive time limit; publishing freezes questions, keys, timer and scoring', () => {
    let s = world();
    let id;
    [s, id] = draft(s, 'Frozen', 'UG', 30, 0, { duration_seconds: 900, marks_incorrect: -0.5 });
    expect(code(() => run(s, 'updateSettings', { duration_seconds: 0 }, id))).toBe('VALIDATION');
    expect(code(() => run(s, 'updateSettings', { duration_seconds: -60 }, id))).toBe('VALIDATION');
    expect(code(() => run(s, 'updateSettings', { duration_seconds: 'abc' }, id))).toBe('VALIDATION');
    s = run(s, 'updateSettings', { duration_seconds: 30 }, id); // half a minute
    s = run(s, 'updateSettings', { duration_seconds: 18_000 }, id); // 5 hours
    expect(setView(s, id).settings.duration_seconds).toBe(18_000);
    s = run(s, 'updateSettings', { duration_seconds: 900 }, id);
    [s] = publish(s, id);
    expect(setStage(setView(s, id).session)).toBe('published');
    expect(code(() => run(s, 'updateSettings', { duration_seconds: 1200 }, id))).toBe('SET_FROZEN');
    expect(code(() => run(s, 'updateQuizDetails', { question_ids: s.questions.slice(1, 31).map((q) => q.id) }, id))).toBe('SET_FROZEN');
    expect(code(() => run(s, 'updateQuizDetails', { section: 'PG' }, id))).toBe('SET_FROZEN');
    // the bank may change, but the set keeps its frozen copy
    const q0 = s.questions[0];
    s = run(s, 'saveQuestion', { ...q0, question_text: 'Edited', correct_option: 'D' });
    const frozen = sessionQuestions(setView(s, id)).find((q) => q.id === q0.id);
    expect(frozen).toMatchObject({ question_text: 'Q1?', correct_option: 'A', marks_incorrect: -0.5 });
    expect(code(() => run(s, 'deleteQuestion', { id: q0.id }))).toBe('QUESTION_IN_PUBLISHED_SET');
    expect(code(() => run(s, 'startQuiz', {}, draft(s, 'D', 'UG')[1]))).toBe('NO_SESSION'); // unknown in this state
  });

  it('only drafts can be deleted; archiving retires the code; stages are reported', () => {
    let s = world();
    let id;
    [s, id] = draft(s, 'Tmp', 'UG');
    s = run(s, 'deleteSet', { id });
    expect(setView(s, id)).toBeNull();
    let c;
    [s, id] = draft(s, 'Arc', 'UG');
    [s, c] = publish(s, id);
    expect(code(() => run(s, 'deleteSet', { id }))).toBe('INVALID_STATE');
    s = run(s, 'archiveSet', { id, reason: 'rehearsal' });
    expect(setStage(setView(s, id).session)).toBe('archived');
    expect(call(s, 'joinLookup', { code: c }).result.error).toBe('INVALID_CODE');
    expect(s.retired_codes).toContain(c);
  });
});

describe('join codes, sections and attempts', () => {
  it('each published set has its own unique code; a code opens exactly its set; wrong section is refused', () => {
    let s = world();
    let a; let b; let p;
    [s, a] = draft(s, 'UG Morning', 'UG', 30, 0, { duration_seconds: 600 });
    [s, b] = draft(s, 'UG Afternoon', 'UG', 30, 30, { duration_seconds: 600 });
    [s, p] = draft(s, 'PG Morning', 'PG');
    let ca; let cb; let cp;
    [s, ca] = publish(s, a);
    [s, cb] = publish(s, b);
    [s, cp] = publish(s, p);
    expect(new Set([ca, cb, cp]).size).toBe(3);
    expect(call(s, 'joinLookup', { code: cb }).result.quiz).toMatchObject({ title: 'UG Afternoon', section: 'UG', duration_seconds: 600, total_questions: 30 });
    // a PG team cannot use a UG code (its number/PIN is not in the UG section)
    expect(call(s, 'joinTeam', { code: ca, team_number: 2, pin: pin(s, 'PG', 2) }).result).toEqual({ ok: false, error: 'INVALID_TEAM_OR_PIN' });
    expect(call(s, 'joinTeam', { code: cp, team_number: 2, pin: pin(s, 'PG', 2) }).result).toMatchObject({ ok: true, section: 'PG' });
    // drafts never open
    const d = draft(s, 'Draft', 'UG')[1];
    expect(setView(draft(s, 'Draft', 'UG')[0], d)).toBeNull();
  });

  it('one set per team per section; revoked codes stop working and are never reused', () => {
    let s = world();
    let a; let b; let ca; let cb;
    [s, a] = draft(s, 'A', 'UG');
    [s, b] = draft(s, 'B', 'UG', 30, 30);
    [s, ca] = publish(s, a, [1, 3]);
    [s, cb] = publish(s, b, [2, 4]);
    s = join(s, ca, 'UG', 1).state;
    expect(code(() => run(s, 'setSetTeams', { set_id: b, team_ids: [find(s, 'UG', 1).id] }))).toBe('TEAM_IN_OTHER_SET'); // one set per team
    expect(join(s, cb, 'UG', 1).result).toEqual({ ok: false, error: 'TEAM_NOT_SELECTED' });
    expect(code(() => run(s, 'recordAnswer', { request_id: req(), team_id: find(s, 'UG', 1).id, question_id: s.questions[30].id, selected: 'A' }, b))).not.toBe('NO_ERROR');
    // the team is not in set B's results
    expect(setResults(s, b, T0).map((x) => x.team_number)).not.toContain(1);
    s = run(s, 'revokeJoinCode', {}, a);
    expect(call(s, 'joinLookup', { code: ca }).result.error).toBe('INVALID_CODE');
    const g = call(s, 'regenerateJoinCode', {}, a);
    expect(g.result.join_code).not.toBe(ca);
    expect(g.state.retired_codes).toContain(ca);
  });

  it('a reconnecting team resumes its single attempt; no team can read another attempt', () => {
    const { s, tok, id, tid } = liveSet();
    expect(s.attempts.filter((a) => a.session_id === id)).toHaveLength(3);
    const st = call(s, 'participantState', { token: tok[1] }).result;
    expect(st.team.team_number).toBe(1);
    expect(JSON.stringify(st)).not.toMatch(LEAK);
    expect(st).not.toHaveProperty('attempts');
    // a forged token is not a session
    expect(call(s, 'participantState', { token: 'f'.repeat(64) }).result.error).toBe('SESSION_INVALID');
    expect(attempt(s, id, tid(1)).id).not.toBe(attempt(s, id, tid(2)).id);
  });
});

describe('per-team shuffling and scoring', () => {
  it('every team gets the same questions in its own stable order with its own option order', () => {
    const { s, tok, id, tid } = liveSet();
    const order = (t) => Array.from({ length: 40 }, (_, p) => call(s, 'participantState', { token: t, position: p }).result.question.id);
    const a = order(tok[1]);
    const b = order(tok[2]);
    expect([...a].sort()).toEqual(sessionQuestions(setView(s, id)).map((q) => q.id).sort());
    expect([...b].sort()).toEqual([...a].sort());
    expect(a).not.toEqual(b);
    expect(order(tok[1])).toEqual(a); // refresh → same order, nothing reshuffled
    expect(a).toEqual(attempt(s, id, tid(1)).question_order);
    const perms = attempt(s, id, tid(1)).option_orders;
    expect(perms.every((p) => [...p].sort().join('') === 'ABCD')).toBe(true);
    expect(new Set(perms).size).toBeGreaterThan(1);
    // the options shown are a permutation of the original ones
    const st = call(s, 'participantState', { token: tok[1], position: 0 }).result.question;
    const q = sessionQuestions(setView(s, id)).find((x) => x.id === st.id);
    expect([st.option_a, st.option_b, st.option_c, st.option_d].sort()).toEqual([q.option_a, q.option_b, q.option_c, q.option_d].sort());
  });

  it('scores the displayed letter through the persisted mapping against the original key', () => {
    let { s, tok, id, tid } = liveSet();
    const [q1, q2] = attempt(s, id, tid(1)).question_order;
    const right = shownFor(s, id, tid(1), q1, keyOf(s, id, q1));
    const wrongOrig = OPTIONS.find((l) => l !== keyOf(s, id, q2));
    const wrong = shownFor(s, id, tid(1), q2, wrongOrig);
    s = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q1, option: right }, 'UG', T0 + 1000).state;
    s = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q2, option: wrong }, 'UG', T0 + 2000).state;
    const rows = s.answers.filter((a) => a.team_id === tid(1));
    expect(rows.map((a) => [a.displayed_option, a.selected_option, a.result])).toEqual([[right, keyOf(s, id, q1), 'correct'], [wrong, wrongOrig, 'incorrect']]);
    expect(setResults(s, id, T0 + 3000).find((x) => x.team_id === tid(1))).toMatchObject({ points: 0.75, correct: 1, incorrect: 1, unanswered: 38 });
  });
});

describe('server timer, submission and ranking', () => {
  it('the deadline survives refreshes; early submission records the server time', () => {
    let { s, tok, id, tid } = liveSet();
    const d1 = call(s, 'participantState', { token: tok[1] }, 'UG', T0 + 60_000).result.attempt;
    const d2 = call(s, 'participantState', { token: tok[1] }, 'UG', T0 + 120_000).result.attempt;
    expect(d1.deadline_at).toBe(iso(T0 + 600_000));
    expect(d2.deadline_at).toBe(d1.deadline_at);
    expect(d2.remaining_ms).toBe(480_000);
    const fin = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 250_000);
    expect(fin.result).toEqual({ ok: true, status: 'submitted', finished_at: iso(T0 + 250_000) });
    s = fin.state;
    expect(call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 300_000).result.finished_at).toBe(iso(T0 + 250_000)); // idempotent
    expect(call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: attempt(s, id, tid(1)).question_order[0], option: 'A' }).result.error).toBe('ATTEMPT_FINISHED');
    expect(setResults(s, id, T0 + 300_000).find((x) => x.team_id === tid(1))).toMatchObject({ elapsed_ms: 250_000, attempt_status: 'submitted' });
  });

  it('after the deadline answers are refused and the attempt is timed out at the deadline, even without the device', () => {
    const { s, tok, id, tid } = liveSet();
    // no request from the device: the results still treat it as timed out at the deadline
    const row = setResults(s, id, T0 + 700_000).find((x) => x.team_id === tid(2));
    expect(row).toMatchObject({ attempt_status: 'timed_out', finished_at: iso(T0 + 600_000), elapsed_ms: 600_000 });
    const late = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: attempt(s, id, tid(2)).question_order[0], option: 'A' }, 'UG', T0 + 600_000);
    expect(late.result.error).toBe('TIME_EXPIRED');
    const fin = run(s, 'finalizeExpiredAttempts', {}, id, T0 + 700_000);
    expect(fin.attempts.filter((a) => a.status === 'timed_out')).toHaveLength(3);
  });

  it('pausing freezes every team timer; resume moves deadlines; paused time is excluded from elapsed', () => {
    let { s, tok, id, tid } = liveSet();
    s = run(s, 'pauseQuiz', {}, id, T0 + 100_000);
    expect(call(s, 'participantState', { token: tok[1] }, 'UG', T0 + 400_000).result.attempt).toMatchObject({ paused: true, remaining_ms: 500_000 });
    s = run(s, 'resumeQuiz', {}, id, T0 + 400_000);
    expect(attempt(s, id, tid(1))).toMatchObject({ deadline_at: iso(T0 + 900_000), paused_ms: 300_000 });
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 500_000).state;
    expect(setResults(s, id, T0 + 500_000).find((x) => x.team_id === tid(1)).elapsed_ms).toBe(200_000);
  });

  it('ranks by score, then shorter elapsed time; equal score and time is flagged for review; unfinished teams count the full limit', () => {
    let { s, tok, id, tid } = liveSet();
    // teams 1 and 2: one correct answer each; team 3: nothing
    for (const n of [1, 2]) {
      const q = attempt(s, id, tid(n)).question_order[0];
      s = call(s, 'participantSubmit', { token: tok[n], request_id: req(), question_id: q, option: shownFor(s, id, tid(n), q, keyOf(s, id, q)) }, 'UG', T0 + 1000).state;
    }
    s = call(s, 'participantFinish', { token: tok[2] }, 'UG', T0 + 200_000).state;
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 300_000).state;
    let rows = setResults(s, id, T0 + 400_000);
    expect(rows.map((x) => [x.team_number, x.points, x.rank, x.tie_review])).toEqual([[2, 1, 1, false], [1, 1, 2, false], [3, 0, 3, true], [4, 0, 3, true]]);
    expect(rows.find((x) => x.team_number === 4)).toMatchObject({ attempt_status: null, elapsed_ms: 600_000 });
    // identical score and identical time → shared rank, flagged
    s = { ...s, attempts: s.attempts.map((a) => (a.team_id === tid(1) ? { ...a, finished_at: iso(T0 + 200_000) } : a)) };
    rows = setResults(s, id, T0 + 400_000);
    expect(rows.filter((x) => x.rank === 1).map((x) => [x.team_number, x.tie_review])).toEqual([[1, true], [2, true]]);
  });

  it('organizer finalize and reset are audited; a reset team gets a fresh attempt', () => {
    let { s, tok, id, tid } = liveSet();
    expect(code(() => run(s, 'finalizeAttempt', { team_id: tid(1) }, id))).toBe('REASON_REQUIRED');
    s = run(s, 'finalizeAttempt', { team_id: tid(1), reason: 'Device broke' }, id, T0 + 50_000);
    expect(attempt(s, id, tid(1))).toMatchObject({ status: 'organizer_finalized', finished_at: iso(T0 + 50_000) });
    const q = attempt(s, id, tid(2)).question_order[0];
    s = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: q, option: 'A' }, 'UG', T0 + 1000).state;
    const old = attempt(s, id, tid(2));
    s = run(s, 'resetAttempt', { team_id: tid(2), reason: 'Wrong team on device' }, id, T0 + 60_000);
    expect(s.answers.filter((a) => a.team_id === tid(2))).toHaveLength(0);
    expect(s.events.filter((e) => ['attempt_finalize', 'attempt_reset'].includes(e.action)).map((e) => e.action)).toEqual(['attempt_finalize', 'attempt_reset']);
    const st = call(s, 'participantState', { token: tok[2] }, 'UG', T0 + 61_000);
    expect(st.result.attempt.status).toBe('ready');
    expect(attempt(st.state, id, tid(2)).id).not.toBe(old.id);
    expect(st.state.attempts.find((a) => a.id === old.id).status).toBe('reset');
  });

  it('end set: running attempts are organizer-finalized, expired ones time out at their deadline', () => {
    let { s, tok, id, tid } = liveSet();
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 100_000).state;
    s = run(s, 'endQuiz', {}, id, T0 + 300_000);
    expect([1, 2, 3].map((n) => attempt(s, id, tid(n)).status)).toEqual(['submitted', 'organizer_finalized', 'organizer_finalized']);
    expect(s.events.at(-1).action).toBe('attempt_finalize');
  });
});

describe('exports', () => {
  it('scores, completion times, registrations and submission audit include the required columns', () => {
    let { s, tok, id, tid } = liveSet();
    const q = attempt(s, id, tid(1)).question_order[0];
    s = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q, option: 'B' }, 'UG', T0 + 1000).state;
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 2000).state;
    const v = setView(s, id);
    const set = { ...v.session };
    const results = setResults(s, id, T0 + 3000);
    const scores = parseCSV(standingsCSV(results, { set, teams: v.teams, settings: v.settings }));
    expect(scores[0]).toEqual(expect.arrayContaining(['set_name', 'college', 'elapsed_ms', 'attempt_status', 'tie_review', 'started_at_utc', 'finished_at_utc']));
    expect(scores[1]).toEqual(expect.arrayContaining(['UG Final', 'MCA College']));
    const times = parseCSV(completionCSV(results, { set, settings: v.settings }));
    expect(times.find((row) => row.includes('Team 1'))).toEqual(expect.arrayContaining(['2000', 'Submitted early']));
    expect(parseCSV(registrationsCSV(v.teams))[0]).not.toContain('team_pin');
    const audit = parseCSV(submissionAuditCSV({ set, teams: v.teams, questions: sessionQuestions(v), answers: v.answers, attempts: v.attempts, events: v.events }));
    expect(audit[0]).toEqual(expect.arrayContaining(['attempt_id', 'displayed_option', 'submitted_at_utc', 'on_time', 'request_id']));
    expect(audit[1]).toEqual(expect.arrayContaining(['B', 'yes', iso(T0 + 1000)]));
  });
});

describe('registration desk (demo)', () => {
  it('creates and edits teams in any section, logs changes, never sets demo flag', () => {
    let s = createEmptyState(T0);
    const c = call(s, 'regSaveTeam', { ...team(5), section: 'PG', is_demo: true }, null, T0, { role: 'registration' });
    expect(c.result.pin).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    s = c.state;
    expect(find(s, 'PG', 5)).toMatchObject({ is_demo: false, college_name: 'MCA College' });
    s = run(s, 'regSaveTeam', { ...find(s, 'PG', 5), college_name: 'New College' }, null, T0, { role: 'registration' });
    expect(s.registration_events.map((e) => [e.action, e.actor_role])).toEqual([['create', 'registration'], ['update', 'registration']]);
    expect(s.registration_events[1].changes).toEqual({ college_name: ['MCA College', 'New College'] });
    expect(code(() => run(s, 'regSaveTeam', team(6)))).toBe('VALIDATION'); // section is required
  });

  it("a team's registration locks once it starts a quiz; new teams and other teams stay open", () => {
    const { s, tid } = liveSet();
    expect(code(() => run(s, 'regSaveTeam', { ...find(s, 'UG', 1), team_name: 'Late edit' }))).toBe('REGISTRATION_LOCKED');
    expect(run(s, 'regSaveTeam', { ...find(s, 'UG', 4), team_name: 'Not started' }).teams.find((t) => t.id === find(s, 'UG', 4).id).team_name).toBe('Not started');
    expect(run(s, 'regSaveTeam', { ...team(20), section: 'UG' }).teams.filter((t) => t.section === 'UG')).toHaveLength(5);
    const o = call(s, 'regOverview').result;
    expect(o.teams.find((t) => t.id === tid(1)).locked).toBe(true);
    expect(o.sections.find((x) => x.section === 'UG').live_sets).toBe(1);
  });

  it('the overview has teams, PINs and section counts only', () => {
    const o = call(createDemoState(T0), 'regOverview').result;
    expect(o.sections.map((x) => [x.section, x.live_sets])).toEqual([['UG', 0], ['PG', 0]]);
    expect(o.teams).toHaveLength(18);
    expect(o.teams.every((t) => t.pin && t.college_name && t.locked === false)).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/question|answer|points|SECRET|attempt/i);
  });
});

describe('UG/PG teams', () => {
  it('team numbers are unique per section; no fixed number of teams per section', () => {
    let s = createEmptyState(T0);
    s = run(s, 'saveTeam', team(1));
    s = run(s, 'saveTeam', team(1), 'PG');
    expect(s.teams.map((t) => [t.section, t.team_number])).toEqual([['PG', 1], ['UG', 1]]);
    expect(code(() => run(s, 'saveTeam', team(1, { team_name: 'Dup' })))).toBe('DUPLICATE_TEAM_NUMBER');
    expect(code(() => run(s, 'saveTeam', team(2, { college_name: '' })))).toBe('VALIDATION');
    expect(code(() => run(s, 'saveTeam', team(2), 'XX'))).toBe('VALIDATION');
    s = run(createEmptyState(T0), 'importTeams', { rows: Array.from({ length: 80 }, (_, i) => team(i + 1)) });
    expect(run(s, 'saveTeam', team(81)).teams).toHaveLength(81);
    expect(code(() => run(s, 'importTeams', { rows: [team(60, { section: 'UG' })] }, 'PG'))).toBe('VALIDATION');
  });

  it('the projector snapshot of a set has no keys and only roster teams', () => {
    const { s, id } = liveSet();
    const pub = buildPublicSnapshot(setView(s, id), setResults(s, id, T0));
    expect(pub.standings).toHaveLength(4);
    expect(JSON.stringify(pub.questions)).not.toMatch(LEAK);
    expect(pub.setId).toBe(id);
  });
});

describe('backups and migration of older demo data', () => {
  it('format 3 round-trips every set with frozen questions and attempts; live sets restore paused with deadlines shifted', () => {
    const { s, id, tid } = liveSet();
    const b = JSON.parse(JSON.stringify(buildBackup(backupData(s), 'demo')));
    expect(b.format_version).toBe(3);
    expect(b.sessions.length).toBe(s.sets.length);
    const before = attempt(s, id, tid(1));
    const restored = run(createEmptyState(T0), 'restoreBackup', { backup: { ...b, exported_at: iso(T0 + 60_000) } }, 'UG', T0 + 160_000);
    const v = setView(restored, id);
    expect(v.session).toMatchObject({ status: 'paused', join_code_active: false });
    expect(v.set_questions).toHaveLength(40);
    const after = attempt(restored, id, tid(1));
    expect(after.question_order).toEqual(before.question_order);
    expect(after).toMatchObject({ deadline_at: iso(T0 + 700_000), paused_ms: 100_000 }); // 100 s between export and restore
  });

  it('format 2 and 1 backups still restore', () => {
    const s = createEmptyState(T0);
    const v1 = {
      app: 'brainfreze-cold-start', format_version: 1, teams: [{ id: '0f8e7c4e-1d3a-4b5c-9e2f-111111111111', team_number: 1, team_name: 'Old', participant_1: 'a', participant_2: 'b' }],
      questions: [], session: { ...s.sets[0].session }, settings: {}, answers: [], events: [], tiebreaks: [],
    };
    const v = validateBackup(v1);
    expect(v.sets.map((x) => x.session.section)).toEqual(['UG']);
    expect(v.teams[0]).toMatchObject({ section: 'UG', college_name: null });
    const restored = run(s, 'restoreBackup', { backup: v1 });
    expect(restored.teams[0].section).toBe('UG');
    expect(restored.sets.map((x) => x.session.section).sort()).toEqual(['PG', 'UG']);
    const v2 = { ...v1, format_version: 2, sessions: [{ session: { ...s.sets[0].session }, settings: {} }, { session: { ...s.sets[1].session }, settings: {} }] };
    expect(validateBackup(v2).sets).toHaveLength(2);
  });

  it('pre-sets demo data (one session per section + archives) becomes quiz sets', () => {
    const old = createEmptyState(T0);
    const legacy = {
      ...old, teams: [{ ...team(3), id: 'x' }],
      sections: { UG: { session: old.sets[0].session, settings: old.sets[0].settings }, PG: { session: old.sets[1].session, settings: old.sets[1].settings } },
      archives: [{ session: { ...old.sets[0].session, id: 'arch' }, settings: old.sets[0].settings, answers: [], events: [], tiebreaks: [] }],
    };
    delete legacy.sets;
    delete legacy.attempts;
    delete legacy.teams[0].section;
    const s = normalizeState(legacy);
    expect(s.sets.map((x) => [x.session.section, x.session.is_current])).toEqual([['UG', false], ['UG', true], ['PG', true]]);
    expect(s.sets[1].session.id).toBe(old.sets[0].session.id);
    expect(s.teams[0].section).toBe('UG');
    expect(s.attempts).toEqual([]);
  });
});

describe('Round 1 setup: one-question quiz and the chosen duration', () => {
  it('a one-question set publishes, shuffles, scores and uses the organizer duration for each team', () => {
    let s = world();
    let id;
    [s, id] = draft(s, 'Lightning', 'UG', 1, 7, { duration_seconds: 45 * 60 });
    let c;
    [s, c] = publish(s, id);
    expect(c).toMatch(/^\d{6}$/);
    const tok = {};
    for (const n of [1, 2]) { const j = join(s, c, 'UG', n); s = j.state; tok[n] = j.result.token; }
    s = run(s, 'startQuiz', {}, id);
    s = call(s, 'participantStart', { token: tok[1] }, 'UG', T0 + 5000).state;
    const a = attempt(s, id, find(s, 'UG', 1).id);
    expect(a.question_order).toEqual([s.questions[7].id]);
    expect(a.deadline_at).toBe(iso(T0 + 5000 + 45 * 60_000));
    const qid = a.question_order[0];
    const right = shownFor(s, id, a.team_id, qid, keyOf(s, id, qid));
    s = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: qid, option: right }, 'UG', T0 + 9000).state;
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 10_000).state;
    const rows = setResults(s, id, T0 + 20_000);
    expect(rows.find((x) => x.team_id === a.team_id)).toMatchObject({ points: 1, correct: 1, unanswered: 0, elapsed_ms: 5000, attempt_status: 'submitted', rank: 1 });
    // a team that never starts is counted at the full chosen time limit
    expect(rows.find((x) => x.team_number === 2)).toMatchObject({ elapsed_ms: 45 * 60_000 });
    expect(parseCSV(standingsCSV(rows, { settings: setView(s, id).settings })).length).toBeGreaterThan(1);
  });
});
