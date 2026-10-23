// Demo-engine mirror of migration 17: fresh sets, copy-imports from previous sets, Save & Next and 2–6 options
// through attempts, shuffling, scoring and results.
import { describe, expect, it } from 'vitest';
import { applyAction, createDemoState, createEmptyState, sessionQuestions, setResults, setView } from '../src/lib/engine.js';

const T0 = Date.parse('2026-10-23T09:00:00Z');
let r = 0;
const req = () => `f7f7f7f7-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const call = (s, name, p = {}, setId = null, now = T0) => applyAction(s, name, p, setId ? { now, setId } : { now, section: 'UG' });
const run = (...a) => call(...a).state;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const q = (text, n, key = 'A') => ({ question_text: text, ...Object.fromEntries([...'abcdef'].slice(0, n).map((l) => [`option_${l}`, `${text} ${l}`])), option_count: n, correct_option: key });
const ids = (s, id) => sessionQuestions(setView(s, id)).map((x) => x.id);

function withPrevious() {
  let s = createDemoState(T0); // demo data: a 30-question bank and teams
  const c = call(s, 'createSet', { name: 'Previous', section: 'UG' });
  const prev = c.result.id;
  s = c.state;
  for (const [t, n, k] of [['P1', 4, 'B'], ['P2', 2, 'A'], ['P3', 6, 'F']]) s = run(s, 'saveSetQuestion', q(t, n, k), prev);
  const pub = call(s, 'publishQuiz', {}, prev);
  return { s: pub.state, prev, prevIds: ids(pub.state, prev) };
}

describe('fresh quiz sets (demo engine)', () => {
  it('a new set starts empty even when a bank and previous sets exist; previous sets are unchanged', () => {
    const { s, prev, prevIds } = withPrevious();
    expect(s.questions.length).toBeGreaterThan(30);
    const c = call(s, 'createSet', { name: 'New', section: 'UG' });
    expect(ids(c.state, c.result.id)).toEqual([]);
    expect(ids(c.state, prev)).toEqual(prevIds);
    expect(code(() => call(c.state, 'publishQuiz', {}, c.result.id))).toBe('QUESTION_COUNT');
  });

  it('Save & Next saves and adds each new question; the count updates after saving, editing and deleting', () => {
    let s = createEmptyState(T0);
    const c = call(s, 'createSet', { name: 'Draft', section: 'UG' });
    const id = c.result.id;
    s = c.state;
    const r1 = call(s, 'saveSetQuestion', q('One', 4), id);
    expect(r1.result).toMatchObject({ added: true, count: 1 });
    const r2 = call(r1.state, 'saveSetQuestion', q('Two', 2), id);
    expect(r2.result).toMatchObject({ added: true, count: 2 });
    s = r2.state;
    expect(code(() => call(s, 'saveSetQuestion', { ...q('Bad', 3), correct_option: 'D' }, id))).toBe('VALIDATION'); // nothing saved
    expect(ids(s, id)).toHaveLength(2);
    expect(call(s, 'saveSetQuestion', { ...q('One edited', 4), id: r1.result.id }, id).result).toMatchObject({ added: false, count: 2 });
    s = run(s, 'updateQuizDetails', { question_ids: [r2.result.id] }, id);
    expect(ids(s, id)).toHaveLength(1);
  });
});

describe('importing from previous sets (demo engine)', () => {
  it('lists other sets, copies chosen questions with options and keys, and never modifies the originals', () => {
    const { s: s0, prev, prevIds } = withPrevious();
    const c = call(s0, 'createSet', { name: 'Target', section: 'UG' });
    const id = c.result.id;
    let s = c.state;
    const list = call(s, 'previousSetQuestions', {}, id).result;
    expect(list.find((x) => x.set_id === prev).questions.map((x) => x.option_count)).toEqual([4, 2, 6]);
    expect(list.some((x) => x.set_id === id)).toBe(false);
    const before = JSON.stringify([s.questions.filter((x) => prevIds.includes(x.id)), setView(s, prev).set_questions]);
    const imp = call(s, 'importSetQuestions', { items: [{ set_id: prev, question_id: prevIds[2] }, { set_id: prev, question_id: prevIds[2] }] }, id);
    expect(imp.result).toMatchObject({ imported: 1, skipped: 1, count: 1 });
    s = imp.state;
    const copy = s.questions.find((x) => x.id === imp.result.ids[0]);
    expect(copy).toMatchObject({ source_question_id: prevIds[2], option_f: 'P3 f', correct_option: 'F' });
    s = run(s, 'saveSetQuestion', { ...q('Copy edited', 3, 'C'), id: copy.id }, id);
    expect(JSON.stringify([s.questions.filter((x) => prevIds.includes(x.id)), setView(s, prev).set_questions])).toBe(before);
    // a second import of the same question is skipped
    expect(call(s, 'importSetQuestions', { items: [{ set_id: prev, question_id: prevIds[2] }] }, id).result).toMatchObject({ imported: 0, skipped: 1 });
    expect(code(() => call(s, 'importSetQuestions', { items: [{ set_id: prev, question_id: prevIds[0] }] }, prev))).toBe('SET_FROZEN');
  });
});

describe('2–6 options through play and scoring (demo engine)', () => {
  it('each participant gets every question with its own options shuffled; letters beyond them are refused; scoring is correct', () => {
    const { s: s0, prev } = withPrevious();
    const set = setView(s0, prev).session;
    const j = call(s0, 'joinQuiz', { code: set.join_code, full_name: 'Asha', college_name: 'SJEC', request_id: req() });
    let s = run(j.state, 'startQuiz', {}, prev);
    s = call(s, 'participantStart', { token: j.result.token }).state;
    const team = s.teams.find((t) => t.participant_1 === 'Asha');
    const a = s.attempts.find((x) => x.team_id === team.id);
    const byId = new Map(sessionQuestions(setView(s, prev)).map((x) => [x.id, x]));
    a.question_order.forEach((qid, i) => expect(a.option_orders[i]).toHaveLength(byId.get(qid).option_e ? 6 : byId.get(qid).option_c ? 4 : 2));
    for (let pos = 0; pos < 3; pos++) {
      const st = call(s, 'participantState', { token: j.result.token, position: pos }).result;
      const len = a.option_orders[pos].length;
      expect(st.question.option_count).toBe(len);
      expect(Object.keys(st.question).filter((k) => /^option_[a-f]$/.test(k))).toHaveLength(len);
      expect(JSON.stringify(st)).not.toMatch(/correct_option/);
      if (len < 6) expect(call(s, 'participantSubmit', { token: j.result.token, request_id: req(), question_id: st.question.id, option: 'ABCDEF'[len] }).result.error).toBe('INVALID_OPTION');
      const shown = 'ABCDEF'[a.option_orders[pos].indexOf(byId.get(st.question.id).correct_option)];
      s = call(s, 'participantSubmit', { token: j.result.token, request_id: req(), question_id: st.question.id, option: shown }).state;
    }
    const row = setResults(s, prev).find((x) => x.team_id === team.id);
    expect(row).toMatchObject({ correct: 3, points: 3, rank: 1, team_name: 'Asha' });
    // paper entry: an option the question does not have is refused
    const two = [...byId.values()].find((x) => !x.option_c);
    expect(code(() => call(s, 'recordAnswer', { request_id: req(), team_id: team.id, question_id: two.id, selected: 'D', correction: true, reason: 'x' }, prev))).toBe('INVALID_OPTION');
  });
});
