// Demo-mode participant workflow (src/lib/engine.js mirrors the SQL functions):
// join code → team PIN → one attempt → Start → answers → submit / deadline.
import { describe, expect, it } from 'vitest';
import { applyAction, backupData, createEmptyState, sectionView, sessionQuestions } from '../src/lib/engine.js';
import { buildPublicSnapshot } from '../src/backend/publicView.js';
import { buildBackup } from '../src/lib/backup.js';
import { formatJoinCode, isJoinCode, normalizeJoinCode, randomJoinCode, randomPin, randomToken } from '../src/lib/joinCodes.js';
import { OPTIONS } from '../src/lib/constants.js';
import { selectTeams } from './helpers/engine.js';

// These tests use the UG draft set that every fresh state starts with.
const ug = (s) => sectionView(s, 'UG');
const withSettings = (s, patch) => ({ ...s, sets: s.sets.map((x) => (x.session.id === ug(s).session.id ? { ...x, settings: { ...x.settings, ...patch } } : x)) });

const T0 = Date.parse('2026-10-14T09:00:00Z');
let r = 0;
const req = () => `cccccccc-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const run = (s, name, p = {}, now = T0) => applyAction(s, name, p, { now }).state;
const call = (s, name, p = {}, now = T0) => applyAction(s, name, p, { now });
const LEAK = /correct_option|explanation|"result"|"points"|SECRET/;

function base() {
  let s = createEmptyState(T0);
  s = run(s, 'importTeams', { rows: [1, 2, 3].map((i) => ({ team_number: i, team_name: `Team ${i}`, participant_1: `P${i}a`, participant_2: `P${i}b`, college_name: 'Test College' })) });
  s = run(s, 'importQuestions', {
    items: Array.from({ length: 32 }, (_, i) => ({ question_text: `Q${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'BCAD'[i % 4], explanation: `SECRET-${i}` })),
  });
  return s;
}
const pinOf = (s, n) => s.credentials[s.teams.find((t) => t.team_number === n).id];
const teamId = (s, n) => s.teams.find((t) => t.team_number === n).id;

function published() {
  let s = base();
  s = run(s, 'updateQuizDetails', { name: 'Cold Start', question_ids: s.questions.slice(0, 30).map((q) => q.id) });
  const { state, result } = call(s, 'publishQuiz');
  return { s: selectTeams(state, null, null, T0), code: result.join_code };
}
function joined() {
  const { s: s0, code } = published();
  const a = call(s0, 'joinTeam', { code, team_number: 1, pin: pinOf(s0, 1) });
  const b = call(a.state, 'joinTeam', { code, team_number: 2, pin: pinOf(s0, 2) });
  return { s: b.state, code, ta: a.result.token, tb: b.result.token };
}
/** Live set with teams 1 and 2 started at T0. */
function started() {
  const j = joined();
  let s = run(j.s, 'startQuiz');
  s = call(s, 'participantStart', { token: j.ta }).state;
  s = call(s, 'participantStart', { token: j.tb }).state;
  return { ...j, s };
}
const attemptOf = (s, n) => s.attempts.find((a) => a.team_id === teamId(s, n) && a.status !== 'reset');
/** The letter team n SEES for a question's correct (or given original) option. */
function shown(s, n, qid, original = null) {
  const a = attemptOf(s, n);
  const perm = a.option_orders[a.question_order.indexOf(qid)];
  const key = original ?? sessionQuestions(ug(s)).find((q) => q.id === qid).correct_option;
  return OPTIONS[perm.indexOf(key)];
}

describe('secure random identifiers', () => {
  it('join codes are six digits and well spread', () => {
    const codes = Array.from({ length: 2000 }, randomJoinCode);
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1990);
  });
  it('PINs avoid ambiguous characters; tokens are 256-bit hex', () => {
    for (let i = 0; i < 500; i++) expect(randomPin()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
  });
  it('normalizes pasted codes', () => {
    expect(normalizeJoinCode(' 482-913 ')).toBe('482913');
    expect(isJoinCode('482 913')).toBe(true);
    expect(isJoinCode('48291')).toBe(false);
    expect(formatJoinCode('482913')).toBe('482 913');
  });
});

