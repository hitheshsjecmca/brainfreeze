// Demo-mode mirror of the participant self-join flow
// (src/lib/engine.js ↔ supabase/migrations/20261027000100_fresh_sets_options_self_join.sql).
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, sessionQuestions, setResults, setView } from '../src/lib/engine.js';

const T0 = Date.parse('2026-10-19T09:00:00Z');
let r = 0;
const req = () => `cdcdcdcd-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const call = (s, name, p = {}, to = 'UG', now = T0) => applyAction(s, name, p, { now, ...(to.length > 2 ? { setId: to } : { section: to }) });
const run = (...a) => call(...a).state;
const iso = (ms) => new Date(ms).toISOString();
const attempt = (s, setId, teamId) => s.attempts.find((a) => a.session_id === setId && a.team_id === teamId && a.status !== 'reset');

/** A published UG set (4 questions, 10 minutes). Nobody is pre-registered or pre-selected. */
function world() {
  let s = createEmptyState(T0);
  s = run(s, 'importQuestions', { items: Array.from({ length: 4 }, (_, i) => ({ question_text: `Q${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'ABCD'[i] })) });
  const c = call(s, 'createSet', { name: 'UG Flow', section: 'UG' });
  const id = c.result.id;
  s = run(c.state, 'updateQuizDetails', { question_ids: c.state.questions.map((q) => q.id) }, id);
  s = run(s, 'updateSettings', { duration_seconds: 600 }, id);
  const pub = call(s, 'publishQuiz', {}, id);
  return { s: pub.state, id, code: pub.result.join_code };
}
const person = (n) => ({ full_name: `Asha ${n}`, college_name: `College ${n}` });
const join = (s, code, n, extra = {}, now = T0) => call(s, 'joinQuiz', { code, ...person(n), request_id: req(), ...extra }, 'UG', now);
const entry = (s, setId, n) => s.teams.find((t) => t.join_session_id === setId && t.participant_1 === `Asha ${n}`);
const tid = (s, n) => s.teams.find((t) => t.participant_1 === `Asha ${n}`).id;

describe('participant self-join (demo engine)', () => {
  it('joins with a valid code and own details; the section comes from the code; no pre-registration', () => {
    const { s, id, code } = world();
    expect(s.teams).toHaveLength(0);
    const r = join(s, code, 1, { full_name: '  Asha   1 ', college_name: ' College 1  ', section: 'UG' });
    expect(r.result).toMatchObject({ ok: true, section: 'UG', resumed: false, team: { participant_1: 'Asha 1', college_name: 'College 1', section: 'UG', self_joined: true } });
    const t = entry(r.state, id, 1);
    expect(t).toMatchObject({ section: 'UG', college_name: 'College 1', participant_2: null, self_registered: true });
    expect(setView(r.state, id).session.team_ids).toEqual([t.id]);
    expect(r.state.attempts.filter((a) => a.team_id === t.id)).toHaveLength(1);
  });

  it('refuses invalid codes, a different section and missing or malformed details', () => {
    const { s, code } = world();
    expect(join(s, '000000', 1).result.error).toBe('INVALID_CODE');
    expect(join(s, code, 1, { section: 'PG' }).result).toEqual({ ok: false, error: 'SECTION_MISMATCH', section: 'UG' });
    expect(join(s, code, 1, { full_name: '   ' }).result).toMatchObject({ ok: false, error: 'VALIDATION', field: 'full_name' });
    expect(join(s, code, 1, { college_name: '' }).result).toMatchObject({ ok: false, error: 'VALIDATION', field: 'college_name' });
    expect(join(s, code, 1, { full_name: 'x'.repeat(81) }).result.error).toBe('VALIDATION');
    expect(join(s, code, 1, { full_name: '<script>' }).result.error).toBe('VALIDATION');
    expect(join(s, code, 1, { request_id: null }).result.error).toBe('VALIDATION');
  });

  it('a retried request never creates a second entry or attempt; the same person on another device is refused until released', () => {
    let { s, id, code } = world();
    const rid = req();
    const first = call(s, 'joinQuiz', { code, ...person(1), request_id: rid }, 'UG');
    const retry = call(first.state, 'joinQuiz', { code, ...person(1), request_id: rid }, 'UG');
    s = retry.state;
    expect(retry.result).toMatchObject({ ok: true, resumed: true });
    expect(s.teams.filter((t) => t.join_session_id === id)).toHaveLength(1);
    expect(s.attempts.filter((a) => a.team_id === tid(s, 1) && a.status !== 'reset')).toHaveLength(1);
    // the first (lost) token was replaced by the retry's token
    expect(call(s, 'participantState', { token: first.result.token }).result.ok).toBe(false);
    expect(call(s, 'participantState', { token: retry.result.token }).result.ok).toBe(true);
    // the same name + college from another device (new request id): refused while the first device is signed in
    expect(join(s, code, 1, { full_name: 'ASHA 1', college_name: 'college 1' }).result.error).toBe('ALREADY_JOINED');
    const a = s.attempts.find((x) => x.team_id === tid(s, 1));
    s = run(s, 'revokeParticipant', { team_id: tid(s, 1) }, id);
    const again = join(s, code, 1);
    expect(again.result).toMatchObject({ ok: true, resumed: true });
    expect(again.state.attempts.filter((x) => x.team_id === tid(s, 1))).toEqual([expect.objectContaining({ id: a.id })]);
    // a different request id with other details is a different participant
    expect(join(again.state, code, 2).result.ok).toBe(true);
  });

  it('closing registration stops new participants but lets joined ones come back', () => {
    let { s, id, code } = world();
    s = join(s, code, 1).state;
    s = run(s, 'revokeParticipant', { team_id: tid(s, 1) }, id);
    s = run(s, 'setRegistration', { open: false }, id);
    expect(join(s, code, 2).result.error).toBe('REGISTRATION_CLOSED');
    expect(join(s, code, 1).result.ok).toBe(true);
  });

  it('going live needs no pre-selected teams; results show the participant with name, college and section', () => {
    let { s, id, code } = world();
    s = run(s, 'startQuiz', {}, id); // nobody has joined yet: allowed
    const j = join(s, code, 1);
    s = j.state;
    const row = setResults(s, id).find((x) => x.team_id === tid(s, 1));
    expect(row).toMatchObject({ team_name: 'Asha 1' });
    expect(s.teams.find((t) => t.id === row.team_id)).toMatchObject({ college_name: 'College 1', section: 'UG' });
  });
});

