// Runs the real Supabase migrations in PGlite (embedded Postgres) with a
// minimal stub of Supabase's auth schema and API roles, then exercises RLS,
// grants and the RPCs as anon / non-organizer / organizer.
// This verifies the SQL logic; it is NOT a test against a live Supabase project.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SAMPLE_QUESTIONS } from '../src/data/sampleQuestions.js';
import { computeStandings } from '../src/lib/scoring.js';

const MIG_DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');
const ORG = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
let db;
let n = 0;
const rid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
`;

async function as(role, sub, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })]);
    return tx.query(sql, params);
  });
}
const org = (sql, params) => as('authenticated', ORG, sql, params);
const rpc = async (fn, args = []) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await org(`select public.${fn}(${ph}) as r`, args);
  return r.rows[0].r;
};
async function code(promise) {
  try { await promise; } catch (e) { return (e.message.match(/^([A-Z_]{3,40}):/) || [null, e.message])[1]; }
  return 'NO_ERROR';
}
const teamId = async (num) => (await org('select id from public.teams where team_number = $1', [num])).rows[0].id;
const qId = async (pos) => (await org('select id from public.questions where position = $1', [pos])).rows[0].id;
const record = async (team, pos, sel, extra = {}) =>
  rpc('record_answer', [rid(), await teamId(team), await qId(pos), sel, extra.correction ?? false, extra.reason ?? null]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
  }
  await db.exec(`insert into auth.users values ('${ORG}', 'host@example.com'), ('${STRANGER}', 'x@example.com');
                 insert into public.organizers (user_id, display_name) values ('${ORG}', 'Host');`);
}, 60_000);

describe('security (RLS + grants)', () => {
  it('migrations are idempotent (can be re-run)', async () => {
    for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
    }
    const r = await db.query(`select count(*)::int c from public.quiz_sessions where is_current and section = 'UG'`);
    expect(r.rows[0].c).toBe(1);
  });

  it('anon cannot read tables or call RPCs', async () => {
    expect(await code(as('anon', null, 'select * from public.question_keys'))).toMatch(/permission denied/);
    expect(await code(as('anon', null, 'select * from public.teams'))).toMatch(/permission denied/);
    expect(await code(as('anon', null, `select public.record_answer('${rid()}', null, null, 'A')`))).toMatch(/permission denied/);
    expect(await code(as('anon', null, 'select public.get_standings()'))).toMatch(/permission denied/);
  });

  it('signed-in non-organizers see no rows and cannot call RPCs', async () => {
    await rpc('save_team', [{ team_number: 40, team_name: 'Probe', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }]);
    const r = await as('authenticated', STRANGER, 'select count(*)::int c from public.teams');
    expect(r.rows[0].c).toBe(0);
    const k = await as('authenticated', STRANGER, 'select count(*)::int c from public.question_keys');
    expect(k.rows[0].c).toBe(0);
    expect(await code(as('authenticated', STRANGER, 'select public.start_quiz()'))).toBe('NOT_AUTHORIZED');
    expect(await code(as('authenticated', STRANGER, `select public.save_team('{"team_number":41,"team_name":"x","participant_1":"a","participant_2":"b","college_name":"c"}')`))).toBe('NOT_AUTHORIZED');
    await rpc('delete_team', [await teamId(40), false]);
  });

  it('organizers cannot write tables directly — only via RPCs', async () => {
    expect(await code(org(`insert into public.teams (team_number, team_name, participant_1, participant_2) values (44, 'x', 'a', 'b')`))).toMatch(/permission denied/);
    expect(await code(org(`update public.quiz_sessions set status = 'finalized'`))).toMatch(/permission denied/);
    expect(await code(org(`insert into public.team_answers (session_id, team_id, question_id, result, points) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'correct', 100)`))).toMatch(/permission denied/);
    expect(await code(org('delete from public.score_events'))).toMatch(/permission denied/);
  });

  it('internal helpers are not callable by API roles', async () => {
    expect(await code(org(`select public._err('X')`))).toMatch(/permission denied/);
    expect(await code(org(`select * from public._standings(gen_random_uuid())`))).toMatch(/permission denied/);
  });

  it('question_keys is not in the realtime publication', async () => {
    const r = await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`);
    const names = r.rows.map((x) => x.tablename);
    expect(names).toContain('team_answers');
    expect(names).not.toContain('question_keys');
  });
});