describe('organizer publishing', () => {
  it('every team has a PIN; drafts are not joinable', () => {
    const s = base();
    expect(Object.keys(s.credentials)).toHaveLength(3);
    expect(call(s, 'joinLookup', { code: '123456' }).result).toEqual({ ok: false, error: 'INVALID_CODE' });
  });

  it('question selection defines the set; publish issues a code, freezes the set and is idempotent', () => {
    const { s, code } = published();
    expect(sessionQuestions(ug(s))).toHaveLength(30);
    expect(ug(s).set_questions).toHaveLength(30);
    expect(code).toMatch(/^\d{6}$/);
    expect(call(s, 'publishQuiz').result.join_code).toBe(code);
    expect(() => run(s, 'updateQuizDetails', { question_ids: [] })).toThrow(/frozen/);
    expect(call(s, 'joinLookup', { code }).result.quiz).toMatchObject({ title: 'Cold Start', section: 'UG', total_questions: 30, duration_seconds: 1800 });
  });

  it('readiness: cannot publish an empty set', () => {
    expect(() => run(createEmptyState(T0), 'publishQuiz')).toThrow(/at least one question/);
  });

  it('regenerate/revoke/unpublish never reuse a code and expire the old one', () => {
    const { s, code } = published();
    const g = call(s, 'regenerateJoinCode');
    expect(g.result.join_code).not.toBe(code);
    expect(call(g.state, 'joinLookup', { code }).result.error).toBe('INVALID_CODE');
    const u = run(g.state, 'unpublishQuiz');
    expect(call(u, 'joinLookup', { code: g.result.join_code }).result.error).toBe('INVALID_CODE');
    expect(u.retired_codes).toEqual(expect.arrayContaining([code, g.result.join_code]));
    expect(ug(u).set_questions).toHaveLength(0);
  });

  it('projector snapshot contains only the set questions and no keys', () => {
    const { s } = published();
    const pub = buildPublicSnapshot(ug(s));
    expect(pub.questions).toHaveLength(30);
    expect(JSON.stringify(pub.questions)).not.toMatch(/correct_option|explanation|SECRET/);
  });
});

describe('joining', () => {
  it('requires the right PIN; same error for unknown team', () => {
    const { s, code } = published();
    expect(call(s, 'joinTeam', { code, team_number: 1, pin: 'AAAAAA' }).result).toEqual({ ok: false, error: 'INVALID_TEAM_OR_PIN' });
    expect(call(s, 'joinTeam', { code, team_number: 9, pin: pinOf(s, 1) }).result).toEqual({ ok: false, error: 'INVALID_TEAM_OR_PIN' });
    const ok = call(s, 'joinTeam', { code, team_number: 1, pin: pinOf(s, 1).toLowerCase() });
    expect(ok.result).toMatchObject({ ok: true, team: { team_number: 1, team_name: 'Team 1' } });
    expect(ok.state.attempts).toHaveLength(1);
    expect(ok.state.attempts[0]).toMatchObject({ status: 'ready', started_at: null });
  });

  it('blocks takeover of a connected team; a replacement device resumes the SAME attempt', () => {
    const { s, code } = joined();
    expect(call(s, 'joinTeam', { code, team_number: 1, pin: pinOf(s, 1) }, T0 + 1000).result.error).toBe('TEAM_ALREADY_CONNECTED');
    const later = call(s, 'joinTeam', { code, team_number: 1, pin: pinOf(s, 1) }, T0 + 60_000);
    expect(later.result.ok).toBe(true);
    expect(later.state.attempts.filter((a) => a.team_id === teamId(s, 1))).toHaveLength(1);
    expect(attemptOf(later.state, 1).id).toBe(attemptOf(s, 1).id);
  });

  it('closed registration: new teams rejected, joined teams may reconnect', () => {
    const { s, code } = joined();
    const closed = run(s, 'setRegistration', { open: false });
    expect(call(closed, 'joinTeam', { code, team_number: 3, pin: pinOf(s, 3) }).result.error).toBe('REGISTRATION_CLOSED');
    expect(call(closed, 'joinTeam', { code, team_number: 1, pin: pinOf(s, 1) }, T0 + 60_000).result.ok).toBe(true);
  });

  it('self-registration only when enabled; duplicate names refused', () => {
    const { s, code } = published();
    expect(call(s, 'registerTeam', { code, team_name: 'New', participant_1: 'a', participant_2: 'b', college_name: 'Walk College' }).result.error).toBe('SELF_REGISTRATION_CLOSED');
    const on = run(s, 'updateQuizDetails', { self_registration: true });
    const reg = call(on, 'registerTeam', { code, team_name: 'New Team', participant_1: 'a', participant_2: 'b', college_name: 'Test College' });
    // Registered, but not a participant until the organiser selects it: no attempt, no device session.
    expect(reg.result).toEqual({ ok: false, error: 'TEAM_NOT_SELECTED', registered: true, team_number: 4, section: 'UG' });
    expect(reg.state.teams.find((t) => t.team_number === 4).self_registered).toBe(true);
    expect(reg.state.attempts).toHaveLength(0);
    expect(call(reg.state, 'registerTeam', { code, team_name: 'new TEAM', participant_1: 'c', participant_2: 'd', college_name: 'Test College' }).result.error).toBe('TEAM_NAME_TAKEN');
  });

  it('rate-limits after 30 failed attempts', () => {
    let { s } = published();
    for (let i = 0; i < 30; i++) s = call(s, 'joinLookup', { code: String(100000 + i) }).state;
    expect(call(s, 'joinLookup', { code: ug(s).session.join_code }).result.error).toBe('RATE_LIMITED');
    expect(call(s, 'joinLookup', { code: ug(s).session.join_code }, T0 + 11 * 60_000).result.ok).toBe(true);
  });
});

