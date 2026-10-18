// Demo-mode mirror of per-team question and option shuffling (src/lib/engine.js ↔ public._make_attempt).
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, sessionQuestions, setResults, setView } from '../src/lib/engine.js';
import { selectTeams } from './helpers/engine.js';

const T0 = Date.parse('2026-10-20T09:00:00Z');
let r = 0;
const req = () => `6b6b6b6b-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const call = (s, name, p = {}, to = 'UG', now = T0) => applyAction(s, name, p, { now, ...(to.length > 2 ? { setId: to } : { section: to }) });
const run = (...a) => call(...a).state;
const TEAMS = [1, 2, 3, 4, 5, 6];
const PERMS = (function perms(rest = 'ABCD') {
  return rest.length <= 1 ? [rest] : [...rest].flatMap((c) => perms(rest.replace(c, '')).map((p) => c + p));
})();

/** A live UG set of 30 questions; teams 1–6 joined and started. */
function live() {
  let s = createEmptyState(T0);
  s = run(s, 'importQuestions', { items: Array.from({ length: 30 }, (_, i) => ({ question_text: `Q${i + 1}?`, option_a: `alpha ${i}`, option_b: `bravo ${i}`, option_c: `charlie ${i}`, option_d: `delta ${i}`, correct_option: 'ABCD'[(i * 7) % 4] })) });
  s = run(s, 'importTeams', { rows: TEAMS.map((n) => ({ team_number: n, team_name: `Shuffle ${n}`, participant_1: 'A', participant_2: 'B', college_name: 'X', section: 'UG' })) }, 'UG');
  const c = call(s, 'createSet', { name: 'Shuffle set', section: 'UG' });
  const id = c.result.id;
  s = run(c.state, 'updateQuizDetails', { question_ids: c.state.questions.map((q) => q.id) }, id);
  const pub = call(s, 'publishQuiz', {}, id);
  s = selectTeams(pub.state, id, null, T0);
  const tok = {};
  for (const n of TEAMS) { const j = call(s, 'joinRegisteredTeam', { code: pub.result.join_code, section: 'UG', team_number: n }); s = j.state; tok[n] = j.result.token; }
  s = run(s, 'startQuiz', {}, id);
  for (const n of TEAMS) s = call(s, 'participantStart', { token: tok[n] }).state;
  const tid = (n) => s.teams.find((t) => t.team_number === n).id;
  return { s, id, tok, tid, code: pub.result.join_code };
}
const attempt = (s, id, teamId) => s.attempts.find((a) => a.session_id === id && a.team_id === teamId && a.status !== 'reset');

describe('per-team shuffling (demo engine)', () => {
  it('different question orders over the same questions; options shuffled per team and question', () => {
    const { s, id, tid } = live();
    const atts = TEAMS.map((n) => attempt(s, id, tid(n)));
    const ids = sessionQuestions(setView(s, id)).map((q) => q.id).sort();
    for (const a of atts) {
      expect([...a.question_order].sort()).toEqual(ids);
      for (const p of a.option_orders) expect([...p].sort().join('')).toBe('ABCD');
    }
    expect(new Set(atts.map((a) => a.question_order.join())).size).toBe(TEAMS.length);
    expect(new Set(atts[0].option_orders).size).toBeGreaterThan(1);
    const per = (a) => Object.fromEntries(a.question_order.map((q, i) => [q, a.option_orders[i]]));
    expect(ids.filter((q) => per(atts[0])[q] !== per(atts[1])[q]).length).toBeGreaterThan(10);
  });

  it('refreshing and reconnecting keep the same order', () => {
    let { s, id, tok, tid, code } = live();
    const view = (st, token) => Array.from({ length: 30 }, (_, pos) => {
      const q = call(st, 'participantState', { token, position: pos }).result.question;
      return [q.id, q.option_a, q.option_b, q.option_c, q.option_d];
    });
    const first = view(s, tok[1]);
    expect(first.map((x) => x[0])).toEqual(attempt(s, id, tid(1)).question_order);
    expect(view(s, tok[1])).toEqual(first);
    s = run(s, 'revokeParticipant', { team_id: tid(1) }, id);
    const j = call(s, 'joinRegisteredTeam', { code, section: 'UG', team_number: 1 });
    expect(view(j.state, j.result.token)).toEqual(first);
  });

  it('every one of the 24 option arrangements maps the shown letter to the real key for scoring', () => {
    let { s, id, tok, tid } = live();
    const a = attempt(s, id, tid(2));
    const qid = a.question_order[0];
    const q = sessionQuestions(setView(s, id)).find((x) => x.id === qid);
    for (const perm of PERMS) {
      attempt(s, id, tid(2)).option_orders[0] = perm; // each action returns a new state: patch the current copy
      const shownQ = call(s, 'participantState', { token: tok[2], position: 0 }).result.question;
      for (const [i, shown] of [...'ABCD'].entries()) expect(shownQ[`option_${shown.toLowerCase()}`]).toBe(q[`option_${perm[i].toLowerCase()}`]);
      const right = 'ABCD'[perm.indexOf(q.correct_option)];
      const wrong = 'ABCD'[(perm.indexOf(q.correct_option) + 1) % 4];
      s = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: qid, option: right }).state;
      expect(s.answers.find((x) => x.team_id === tid(2) && x.question_id === qid), perm).toMatchObject({ selected_option: q.correct_option, result: 'correct', points: 1 });
      s = call(s, 'participantSubmit', { token: tok[2], request_id: req(), question_id: qid, option: wrong }).state;
      expect(s.answers.find((x) => x.team_id === tid(2) && x.question_id === qid), perm).toMatchObject({ result: 'incorrect', points: -0.25 });
    }
  });

  it('scoring is correct for each team\'s own random arrangement', () => {
    let { s, id, tok, tid } = live();
    const keys = new Map(sessionQuestions(setView(s, id)).map((q) => [q.id, q.correct_option]));
    for (const n of [3, 4, 5]) {
      const a = attempt(s, id, tid(n));
      a.question_order.forEach((qid, pos) => {
        const k = a.option_orders[pos].indexOf(keys.get(qid));
        s = call(s, 'participantSubmit', { token: tok[n], request_id: req(), question_id: qid, option: 'ABCD'[n === 5 ? (k + 1) % 4 : k] }).state;
      });
    }
    const rows = setResults(s, id, T0 + 1000);
    const row = (n) => rows.find((x) => x.team_id === tid(n));
    for (const n of [3, 4]) expect(row(n)).toMatchObject({ correct: 30, incorrect: 0, points: 30 });
    expect(row(5)).toMatchObject({ correct: 0, incorrect: 30, points: -7.5 });
  });
});
