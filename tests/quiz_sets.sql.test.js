// Quiz sets, team attempts, per-team timers, option shuffling and completion-time
// ranking against the real migrations (1–6) in PGlite. Organizer calls select a
// set with the x-brainfreze-set header exactly as the browser does.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, attachTeam, createDb, errCode, ORG, STAFF, selectTeams } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const results = async (set) => (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows;
const anon = async (fn, args = [], ip = '10.3.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const team = (num, section = 'UG') => ({ team_number: num, team_name: `${section} Team ${num}`, participant_1: 'A', participant_2: 'B', college_name: 'MCA College', section });
const teamId = async (section, num) => (await db.query('select id from public.teams where section = $1 and team_number = $2', [section, num])).rows[0].id;
const attemptOf = async (set, section, num) => (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2 and status <> 'reset'`, [set, await teamId(section, num)])).rows[0];
const keyOf = async (set, qid) => (await db.query('select correct_option from public.set_questions where session_id = $1 and question_id = $2', [set, qid])).rows[0].correct_option;
const KEY_WORDS = /correct_option|explanation|"result"|"points"|option_orders|question_order/;

let bank; // 62 question ids in bank order
const ids = (from, count) => bank.slice(from, from + count);

/** Create a draft set with `count` questions; returns its id. */
async function draft(name, section, count, from = 0, settings = {}) {
  const id = await org('create_set', [{ name, section }]);
  await org('update_quiz_details', [{ question_ids: ids(from, count) }], id);
  if (Object.keys(settings).length) await org('update_settings', [settings], id);
  return id;
}

/** Attach a registered team to a device (test fixture, see helpers/db.js) and return its token. */
async function join(code, section, num, ip) {
  const r = await attachTeam(db, code, section, num, ip);
  if (!r.ok) throw new Error(r.error);
  return r.token;
}

/** The letter the team sees for the original option `orig` of question `qid`. */
const shownFor = (attempt, qid, orig) => 'ABCD'[attempt.option_orders[attempt.question_order.indexOf(qid)].indexOf(orig)];

beforeAll(async () => {
  db = await createDb();
  const items = Array.from({ length: 62 }, (_, i) => ({
    question_text: `Bank question ${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`,
    correct_option: 'ABCD'[i % 4], explanation: `SECRET-${i + 1}`,
  }));
  await org('import_questions', [items, false, false]);
  bank = (await db.query('select id from public.questions order by position')).rows.map((r) => r.id);
  for (let i = 1; i <= 6; i++) await org('save_team', [team(i, 'UG')]);
  for (let i = 1; i <= 3; i++) await org('save_team', [team(i, 'PG')]);
}, 60_000);

describe('quiz set lifecycle', () => {
  it('supports many UG and PG sets, each a draft until published', async () => {
    const a = await draft('UG Set A', 'UG', 30);
    const b = await draft('UG Set B', 'UG', 40, 10);
    const c = await draft('PG Set A', 'PG', 30);
    const rows = (await db.query(`select id, section, published_at from public.quiz_sessions where id = any ($1)`, [[a, b, c]])).rows;
    expect(rows.map((r) => r.section).sort()).toEqual(['PG', 'UG', 'UG']);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    expect(await errCode(org('create_set', [{ name: 'x', section: 'XX' }]))).toBe('VALIDATION');
    expect(await errCode(org('create_set', [{ name: '', section: 'UG' }]))).toBe('VALIDATION');
  });

  it('publishing needs at least one question and has no upper limit (1, 29 and the whole 62-question bank accepted)', async () => {
    const s1 = await draft('1', 'UG', 1, 3);
    expect((await org('publish_quiz', [], s1)).join_code).toMatch(/^\d{6}$/);
    expect((await db.query('select count(*)::int c from public.set_questions where session_id = $1', [s1])).rows[0].c).toBe(1);
    const s29 = await draft('29', 'PG', 29);
    expect((await org('publish_quiz', [], s29)).join_code).toMatch(/^\d{6}$/);
    // The whole 62-question bank — more than the old 60 maximum.
    const all = await draft('All', 'UG', 62);
    expect((await org('publish_quiz', [], all)).join_code).toMatch(/^\d{6}$/);
    expect((await db.query('select count(*)::int c from public.set_questions where session_id = $1', [all])).rows[0].c).toBe(62);
    // A new set starts empty (never the bank); an empty draft is saved but cannot be published.
    const empty = await org('create_set', [{ name: 'Empty', section: 'UG' }]);
    expect((await db.query('select question_ids from public.quiz_sessions where id = $1', [empty])).rows[0].question_ids).toEqual([]);
    expect(await errCode(org('update_quiz_details', [{ question_ids: [] }], empty))).toBe('NO_ERROR');
    expect(await errCode(org('publish_quiz', [], empty))).toBe('QUESTION_COUNT');
    await org('delete_set', [empty]);
    for (const id of [s1, s29, all]) await org('archive_set', [id, 'test cleanup']);
  });

  it('duplicate questions, missing keys and invalid timers are refused', async () => {
    const s = await draft('Dup', 'UG', 30);
    expect(await errCode(org('update_quiz_details', [{ question_ids: [...ids(0, 29), bank[0]] }], s))).toBe('VALIDATION');
    await db.query('delete from public.question_keys where question_id = $1', [bank[5]]);
    expect(await errCode(org('publish_quiz', [], s))).toBe('QUIZ_NOT_READY');
    await db.query(`insert into public.question_keys (question_id, correct_option) values ($1, 'B')`, [bank[5]]);
    expect(await errCode(org('update_settings', [{ duration_seconds: 0 }], s))).toBe('VALIDATION');
    expect(await errCode(org('update_settings', [{ duration_seconds: -60 }], s))).toBe('VALIDATION');
    // any positive time limit is stored, including ones outside the old 5–120 and 1–240 minute ranges
    for (const d of [30, 60, 9000, 18_000]) {
      await org('update_settings', [{ duration_seconds: d }], s);
      expect((await db.query('select duration_seconds from public.quiz_settings where session_id = $1', [s])).rows[0].duration_seconds).toBe(d);
    }
    await expect(db.query('update public.quiz_settings set duration_seconds = 0 where session_id = $1', [s])).rejects.toThrow(/duration_seconds_check/);
    await org('delete_set', [s]);
  });

  it('publishing freezes questions, keys, timer and scoring; bank edits never reach a published set', async () => {
    const s = await draft('Frozen', 'UG', 30, 0, { duration_seconds: 900, marks_incorrect: -0.5 });
    await org('publish_quiz', [], s);
    const snap = (await db.query('select question_id, correct_option, marks_incorrect from public.set_questions where session_id = $1 order by position', [s])).rows;
    expect(snap).toHaveLength(30);
    expect(snap.every((r) => Number(r.marks_incorrect) === -0.5)).toBe(true);
    const q = (await db.query('select q.*, k.correct_option, k.explanation from public.questions q join public.question_keys k on k.question_id = q.id where q.id = $1', [bank[0]])).rows[0];
    await org('save_question', [{ ...q, correct_option: 'D', question_text: 'Edited in the bank' }]);
    expect(await keyOf(s, bank[0])).toBe('A');
    expect((await db.query('select question_text from public.set_questions where session_id = $1 and question_id = $2', [s, bank[0]])).rows[0].question_text).toBe('Bank question 1?');
    await org('save_question', [{ ...q }]);
    expect(await errCode(org('update_settings', [{ duration_seconds: 1200 }], s))).toBe('SET_FROZEN');
    expect(await errCode(org('update_quiz_details', [{ question_ids: ids(1, 30) }], s))).toBe('SET_FROZEN');
    expect(await errCode(org('update_quiz_details', [{ section: 'PG' }], s))).toBe('SET_FROZEN');
    expect(await errCode(org('delete_question', [bank[0], true]))).toBe('QUESTION_IN_PUBLISHED_SET');
    expect(await errCode(org('delete_set', [s]))).toBe('INVALID_STATE'); // published sets are archived, not deleted
    await org('archive_set', [s, 'test cleanup']);
  });
});

describe('join codes and access', () => {
  let ugA;
  let ugB;
  let pgA;
  let codeA;
  let codeB;
  let codePG;

  beforeAll(async () => {
    ugA = await draft('UG Morning', 'UG', 30, 0, { duration_seconds: 600 });
    ugB = await draft('UG Afternoon', 'UG', 30, 30, { duration_seconds: 600 });
    pgA = await draft('PG Morning', 'PG', 30, 0, { duration_seconds: 600 });
  });

  it('each published set gets its own unique code (across UG and PG); drafts cannot be joined', async () => {
    expect(await anon('join_lookup', ['000000'])).toEqual({ ok: false, error: 'INVALID_CODE' });
    codeA = (await org('publish_quiz', [], ugA)).join_code;
    codeB = (await org('publish_quiz', [], ugB)).join_code;
    codePG = (await org('publish_quiz', [], pgA)).join_code;
    await selectTeams(db, ugA, [1, 3]);
    await selectTeams(db, ugB, [2]);
    await selectTeams(db, pgA, [1]);
    expect(new Set([codeA, codeB, codePG]).size).toBe(3);
    const s = (await db.query('select published_by, published_at from public.quiz_sessions where id = $1', [ugA])).rows[0];
    expect(s.published_by).toBe(ORG);
    expect((await anon('join_lookup', [codeB])).quiz).toMatchObject({ title: 'UG Afternoon', section: 'UG', duration_seconds: 600, total_questions: 30 });
  });

  it('the code identifies the set and its section; a client claiming another section is refused', async () => {
    expect(await anon('join_quiz', [codePG, 'Asha', 'MCA College', rid(), 'UG', null], '10.3.1.1')).toEqual({ ok: false, error: 'SECTION_MISMATCH', section: 'PG' });
    const r = await anon('join_quiz', [codeA, 'Asha', 'MCA College', rid(), null, null], '10.3.1.2');
    expect(r).toMatchObject({ ok: true, section: 'UG', team: { section: 'UG', participant_1: 'Asha' } });
    // the retired PIN sign-in is not callable any more
    expect(await errCode(anon('join_team', [codeA, 1, 'ABCDEF', null], '10.3.1.2'))).toMatch(/permission denied/);
  });

  it('one set per team per section: a team in UG Morning cannot be selected for or join UG Afternoon', async () => {
    await join(codeA, 'UG', 1, '10.3.1.3');
    expect(await errCode(selectTeams(db, ugB, [1, 2]))).toBe('TEAM_IN_OTHER_SET');
    expect(await attachTeam(db, codeB, 'UG', 1, '10.3.1.4')).toEqual({ ok: false, error: 'TEAM_NOT_SELECTED' });
    await join(codeB, 'UG', 2, '10.3.1.5'); // a different team can
    // PG sets are independent of UG ones.
    await join(codePG, 'PG', 1, '10.3.1.6');
  });

  it('revoked codes stop working and are never reissued; joined teams keep access', async () => {
    const before = await join(codeA, 'UG', 3, '10.3.1.7');
    await org('revoke_join_code', [], ugA);
    expect(await anon('join_lookup', [codeA], '10.3.1.8')).toEqual({ ok: false, error: 'INVALID_CODE' });
    expect((await anon('participant_state', [before])).ok).toBe(true);
    expect(await errCode(org('publish_quiz', [], ugA))).toBe('INVALID_STATE');
    const fresh = (await org('regenerate_join_code', [], ugA)).join_code;
    expect(fresh).not.toBe(codeA);
    expect((await db.query('select 1 from public.retired_join_codes where code = $1', [codeA])).rows).toHaveLength(1);
    codeA = fresh;
  });

  it('archived sets cannot be joined and their devices are signed out', async () => {
    const tmp = await draft('Temp', 'UG', 30);
    const c = (await org('publish_quiz', [], tmp)).join_code;
    await selectTeams(db, tmp, [6]);
    const tok = await join(c, 'UG', 6, '10.3.1.9');
    await org('archive_set', [tmp, 'Not needed']);
    expect(await anon('join_lookup', [c], '10.3.1.10')).toEqual({ ok: false, error: 'INVALID_CODE' });
    expect((await anon('participant_state', [tok])).error).toBe('SESSION_REVOKED');
  });

  it('registration staff cannot create, publish, run or read quiz sets, attempts or results', async () => {
    const staff = (fn, args = []) => asRole(db, 'authenticated', STAFF, `select public.${fn}(${ph(args)})`, args, { 'x-brainfreze-set': ugA });
    for (const [fn, args] of [['create_set', [{ name: 'x', section: 'UG' }]], ['publish_quiz', []], ['start_quiz', []], ['pause_quiz', []],
      ['update_settings', [{ duration_seconds: 900 }]], ['revoke_join_code', []], ['archive_set', [ugA, 'x']], ['delete_set', [ugA]],
      ['reset_attempt', [rid(), 'x']], ['finalize_attempt', [rid(), 'x']], ['correct_set_question', [bank[0], {}, 'x']], ['duplicate_set', [ugA]]]) {
      expect(await errCode(staff(fn, args)), fn).toBe('NOT_AUTHORIZED');
    }
    expect(await errCode(asRole(db, 'authenticated', STAFF, 'select * from public.get_set_results()'))).toBe('NOT_AUTHORIZED');
    for (const t of ['quiz_attempts', 'set_questions']) {
      expect((await asRole(db, 'authenticated', STAFF, `select count(*)::int c from public.${t}`)).rows[0].c, t).toBe(0);
    }
  });
});

describe('attempts: shuffling, timer, submission and ranking', () => {
  let set;
  let code;
  const tok = {};

  beforeAll(async () => {
    for (let i = 10; i <= 14; i++) await org('save_team', [team(i, 'UG')]);
    set = await draft('UG Final', 'UG', 40, 5, { duration_seconds: 600 });
    code = (await org('publish_quiz', [], set)).join_code;
    await selectTeams(db, set, [10, 11, 12, 13, 14]);
    for (const i of [10, 11, 12, 13, 14]) tok[i] = await join(code, 'UG', i, `10.4.0.${i}`);
  });

  it('each team has a stored, different question order and per-question option order over the same 40 questions', async () => {
    const a = await attemptOf(set, 'UG', 10);
    const b = await attemptOf(set, 'UG', 11);
    const expected = ids(5, 40).sort();
    expect([...a.question_order].sort()).toEqual(expected);
    expect([...b.question_order].sort()).toEqual(expected);
    expect(a.question_order).not.toEqual(b.question_order);
    expect(a.option_orders.every((p) => [...p].sort().join('') === 'ABCD')).toBe(true);
    expect(new Set(a.option_orders).size).toBeGreaterThan(1); // options shuffled per question
    expect(a.option_orders).not.toEqual(b.option_orders);
  });

  it('the order is stable across refreshes and reconnections; the device sees the shuffled options', async () => {
    await org('start_quiz', [], set);
    await anon('participant_start', [tok[10]]);
    const a = await attemptOf(set, 'UG', 10);
    const p0 = await anon('participant_state', [tok[10], 0]);
    const p0again = await anon('participant_state', [tok[10], 0]);
    expect(p0.question.id).toBe(a.question_order[0]);
    expect(p0again.question).toEqual(p0.question);
    const q = (await db.query('select option_a, option_b, option_c, option_d from public.set_questions where session_id = $1 and question_id = $2', [set, a.question_order[0]])).rows[0];
    const perm = a.option_orders[0];
    expect(p0.question.option_a).toBe(q[`option_${perm[0].toLowerCase()}`]);
    expect(p0.question.option_d).toBe(q[`option_${perm[3].toLowerCase()}`]);
    expect(JSON.stringify(p0)).not.toMatch(KEY_WORDS);
    expect(JSON.stringify(p0)).not.toMatch(/SECRET/);
    // a replacement device (after the organizer releases the old one) resumes the same attempt
    await org('revoke_participant', [await teamId('UG', 10)], set);
    tok[10] = await join(code, 'UG', 10, '10.4.0.10');
    expect((await attemptOf(set, 'UG', 10)).id).toBe(a.id);
    expect((await anon('participant_state', [tok[10], 0])).question.id).toBe(a.question_order[0]);
  });

  it('scoring uses the original key through the stored option mapping', async () => {
    const a = await attemptOf(set, 'UG', 10);
    const q0 = a.question_order[0];
    const q1 = a.question_order[1];
    const k0 = await keyOf(set, q0);
    const k1 = await keyOf(set, q1);
    const right = shownFor(a, q0, k0);
    const wrong = shownFor(a, q1, 'ABCD'.replace(k1, '')[0]);
    expect((await anon('participant_submit', [tok[10], rid(), q0, right])).ok).toBe(true);
    expect((await anon('participant_submit', [tok[10], rid(), q1, wrong])).ok).toBe(true);
    const rows = (await db.query('select question_id, selected_option, displayed_option, result, points from public.team_answers where team_id = $1 order by created_at', [await teamId('UG', 10)])).rows;
    expect(rows.map((r) => [r.selected_option, r.displayed_option, r.result])).toEqual([[k0, right, 'correct'], [rows[1].selected_option, wrong, 'incorrect']]);
    expect(rows[1].selected_option).not.toBe(k1);
  });

  it('duplicate clicks and network retries are idempotent; one (changeable) answer per question', async () => {
    const a = await attemptOf(set, 'UG', 10);
    const q2 = a.question_order[2];
    const req = rid();
    const first = await anon('participant_submit', [tok[10], req, q2, 'C']);
    const retry = await anon('participant_submit', [tok[10], req, q2, 'C']);
    expect(first).toMatchObject({ ok: true, duplicate_request: false });
    expect(retry).toMatchObject({ ok: true, duplicate_request: true, selected: 'C' });
    expect(await anon('participant_submit', [tok[10], rid(), q2, 'A'])).toMatchObject({ ok: true, selected: 'A' }); // changed before submitting
    expect(await anon('participant_submit', [tok[10], rid(), q2, 'C'])).toMatchObject({ ok: true, selected: 'C' });
    expect((await db.query('select count(*)::int c from public.team_answers where team_id = $1 and question_id = $2', [await teamId('UG', 10), q2])).rows[0].c).toBe(1);
  });

  it('server timestamps: refreshing never restarts the timer; remaining time comes from the stored deadline', async () => {
    const a = await attemptOf(set, 'UG', 10);
    expect(Date.parse(a.deadline_at) - Date.parse(a.started_at)).toBe(600_000);
    await anon('participant_start', [tok[10]]); // pressing Start again changes nothing
    expect((await attemptOf(set, 'UG', 10)).started_at).toEqual(a.started_at);
    // Simulate 4 minutes having passed.
    await db.query(`update public.quiz_attempts set started_at = started_at - interval '4 minutes', deadline_at = deadline_at - interval '4 minutes' where id = $1`, [a.id]);
    const st = await anon('participant_state', [tok[10]]);
    expect(st.attempt.remaining_ms).toBeGreaterThan(355_000);
    expect(st.attempt.remaining_ms).toBeLessThanOrEqual(360_000);
  });

  it('early submission records the server final time and ends the attempt', async () => {
    await anon('participant_start', [tok[11]]);
    await db.query(`update public.quiz_attempts set started_at = now() - interval '200 seconds', deadline_at = now() + interval '400 seconds' where id = $1`, [(await attemptOf(set, 'UG', 11)).id]);
    const a = await attemptOf(set, 'UG', 11);
    expect((await anon('participant_submit', [tok[11], rid(), a.question_order[0], shownFor(a, a.question_order[0], await keyOf(set, a.question_order[0]))])).ok).toBe(true);
    const fin = await anon('participant_finish', [tok[11]]);
    expect(fin.status).toBe('submitted');
    expect(await anon('participant_finish', [tok[11]])).toEqual(fin); // idempotent
    expect(await anon('participant_submit', [tok[11], rid(), a.question_order[1], 'A'])).toEqual({ ok: false, error: 'ATTEMPT_FINISHED' });
    const r = (await results(set)).find((x) => x.team_number === 11);
    expect(r.attempt_status).toBe('submitted');
    expect(Number(r.elapsed_ms)).toBeGreaterThanOrEqual(199_000);
    expect(Number(r.elapsed_ms)).toBeLessThan(202_000);
  });

  it('after the deadline answers are refused and the attempt times out — even if the device never returns', async () => {
    await anon('participant_start', [tok[12]]);
    const a = await attemptOf(set, 'UG', 12);
    await db.query(`update public.quiz_attempts set started_at = now() - interval '11 minutes', deadline_at = now() - interval '1 minute' where id = $1`, [a.id]);
    // The organizer's view (no device activity) already shows it as timed out with the full limit.
    const r = (await results(set)).find((x) => x.team_number === 12);
    expect(r.attempt_status).toBe('timed_out');
    expect(Number(r.elapsed_ms)).toBe(600_000);
    expect(await anon('participant_submit', [tok[12], rid(), a.question_order[0], 'A'])).toEqual({ ok: false, error: 'TIME_EXPIRED' });
    const row = await attemptOf(set, 'UG', 12);
    expect(row.status).toBe('timed_out');
    expect(row.finished_at).toEqual(row.deadline_at);
    expect(await anon('participant_finish', [tok[12]])).toMatchObject({ status: 'timed_out' });
  });

  it('pause freezes every running timer; resume moves deadlines by the paused time', async () => {
    await anon('participant_start', [tok[13]]);
    const before = await attemptOf(set, 'UG', 13);
    await org('pause_quiz', [], set);
    expect(await anon('participant_start', [tok[14]])).toEqual({ ok: false, error: 'NOT_STARTED_YET' });
    expect(await anon('participant_submit', [tok[13], rid(), before.question_order[0], 'A'])).toEqual({ ok: false, error: 'NOT_ACCEPTING' });
    const paused = await anon('participant_state', [tok[13]]);
    expect(paused.attempt.paused).toBe(true);
    expect(paused.question).toBeUndefined();
    await db.query(`update public.quiz_sessions set paused_at = paused_at - interval '90 seconds' where id = $1`, [set]);
    const r1 = (await anon('participant_state', [tok[13]])).attempt.remaining_ms;
    const r2 = (await anon('participant_state', [tok[13]])).attempt.remaining_ms;
    expect(r1).toBe(r2); // frozen while paused
    await org('resume_quiz', [], set);
    const after = await attemptOf(set, 'UG', 13);
    expect(Date.parse(after.deadline_at) - Date.parse(before.deadline_at)).toBeGreaterThanOrEqual(90_000);
    expect(Number(after.paused_ms)).toBeGreaterThanOrEqual(90_000);
    expect((await attemptOf(set, 'UG', 12)).status).toBe('timed_out'); // already expired → not extended
  });

  it('ranking: score, then shorter elapsed time, then tie review; timed-out teams count the full limit', async () => {
    // Give team 13 the same score as team 11 (1 correct) and finish slower (300 s).
    const a = await attemptOf(set, 'UG', 13);
    await anon('participant_submit', [tok[13], rid(), a.question_order[0], shownFor(a, a.question_order[0], await keyOf(set, a.question_order[0]))]);
    await anon('participant_finish', [tok[13]]);
    await db.query(`update public.quiz_attempts set started_at = finished_at - interval '300 seconds', paused_ms = 0 where id = $1`, [a.id]);
    // Team 12 (timed out, 0 answers) and team 14 (never started) score 0 with the full limit.
    const r = await results(set);
    const by = (num) => r.find((x) => x.team_number === num);
    expect(Number(by(11).points)).toBe(Number(by(13).points));
    expect(by(11).rank).toBeLessThan(by(13).rank); // 200 s beats 300 s
    expect(by(11).tie_review).toBe(false);
    expect(Number(by(12).elapsed_ms)).toBe(600_000);
    expect(Number(by(14).elapsed_ms)).toBe(600_000);
    expect(by(12).rank).toBe(by(14).rank); // equal score and equal (full) time → shared rank
    expect(by(12).tie_review).toBe(true);
    // Equal score AND equal elapsed time → flagged; a tie-break result resolves it after the set ends.
    const a11 = await attemptOf(set, 'UG', 11);
    await db.query(`update public.quiz_attempts set started_at = finished_at - interval '200 seconds', paused_ms = 0 where id = any ($1)`, [[a.id, a11.id]]);
    const r2 = await results(set);
    const t11 = r2.find((x) => x.team_number === 11);
    const t13 = r2.find((x) => x.team_number === 13);
    expect(Number(t11.elapsed_ms)).toBe(200_000);
    expect(Number(t13.elapsed_ms)).toBe(200_000);
    expect(t11.rank).toBe(t13.rank);
    expect(t11.tie_review && t13.tie_review).toBe(true);
  });

  it('organizer reset is audited and gives the team a fresh attempt; finalize ends one attempt', async () => {
    expect(await errCode(org('reset_attempt', [await teamId('UG', 10), ''], set))).toBe('REASON_REQUIRED');
    const old = await attemptOf(set, 'UG', 10);
    expect((await org('reset_attempt', [await teamId('UG', 10), 'Device crashed before start of Q1'], set)).removed_answers).toBe(3);
    expect((await db.query('select status, reset_reason from public.quiz_attempts where id = $1', [old.id])).rows[0]).toEqual({ status: 'reset', reset_reason: 'Device crashed before start of Q1' });
    expect((await db.query(`select count(*)::int c from public.score_events where action = 'attempt_reset'`)).rows[0].c).toBe(1);
    const st = await anon('participant_state', [tok[10]]);
    expect(st.attempt.status).toBe('ready');
    const fresh = await attemptOf(set, 'UG', 10);
    expect(fresh.id).not.toBe(old.id);
    await anon('participant_start', [tok[10]]);
    expect(await errCode(org('finalize_attempt', [await teamId('UG', 10), ''], set))).toBe('REASON_REQUIRED');
    await org('finalize_attempt', [await teamId('UG', 10), 'Team left the hall'], set);
    expect((await attemptOf(set, 'UG', 10)).status).toBe('organizer_finalized');
    expect(await anon('participant_submit', [tok[10], rid(), fresh.question_order[0], 'A'])).toEqual({ ok: false, error: 'ATTEMPT_FINISHED' });
  });

  it('a published key correction is explicit, audited and re-scores only this set', async () => {
    const a = await attemptOf(set, 'UG', 11);
    const q = a.question_order[0];
    const k = await keyOf(set, q);
    const other = 'ABCD'.replace(k, '')[0];
    const res = await org('correct_set_question', [q, { correct_option: other }, 'Key typo'], set);
    expect(res.rescored).toBeGreaterThanOrEqual(1);
    expect((await db.query(`select result from public.team_answers where team_id = $1 and question_id = $2`, [await teamId('UG', 11), q])).rows[0].result).toBe('incorrect');
    await org('correct_set_question', [q, { correct_option: k }, 'Revert'], set);
  });

  it('ending the set finalizes running attempts; results and audit data are available to organizers only', async () => {
    const t14 = await attemptOf(set, 'UG', 14);
    await anon('participant_start', [tok[14]]);
    await org('end_quiz', [], set);
    expect((await attemptOf(set, 'UG', 14)).status).toBe('organizer_finalized');
    expect(t14.status).toBe('ready');
    const r = await results(set);
    expect(r.every((x) => x.started_at === null || typeof x.started_at === 'object')).toBe(true);
    expect(r.find((x) => x.team_number === 11).finished_at).not.toBeNull();
    // Answer audit columns.
    const ans = (await db.query(`select attempt_id, on_time, displayed_option, created_at from public.team_answers where session_id = $1 and source = 'participant'`, [set])).rows;
    expect(ans.every((x) => x.attempt_id && x.on_time === true && x.displayed_option && x.created_at)).toBe(true);
    expect(await errCode(asRole(db, 'anon', null, 'select * from public.get_set_results()'))).toMatch(/permission denied/);
  });
});
