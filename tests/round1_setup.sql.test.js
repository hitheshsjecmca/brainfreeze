// Round 1 setup simplification against the real migrations in PGlite:
// publish_quiz accepts any number of complete MCQs (at least one), refuses empty sets
// and incomplete questions, and every team's deadline uses the organizer's chosen
// time limit (here 7.5 minutes — outside the old 5–120 minute range is fine too).
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, joinQuiz, joinedTeam, ORG } from './helpers/db.js';
import { migrationFiles } from './helpers/db.js';
import { OUTDATED_DATABASE_MESSAGE, toQuizError } from '../src/lib/errors.js';

let db;
let n = 0;
const rid = () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const anon = async (fn, args = [], ip = '10.9.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const team = (num) => ({ team_number: num, team_name: `UG Team ${num}`, participant_1: 'A', participant_2: 'B', college_name: 'MCA College', section: 'UG' });
const mcq = (i) => ({ question_text: `Bank question ${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'ABCD'[i % 4] });
const frozenCount = async (set) => (await db.query('select count(*)::int c from public.set_questions where session_id = $1', [set])).rows[0].c;

let bank;

/** A draft with exactly these bank questions; returns its id. */
async function draft(name, questionIds) {
  const id = await org('create_set', [{ name, section: 'UG' }]);
  if (questionIds) await org('update_quiz_details', [{ question_ids: questionIds }], id);
  return id;
}

beforeAll(async () => {
  db = await createDb();
  for (const i of [1, 2]) await org('save_team', [team(i)]);
}, 60_000);

describe('publish_quiz question-count rules (latest migrations)', () => {
  it('the Round 1 simplification migration is part of the migration history', () => {
    expect(migrationFiles()).toContain('20261018000100_round1_simplify_setup.sql');
  });

  it('publishing with zero questions fails', async () => {
    const empty = await draft('Empty', null); // empty bank → the set has no questions
    expect(await errCode(org('publish_quiz', [], empty))).toBe('QUESTION_COUNT');
    await org('delete_set', [empty]);
  });

  it('publishing with 1, 2 and 65 (more than 60) valid questions succeeds', async () => {
    await org('import_questions', [Array.from({ length: 65 }, (_, i) => mcq(i)), false, false]);
    bank = (await db.query('select id from public.questions order by position')).rows.map((r) => r.id);
    for (const count of [1, 2, 65]) {
      const set = await draft(`${count} questions`, bank.slice(0, count));
      const r = await org('publish_quiz', [], set);
      expect(r.join_code, `${count} questions`).toMatch(/^\d{6}$/);
      expect(await frozenCount(set)).toBe(count);
      await org('archive_set', [set, 'test cleanup']);
    }
  });

  it('publishing with an incomplete or invalid MCQ fails', async () => {
    // a question without an answer key
    const set = await draft('Missing key', bank.slice(10, 12));
    await db.query('delete from public.question_keys where question_id = $1', [bank[11]]);
    expect(await errCode(org('publish_quiz', [], set))).toBe('QUIZ_NOT_READY');
    expect(await frozenCount(set)).toBe(0);
    await db.query(`insert into public.question_keys (question_id, correct_option) values ($1, 'D')`, [bank[11]]);
    // invalid per-question marks (positive marks for a wrong answer) cannot even be stored
    await expect(db.query('update public.questions set marks_incorrect = 1 where id = $1', [bank[10]])).rejects.toThrow(/marks_incorrect/);
    // incomplete MCQs never reach the bank: missing options, duplicate options, no key
    expect(await errCode(org('save_question', [{ ...mcq(500), option_c: '' }]))).toBe('VALIDATION'); // a gap (C empty, D filled)
    expect(await errCode(org('save_question', [{ ...mcq(503), option_b: '', option_c: '', option_d: '' }]))).toBe('VALIDATION'); // one option only
    expect(await errCode(org('save_question', [{ ...mcq(501), option_b: 'a501' }]))).toBe('VALIDATION');
    expect(await errCode(org('save_question', [{ ...mcq(502), correct_option: 'E' }]))).toBe('VALIDATION');
    // once fixed, the same set publishes
    expect((await org('publish_quiz', [], set)).join_code).toMatch(/^\d{6}$/);
    await org('archive_set', [set, 'test cleanup']);
  });

  it('a database without the new migration is explained instead of shown raw', () => {
    const e = toQuizError(new Error('QUESTION_COUNT: A set must have 30 to 60 questions to be published (it has 2).'));
    expect(e).toMatchObject({ code: 'QUESTION_COUNT', message: OUTDATED_DATABASE_MESSAGE });
    expect(toQuizError(new Error('QUESTION_COUNT: Add at least one question before publishing.')).message).toBe('Add at least one question before publishing.');
  });
});

describe('two-question Round 1 set with a custom time limit', () => {
  let set;
  let code;
  const tok = {};

  it('an invalid duration is refused; a two-question set with 7.5 minutes publishes', async () => {
    set = await draft('Lightning round', [bank[20], bank[21]]);
    expect(await errCode(org('update_settings', [{ duration_seconds: 0 }], set))).toBe('VALIDATION');
    await org('update_settings', [{ duration_seconds: 450, marks_incorrect: -0.5 }], set);
    code = (await org('publish_quiz', [], set)).join_code;
    expect(code).toMatch(/^\d{6}$/);
    const snap = (await db.query('select question_id, marks_incorrect from public.set_questions where session_id = $1 order by position', [set])).rows;
    expect(snap.map((r) => r.question_id)).toEqual([bank[20], bank[21]]);
    expect(snap.every((r) => Number(r.marks_incorrect) === -0.5)).toBe(true);
    const settings = (await db.query('select duration_seconds from public.quiz_settings where session_id = $1', [set])).rows[0];
    expect(settings.duration_seconds).toBe(450);
  });

  it('a team joins with the code, gets a deadline from the chosen duration, answers, submits and is ranked', async () => {
    for (const i of [1, 2]) {
      const r = await joinQuiz(db, code, `Runner ${i}`, 'MCA College', { ip: `10.9.0.${i}` });
      expect(r.ok).toBe(true);
      tok[i] = r.token;
    }
    const teamId = async (i) => (await joinedTeam(db, set, `Runner ${i}`)).id;
    await org('start_quiz', [], set);
    await anon('participant_start', [tok[1]], '10.9.0.1');
    const a = (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2`, [set, await teamId(1)])).rows[0];
    expect([...a.question_order].sort()).toEqual([bank[20], bank[21]].sort());
    expect(Date.parse(a.deadline_at) - Date.parse(a.started_at)).toBe(450_000);
    const keyOf = async (qid) => (await db.query('select correct_option from public.set_questions where session_id = $1 and question_id = $2', [set, qid])).rows[0].correct_option;
    const [q0, q1] = a.question_order;
    const shown = (qid, orig) => 'ABCD'[a.option_orders[a.question_order.indexOf(qid)].indexOf(orig)];
    const k1 = await keyOf(q1);
    expect((await anon('participant_submit', [tok[1], rid(), q0, shown(q0, await keyOf(q0))], '10.9.0.1')).ok).toBe(true);
    expect((await anon('participant_submit', [tok[1], rid(), q1, shown(q1, 'ABCD'.replace(k1, '')[0])], '10.9.0.1')).ok).toBe(true);
    expect(await anon('participant_finish', [tok[1]], '10.9.0.1')).toMatchObject({ ok: true, status: 'submitted' });
    const rows = (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows;
    const r1 = rows.find((r) => r.team_name === 'Runner 1');
    expect(Number(r1.points)).toBe(0.5); // +1 − 0.5
    expect(r1.attempt_status).toBe('submitted');
    expect(Number(r1.rank)).toBe(1);
    // a team that never started is counted at the full chosen time limit
    expect(Number(rows.find((r) => r.team_name === 'Runner 2').elapsed_ms)).toBe(450_000);
  });
});
