// Round 2 authorization (migration 20261022000100_permissions_repair) against the real migrations in PGlite.
// Reproduces the live failure — "Round 2 could not load. This account is not authorized for this action."
// = permission denied for function r2s_overview after an older migration re-ran its revoke-all loop
// after migration 10 — and proves the repair restores organiser access without opening anything up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, MIG_DIR, ORG, STAFF, STRANGER } from './helpers/db.js';
import { toQuizError } from '../src/lib/errors.js';

const REPAIR = '20261022000100_permissions_repair.sql';
const sql = (f) => readFileSync(join(MIG_DIR, f), 'utf8');
let db;
let n = 0;
const rid = () => `3e3e3e3e-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const as = async (role, sub, fn, args = []) => (await asRole(db, role, sub, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const org = (fn, args) => as('authenticated', ORG, fn, args);
const tryAs = (role, sub, fn, args = []) => errCode(as(role, sub, fn, args));

let setId;
let code;
let sid;
let qid;

beforeAll(async () => {
  db = await createDb();
  await org('save_team', [{ team_number: 1, team_name: 'Perm A', participant_1: 'a', participant_2: 'b', college_name: 'X', section: 'UG' }]);
}, 60_000);

describe('authorized organiser: Round 2 dashboard, trivia sets and sessions load', () => {
  it('the dashboard request (r2s_overview) succeeds for the signed-in organiser', async () => {
    const o = await org('r2s_overview');
    expect(o).toMatchObject({ sets: [], sessions: [] });
  });

  it('the organiser can create, publish and start a game, then load it as host and as projector', async () => {
    setId = await org('r2s_save_set', [{ title: 'Perm Board', section: 'UG' }]);
    const t = await org('r2s_save_topic', [{ set_id: setId, name: 'Auth' }]);
    await org('r2s_save_question', [{ topic_id: t, points: 10, question_text: 'Q?', answer_text: 'SECRET' }]);
    code = (await org('r2s_publish_set', [setId])).join_code;
    const team = (await db.query(`select id from public.teams where team_number = 1 and section = 'UG'`)).rows[0].id;
    sid = (await org('r2s_start_session', [rid(), code, 'UG', [team]])).session_id;
    const o = await org('r2s_overview');
    expect(o.sets.map((s) => s.title)).toEqual(['Perm Board']);
    expect(o.sessions.map((g) => g.id)).toEqual([sid]);
    expect((await org('r2s_set_detail', [setId])).questions).toHaveLength(1);
    const hostBoard = await org('r2s_board', [sid, true]);
    expect(hostBoard.scores).toHaveLength(1);
    qid = hostBoard.topics[0].questions[0].id;
    const proj = await org('r2s_board', [sid, false]);
    expect(proj).not.toHaveProperty('scores');
    expect(JSON.stringify(proj)).not.toMatch(/SECRET/);
  });
});

describe('unauthorized access stays refused', () => {
  const ORGANIZER_CALLS = () => [
    ['r2s_overview', []], ['r2s_set_detail', [setId]], ['r2s_save_set', [{ title: 'Hack', section: 'UG' }]], ['r2s_publish_set', [setId]],
    ['r2s_start_session', [rid(), code, 'UG', []]], ['r2s_board', [sid, false]], ['r2s_board', [sid, true]],
    ['r2s_select', [sid, qid]], ['r2s_reveal_question', [sid, qid]], ['r2s_reveal_answer', [sid, qid]],
    ['r2s_score', [rid(), sid, qid, sid, 'right']], ['r2s_end_session', [sid]],
  ];

  it('signed-in non-organisers (stranger, registration staff) are refused by the organizer check', async () => {
    for (const sub of [STRANGER, STAFF]) for (const [fn, args] of ORGANIZER_CALLS()) expect(await tryAs('authenticated', sub, fn, args)).toBe('NOT_AUTHORIZED');
  });

  it('anon (anyone with only a join code) cannot execute any Round 2 function', async () => {
    for (const [fn, args] of ORGANIZER_CALLS()) expect(await tryAs('anon', null, fn, args)).toMatch(/permission denied for function/);
  });

  it('non-organisers read no Round 2 rows directly, and nobody reads the answer tables', async () => {
    for (const sub of [STRANGER, STAFF]) {
      for (const t of ['r2_sets', 'r2_sessions', 'r2_session_results']) {
        expect((await asRole(db, 'authenticated', sub, `select count(*)::int as c from public.${t}`)).rows[0].c).toBe(0);
      }
    }
    expect((await asRole(db, 'authenticated', ORG, 'select count(*)::int as c from public.r2_sets')).rows[0].c).toBe(1);
    for (const t of ['r2_set_answers', 'r2_version_answers']) expect(await errCode(asRole(db, 'authenticated', ORG, `select * from public.${t}`))).toMatch(/permission denied/);
  });
});

describe('the live failure: an older migration applied after migration 10, and the repair', () => {
  it('re-running migration 9 after 10 reproduces "permission denied for function r2s_overview"; Round 1 is unaffected', async () => {
    await db.exec(sql('20261019000100_round1_participant_flow.sql'));
    const err = await tryAs('authenticated', ORG, 'r2s_overview');
    expect(err).toBe('permission denied for function r2s_overview');
    expect(toQuizError(new Error(err)).code).toBe('DB_PERMISSION_MISSING'); // was shown as "not authorized"
    expect(await errCode(asRole(db, 'authenticated', ORG, 'select * from public.get_standings()'))).toBe('NO_ERROR');
    expect(await tryAs('authenticated', ORG, 'r2s_board', [sid, true])).toMatch(/permission denied/);
  });

  it('migration 12 restores every organiser call and keeps all the refusals', async () => {
    await db.exec(sql(REPAIR));
    expect((await org('r2s_overview')).sets).toHaveLength(1);
    expect((await org('r2s_board', [sid, true])).session.id).toBe(sid);
    await org('r2s_select', [sid, qid]);
    await org('r2s_reveal_question', [sid, qid]);
    expect((await org('r2s_score', [rid(), sid, qid, (await org('r2s_board', [sid, true])).teams[0].team_id, 'right'])).points).toBe(10);
    expect(await errCode(asRole(db, 'authenticated', ORG, 'select * from public.get_standings()'))).toBe('NO_ERROR');
    expect(await tryAs('authenticated', STRANGER, 'r2s_overview')).toBe('NOT_AUTHORIZED');
    expect(await tryAs('authenticated', STAFF, 'r2s_overview')).toBe('NOT_AUTHORIZED');
    expect(await tryAs('anon', null, 'r2s_overview')).toMatch(/permission denied/);
    expect(await tryAs('anon', null, 'join_lookup', [code])).toBe('NO_ERROR'); // participant functions still open to anon
  });

  it('the repair also fixes an older file re-run (migration 7), is idempotent, and grants no internal helper', async () => {
    await db.exec(sql('20261017000100_round2_trivia.sql'));
    expect(await tryAs('authenticated', ORG, 'r2s_overview')).toMatch(/permission denied/);
    await db.exec(sql(REPAIR));
    await db.exec(sql(REPAIR));
    expect(await tryAs('authenticated', ORG, 'r2s_overview')).toBe('NO_ERROR');
    const helpers = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like '\\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
    expect(helpers.rows).toEqual([]);
    const r2sMissing = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'r2s\\_%' and not has_function_privilege('authenticated', p.oid, 'execute')`);
    expect(r2sMissing.rows).toEqual([]);
  });

  it('the newest migration re-applies the complete permission set (Round 2 included), so re-running it last is always the fix', async () => {
    const files = (await import('./helpers/db.js')).migrationFiles();
    const last = sql(files.at(-1));
    for (const g of ['public.r2s_overview()', 'public.r2s_board(uuid, boolean)', 'public.get_standings()', 'public.join_lookup(text)']) expect(last).toContain(g);
    expect(last).toMatch(/revoke all on function %s from public, anon, authenticated/);
    expect(last).toMatch(/Permission check failed|Permission repair failed/);
  });
});

describe('error messages', () => {
  it('a missing GRANT is reported as a database permission problem naming the function and the fix', () => {
    const e = toQuizError({ code: '42501', message: 'permission denied for function r2s_overview' });
    expect(e.code).toBe('DB_PERMISSION_MISSING');
    expect(e.message).toMatch(/r2s_overview/);
    expect(e.message).toMatch(/20261027000100_fresh_sets_options_self_join\.sql/);
  });

  it('a real organizer rejection is still NOT_AUTHORIZED', () => {
    expect(toQuizError(new Error('NOT_AUTHORIZED: This account is not an authorized organizer.')).code).toBe('NOT_AUTHORIZED');
    expect(toQuizError({ code: '42501', message: 'new row violates row-level security policy for table "teams"' }).code).toBe('NOT_AUTHORIZED');
  });
});
