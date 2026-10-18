// Demo-mode mirror of the PIN-free participant flow
// (src/lib/engine.js ↔ supabase/migrations/20261019000100_round1_participant_flow.sql).
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, sessionQuestions, setResults, setView } from '../src/lib/engine.js';
import { selectTeams } from './helpers/engine.js';

const T0 = Date.parse('2026-10-19T09:00:00Z');
let r = 0;
const req = () => `cdcdcdcd-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const call = (s, name, p = {}, to = 'UG', now = T0) => applyAction(s, name, p, { now, ...(to.length > 2 ? { setId: to } : { section: to }) });
const run = (...a) => call(...a).state;
const iso = (ms) => new Date(ms).toISOString();
const team = (n, section) => ({ team_number: n, team_name: `${section} Frost ${n}`, participant_1: `Asha ${n}`, participant_2: `Ravi ${n}`, college_name: 'Private College', section });
const attempt = (s, setId, teamId) => s.attempts.find((a) => a.session_id === setId && a.team_id === teamId && a.status !== 'reset');
const tid = (s, n) => s.teams.find((t) => t.section === 'UG' && t.team_number === n).id;

/** A published UG set (4 questions, 10 minutes) with UG teams 1–4 and PG team 1. */
function world() {
  let s = createEmptyState(T0);
  s = run(s, 'importQuestions', { items: Array.from({ length: 4 }, (_, i) => ({ question_text: `Q${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'ABCD'[i] })) });
  s = run(s, 'importTeams', { rows: [1, 2, 3, 4].map((n) => team(n, 'UG')) }, 'UG');
  s = run(s, 'importTeams', { rows: [team(1, 'PG')] }, 'PG');
  const c = call(s, 'createSet', { name: 'UG Flow', section: 'UG' });
  const id = c.result.id;
  s = run(c.state, 'updateQuizDetails', { question_ids: c.state.questions.map((q) => q.id) }, id);
  s = run(s, 'updateSettings', { duration_seconds: 600 }, id);
  const pub = call(s, 'publishQuiz', {}, id);
  return { s: selectTeams(pub.state, id, null, T0), id, code: pub.result.join_code };
}
const join = (s, code, n, section = 'UG', now = T0) => call(s, 'joinRegisteredTeam', { code, section, team_number: n }, 'UG', now);

describe('PIN-free join (demo engine)', () => {
  it('lists registered teams for the matching section only, without private data', () => {
    const { s, code } = world();
    const ros = call(s, 'joinRoster', { code, section: 'ug' }).result;
    expect(ros.teams.map((t) => t.team_number)).toEqual([1, 2, 3, 4]);
    expect(ros.teams[0]).toEqual({ team_number: 1, team_name: 'UG Frost 1', participant_1: 'Asha 1', participant_2: 'Ravi 1', joined: false });
    expect(JSON.stringify(ros)).not.toMatch(/college|pin|"id"/i);
    expect(call(s, 'joinRoster', { code, section: 'PG' }).result).toEqual({ ok: false, error: 'SECTION_MISMATCH', section: 'UG' });
    expect(call(s, 'joinRoster', { code: '000000', section: 'UG' }).result.error).toBe('INVALID_CODE');
  });

  it('refuses unregistered teams and the wrong section; binds a team to one device until released', () => {
    let { s, id, code } = world();
    expect(join(s, code, 77).result).toEqual({ ok: false, error: 'TEAM_NOT_REGISTERED' });
    expect(join(s, code, 1, 'PG').result.error).toBe('SECTION_MISMATCH');
    const first = join(s, code, 1);
    s = first.state;
    expect(first.result).toMatchObject({ ok: true, team: { team_number: 1 } });
    expect(call(s, 'joinRoster', { code, section: 'UG' }).result.teams[0].joined).toBe(true);
    expect(join(s, code, 1, 'UG', T0 + 3600_000).result).toEqual({ ok: false, error: 'TEAM_ALREADY_JOINED' }); // no idle takeover
    const a = attempt(s, id, tid(s, 1));
    s = run(s, 'revokeParticipant', { team_id: tid(s, 1) }, id);
    const again = join(s, code, 1);
    expect(again.result.ok).toBe(true);
    expect(attempt(again.state, id, tid(s, 1)).id).toBe(a.id);
    expect(again.state.attempts.filter((x) => x.team_id === tid(s, 1))).toHaveLength(1);
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