describe('quiz flow through RPCs', () => {
  it('imports teams with validation and duplicate protection; no fixed team capacity', async () => {
    expect(await code(rpc('import_teams', [[{ team_number: 1, team_name: 'A', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }, { team_number: 1, team_name: 'B', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }], false, false]))).toBe('DUPLICATE_TEAM_NUMBER');
    expect(await code(rpc('save_team', [{ team_number: 3, team_name: 'Solo', participant_1: 'a', participant_2: '', college_name: 'Test College' }]))).toBe('VALIDATION');
    const rows = Array.from({ length: 50 }, (_, i) => ({ team_number: i + 1, team_name: `Team ${i + 1}`, participant_1: `P${i}a`, participant_2: `P${i}b`, college_name: `College ${i}` }));
    expect(await rpc('import_teams', [rows, false, false])).toEqual({ imported: 50 });
    expect((await rpc('save_team', [{ team_number: 51, team_name: 'X', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }])).id).toBeTruthy(); // no 50-team cap
    expect(await rpc('import_teams', [Array.from({ length: 60 }, (_, i) => ({ team_number: 100 + i, team_name: `Extra ${i}`, participant_1: 'a', participant_2: 'b', college_name: 'C' })), false, false])).toEqual({ imported: 60 });
    // keep 7 teams for the rest of the flow
    await rpc('import_teams', [rows.slice(0, 7), true, false]);
    expect((await org('select count(*)::int c from public.teams')).rows[0].c).toBe(7);
  });

  it('imports questions and validates them', async () => {
    expect(await code(rpc('save_question', [{ question_text: 'x', option_a: 'a', option_b: 'A', option_c: 'c', option_d: 'd', correct_option: 'A' }]))).toBe('VALIDATION');
    const items = SAMPLE_QUESTIONS.slice(0, 4).map(({ sample_ref: _s, ...q }) => q);
    expect(await rpc('import_questions', [items, false, false])).toEqual({ imported: 4 });
    const keys = (await org('select q.position, k.correct_option from public.questions q join public.question_keys k on k.question_id = q.id order by 1')).rows;
    expect(keys.map((k) => k.correct_option)).toEqual(SAMPLE_QUESTIONS.slice(0, 4).map((q) => q.correct_option));
  });

  it('rejects recording before start; going live needs a published (frozen) set; settings lock', async () => {
    expect(await code(record(1, 1, 'A'))).toBe('QUIZ_NOT_STARTED');
    await rpc('update_settings', [{ qualify_count: 4 }]);
    expect(await code(rpc('start_quiz'))).toBe('NOT_PUBLISHED');
    // Any number of questions may be published; the later tests use a 30-question set, so pad the bank with 26 more (keys A, never answered here).
    const filler = Array.from({ length: 26 }, (_, i) => ({ question_text: `Filler ${i + 1}?`, option_a: 'w', option_b: 'x', option_c: 'y', option_d: 'z', correct_option: 'A' }));
    await rpc('import_questions', [filler, false, false]);
    await rpc('publish_quiz');
    // Going live no longer needs pre-selected teams (participants join themselves); here the organizer adds
    // registered teams for paper answer entry before going live.
    await org("select public.set_set_teams((select id from public.quiz_sessions where is_current and section = 'UG' order by created_at desc limit 1), array(select id from public.teams where section = 'UG'))");
    await rpc('start_quiz');
    expect(await code(rpc('update_settings', [{ marks_correct: 3 }]))).toBe('SET_FROZEN');
    // The bank can be reordered: the live set uses its frozen snapshot.
    expect(await code(rpc('reorder_questions', [[]]))).toBe('VALIDATION');
  });

  it('scores from the private key, prevents duplicates and is idempotent', async () => {
    // keys: Q1 B, Q2 D, Q3 A, Q4 C
    const r = await record(1, 1, 'B');
    expect(r).toMatchObject({ result: 'correct', action: 'record', duplicate_request: false });
    expect(Number(r.points)).toBe(1);
    expect(await code(record(1, 1, 'B'))).toBe('ALREADY_RECORDED');
    const req = rid();
    const args = [req, await teamId(2), await qId(1), 'A', false, null];
    const first = await rpc('record_answer', args);
    const retry = await rpc('record_answer', args);
    expect(Number(first.points)).toBe(-0.25);
    expect(retry.duplicate_request).toBe(true);
    expect((await org(`select count(*)::int c from public.team_answers where team_id = $1`, [await teamId(2)])).rows[0].c).toBe(1);
    expect(await code(record(1, 2, 'E'))).toBe('INVALID_OPTION');
  });

  it('corrections need a reason; undo works as a stack', async () => {
    expect(await code(record(2, 1, 'B', { correction: true }))).toBe('REASON_REQUIRED');
    await record(2, 1, 'B', { correction: true, reason: 'Misread sheet' });
    await record(3, 1, null);
    await rpc('undo_last_action', [rid()]); // removes team 3 unanswered
    await rpc('undo_last_action', [rid()]); // reverts team 2 correction → A
    const a = (await org(`select selected_option, result, points from public.team_answers where team_id = $1`, [await teamId(2)])).rows[0];
    expect(a).toMatchObject({ selected_option: 'A', result: 'incorrect' });
    expect(Number(a.points)).toBe(-0.25);
    expect((await org(`select count(*)::int c from public.team_answers where team_id = $1`, [await teamId(3)])).rows[0].c).toBe(0);
    const ev = (await org(`select action, undone from public.score_events where action in ('record','correction','undo') order by id`)).rows;
    expect(ev.filter((e) => e.action === 'undo')).toHaveLength(2);
  });

  it('audit history is append-only even for the database owner', async () => {
    expect(await code(db.query(`update public.score_events set new_points = 99 where action = 'record'`))).toBe('AUDIT_IMMUTABLE');
    expect(await code(db.query(`delete from public.score_events where action = 'record'`))).toBe('AUDIT_IMMUTABLE');
  });

  it('a published set is frozen; its key changes only through the audited workflow, which rescores', async () => {
    const q1 = (await org(`select q.*, k.correct_option, k.explanation from public.questions q join public.question_keys k on k.question_id = q.id where position = 1`)).rows[0];
    expect((await rpc('save_question', [{ ...q1, correct_option: 'A' }])).rescored).toBe(0); // bank only
    expect(await code(rpc('correct_set_question', [q1.id, { correct_option: 'A' }, '']))).toBe('REASON_REQUIRED');
    expect((await rpc('correct_set_question', [q1.id, { correct_option: 'A' }, 'Key typo'])).rescored).toBe(2);
    expect((await rpc('correct_set_question', [q1.id, { correct_option: 'B' }, 'Revert'])).rescored).toBe(2);
    expect((await org(`select count(*)::int c from public.score_events where action = 'key_change'`)).rows[0].c).toBe(2);
    await rpc('save_question', [{ ...q1, correct_option: 'B' }]);
  });

  it('timer is timestamp-based; expiry blocks scoring until corrections are authorized', async () => {
    await rpc('pause_quiz');
    const s1 = (await org(`select elapsed_ms, timer_started_at from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    expect(s1.timer_started_at).toBeNull();
    await rpc('resume_quiz');
    // Simulate 31 minutes having elapsed (as the DB owner).
    await db.query(`update public.quiz_sessions set timer_started_at = now() - interval '31 minutes', elapsed_ms = 0 where is_current and section = 'UG'`);
    expect(await code(record(4, 1, 'B'))).toBe('TIME_EXPIRED');
    expect(await code(rpc('undo_last_action', [rid()]))).toBe('TIME_EXPIRED');
    expect(await code(rpc('set_corrections', [true, '']))).toBe('REASON_REQUIRED');
    await rpc('set_corrections', [true, 'Entering paper answer sheets']);
    await rpc('end_quiz');
    const s2 = (await org(`select status, elapsed_ms from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    expect(s2.status).toBe('ended');
    expect(Number(s2.elapsed_ms)).toBe(1_800_000);
  });

  it('SQL standings match the JS ranking and detect the cut-off tie', async () => {
    // keys: Q1 B, Q2 D, Q3 A, Q4 C
    const sheets = {
      1: [null, 'D', 'A', 'C'], // Q1 already B → 4
      2: [null, 'D', 'A', null], // Q1 A (−0.25) → 1.75
      3: ['B', 'D', 'A', null], // 3
      4: ['B', 'D', null, null], // 2
      5: ['B', 'A', 'B', 'A'], // 1 − 0.75 = 0.25
      6: ['B', 'D', null, null], // 2 (ties 4)
      7: ['B', null, null, null], // 1
    };
    for (const [t, sheet] of Object.entries(sheets)) {
      for (let i = 0; i < 4; i++) if (sheet[i] !== null || (Number(t) === 3 && i === 3)) await record(Number(t), i + 1, sheet[i]);
    }
    const sql = (await org('select * from public.get_standings()')).rows;
    expect(sql.map((r) => [r.team_number, Number(r.points), r.rank])).toEqual([[1, 4, 1], [3, 3, 2], [4, 2, 3], [6, 2, 3], [2, 1.75, 5], [7, 1, 6], [5, 0.25, 7]]);

    const snap = async (q) => (await org(q)).rows;
    const js = computeStandings({
      teams: await snap('select * from public.teams'),
      questions: await snap('select * from public.questions'),
      answers: (await snap(`select a.* from public.team_answers a join public.quiz_sessions s on s.id = a.session_id and s.is_current and s.section = 'UG'`)).map((a) => ({ ...a, points: Number(a.points) })),
      tiebreaks: [],
      settings: { marks_unanswered: 0, accuracy_tiebreak: true },
    });
    expect(js.map((r) => [r.team_number, r.points, r.rank])).toEqual(sql.map((r) => [r.team_number, Number(r.points), r.rank]));
  });

  it('qualification: unresolved tie needs tie-break or override; reveal needs confirmation', async () => {
    // qualify_count = 4 → teams 1, 3 certain; 4 and 6 tied at rank 3 for 2 slots → resolved.
    const ids = async (nums) => Promise.all(nums.map(teamId));
    expect(await code(rpc('reveal_results', [true]))).toBe('NOT_FINALIZED');
    expect(await code(rpc('confirm_qualifiers', [await ids([1, 3, 4, 2])]))).toBe('QUALIFIERS_MISMATCH');
    // Make it unresolved: give team 2 (1.75) a correction to 2 points → three teams tied at 2 for two slots.
    await record(2, 4, 'D', { correction: false }); // Q4 key C → incorrect, 1.5
    await record(2, 4, 'C', { correction: true, reason: 'Recheck' }); // 2.75? no: Q1 A(−.25)+D(1)+A(1)+C(1) = 2.75
    const st = (await org('select team_number, points, rank from public.get_standings()')).rows;
    expect(st.find((r) => r.team_number === 2).rank).toBe(3);
    // Now: 1 (4), 3 (3), 2 (2.75), 4 & 6 (2) tied at rank 4 for one slot → unresolved.
    expect(await code(rpc('confirm_qualifiers', [await ids([1, 3, 2, 4])]))).toBe('TIE_UNRESOLVED');
    await rpc('set_corrections', [false, null]);
    await rpc('set_tiebreak', [await teamId(4), 2, 'Buzzer question']);
    expect(await code(rpc('confirm_qualifiers', [await ids([1, 3, 2, 4])]))).toBe('TIE_UNRESOLVED'); // team 6 lacks a result
    await rpc('set_tiebreak', [await teamId(6), 1, 'Buzzer question']);
    expect(await code(rpc('confirm_qualifiers', [await ids([1, 3, 2, 6])]))).toBe('QUALIFIERS_MISMATCH');
    expect(await rpc('confirm_qualifiers', [await ids([1, 3, 2, 4])])).toMatchObject({ ok: true, override: false });
    expect(await code(record(7, 2, 'D'))).toBe('RESULTS_FINALIZED');
    await rpc('reveal_results', [true]);
    const s = (await org(`select status, results_revealed, projector_view from public.quiz_sessions where is_current and section = 'UG'`)).rows[0];
    expect(s).toEqual({ status: 'finalized', results_revealed: true, projector_view: 'reveal' });
  });

  it('restores a backup and keeps the audit trail', async () => {
    const pick = async (q) => (await org(q)).rows;
    const questions = await pick('select q.*, k.correct_option, k.explanation from public.questions q join public.question_keys k on k.question_id = q.id order by position');
    const session = (await pick(`select * from public.quiz_sessions where is_current and section = 'UG'`))[0];
    const backup = {
      app: 'brainfreze-cold-start', format_version: 1, exported_at: new Date().toISOString(),
      teams: await pick('select * from public.teams'),
      questions,
      session,
      settings: (await pick(`select * from public.quiz_settings where session_id = '${session.id}'`))[0],
      answers: await pick(`select * from public.team_answers where session_id = '${session.id}'`),
      events: await pick(`select * from public.score_events where session_id = '${session.id}' order by id`),
      tiebreaks: await pick(`select * from public.tiebreak_results where session_id = '${session.id}'`),
    };
    const before = (await pick('select team_number, points, rank from public.get_standings()'));
    const json = JSON.parse(JSON.stringify(backup));
    await rpc('new_session');
    expect((await pick(`select count(*)::int c from public.team_answers a join public.quiz_sessions s on s.id = a.session_id and s.is_current and s.section = 'UG'`))[0].c).toBe(0);
    await rpc('restore_backup', [json]);
    const after = (await pick('select team_number, points, rank from public.get_standings()'));
    expect(after).toEqual(before);
    const ev = await pick('select action from public.score_events order by id desc limit 1');
    expect(ev[0].action).toBe('restore');
    // the next audit id continues after the restored ones
    await rpc('reopen_results', ['Re-check after restore']);
    expect(await code(rpc('restore_backup', [{ app: 'nope' }]))).toBe('INVALID_BACKUP');
  });

  it('deleting a team with answers requires confirmation', async () => {
    expect(await code(rpc('delete_team', [await teamId(7), false]))).toBe('TEAM_HAS_ANSWERS');
    await rpc('delete_team', [await teamId(7), true]);
    const ev = (await org(`select action, team_number from public.score_events order by id desc limit 1`)).rows[0];
    expect(ev).toEqual({ action: 'delete_team', team_number: 7 });
  });
});