describe('timer, autosave and submission (demo engine)', () => {
  function live() {
    let { s, id, code } = world();
    const tok = {};
    for (const n of [1, 2, 3]) { const j = join(s, code, n); s = j.state; tok[n] = j.result.token; }
    s = run(s, 'startQuiz', {}, id, T0 + 1000);
    return { s, id, tok };
  }

  it('the deadline is set when the team starts and never moves on refresh', () => {
    let { s, id, tok } = live();
    expect(call(s, 'participantState', { token: tok[1] }, 'UG', T0 + 2000).result.attempt).toMatchObject({ status: 'ready', deadline_at: null });
    s = call(s, 'participantStart', { token: tok[1] }, 'UG', T0 + 5000).state;
    s = call(s, 'participantStart', { token: tok[1] }, 'UG', T0 + 9000).state;
    expect(attempt(s, id, tid(s, 1)).deadline_at).toBe(iso(T0 + 5000 + 600_000));
    expect(call(s, 'participantState', { token: tok[1] }, 'UG', T0 + 65_000).result.attempt.remaining_ms).toBe(540_000);
  });

  it('answers autosave, can be changed until submission, and late changes are refused', () => {
    let { s, id, tok } = live();
    s = call(s, 'participantStart', { token: tok[1] }).state;
    const a = attempt(s, id, tid(s, 1));
    const q = a.question_order[0];
    s = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q, option: 'A' }).state;
    const ch = call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q, option: 'D' });
    expect(ch.result).toMatchObject({ ok: true, selected: 'D' });
    s = ch.state;
    const ans = s.answers.filter((x) => x.team_id === tid(s, 1));
    expect(ans).toHaveLength(1);
    expect(ans[0]).toMatchObject({ displayed_option: 'D', selected_option: a.option_orders[0][3] });
    expect(s.events.filter((e) => e.team_id === tid(s, 1)).map((e) => e.action)).toEqual(['record', 'correction']);
    s = call(s, 'participantFinish', { token: tok[1] }, 'UG', T0 + 20_000).state;
    expect(call(s, 'participantSubmit', { token: tok[1], request_id: req(), question_id: q, option: 'B' }).result.error).toBe('ATTEMPT_FINISHED');
  });

  it('at the deadline the attempt is submitted automatically with every saved answer', () => {
    let { s, id, tok } = live();
    s = call(s, 'participantStart', { token: tok[2] }).state;
    const a = attempt(s, id, tid(s, 2));
    s = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: a.question_order[0], option: 'B' }).state;
    s = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: a.question_order[1], option: 'C' }).state;
    const late = T0 + 600_000 + 1;
    expect(call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: a.question_order[2], option: 'A' }, 'UG', late).result.error).toBe('TIME_EXPIRED');
    const st = call(s, 'participantState', { token: tok[2] }, 'UG', late);
    expect(st.result.attempt.status).toBe('timed_out');
    s = st.state;
    expect(attempt(s, id, tid(s, 2)).finished_at).toBe(iso(T0 + 600_000));
    const row = setResults(s, id, late).find((x) => x.team_id === tid(s, 2));
    expect(row).toMatchObject({ attempt_status: 'timed_out', unanswered: 2 });
    expect(row.correct + row.incorrect).toBe(2);
    expect(sessionQuestions(setView(s, id))).toHaveLength(4);
  });
});
