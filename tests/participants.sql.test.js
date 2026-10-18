// Participant join / attempt / answer flow against the real migrations in
// PGlite, calling participant functions as the `anon` role exactly as the browser would.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STRANGER, selectTeams } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const org = (sql, params) => asRole(db, 'authenticated', ORG, sql, params);
const orgRpc = async (fn, args = []) => (await org(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
// Participants: anon role, distinct simulated client IPs so rate limits are per-device.
const anon = async (fn, args = [], ip = '10.0.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const pin = async (num) => (await db.query(`select c.pin from public.team_credentials c join public.teams t on t.id = c.team_id where t.team_number = $1`, [num])).rows[0].pin;
const teamId = async (num) => (await db.query('select id from public.teams where team_number = $1', [num])).rows[0].id;
const KEY_WORDS = /correct_option|explanation|"result"|"points"|is_correct|option_orders|question_order/;
// The letter a team SEES for a question's original option (from its stored option order).
async function shown(num, questionId, original) {
  const a = (await db.query(`select a.question_order, a.option_orders from public.quiz_attempts a join public.teams t on t.id = a.team_id
    where t.team_number = $1 and a.status <> 'reset'`, [num])).rows[0];
  const perm = a.option_orders[a.question_order.indexOf(questionId)];
  return 'ABCD'[perm.indexOf(original)];
}

// 32 questions: the quiz uses the first 30; Q31–32 are outside it.
const QUESTIONS = Array.from({ length: 32 }, (_, i) => ({
  question_text: i === 0 ? 'Q one?' : `Question ${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`,
  correct_option: 'BCAD'[i % 4], explanation: `SECRET-EXPLANATION-${i + 1}`,
}));

let code;
let tokenA;
let tokenB;
let q1; // first quiz question (key B)

beforeAll(async () => {
  db = await createDb();
  await orgRpc('import_teams', [[1, 2, 3].map((i) => ({ team_number: i, team_name: `Team ${i}`, participant_1: `P${i}a`, participant_2: `P${i}b`, college_name: `College ${i}` })), false, false]);
  await orgRpc('import_questions', [QUESTIONS, false, false]);
  q1 = (await db.query('select id from public.questions where position = 1')).rows[0].id;
}, 60_000);

describe('schema & permissions', () => {
  it('every team gets a random 6-character PIN automatically', async () => {
    const rows = (await db.query('select pin from public.team_credentials')).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.pin).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(new Set(rows.map((r) => r.pin)).size).toBe(3);
  });

  it('anon cannot read any table, including PINs, attempts, set snapshots and answer keys', async () => {
    for (const t of ['team_credentials', 'participant_sessions', 'join_attempts', 'retired_join_codes', 'question_keys', 'team_answers',
      'teams', 'questions', 'quiz_sessions', 'quiz_attempts', 'set_questions']) {
      expect(await errCode(asRole(db, 'anon', null, `select * from public.${t}`)), t).toMatch(/permission denied/);
    }
  });

  it('participants (anon) cannot call organizer or internal functions', async () => {
    for (const call of ['public.start_quiz()', 'public.publish_quiz()', 'public.get_standings()', 'public.get_set_results()', `public.record_answer('${rid()}', null, null, 'A')`,
      `public._record(null, null, null, null, 'A', null, false, null, 'participant', null, null, true)`, "public._random_join_code()", "public._issue_join_code(null)",
      `public.rotate_team_pin(null)`, `public.set_registration(true)`, `public.reset_attempt(null, 'x')`, `public.create_set('{}')`, 'public.finalize_all_expired()']) {
      expect(await errCode(asRole(db, 'anon', null, `select ${call}`)), call).toMatch(/permission denied/);
    }
  });

  it('non-organizer accounts see no PINs, attempts or snapshots and cannot publish', async () => {
    for (const t of ['team_credentials', 'quiz_attempts', 'set_questions']) {
      expect((await asRole(db, 'authenticated', STRANGER, `select count(*)::int c from public.${t}`)).rows[0].c, t).toBe(0);
    }
    expect(await errCode(asRole(db, 'authenticated', STRANGER, 'select public.publish_quiz()'))).toBe('NOT_AUTHORIZED');
  });
});

describe('publishing and join codes', () => {
  it('rejects codes before the quiz is published', async () => {
    expect(await anon('join_lookup', ['000000'])).toEqual({ ok: false, error: 'INVALID_CODE' });
  });

  it('draft: title, description and 30 questions; publish freezes the set and generates a 6-digit code', async () => {
    const ids = (await org('select id from public.questions where position <= 30 order by position')).rows.map((r) => r.id);
    await orgRpc('update_quiz_details', [{ name: 'Cold Start Final', description: 'Round 1', question_ids: ids }]);
    expect(await errCode(orgRpc('update_quiz_details', [{ question_ids: [] }]))).toBe('VALIDATION');
    const res = await orgRpc('publish_quiz');
    await selectTeams(db, 'UG');
    code = res.join_code;
    expect(code).toMatch(/^\d{6}$/);
    expect(await orgRpc('publish_quiz')).toEqual({ ok: true, join_code: code }); // idempotent
    const s = (await org(`select published_at, published_by, join_code_active, registration_open from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    expect(s.join_code_active && s.registration_open && !!s.published_at).toBe(true);
    expect(s.published_by).toBe(ORG);
    expect((await db.query('select count(*)::int c from public.set_questions')).rows[0].c).toBe(30);
    expect(await errCode(orgRpc('update_quiz_details', [{ question_ids: ids.slice(0, 29) }]))).toBe('SET_FROZEN');
  });

  it('join code generator retries on collisions and never reuses an old code', async () => {
    await db.exec(`create table public._t_codes (i serial primary key, c text);
      insert into public._t_codes (c) select join_code from public.quiz_sessions where join_code_active;
      insert into public._t_codes (c) select join_code from public.quiz_sessions where join_code_active;
      insert into public._t_codes (c) values ('424242'), ('135790');
      insert into public.retired_join_codes (code) values ('424242');
      create or replace function public._random_join_code() returns text language sql volatile set search_path = '' as $$
        delete from public._t_codes where i = (select min(i) from public._t_codes) returning c $$;`);
    const s = (await db.query(`select id from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    const c = (await db.query(`select public._issue_join_code($1) as c`, [s.id])).rows[0].c;
    expect(c).toBe('135790'); // skipped the active code and the retired code
    expect(await errCode(db.query(`insert into public.quiz_sessions (is_current, published_at, join_code, join_code_active) values (false, now(), '135790', true)`))).toMatch(/duplicate key/);
    await db.exec(`create or replace function public._random_join_code() returns text language plpgsql volatile set search_path = '' as $$
      declare v bigint; begin loop v := ('x' || public._random_bytes_hex(4))::bit(32)::bigint;
      if v < 4294000000 then return lpad((v % 1000000)::text, 6, '0'); end if; end loop; end $$;
      revoke all on function public._random_join_code() from public, anon, authenticated;
      drop table public._t_codes;`);
    await db.query(`update public.quiz_sessions set join_code = $1 where is_current and section = 'UG'`, [code]);
  });

  it('real generator produces uniform-looking 6-digit codes', async () => {
    const rows = (await db.query('select public._random_join_code() c from generate_series(1, 300)')).rows;
    expect(rows.every((r) => /^\d{6}$/.test(r.c))).toBe(true);
    expect(new Set(rows.map((r) => r.c)).size).toBeGreaterThan(290);
  });

  it('valid code lookup reveals only public quiz info', async () => {
    const r = await anon('join_lookup', [`${code.slice(0, 3)} ${code.slice(3)}`]);
    expect(r).toEqual({ ok: true, quiz: { title: 'Cold Start Final', description: 'Round 1', status: 'setup', section: 'UG', duration_seconds: 1800, total_questions: 30, registration_open: true, self_registration: false } });
    expect(await anon('join_lookup', ['12ab56'])).toEqual({ ok: false, error: 'INVALID_CODE' });
  });
});

describe('team identity and attempts', () => {
  it('requires the team PIN; unknown team and wrong PIN give the same error', async () => {
    expect(await anon('join_team', [code, 1, 'WRONG1', null])).toEqual({ ok: false, error: 'INVALID_TEAM_OR_PIN' });
    expect(await anon('join_team', [code, 99, await pin(1), null])).toEqual({ ok: false, error: 'INVALID_TEAM_OR_PIN' });
    const a = await anon('join_team', [code, 1, (await pin(1)).toLowerCase(), 'Device A'], '10.0.0.2');
    expect(a.ok).toBe(true);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.team).toEqual({ team_number: 1, team_name: 'Team 1', participant_1: 'P1a', participant_2: 'P1b' });
    tokenA = a.token;
    tokenB = (await anon('join_team', [code, 2, await pin(2), 'Device B'], '10.0.0.3')).token;
    // Joining creates one attempt per team with a stored random order.
    const att = (await db.query('select status, cardinality(question_order) n, cardinality(option_orders) m from public.quiz_attempts')).rows;
    expect(att).toEqual([{ status: 'ready', n: 30, m: 30 }, { status: 'ready', n: 30, m: 30 }]);
  });

  it('stores only a hash of the device token', async () => {
    const rows = (await db.query('select token_hash from public.participant_sessions')).rows;
    expect(rows.some((r) => r.token_hash === tokenA)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it('a second device cannot take over an actively connected team', async () => {
    expect(await anon('join_team', [code, 1, await pin(1), 'Intruder'], '10.0.0.4')).toEqual({ ok: false, error: 'TEAM_ALREADY_CONNECTED' });
  });

  it('a silent device can be replaced with the PIN (same attempt, old token revoked); organizer can disconnect devices', async () => {
    const t3 = (await anon('join_team', [code, 3, await pin(3), 'Old phone'], '10.0.0.5')).token;
    const before = (await db.query('select id from public.quiz_attempts where team_id = $1', [await teamId(3)])).rows[0].id;
    await db.query(`update public.participant_sessions set last_seen_at = now() - interval '2 minutes' where revoked_at is null and team_id = $1`, [await teamId(3)]);
    const t3b = (await anon('join_team', [code, 3, await pin(3), 'New phone'], '10.0.0.5')).token;
    expect(t3b).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.query('select id from public.quiz_attempts where team_id = $1', [await teamId(3)])).rows.map((r) => r.id)).toEqual([before]);
    expect(await anon('participant_state', [t3])).toEqual({ ok: false, error: 'SESSION_REVOKED', message: 'Replaced by a new device sign-in' });
    expect((await orgRpc('revoke_participant', [await teamId(3)])).revoked).toBe(1);
    expect((await anon('participant_state', [t3b])).error).toBe('SESSION_REVOKED');
  });

  it('closing registration blocks new teams but lets already-joined teams reconnect', async () => {
    await orgRpc('set_registration', [false]);
    await orgRpc('save_team', [{ team_number: 4, team_name: 'Team 4', participant_1: 'x', participant_2: 'y', college_name: 'Test College' }]);
    expect(await anon('join_team', [code, 4, await pin(4), null])).toEqual({ ok: false, error: 'TEAM_NOT_SELECTED' }); // registered, not yet chosen
    await selectTeams(db, 'UG');
    expect(await anon('join_team', [code, 4, await pin(4), null])).toEqual({ ok: false, error: 'REGISTRATION_CLOSED' });
    const again = await anon('join_team', [code, 3, await pin(3), 'Phone again'], '10.0.0.5');
    expect(again.ok).toBe(true);
    await orgRpc('revoke_participant', [await teamId(3)]);
    await orgRpc('set_registration', [true]);
  });

  it('self-registration is off unless the organizer enables it; then prevents duplicate names', async () => {
    expect((await anon('register_team', [code, 'Walk-ins', 'A', 'B', 'Walk College', null])).error).toBe('SELF_REGISTRATION_CLOSED');
    await orgRpc('update_quiz_details', [{ self_registration: true }]);
    const r = await anon('register_team', [code, 'Walk-ins', 'Asha', 'Bilal', 'Walk College', 'Tablet 9'], '10.0.0.9');
    // The walk-in team is registered, but only the organiser can add it to the set's participants.
    expect(r).toEqual({ ok: false, error: 'TEAM_NOT_SELECTED', registered: true, team_number: 5, section: 'UG' });
    expect((await db.query(`select self_registered from public.teams where section = 'UG' and team_number = 5`)).rows[0].self_registered).toBe(true);
    expect((await db.query(`select count(*)::int c from public.quiz_attempts a join public.teams t on t.id = a.team_id where t.team_number = 5`)).rows[0].c).toBe(0);
    expect((await anon('register_team', [code, 'walk-INS', 'C', 'D', 'Walk College', null], '10.0.0.10')).error).toBe('TEAM_NAME_TAKEN');
    expect((await anon('register_team', [code, '', 'C', 'D', 'Walk College', null], '10.0.0.10')).error).toBe('VALIDATION');
    await orgRpc('update_quiz_details', [{ self_registration: false }]);
  });

  it('rate-limits repeated failed attempts from one client', async () => {
    for (let i = 0; i < 30; i++) await anon('join_lookup', [String(100000 + i)], '10.9.9.9');
    expect(await anon('join_lookup', [code], '10.9.9.9')).toEqual({ ok: false, error: 'RATE_LIMITED' });
    expect((await anon('join_lookup', [code], '10.9.9.8')).ok).toBe(true); // other clients unaffected
  });
});

describe('lobby, start, answers', () => {
  it('lobby shows team, set and duration but no question before the start', async () => {
    const st = await anon('participant_state', [tokenA]);
    expect(st.ok).toBe(true);
    expect(st.quiz).toMatchObject({ title: 'Cold Start Final', status: 'setup', total_questions: 30, duration_seconds: 1800 });
    expect(st.attempt).toMatchObject({ status: 'ready', started_at: null, deadline_at: null });
    expect(st.question).toBeUndefined();
    expect(await anon('participant_start', [tokenA])).toEqual({ ok: false, error: 'NOT_STARTED_YET' });
    expect(await anon('participant_submit', [tokenA, rid(), q1, 'A'])).toEqual({ ok: false, error: 'NOT_STARTED_YET' });
  });

  it('after the organizer goes live, the team presses Start: the server sets start and deadline', async () => {
    await orgRpc('start_quiz');
    expect((await anon('participant_state', [tokenA])).question).toBeUndefined(); // not started yet
    const s = await anon('participant_start', [tokenA]);
    expect(s.status).toBe('in_progress');
    expect(Date.parse(s.deadline_at) - Date.parse(s.started_at)).toBe(1_800_000);
    expect(await anon('participant_start', [tokenA])).toMatchObject({ started_at: s.started_at, deadline_at: s.deadline_at }); // idempotent
    const st = await anon('participant_state', [tokenA]);
    expect(st.attempt.status).toBe('in_progress');
    expect(st.attempt.remaining_ms).toBeGreaterThan(1_790_000);
    expect(st.question.number).toBe(1);
    expect(st.progress).toHaveLength(30);
    expect(JSON.stringify(st)).not.toMatch(KEY_WORDS);
    expect(JSON.stringify(st)).not.toContain('SECRET-EXPLANATION');
  });

  it('accepts one answer (mapped through the team option order), scores it server-side, never reveals correctness', async () => {
    const letter = await shown(1, q1, 'B'); // Q1 key is B (original)
    const req = rid();
    const res = await anon('participant_submit', [tokenA, req, q1, letter.toLowerCase()]);
    expect(res).toMatchObject({ ok: true, duplicate_request: false, selected: letter });
    expect(JSON.stringify(res)).not.toMatch(KEY_WORDS);
    const row = (await db.query(`select result, points, source, selected_option, displayed_option, on_time, attempt_id from public.team_answers where team_id = $1`, [await teamId(1)])).rows[0];
    expect(row).toMatchObject({ result: 'correct', source: 'participant', selected_option: 'B', displayed_option: letter, on_time: true });
    expect(row.attempt_id).toBeTruthy();
    expect(Number(row.points)).toBe(1);
    expect(await anon('participant_submit', [tokenA, req, q1, letter])).toMatchObject({ ok: true, duplicate_request: true, selected: letter });
    // the team may change its answer until it submits (one row per question; each change audited), then change it back
    const other = 'ABCD'.replace(letter, '')[0];
    expect(await anon('participant_submit', [tokenA, rid(), q1, other])).toMatchObject({ ok: true, selected: other });
    expect(await anon('participant_submit', [tokenA, rid(), q1, letter])).toMatchObject({ ok: true, selected: letter });
    expect((await db.query('select count(*)::int c from public.team_answers where team_id = $1', [await teamId(1)])).rows[0].c).toBe(1);
    // reconnect: the team returns to that question and sees its saved answer (option only)
    const pos = (await db.query('select array_position(question_order, $1) - 1 p from public.quiz_attempts where team_id = $2', [q1, await teamId(1)])).rows[0].p;
    const after = await anon('participant_state', [tokenA, pos]);
    expect(after.my_answer).toMatchObject({ selected: letter, source: 'participant' });
    expect(JSON.stringify(after)).not.toMatch(KEY_WORDS);
  });

  it('validates option, question, start and token', async () => {
    expect(await anon('participant_submit', [tokenB, rid(), q1, 'A'])).toEqual({ ok: false, error: 'NOT_STARTED_YET' });
    await anon('participant_start', [tokenB]);
    expect(await anon('participant_submit', [tokenB, rid(), q1, 'E'])).toEqual({ ok: false, error: 'INVALID_OPTION' });
    expect(await anon('participant_submit', [tokenB, rid(), q1, ''])).toEqual({ ok: false, error: 'INVALID_OPTION' });
    const q31 = (await db.query(`select id from public.questions where position = 31`)).rows[0].id;
    expect(await anon('participant_submit', [tokenB, rid(), q31, 'A'])).toEqual({ ok: false, error: 'QUESTION_NOT_IN_QUIZ' });
    expect(await anon('participant_submit', ['f'.repeat(64), rid(), q1, 'A'])).toEqual({ ok: false, error: 'SESSION_INVALID' });
    expect(await anon('participant_submit', ["x' or 1=1 --", rid(), q1, 'A'])).toEqual({ ok: false, error: 'SESSION_INVALID' });
  });

  it("one team's token cannot read or reuse another team's submission", async () => {
    const reqA = (await db.query(`select request_id from public.score_events where source = 'participant' limit 1`)).rows[0].request_id;
    expect(await anon('participant_submit', [tokenB, reqA, q1, 'A'])).toEqual({ ok: false, error: 'VALIDATION' });
    const st = await anon('participant_state', [tokenB]);
    expect(st.progress.filter(Boolean)).toHaveLength(0); // team 2 does not see team 1's answers
    expect(st.team.team_number).toBe(2);
  });

  it('organizer cannot record answers for questions outside the set', async () => {
    const q31 = (await db.query('select id from public.questions where position = 31')).rows[0].id;
    expect(await errCode(orgRpc('record_answer', [rid(), await teamId(4), q31, 'A', false, null]))).toBe('QUESTION_NOT_IN_QUIZ');
  });

  it('organizer corrections and undo still work on device submissions (audited)', async () => {
    await orgRpc('record_answer', [rid(), await teamId(1), q1, 'A', true, 'Team asked organizer to fix tap error']);
    const ev = (await db.query(`select action, source, prev_selected, new_selected from public.score_events order by id desc limit 1`)).rows[0];
    expect(ev).toEqual({ action: 'correction', source: 'organizer', prev_selected: 'B', new_selected: 'A' });
    await orgRpc('undo_last_action', [rid()]);
    expect((await db.query(`select selected_option from public.team_answers where team_id = $1 and question_id = $2`, [await teamId(1), q1])).rows[0].selected_option).toBe('B');
    expect(await errCode(db.query(`update public.score_events set source = 'organizer' where source = 'participant'`))).toBe('AUDIT_IMMUTABLE');
  });

  it('ending the set expires the code and finalizes running attempts; finalized results show only the own team result', async () => {
    await orgRpc('end_quiz');
    expect(await anon('join_lookup', [code], '10.1.1.1')).toEqual({ ok: false, error: 'INVALID_CODE' });
    const st = await anon('participant_state', [tokenA]);
    expect(st.quiz.status).toBe('ended');
    expect(st.attempt.status).toBe('organizer_finalized');
    expect(st.result).toBeUndefined();
    await db.query(`update public.quiz_settings set qualify_count = 1`);
    await orgRpc('confirm_qualifiers', [[await teamId(1)]]);
    await orgRpc('reveal_results', [true]);
    const fin = await anon('participant_state', [tokenA]);
    expect(fin.result).toMatchObject({ rank: 1, qualified: true });
    expect(JSON.stringify(fin)).not.toMatch(/correct_option|explanation/);
    expect((await anon('participant_state', [tokenB])).result.qualified).toBe(false);
  });

  it('a new draft copy archives the set, signs devices out and never reuses the old code', async () => {
    await orgRpc('new_session');
    expect(await anon('participant_state', [tokenA])).toEqual({ ok: false, error: 'SESSION_REVOKED', message: 'Quiz set archived' });
    const s = (await org(`select name, description, question_ids, published_at, join_code from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    expect(s).toMatchObject({ name: 'Cold Start Final', description: 'Round 1', published_at: null, join_code: null });
    expect(s.question_ids).toHaveLength(30);
    const c2 = (await orgRpc('publish_quiz')).join_code;
    expect(c2).not.toBe(code);
    expect(await anon('join_lookup', [code], '10.2.2.2')).toEqual({ ok: false, error: 'INVALID_CODE' });
    const regenerated = (await orgRpc('regenerate_join_code')).join_code;
    expect(regenerated).not.toBe(c2);
    expect(await anon('join_lookup', [c2], '10.2.2.2')).toEqual({ ok: false, error: 'INVALID_CODE' });
    expect((await anon('join_lookup', [regenerated], '10.2.2.2')).ok).toBe(true);
    await orgRpc('unpublish_quiz');
    expect(await anon('join_lookup', [regenerated], '10.2.2.2')).toEqual({ ok: false, error: 'INVALID_CODE' });
  });
});
