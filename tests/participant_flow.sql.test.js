// Round 1 participant flow without PINs (migration 20261019000100) against the real
// migrations in PGlite: join code → section → registered team, one device per team,
// server deadline, autosaved/changeable answers, automatic and early submission.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, ORG, selectTeams } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `abababab-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = [], set = null) =>
  (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args, set ? { 'x-brainfreze-set': set } : null)).rows[0].r;
const anon = async (fn, args = [], ip = '10.7.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const team = (num, section) => ({ team_number: num, team_name: `${section} Frost ${num}`, participant_1: `Asha ${num}`, participant_2: `Ravi ${num}`, college_name: 'Private College', section });
const teamId = async (section, num) => (await db.query('select id from public.teams where section = $1 and team_number = $2', [section, num])).rows[0].id;
const attemptOf = async (set, section, num) => (await db.query(`select * from public.quiz_attempts where session_id = $1 and team_id = $2 and status <> 'reset'`, [set, await teamId(section, num)])).rows[0];
const answersOf = async (set, section, num) => (await db.query('select question_id, selected_option, displayed_option, source from public.team_answers where session_id = $1 and team_id = $2', [set, await teamId(section, num)])).rows;
const keyOf = async (set, qid) => (await db.query('select correct_option from public.set_questions where session_id = $1 and question_id = $2', [set, qid])).rows[0].correct_option;
/** The letter team `a` sees for original option `orig` of question `qid`. */
const shown = (a, qid, orig) => 'ABCD'[a.option_orders[a.question_order.indexOf(qid)].indexOf(orig)];
const KEY_WORDS = /correct_option|explanation|"result"|"points"|SECRET|"pin"|college/;

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
  for (const i of [1, 2, 3, 4]) await org('save_team', [team(i, 'UG')]);
  await org('save_team', [team(1, 'PG')]);
  set = await org('create_set', [{ name: 'UG Flow', section: 'UG' }]);
  await org('update_quiz_details', [{ question_ids: bank }], set);
  await org('update_settings', [{ duration_seconds: 600 }], set);
  code = (await org('publish_quiz', [], set)).join_code;
  await selectTeams(db, set);
}, 60_000);

describe('join: code → section → registered team (no PIN)', () => {
  it('a valid code and matching section list the registered teams, without private data', async () => {
    const r = await anon('join_roster', [code, 'ug']);
    expect(r.ok).toBe(true);
    expect(r.section).toBe('UG');
    expect(r.teams.map((t) => t.team_number)).toEqual([1, 2, 3, 4]);
    expect(r.teams[0]).toEqual({ team_number: 1, team_name: 'UG Frost 1', participant_1: 'Asha 1', participant_2: 'Ravi 1', joined: false });
    expect(JSON.stringify(r)).not.toMatch(KEY_WORDS);
    expect(JSON.stringify(r)).not.toMatch(/"id"|team_id/);
  });

  it('a wrong code, a mismatched section or a bad section are refused', async () => {
    expect(await anon('join_roster', ['000000', 'UG'], '10.7.9.1')).toEqual({ ok: false, error: 'INVALID_CODE' });
    expect(await anon('join_roster', [code, 'PG'])).toEqual({ ok: false, error: 'SECTION_MISMATCH', section: 'UG' });
    expect((await anon('join_roster', [code, 'MBA'])).error).toBe('VALIDATION');
    expect(await anon('join_registered_team', [code, 'PG', 1, null])).toEqual({ ok: false, error: 'SECTION_MISMATCH', section: 'UG' });
  });

  it('unregistered team numbers are refused; arbitrary names cannot join', async () => {
    expect(await anon('join_registered_team', [code, 'UG', 77, null])).toEqual({ ok: false, error: 'TEAM_NOT_REGISTERED' });
    // there is no RPC that accepts a free-text name for joining
    const fns = (await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).rows.map((r) => `${r.proname}(${r.a})`);
    expect(fns).toContain('join_registered_team(p_code text, p_section text, p_team_number integer, p_device_label text)');
    expect(fns).toContain('join_roster(p_code text, p_section text)');
  });

  it('a registered team joins without a PIN; a second device is refused until the organizer releases the team', async () => {
    const first = await anon('join_registered_team', [code, 'UG', 1, 'Tablet 1'], '10.7.1.1');
    expect(first).toMatchObject({ ok: true, team: { team_number: 1, team_name: 'UG Frost 1' }, section: 'UG' });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await anon('join_roster', [code, 'UG'])).teams[0].joined).toBe(true);
    // no idle takeover: even long after the last check-in, another device cannot claim the team
    await db.query(`update public.participant_sessions set last_seen_at = now() - interval '1 hour' where team_id = $1`, [await teamId('UG', 1)]);
    expect(await anon('join_registered_team', [code, 'UG', 1, 'Phone'], '10.7.1.2')).toEqual({ ok: false, error: 'TEAM_ALREADY_JOINED' });
    const a1 = await attemptOf(set, 'UG', 1);
    await org('revoke_participant', [await teamId('UG', 1)], set);
    const again = await anon('join_registered_team', [code, 'UG', 1, 'Replacement'], '10.7.1.2');
    expect(again.ok).toBe(true);
    expect((await attemptOf(set, 'UG', 1)).id).toBe(a1.id); // same single attempt
    expect((await anon('participant_state', [first.token])).error).toBe('SESSION_REVOKED');
    expect((await db.query('select count(*)::int c from public.quiz_attempts where session_id = $1 and team_id = $2', [set, await teamId('UG', 1)])).rows[0].c).toBe(1);
  });
});

describe('timer, autosave, automatic and early submission', () => {
  const tok = {};

  beforeAll(async () => {
    for (const i of [2, 3, 4]) tok[i] = (await anon('join_registered_team', [code, 'UG', i, null], `10.7.2.${i}`)).token;
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
    const res = (await asRole(db, 'authenticated', ORG, 'select * from public.get_set_results()', [], { 'x-brainfreze-set': set })).rows.find((r) => r.team_number === 3);
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
