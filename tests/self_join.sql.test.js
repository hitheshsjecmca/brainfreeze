// Migration 17 against the real migrations in PGlite: fresh quiz sets, explicit copy-imports from previous sets,
// Save & Next, 2–6 answer options end to end, and participant self-join with a verified code (no pre-registration).
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, joinQuiz, joinedTeam, ORG, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `17171717-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const anon = async (fn, args = [], ip = '10.17.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const setIds = async (set) => (await db.query('select question_ids from public.quiz_sessions where id = $1', [set])).rows[0].question_ids;
const question = async (id) => (await db.query('select q.*, k.correct_option from public.questions q left join public.question_keys k on k.question_id = q.id where q.id = $1', [id])).rows[0];
const opts = (count, tag = 'x') => Object.fromEntries('abcdef'.slice(0, count).split('').map((l) => [`option_${l}`, `${tag} ${l}`]));
const KEY_WORDS = /correct_option|explanation|"result"|"points"|SECRET/;

let previous; // a published set with 3 questions
let prevIds;

beforeAll(async () => {
  db = await createDb();
  previous = await org('create_set', [{ name: 'Morning (previous)', section: 'UG' }]);
  for (const [i, count] of [[1, 4], [2, 2], [3, 6]].entries()) {
    await org('save_set_question', [{ question_text: `Previous question ${count[0]}?`, ...opts(count[1], `p${i}`), option_count: count[1], correct_option: 'B', explanation: 'SECRET' }], previous);
  }
  prevIds = await setIds(previous);
  await org('publish_quiz', [], previous);
}, 60_000);

describe('fresh sets and Save & Next', () => {
  it('a new set starts with no questions even when previous sets and a bank exist', async () => {
    expect((await db.query('select count(*)::int c from public.questions')).rows[0].c).toBe(3);
    const fresh = await org('create_set', [{ name: 'Fresh', section: 'UG' }]);
    expect(await setIds(fresh)).toEqual([]);
    expect((await db.query('select count(*)::int c from public.set_questions where session_id = $1', [fresh])).rows[0].c).toBe(0);
    expect(await errCode(org('publish_quiz', [], fresh))).toBe('QUESTION_COUNT');
    expect(await setIds(previous)).toEqual(prevIds); // the previous set is untouched
    await org('delete_set', [fresh]);
  });

  it('save_set_question saves a new question and adds it to the draft in one step; the count follows', async () => {
    const s = await org('create_set', [{ name: 'Save & Next', section: 'UG' }]);
    const r1 = await org('save_set_question', [{ question_text: 'One?', ...opts(4), option_count: 4, correct_option: 'A' }], s);
    expect(r1).toMatchObject({ added: true, count: 1 });
    const r2 = await org('save_set_question', [{ question_text: 'Two?', ...opts(3), option_count: 3, correct_option: 'C' }], s);
    expect(r2).toMatchObject({ added: true, count: 2 });
    expect(await setIds(s)).toEqual([r1.id, r2.id]);
    // a failed save stores nothing and keeps the count
    expect(await errCode(org('save_set_question', [{ question_text: '', ...opts(4), correct_option: 'A' }], s))).toBe('VALIDATION');
    expect(await setIds(s)).toHaveLength(2);
    // editing keeps the list (and the count); removing a question from the draft updates it
    expect(await org('save_set_question', [{ id: r1.id, question_text: 'One (edited)?', ...opts(4), option_count: 4, correct_option: 'D' }], s)).toMatchObject({ added: false, count: 2 });
    await org('update_quiz_details', [{ question_ids: [r2.id] }], s);
    expect(await setIds(s)).toEqual([r2.id]);
    // a published set never gets new questions this way
    expect(await errCode(org('save_set_question', [{ question_text: 'Late?', ...opts(2), correct_option: 'A' }], previous))).toBe('SET_FROZEN');
    await org('archive_set', [s, 'cleanup']);
  });
});

describe('importing questions from previous sets', () => {
  let target;

  it('lists the other sets with their (frozen) questions; organizers only', async () => {
    target = await org('create_set', [{ name: 'Afternoon (new)', section: 'UG' }]);
    const list = await org('previous_set_questions', [], target);
    const prev = list.find((x) => x.set_id === previous);
    expect(prev).toMatchObject({ name: 'Morning (previous)', stage: 'published' });
    expect(prev.questions.map((q) => q.option_count)).toEqual([4, 2, 6]);
    expect(list.some((x) => x.set_id === target)).toBe(false); // never the set being edited
    expect(await errCode(asRole(db, 'authenticated', STRANGER, 'select public.previous_set_questions()'))).toBe('NOT_AUTHORIZED');
    expect(await errCode(asRole(db, 'anon', null, 'select public.previous_set_questions()'))).toMatch(/permission denied/);
  });

  it('copies the chosen questions with their options and key; the originals and their set never change', async () => {
    const before = await Promise.all(prevIds.map(question));
    const r = await org('import_set_questions', [[{ set_id: previous, question_id: prevIds[0] }, { set_id: previous, question_id: prevIds[2] }]], target);
    expect(r).toMatchObject({ imported: 2, skipped: 0, count: 2 });
    const ids = await setIds(target);
    expect(ids).toEqual(r.ids);
    expect(ids.some((id) => prevIds.includes(id))).toBe(false); // new questions, not references
    const copy = await question(ids[1]);
    expect(copy).toMatchObject({ source_question_id: prevIds[2], option_f: 'p2 f', correct_option: 'B' });
    // editing the copy leaves the original question and the published set unchanged
    await org('save_set_question', [{ id: copy.id, question_text: 'Edited copy?', ...opts(5, 'new'), option_count: 5, correct_option: 'E' }], target);
    expect(await Promise.all(prevIds.map(question))).toEqual(before);
    expect(await setIds(previous)).toEqual(prevIds);
    expect((await db.query('select question_text from public.set_questions where session_id = $1 order by position', [previous])).rows.map((x) => x.question_text))
      .toEqual(['Previous question 1?', 'Previous question 2?', 'Previous question 3?']);
  });

  it('duplicate imports into the same set are skipped', async () => {
    const r = await org('import_set_questions', [[{ set_id: previous, question_id: prevIds[0] }, { set_id: previous, question_id: prevIds[1] }, { set_id: previous, question_id: prevIds[1] }]], target);
    expect(r).toMatchObject({ imported: 1, skipped: 2, count: 3 });
    // a copy of a copy is recognised as the same original
    const other = await org('create_set', [{ name: 'Evening', section: 'UG' }]);
    await org('import_set_questions', [[{ set_id: target, question_id: (await setIds(target))[0] }]], other);
    const r2 = await org('import_set_questions', [[{ set_id: previous, question_id: prevIds[0] }]], other);
    expect(r2).toMatchObject({ imported: 0, skipped: 1 });
    expect(await errCode(org('import_set_questions', [[{ set_id: target, question_id: prevIds[0] }]], other))).toBe('QUESTION_NOT_IN_QUIZ');
    expect(await errCode(org('import_set_questions', [[{ set_id: previous, question_id: prevIds[0] }]], previous))).toBe('SET_FROZEN'); // published: frozen
    expect(await errCode(org('import_set_questions', [[{ set_id: other, question_id: (await setIds(other))[0] }]], other))).toBe('VALIDATION'); // from itself
    expect(await errCode(asRole(db, 'anon', null, `select public.import_set_questions('[]')`))).toMatch(/permission denied/);
    await org('delete_set', [other]);
  });
});

describe('2–6 answer options', () => {
  it('stores 2, 3, 4, 5 and 6 options; refuses 1, 7, gaps and a key outside the options', async () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const { id } = await org('save_question', [{ question_text: `Count ${count}?`, ...opts(count, `c${count}`), option_count: count, correct_option: 'ABCDEF'[count - 1] }]);
      const q = await question(id);
      expect(['a', 'b', 'c', 'd', 'e', 'f'].filter((l) => q[`option_${l}`] !== null)).toHaveLength(count);
    }
    expect(await errCode(org('save_question', [{ question_text: 'One?', option_a: 'only', correct_option: 'A' }]))).toBe('VALIDATION');
    expect(await errCode(org('save_question', [{ question_text: 'Seven?', ...opts(6), option_count: 7, correct_option: 'A' }]))).toBe('VALIDATION');
    expect(await errCode(org('save_question', [{ question_text: 'Gap?', option_a: 'a', option_b: 'b', option_d: 'd', correct_option: 'A' }]))).toBe('VALIDATION');
    expect(await errCode(org('save_question', [{ question_text: 'Key?', ...opts(3), option_count: 3, correct_option: 'D' }]))).toBe('VALIDATION');
    // removed options are never stored: option_count drops anything after it
    const { id } = await org('save_question', [{ question_text: 'Trim?', ...opts(6), option_count: 3, correct_option: 'C' }]);
    expect(await question(id)).toMatchObject({ option_c: 'x c', option_d: null, option_e: null, option_f: null });
    const six = (await db.query(`select id from public.questions where question_text = 'Count 6?'`)).rows[0].id;
    await expect(db.query(`update public.questions set option_c = null where id = $1`, [six])).rejects.toThrow(/contiguous/); // no gaps, even directly
  });
});

describe('participant self-join with a verified code', () => {
  let set;
  let code;
  const tok = {};

  beforeAll(async () => {
    set = await org('create_set', [{ name: 'Live set', section: 'PG' }]);
    await org('import_set_questions', [prevIds.map((question_id) => ({ set_id: previous, question_id }))], set);
    await org('update_settings', [{ duration_seconds: 600 }], set);
    code = (await org('publish_quiz', [], set)).join_code;
  });

  it('the code verifies the section; invalid, unpublished and ended codes are refused', async () => {
    expect((await anon('join_lookup', [code])).quiz).toMatchObject({ section: 'PG', total_questions: 3 });
    expect((await joinQuiz(db, '000000', 'Asha', 'X College', { ip: '10.17.1.1' })).error).toBe('INVALID_CODE');
    expect((await joinQuiz(db, code, 'Asha', 'X College', { ip: '10.17.1.1', section: 'UG' }))).toMatchObject({ ok: false, error: 'SECTION_MISMATCH', section: 'PG' });
    const ended = await org('create_set', [{ name: 'Ended', section: 'PG' }]);
    await org('import_set_questions', [[{ set_id: previous, question_id: prevIds[1] }]], ended);
    const endedCode = (await org('publish_quiz', [], ended)).join_code;
    await org('start_quiz', [], ended);
    await org('end_quiz', [], ended);
    expect((await joinQuiz(db, endedCode, 'Asha', 'X College', { ip: '10.17.1.1' })).error).toBe('INVALID_CODE');
  });

  it('name and college are required, trimmed and length-checked', async () => {
    expect(await joinQuiz(db, code, '   ', 'X College', { ip: '10.17.2.1' })).toMatchObject({ ok: false, error: 'VALIDATION', field: 'full_name' });
    expect(await joinQuiz(db, code, 'Asha', '', { ip: '10.17.2.1' })).toMatchObject({ ok: false, error: 'VALIDATION', field: 'college_name' });
    expect((await joinQuiz(db, code, 'a'.repeat(81), 'X College', { ip: '10.17.2.1' })).error).toBe('VALIDATION');
    expect((await joinQuiz(db, code, 'Asha', 'c'.repeat(121), { ip: '10.17.2.1' })).error).toBe('VALIDATION');
    expect((await joinQuiz(db, code, '<b>Asha</b>', 'X College', { ip: '10.17.2.1' })).error).toBe('VALIDATION');
    expect((await db.query('select count(*)::int c from public.teams where join_session_id = $1', [set])).rows[0].c).toBe(0);
  });

  it('a participant joins without pre-registration; their name, college, section and attempt are stored', async () => {
    const r = await joinQuiz(db, code, '  Asha   Rao ', ' St Joseph  College ', { ip: '10.17.3.1', section: 'PG' });
    expect(r).toMatchObject({ ok: true, section: 'PG', resumed: false, team: { participant_1: 'Asha Rao', college_name: 'St Joseph College', section: 'PG', self_joined: true } });
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    tok.asha = r.token;
    const t = await joinedTeam(db, set, 'Asha Rao');
    expect(t).toMatchObject({ section: 'PG', college_name: 'St Joseph College', participant_2: null, self_registered: true });
    expect((await db.query('select team_ids from public.quiz_sessions where id = $1', [set])).rows[0].team_ids).toEqual([t.id]);
    const a = (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2`, [set, t.id])).rows;
    expect(a).toHaveLength(1);
    // each question's option order has exactly that question's own options (4, 2 and 6)
    const counts = new Map((await db.query('select question_id, option_a, option_c, option_e from public.set_questions where session_id = $1', [set])).rows
      .map((q) => [q.question_id, q.option_e ? 6 : q.option_c ? 4 : 2]));
    a[0].question_order.forEach((qid, i) => {
      expect(a[0].option_orders[i]).toHaveLength(counts.get(qid));
      expect([...a[0].option_orders[i]].sort().join('')).toBe('ABCDEF'.slice(0, counts.get(qid)));
    });
  });

  it('a retried request never creates a second entry or attempt; another device is refused until released', async () => {
    const request = rid();
    const first = await joinQuiz(db, code, 'Ravi', 'MCA College', { ip: '10.17.4.1', request });
    const retry = await joinQuiz(db, code, 'Ravi', 'MCA College', { ip: '10.17.4.1', request });
    expect(retry).toMatchObject({ ok: true, resumed: true });
    expect((await anon('participant_state', [first.token])).ok).toBe(false); // the lost answer's token is replaced
    tok.ravi = retry.token;
    const t = await joinedTeam(db, set, 'Ravi');
    expect((await db.query('select count(*)::int c from public.teams where join_session_id = $1 and participant_1 = $2', [set, 'Ravi'])).rows[0].c).toBe(1);
    expect((await db.query(`select count(*)::int c from public.quiz_attempts where team_id = $1 and status <> 'reset'`, [t.id])).rows[0].c).toBe(1);
    expect(await joinQuiz(db, code, 'RAVI', 'mca college', { ip: '10.17.4.2' })).toMatchObject({ ok: false, error: 'ALREADY_JOINED' });
    expect((await joinQuiz(db, code, 'Ravi', 'Other College', { ip: '10.17.4.1', request })).error).toBe('VALIDATION'); // same request, other details
  });

  it('participants wait for Go live; timers, answers, own options and refresh recovery work; the key is never sent', async () => {
    const lobby = await anon('participant_state', [tok.asha], '10.17.3.1');
    expect(lobby).toMatchObject({ ok: true, quiz: { status: 'setup', section: 'PG' }, attempt: { status: 'ready' } });
    expect(lobby.question).toBeUndefined();
    expect((await anon('participant_start', [tok.asha], '10.17.3.1')).error).toBe('NOT_STARTED_YET');
    await org('start_quiz', [], set);
    await anon('participant_start', [tok.asha], '10.17.3.1');
    const t = await joinedTeam(db, set, 'Asha Rao');
    const a = (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2`, [set, t.id])).rows[0];
    expect(Date.parse(a.deadline_at) - Date.parse(a.started_at)).toBe(600_000);
    for (let pos = 0; pos < 3; pos++) {
      const st = await anon('participant_state', [tok.asha, pos], '10.17.3.1');
      const len = a.option_orders[pos].length;
      expect(st.question.option_count).toBe(len);
      expect(Object.keys(st.question).filter((k) => /^option_[a-f]$/.test(k))).toHaveLength(len);
      expect(JSON.stringify(st)).not.toMatch(KEY_WORDS);
      // a letter beyond this question's options is refused
      const beyond = 'ABCDEFG'[len];
      if (len < 6) expect((await anon('participant_submit', [tok.asha, rid(), st.question.id, beyond], '10.17.3.1')).error).toBe('INVALID_OPTION');
      // answer correctly through the participant's own option order
      const key = (await db.query('select correct_option from public.set_questions where session_id = $1 and question_id = $2', [set, st.question.id])).rows[0].correct_option;
      const shown = 'ABCDEF'[a.option_orders[pos].indexOf(key)];
      expect((await anon('participant_submit', [tok.asha, rid(), st.question.id, shown], '10.17.3.1')).ok).toBe(true);
    }
    // refresh recovery: a rejoin after release keeps the attempt and its deadline
    await org('revoke_participant', [t.id], set);
    const back = await joinQuiz(db, code, 'Asha Rao', 'St Joseph College', { ip: '10.17.3.9' });
    expect(back).toMatchObject({ ok: true, resumed: true });
    const after = (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2 and status <> 'reset'`, [set, t.id])).rows;
    expect(after.map((x) => [x.id, x.deadline_at.toISOString()])).toEqual([[a.id, a.deadline_at.toISOString()]]);
    tok.asha = back.token;
    expect(await anon('participant_finish', [tok.asha], '10.17.3.9')).toMatchObject({ ok: true, status: 'submitted' });
  });

  it('paper entry refuses an option the question does not have', async () => {
    const two = (await db.query(`select question_id from public.set_questions where session_id = $1 and option_c is null`, [set])).rows[0].question_id;
    const ravi = await joinedTeam(db, set, 'Ravi');
    expect(await errCode(org('record_answer', [rid(), ravi.id, two, 'C', false, null], set))).toBe('INVALID_OPTION');
    expect((await org('record_answer', [rid(), ravi.id, two, 'B', false, null], set)).result).toBe('correct');
  });

  it('results show each participant with name, college, section and score; sets stay separate', async () => {
    const rows = (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows;
    expect(rows.map((r) => r.team_name).sort()).toEqual(['Asha Rao', 'Ravi']);
    const asha = rows.find((r) => r.team_name === 'Asha Rao');
    expect([Number(asha.points), asha.correct, Number(asha.rank), asha.attempt_status]).toEqual([3, 3, 1, 'submitted']);
    const t = await joinedTeam(db, set, 'Asha Rao');
    expect(t).toMatchObject({ college_name: 'St Joseph College', section: 'PG' });
    const prevRows = (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': previous })).rows;
    expect(prevRows.some((r) => ['Asha Rao', 'Ravi'].includes(r.team_name))).toBe(false);
  });

  it('participants cannot read tables, change scores or keys, or touch another participant', async () => {
    for (const tbl of ['teams', 'team_answers', 'question_keys', 'set_questions', 'quiz_attempts']) {
      expect(await errCode(asRole(db, 'anon', null, `select * from public.${tbl}`)), tbl).toMatch(/permission denied/);
    }
    for (const sql of ['public.record_answer(gen_random_uuid(), null, null, \'A\')', 'public.correct_set_question(null, \'{}\', \'x\')',
      'public.save_set_question(\'{}\')', 'public.revoke_participant(null)', 'public._make_attempt(null, null)']) {
      expect(await errCode(asRole(db, 'anon', null, `select ${sql}`)), sql).toMatch(/permission denied/);
    }
    // Ravi's token cannot answer as Asha: an answer always belongs to the token's own entry
    const ashaId = (await joinedTeam(db, set, 'Asha Rao')).id;
    const before = (await db.query('select count(*)::int c from public.team_answers where team_id = $1', [ashaId])).rows[0].c;
    const st = await anon('participant_state', [tok.ravi], '10.17.4.1');
    if (st.question) await anon('participant_submit', [tok.ravi, rid(), st.question.id, 'A'], '10.17.4.1');
    expect((await db.query('select count(*)::int c from public.team_answers where team_id = $1', [ashaId])).rows[0].c).toBe(before);
  });

  it('closing registration stops new participants; a released participant can still come back', async () => {
    await org('set_registration', [false], set);
    expect((await joinQuiz(db, code, 'Latecomer', 'X College', { ip: '10.17.5.1' })).error).toBe('REGISTRATION_CLOSED');
    await org('revoke_participant', [(await joinedTeam(db, set, 'Ravi')).id], set);
    expect((await joinQuiz(db, code, 'Ravi', 'MCA College', { ip: '10.17.5.2' })).ok).toBe(true);
  });
});
