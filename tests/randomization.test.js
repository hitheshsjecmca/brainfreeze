// Independent per-participant question order (demo engine and the real migrations in PGlite):
// each attempt's order is drawn on its own (not a rotation or reversal of one list, roughly uniform), stored with
// the attempt, unchanged by refresh together with the saved answers, and never changes the published set.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, setView } from '../src/lib/engine.js';
import { asRole, createDb, joinQuiz, ORG } from './helpers/db.js';

const T0 = Date.parse('2026-10-23T09:00:00Z');
let r = 0;
const req = () => `7d7d7d7d-0000-4000-8000-${String(++r).padStart(12, '0')}`;

/** Rotations and reversals of `ids` (what a naive "shuffle" would produce). */
const naiveOrders = (ids) => {
  const out = new Set();
  for (let i = 0; i < ids.length; i++) {
    const rot = [...ids.slice(i), ...ids.slice(0, i)];
    out.add(rot.join()); out.add([...rot].reverse().join());
  }
  return out;
};
/** How often each question comes first. */
const firstCounts = (orders) => orders.reduce((m, o) => ({ ...m, [o[0]]: (m[o[0]] || 0) + 1 }), {});

describe('independent question orders (demo engine)', () => {
  const call = (s, name, p = {}, setId = null, now = T0) => applyAction(s, name, p, setId ? { now, setId } : { now, section: 'UG' });
  const run = (...a) => call(...a).state;
  const N = 240;
  let s; let id; let ids; let tokens; let before;

  beforeAll(() => {
    s = createEmptyState(T0);
    const c = call(s, 'createSet', { name: 'Random set', section: 'UG' });
    id = c.result.id;
    s = c.state;
    for (let i = 1; i <= 4; i++) s = run(s, 'saveSetQuestion', { question_text: `R${i}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, option_count: 4, correct_option: 'ABCD'[i - 1] }, id);
    const pub = call(s, 'publishQuiz', {}, id);
    s = pub.state;
    ids = setView(s, id).session.question_ids;
    before = JSON.stringify([setView(s, id).session.question_ids, setView(s, id).set_questions]);
    tokens = [];
    for (let i = 0; i < N; i++) {
      const j = call(s, 'joinQuiz', { code: pub.result.join_code, full_name: `Player ${i}`, college_name: 'College', request_id: req() });
      s = j.state;
      tokens.push(j.result.token);
    }
  });

  it('every attempt gets its own complete order; orders vary like a real shuffle (not rotations/reversals)', () => {
    const orders = s.attempts.filter((a) => a.session_id === id).map((a) => a.question_order);
    expect(orders).toHaveLength(N);
    for (const o of orders) expect([...o].sort()).toEqual([...ids].sort());
    const distinct = new Set(orders.map((o) => o.join()));
    expect(distinct.size).toBeGreaterThan(naiveOrders(ids).size); // all 24 orders are reachable, not just 8
    expect(distinct.size).toBeGreaterThanOrEqual(20);
    // roughly uniform: each question first about N/4 = 60 times (bounds are > 6 standard deviations wide)
    for (const q of ids) expect(firstCounts(orders)[q]).toBeGreaterThan(20);
    for (const q of ids) expect(firstCounts(orders)[q]).toBeLessThan(100);
  });

  it('generating orders never changes the published set', () => {
    expect(JSON.stringify([setView(s, id).session.question_ids, setView(s, id).set_questions])).toBe(before);
  });

  it('a refresh keeps the order and the saved answers; scoring follows the question, not its position', () => {
    let st = run(s, 'startQuiz', {}, id);
    const token = tokens[0];
    st = call(st, 'participantStart', { token }).state;
    const view = (x) => [0, 1, 2, 3].map((pos) => call(x, 'participantState', { token, position: pos }, null, T0 + 2000).result);
    const first = view(st);
    const picks = {};
    for (const q of first) {
      picks[q.question.id] = 'BC'[q.question.number % 2];
      const sub = call(st, 'participantSubmit', { token, request_id: req(), question_id: q.question.id, option: picks[q.question.id] }, null, T0 + 3000);
      expect(sub.result.ok).toBe(true);
      st = sub.state;
    }
    const again = view(st);
    expect(again.map((q) => q.question.id)).toEqual(first.map((q) => q.question.id));
    expect(again.map((q) => [q.question.option_a, q.question.option_b, q.question.option_c, q.question.option_d]))
      .toEqual(first.map((q) => [q.question.option_a, q.question.option_b, q.question.option_c, q.question.option_d]));
    for (const q of again) expect(q.my_answer.selected).toBe(picks[q.question.id]);
    // each answer is stored against its question's original option
    const a = st.attempts.find((x) => x.session_id === id && x.team_id === st.teams.find((t) => t.participant_1 === 'Player 0').id);
    for (const q of again) {
      const row = st.answers.find((x) => x.attempt_id === a.id && x.question_id === q.question.id);
      const orig = a.option_orders[a.question_order.indexOf(q.question.id)]['ABCD'.indexOf(picks[q.question.id])];
      expect(row.selected_option).toBe(orig);
    }
  });
});

describe('independent question orders (SQL)', () => {
  let db; let set; let ids; let before; const tokens = [];
  const N = 60;
  const org = async (fn, args = []) =>
    (await asRole(db, 'authenticated', ORG, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args, { 'x-brainfreze-set': set })).rows[0].r;
  const anon = async (fn, args, ip) =>
    (await asRole(db, 'anon', null, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
  const frozen = async () => JSON.stringify([
    (await db.query('select question_ids from public.quiz_sessions where id = $1', [set])).rows[0].question_ids,
    (await db.query('select question_id, position, option_a, option_b, option_c, option_d, correct_option from public.set_questions where session_id = $1 order by position', [set])).rows,
  ]);

  beforeAll(async () => {
    db = await createDb();
    set = (await asRole(db, 'authenticated', ORG, 'select public.create_set($1) as r', [{ name: 'Random SQL set', section: 'UG' }])).rows[0].r;
    for (let i = 1; i <= 5; i++) {
      await org('save_set_question', [{ question_text: `S${i}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, option_count: 4, correct_option: 'ABCD'[i % 4] }]);
    }
    const code = (await org('publish_quiz')).join_code;
    ids = (await db.query('select question_ids from public.quiz_sessions where id = $1', [set])).rows[0].question_ids;
    before = await frozen();
    for (let i = 0; i < N; i++) tokens.push((await joinQuiz(db, code, `Player ${i}`, 'College', { ip: `10.77.${Math.floor(i / 200)}.${i % 200}` })).token);
  }, 120_000);

  it('every join stores its own complete order; orders vary like a real shuffle (not rotations/reversals)', async () => {
    const orders = (await db.query(`select question_order from public.quiz_attempts where session_id = $1 and status <> 'reset'`, [set])).rows.map((x) => x.question_order);
    expect(orders).toHaveLength(N);
    for (const o of orders) expect([...o].sort()).toEqual([...ids].sort());
    const distinct = new Set(orders.map((o) => o.join()));
    const naive = naiveOrders(ids);
    expect(distinct.size).toBeGreaterThan(naive.size); // 120 possible orders; ~47 distinct expected from 60 joins
    expect([...distinct].filter((o) => !naive.has(o)).length).toBeGreaterThan(20);
    for (const q of ids) expect(firstCounts(orders)[q] || 0).toBeGreaterThan(0);
  });

  it('generating orders never changes the published set', async () => {
    expect(await frozen()).toBe(before);
  });

  it('a refresh keeps the order and the saved answers', async () => {
    await org('start_quiz');
    const ip = '10.77.0.0';
    await anon('participant_start', [tokens[0]], ip);
    const view = async () => {
      const out = [];
      for (let pos = 0; pos < 5; pos++) out.push(await anon('participant_state', [tokens[0], pos], ip));
      return out;
    };
    const first = await view();
    const picks = {};
    for (const st of first) {
      picks[st.question.id] = 'ABCD'[st.question.number % 4];
      const res = await anon('participant_submit', [tokens[0], req(), st.question.id, picks[st.question.id]], ip);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    const again = await view();
    expect(again.map((x) => x.question.id)).toEqual(first.map((x) => x.question.id));
    expect(again.map((x) => x.question.option_a + x.question.option_b + x.question.option_c + x.question.option_d))
      .toEqual(first.map((x) => x.question.option_a + x.question.option_b + x.question.option_c + x.question.option_d));
    for (const st of again) expect(st.my_answer.selected).toBe(picks[st.question.id]);
    for (const st of again) expect(JSON.stringify(st)).not.toMatch(/correct_option/);
  });
});