describe('instructions, Start, answering and timing', () => {
  it('before Start there is no question; Start needs the set live; the server records start and deadline', () => {
    let { s, ta } = joined();
    const lobby = call(s, 'participantState', { token: ta }).result;
    expect(lobby.question).toBeUndefined();
    expect(lobby.attempt).toMatchObject({ status: 'ready', started_at: null, deadline_at: null });
    expect(lobby.quiz).toMatchObject({ duration_seconds: 1800, total_questions: 30, marks: { correct: 1, incorrect: -0.25, unanswered: 0 } });
    expect(call(s, 'participantStart', { token: ta }).result).toEqual({ ok: false, error: 'NOT_STARTED_YET' });
    s = run(s, 'startQuiz');
    expect(call(s, 'participantState', { token: ta }).result.question).toBeUndefined(); // still waits for Start
    const st = call(s, 'participantStart', { token: ta }, T0 + 5000);
    expect(st.result).toMatchObject({ ok: true, status: 'in_progress', started_at: new Date(T0 + 5000).toISOString(), deadline_at: new Date(T0 + 5000 + 1_800_000).toISOString() });
    // pressing Start again (double click, refresh) never moves the start
    expect(call(st.state, 'participantStart', { token: ta }, T0 + 60_000).result.started_at).toBe(new Date(T0 + 5000).toISOString());
    const q = call(st.state, 'participantState', { token: ta }, T0 + 6000).result;
    expect(q.question).toMatchObject({ number: 1 });
    expect(q.attempt.remaining_ms).toBe(1_799_000);
    expect(JSON.stringify(q)).not.toMatch(LEAK);
  });

  it('one answer per question, changeable until submission; retries are idempotent; scored server-side against the original key', () => {
    let { s, ta, tb } = started();
    const qid = call(s, 'participantState', { token: ta }).result.question.id;
    const letter = shown(s, 1, qid);
    const id = req();
    const out = call(s, 'participantSubmit', { token: ta, request_id: id, question_id: qid, option: letter.toLowerCase() }, T0 + 1000);
    expect(out.result).toMatchObject({ ok: true, selected: letter, duplicate_request: false });
    expect(JSON.stringify(out.result)).not.toMatch(LEAK);
    s = out.state;
    expect(s.answers[0]).toMatchObject({ result: 'correct', points: 1, source: 'participant', displayed_option: letter, on_time: true, attempt_id: attemptOf(s, 1).id });
    expect(s.answers[0].selected_option).toBe(sessionQuestions(ug(s)).find((q) => q.id === qid).correct_option);
    expect(call(s, 'participantSubmit', { token: ta, request_id: id, question_id: qid, option: letter }).result.duplicate_request).toBe(true);
    // a different letter replaces the answer (audited as a correction); still one answer per question
    const other = 'ABCD'.replace(letter, '')[0];
    const changed = call(s, 'participantSubmit', { token: ta, request_id: req(), question_id: qid, option: other });
    expect(changed.result).toMatchObject({ ok: true, selected: other });
    expect(changed.state.answers.filter((x) => x.question_id === qid && x.team_id === s.answers[0].team_id)).toHaveLength(1);
    expect(changed.state.events.at(-1)).toMatchObject({ action: 'correction', source: 'participant' });
    // another team's token cannot reuse team 1's request id
    expect(call(s, 'participantSubmit', { token: tb, request_id: id, question_id: qid, option: 'A' }).result.error).toBe('VALIDATION');
    // reconnect sees the letter it chose, only for its own team
    const pos = attemptOf(s, 1).question_order.indexOf(qid);
    expect(call(s, 'participantState', { token: ta, position: pos }).result.my_answer).toMatchObject({ selected: letter });
    const posB = attemptOf(s, 2).question_order.indexOf(qid);
    expect(call(s, 'participantState', { token: tb, position: posB }).result.my_answer).toBeNull();
  });

  it('rejects bad options, questions outside the set, a paused set and answers after the deadline', () => {
    const { s, ta } = started();
    const qs = sessionQuestions(ug(s));
    const sub = (st, p, now = T0 + 1000) => call(st, 'participantSubmit', { token: ta, request_id: req(), ...p }, now).result;
    expect(sub(s, { question_id: qs[0].id, option: 'E' }).error).toBe('INVALID_OPTION');
    expect(sub(s, { question_id: s.questions[31].id, option: 'A' }).error).toBe('QUESTION_NOT_IN_QUIZ');
    const paused = run(s, 'pauseQuiz', {}, T0 + 2000);
    expect(sub(paused, { question_id: qs[0].id, option: 'A' }, T0 + 3000).error).toBe('NOT_ACCEPTING');
    expect(call(paused, 'participantState', { token: ta }, T0 + 3000).result.question).toBeUndefined();
    const late = T0 + 1_800_000;
    const res = call(s, 'participantSubmit', { token: ta, request_id: req(), question_id: qs[0].id, option: 'A' }, late);
    expect(res.result.error).toBe('TIME_EXPIRED');
    expect(attemptOf(res.state, 1)).toMatchObject({ status: 'timed_out', finished_at: new Date(late).toISOString() });
    expect(call(s, 'participantState', { token: ta }, late + 5000).result.attempt.status).toBe('timed_out');
  });

  it('end finalizes running attempts and expires the join code; revealed results show only the own team', () => {
    let { s, code, ta, tb } = started();
    const q1 = sessionQuestions(ug(s))[0].id;
    s = call(s, 'participantSubmit', { token: ta, request_id: req(), question_id: q1, option: shown(s, 1, q1) }, T0 + 1000).state;
    s = run(s, 'endQuiz', {}, T0 + 2000);
    expect(s.attempts.map((a) => a.status)).toEqual(['organizer_finalized', 'organizer_finalized']);
    expect(call(s, 'joinLookup', { code }).result.error).toBe('INVALID_CODE');
    s = withSettings(s, { qualify_count: 1 });
    s = run(s, 'confirmQualifiers', { team_ids: [teamId(s, 1)] });
    s = run(s, 'revealResults', { reveal: true });
    expect(call(s, 'participantState', { token: ta }).result.result).toMatchObject({ rank: 1, qualified: true });
    expect(call(s, 'participantState', { token: tb }).result.result.qualified).toBe(false);
  });

  it('organizer can disconnect a device; a new draft copy archives the set and signs devices out', () => {
    let { s, ta } = joined();
    s = run(s, 'revokeParticipant', { team_id: teamId(s, 1) });
    expect(call(s, 'participantState', { token: ta }).result).toEqual({ ok: false, error: 'SESSION_REVOKED', message: 'Disconnected by organizer' });
    const n = call(joined().s, 'newSession');
    const fresh = n.state.sets.find((x) => x.session.id === n.result.id);
    expect(fresh.session).toMatchObject({ name: 'Cold Start', published_at: null, join_code_active: false, is_current: true });
    expect(n.state.participant_sessions.every((p) => p.revoked_at)).toBe(true);
    expect(n.state.sets.filter((x) => x.session.is_current === false)).toHaveLength(1);
  });

  it('backups keep team PINs, frozen questions and attempts; restored sets never have an active code', () => {
    const { s } = started();
    const backup = JSON.parse(JSON.stringify(buildBackup(backupData(s), 'demo')));
    expect(backup.format_version).toBe(3);
    expect(backup.team_credentials).toHaveLength(3);
    const restored = run(createEmptyState(T0), 'restoreBackup', { backup }, T0 + 60_000);
    expect(restored.credentials[teamId(s, 1)]).toBe(pinOf(s, 1));
    expect(ug(restored).session).toMatchObject({ join_code_active: false, status: 'paused' });
    expect(sessionQuestions(ug(restored))).toHaveLength(30);
    expect(attemptOf(restored, 1).question_order).toEqual(attemptOf(s, 1).question_order);
  });
});
