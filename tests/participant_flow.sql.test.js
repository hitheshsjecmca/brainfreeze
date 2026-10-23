// Round 1 participant flow against the real migrations in PGlite: participants join with the code and their own
// details (join_quiz, migration 17), then the server deadline, autosaved/changeable answers, automatic and early
// submission. Joining itself (validation, retries, devices) is covered in self_join.sql.test.js.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, joinQuiz, ORG } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `abababab-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const anon = async (fn, args = [], ip = '10.7.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
// Participant `num` joined the UG set as "Joiner num".
const teamId = async (section, num) => (await db.query('select id from public.teams where section = $1 and participant_1 = $2 and join_session_id is not null', [section, `Joiner ${num}`])).rows[0].id;
const attemptOf = async (set, section, num) => (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2 and status <> 'reset'`, [set, await teamId(section, num)])).rows[0];
const answersOf = async (set, section, num) => (await db.query('select question_id, selected_option, displayed_option, source from public.team_answers where session_id = $1 and team_id = $2', [set, await teamId(section, num)])).rows;
const keyOf = async (set, qid) => (await db.query('select correct_option from public.set_questions where session_id = $1 and question_id = $2', [set, qid])).rows[0].correct_option;
/** The letter team `a` sees for original option `orig` of question `qid`. */
const shown = (a, qid, orig) => 'ABCD'[a.option_orders[a.question_order.indexOf(qid)].indexOf(orig)];
const KEY_WORDS = /correct_option|explanation|"result"|"points"|SECRET|"pin"/;

let set;
let code;
let bank;

beforeAll(async () => {
  db = await createDb();
  const items = Array.from({ length: 4 }, (_, i) => ({
    question_text: `Flow question ${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`,
    correct_option: 'ABCD'[i], explanation: `SECRET-${i}`,
  }));
  await org('import_questions', [items, false, false]);
  bank = (await db.query('select id from public.questions order by position')).rows.map((r) => r.id);
  set = await org('create_set', [{ name: 'UG Flow', section: 'UG' }]);
  await org('update_quiz_details', [{ question_ids: bank }], set);
  await org('update_settings', [{ duration_seconds: 600 }], set);
  code = (await org('publish_quiz', [], set)).join_code;
}, 60_000);

describe('timer, autosave, automatic and early submission', () => {
  const tok = {};

  beforeAll(async () => {
    for (const i of [2, 3, 4]) tok[i] = (await joinQuiz(db, code, `Joiner ${i}`, 'Private College', { ip: `10.7.2.${i}` })).token;
    await org('start_quiz', [], set);
  });

  it('the timer starts when the team starts its attempt (not when the set goes live) and survives refreshes', async () => {
    expect((await attemptOf(set, 'UG', 2)).status).toBe('ready');
    const before = await anon('participant_state', [tok[2]]);
    expect(before.attempt).toMatchObject({ status: 'ready', deadline_at: null });
    expect(before.quiz.duration_seconds).toBe(600);
    await anon('participant_start', [tok[2]]);
    const a = await attemptOf(set, 'UG', 2);
    expect(Date.parse(a.deadline_at) - Date.parse(a.started_at)).toBe(600_000);
    await anon('participant_start', [tok[2]]); // pressing Start again (or refreshing) never moves the deadline
    const s2 = await anon('participant_state', [tok[2]]);
    expect(Date.parse(s2.attempt.deadline_at)).toBe(new Date(a.deadline_at).getTime());
    expect(s2.attempt.remaining_ms).toBeGreaterThan(590_000);
    expect(JSON.stringify(s2)).not.toMatch(KEY_WORDS);
  });

  it('answers autosave and can be changed until submission; every change is audited', async () => {
    const a = await attemptOf(set, 'UG', 2);
    const q = a.question_order[0];
    const r1 = await anon('participant_submit', [tok[2], rid(), q, 'A']);
    expect(r1).toMatchObject({ ok: true, selected: 'A' });
    const req = rid();
    const r2 = await anon('participant_submit', [tok[2], req, q, 'C']);
    expect(r2).toMatchObject({ ok: true, selected: 'C' });
    expect(await anon('participant_submit', [tok[2], req, q, 'C'])).toMatchObject({ ok: true, duplicate_request: true, selected: 'C' }); // retry
    expect(await anon('participant_submit', [tok[2], rid(), q, 'C'])).toMatchObject({ ok: true, selected: 'C' }); // same choice: no change
    const rows = await answersOf(set, 'UG', 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question_id: q, displayed_option: 'C', source: 'participant' });
    expect(rows[0].selected_option).toBe(a.option_orders[0][2]); // the original option behind the shown "C"
    const ev = (await db.query(`select action, source from public.score_events where session_id = $1 and team_id = $2 order by id`, [set, await teamId('UG', 2)])).rows;
    expect(ev).toEqual([{ action: 'record', source: 'participant' }, { action: 'correction', source: 'participant' }]);
    const st = await anon('participant_state', [tok[2], 0]);
    expect(st.my_answer.selected).toBe('C');
  });

  it('answers recorded by an organizer stay locked for the team', async () => {
    const a = await attemptOf(set, 'UG', 2);
    const q = a.question_order[1];
    await org('record_answer', [rid(), await teamId('UG', 2), q, 'B', false, null], set);
    expect((await anon('participant_submit', [tok[2], rid(), q, 'A'])).error).toBe('ALREADY_SUBMITTED');
  });

  it('at the deadline the attempt is submitted automatically, keeping every saved answer; late changes are refused', async () => {
    await anon('participant_start', [tok[3]]);
    const a = await attemptOf(set, 'UG', 3);
    const [q0, q1] = a.question_order;
    const k0 = await keyOf(set, q0);
    await anon('participant_submit', [tok[3], rid(), q0, shown(a, q0, k0)]);
    const wrong = shown(a, q1, 'ABCD'.replace(await keyOf(set, q1), '')[0]);
    await anon('participant_submit', [tok[3], rid(), q1, wrong]);
    // the deadline passes with nobody pressing anything
    await db.query(`update public.quiz_attempts set started_at = started_at - interval '11 minutes', deadline_at = deadline_at - interval '11 minutes' where id = $1`, [a.id]);
    expect(await anon('participant_submit', [tok[3], rid(), q1, 'A'])).toEqual({ ok: false, error: 'TIME_EXPIRED' });
    const st = await anon('participant_state', [tok[3]]);
    expect(st.attempt.status).toBe('timed_out');
    expect(await anon('participant_finish', [tok[3]])).toMatchObject({ ok: true, status: 'timed_out' }); // a late Submit changes nothing
    const fin = await attemptOf(set, 'UG', 3);
    expect(new Date(fin.finished_at).getTime()).toBe(new Date(fin.deadline_at).getTime());
    const rows = await answersOf(set, 'UG', 3);
    expect(rows.map((r) => r.question_id).sort()).toEqual([q0, q1].sort());
    expect(rows.find((r) => r.question_id === q1).displayed_option).toBe(wrong);
    const res = (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows.find((r) => r.team_name === 'Joiner 3');
    expect(res).toMatchObject({ attempt_status: 'timed_out', correct: 1, incorrect: 1 });
    expect(Number(res.unanswered)).toBe(2); // the questions never answered count as unanswered
  });

  it('early submission records the server time once; afterwards answers are locked and duplicates change nothing', async () => {
    await anon('participant_start', [tok[4]]);
    const a = await attemptOf(set, 'UG', 4);
    await anon('participant_submit', [tok[4], rid(), a.question_order[0], 'B']);
    const fin = await anon('participant_finish', [tok[4]]);
    expect(fin).toMatchObject({ ok: true, status: 'submitted' });
    expect(await anon('participant_finish', [tok[4]])).toEqual(fin);
    expect(await anon('participant_submit', [tok[4], rid(), a.question_order[0], 'C'])).toEqual({ ok: false, error: 'ATTEMPT_FINISHED' });
    expect(await anon('participant_submit', [tok[4], rid(), a.question_order[1], 'C'])).toEqual({ ok: false, error: 'ATTEMPT_FINISHED' });
    expect((await answersOf(set, 'UG', 4))[0].displayed_option).toBe('B');
  });
});
