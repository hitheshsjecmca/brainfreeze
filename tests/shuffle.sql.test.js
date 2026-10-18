// Per-team question and option shuffling against the real migrations in PGlite:
// every team gets its own stored question order and per-question option order;
// the order never changes on refresh or reconnect; the shown letter always maps
// back to the original option, so scoring is correct for every arrangement.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, ORG, selectTeams } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `5a5a5a5a-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const anon = async (fn, args = [], ip = '10.6.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const team = (num) => ({ team_number: num, team_name: `Shuffle ${num}`, participant_1: 'A', participant_2: 'B', college_name: 'X', section: 'UG' });
const teamId = async (num) => (await db.query(`select id from public.teams where section = 'UG' and team_number = $1`, [num])).rows[0].id;
const attemptOf = async (num) => (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2 and status <> 'reset'`, [set, await teamId(num)])).rows[0];
const results = async () => (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows;
const KEY_WORDS = /correct_option|explanation|"result"|"points"|SECRET/;
const TEAMS = [1, 2, 3, 4, 5, 6, 7];
/** All 24 orders of A–D. */
const PERMS = (function perms(rest = 'ABCD') {
  return rest.length <= 1 ? [rest] : [...rest].flatMap((c) => perms(rest.replace(c, '')).map((p) => c + p));
})();

let set;
let bank; // question rows with their original options and key
const tok = {};

beforeAll(async () => {
  db = await createDb();
  const items = Array.from({ length: 30 }, (_, i) => ({
    question_text: `Shuffle question ${i + 1}?`, option_a: `alpha ${i}`, option_b: `bravo ${i}`, option_c: `charlie ${i}`, option_d: `delta ${i}`,
    correct_option: 'ABCD'[(i * 7) % 4], explanation: `SECRET-${i}`,
  }));
  await org('import_questions', [items, false, false]);
  bank = (await db.query('select q.id, q.option_a, q.option_b, q.option_c, q.option_d, k.correct_option from public.questions q join public.question_keys k on k.question_id = q.id order by q.position')).rows;
  for (const i of TEAMS) await org('save_team', [team(i)]);
  set = await org('create_set', [{ name: 'Shuffle set', section: 'UG' }]);
  await org('update_quiz_details', [{ question_ids: bank.map((q) => q.id) }], set);
  const code = (await org('publish_quiz', [], set)).join_code;
  await selectTeams(db, set);
  for (const i of TEAMS) tok[i] = (await anon('join_registered_team', [code, 'UG', i, null], `10.6.1.${i}`)).token;
  await org('start_quiz', [], set);
  for (const i of TEAMS) await anon('participant_start', [tok[i]], `10.6.1.${i}`);
}, 90_000);

const byId = (id) => bank.find((q) => q.id === id);
const optionText = (q, letter) => q[`option_${letter.toLowerCase()}`];

describe('per-team shuffling (SQL)', () => {
  it('every team gets its own question order over exactly the same questions', async () => {
    const orders = await Promise.all(TEAMS.map((i) => attemptOf(i).then((a) => a.question_order)));
    const ids = bank.map((q) => q.id).sort();
    for (const o of orders) expect([...o].sort()).toEqual(ids);
    expect(new Set(orders.map((o) => o.join())).size).toBe(TEAMS.length); // 30! orders: a collision is practically impossible
  });

  it('options are shuffled independently per team and per question', async () => {
    const [a, b] = [await attemptOf(1), await attemptOf(2)];
    for (const p of [...a.option_orders, ...b.option_orders]) expect([...p].sort().join('')).toBe('ABCD');
    expect(new Set(a.option_orders).size).toBeGreaterThan(1); // not one order reused for every question
    const perQuestion = (x) => Object.fromEntries(x.question_order.map((q, i) => [q, x.option_orders[i]]));
    const pa = perQuestion(a);
    const pb = perQuestion(b);
    expect(bank.filter((q) => pa[q.id] !== pb[q.id]).length).toBeGreaterThan(10); // ~29 of 30 differ on average
  });

  it('refreshing or reconnecting never reshuffles: the device sees the same questions and options', async () => {
    const before = await attemptOf(3);
    const view = async () => {
      const out = [];
      for (let pos = 0; pos < 30; pos++) {
        const st = await anon('participant_state', [tok[3], pos], '10.6.1.3');
        out.push([st.question.id, st.question.option_a, st.question.option_b, st.question.option_c, st.question.option_d]);
      }
      return out;
    };
    const first = await view();
    expect(first.map((r) => r[0])).toEqual(before.question_order);
    expect(await view()).toEqual(first); // refresh
    await org('revoke_participant', [await teamId(3)], set); // device replaced: join again
    const code = (await db.query('select join_code from public.quiz_sessions where id = $1', [set])).rows[0].join_code;
    tok[3] = (await anon('join_registered_team', [code, 'UG', 3, 'replacement'], '10.6.1.3')).token;
    expect(await view()).toEqual(first);
    const after = await attemptOf(3);
    expect(after.question_order).toEqual(before.question_order);
    expect(after.option_orders).toEqual(before.option_orders);
  });

  it('for all 24 option arrangements the shown letter maps to the right option and is scored against the real key', async () => {
    const a = await attemptOf(4);
    const qid = a.question_order[0];
    const q = byId(qid);
    for (const perm of PERMS) {
      await db.query('update public.quiz_attempts set option_orders[1] = $1 where id = $2', [perm, a.id]);
      const st = await anon('participant_state', [tok[4], 0], '10.6.1.4');
      expect(JSON.stringify(st)).not.toMatch(KEY_WORDS); // the key is never sent to the device
      for (const [i, shown] of [...'ABCD'].entries()) expect(st.question[`option_${shown.toLowerCase()}`]).toBe(optionText(q, perm[i]));
      const right = 'ABCD'[perm.indexOf(q.correct_option)];
      const wrong = 'ABCD'[(perm.indexOf(q.correct_option) + 1) % 4];
      expect((await anon('participant_submit', [tok[4], rid(), qid, right], '10.6.1.4')).selected).toBe(right);
      let row = (await db.query('select selected_option, displayed_option, result, points from public.team_answers where team_id = $1 and question_id = $2', [await teamId(4), qid])).rows[0];
      expect(row, perm).toMatchObject({ selected_option: q.correct_option, displayed_option: right, result: 'correct' });
      expect(Number(row.points)).toBe(1);
      await anon('participant_submit', [tok[4], rid(), qid, wrong], '10.6.1.4');
      row = (await db.query('select selected_option, result, points from public.team_answers where team_id = $1 and question_id = $2', [await teamId(4), qid])).rows[0];
      expect(row, perm).toMatchObject({ selected_option: perm['ABCD'.indexOf(wrong)], result: 'incorrect' });
      expect(Number(row.points)).toBe(-0.25);
    }
  });

  it('scoring is correct for every team\'s own random arrangement', async () => {
    // teams 5 and 6 answer every question correctly through their own option order; team 7 answers every one wrongly
    for (const i of [5, 6, 7]) {
      const a = await attemptOf(i);
      for (const [pos, qid] of a.question_order.entries()) {
        const key = byId(qid).correct_option;
        const k = a.option_orders[pos].indexOf(key);
        const letter = 'ABCD'[i === 7 ? (k + 1) % 4 : k];
        expect((await anon('participant_submit', [tok[i], rid(), qid, letter], `10.6.1.${i}`)).ok).toBe(true);
      }
    }
    const rows = await results();
    const row = (num) => rows.find((r) => r.team_number === num);
    for (const i of [5, 6]) expect([row(i).correct, row(i).incorrect, Number(row(i).points)]).toEqual([30, 0, 30]);
    expect([row(7).correct, row(7).incorrect, Number(row(7).points)]).toEqual([0, 30, -7.5]);
  });
});
