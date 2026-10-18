// Round 3 Availability (migration 20261026000100) against the real migrations in PGlite: Round 3 is disabled by
// default, every r3s_* RPC and every r3_* table read is refused while disabled, only organizers can switch it, and
// enabling it restores the existing Round 3 data untouched. Isolated in-memory database — never the live project.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STAFF, STRANGER } from './helpers/db.js';

let db;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const as = async (role, sub, fn, args = []) => (await asRole(db, role, sub, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const org = (fn, args) => as('authenticated', ORG, fn, args);
const rows = async (table) => (await asRole(db, 'authenticated', ORG, `select count(*)::int as n from public.${table}`)).rows[0].n;

let setId;
let sessionId;

beforeAll(async () => {
  db = await createDb();
}, 60_000);

describe('Round 3 Availability', () => {
  it('is disabled by default', async () => {
    expect(await org('get_app_settings')).toMatchObject({ round3_enabled: false });
    expect((await db.query('select round3_enabled from public.app_settings')).rows).toEqual([{ round3_enabled: false }]);
  });

  it('refuses every Round 3 RPC while disabled (sets, publishing, sessions, auction actions, reads)', async () => {
    expect(await errCode(org('r3s_overview'))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_save_set', [{ title: 'Blocked' }]))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_publish_set', ['00000000-0000-4000-8000-000000000000']))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_start_session', ['00000000-0000-4000-8000-000000000001', '123456', 'UG', [], {}]))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_record_bid', ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', 10, false]))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_board', ['00000000-0000-4000-8000-000000000000', false]))).toBe('ROUND3_DISABLED');
    expect((await db.query('select count(*)::int as n from public.r3_sets')).rows[0].n).toBe(0);
  });

  it('every r3s_* function is gated, and the ungated bodies are not callable by any API role', async () => {
    const { rows: fns } = await db.query(`select p.proname, p.prosrc,
        has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'r3s\\_%'`);
    expect(fns.length).toBeGreaterThan(25);
    for (const f of fns) {
      expect(f.prosrc, f.proname).toContain('public._require_round3()');
      expect(f.auth, f.proname).toBe(true);
      expect(f.anon, f.proname).toBe(false);
    }
    const { rows: inner } = await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '\\_r3s\\_%\\_ungated'`);
    expect(inner).toHaveLength(fns.length);
    for (const f of inner) expect([f.auth, f.anon], f.proname).toEqual([false, false]);
    expect(await errCode(org('_r3s_overview_ungated'))).toMatch(/permission denied/);
  });

  it('only organizers can read or change the setting', async () => {
    expect(await errCode(as('authenticated', STRANGER, 'set_round3_enabled', [true]))).toBe('NOT_AUTHORIZED');
    expect(await errCode(as('authenticated', STAFF, 'set_round3_enabled', [true]))).toBe('NOT_AUTHORIZED');
    expect(await errCode(as('authenticated', STRANGER, 'get_app_settings'))).toBe('NOT_AUTHORIZED');
    expect(await errCode(as('anon', null, 'set_round3_enabled', [true]))).toMatch(/permission denied/);
    expect(await errCode(as('anon', null, 'get_app_settings'))).toMatch(/permission denied/);
    expect(await errCode(asRole(db, 'authenticated', ORG, 'update public.app_settings set round3_enabled = true'))).toMatch(/permission denied/);
    expect(await errCode(as('authenticated', ORG, 'set_round3_enabled', [null]))).toBe('VALIDATION');
    expect(await org('get_app_settings')).toMatchObject({ round3_enabled: false });
    // A non-organizer is told it is not authorized, not whether Round 3 is enabled.
    expect(await errCode(as('authenticated', STRANGER, 'r3s_overview'))).toBe('NOT_AUTHORIZED');
  });

  it('an organizer can enable Round 3; it persists and Round 3 works again', async () => {
    expect(await org('set_round3_enabled', [true])).toMatchObject({ round3_enabled: true });
    expect(await org('get_app_settings')).toMatchObject({ round3_enabled: true });
    expect((await db.query('select updated_by from public.app_settings')).rows[0].updated_by).toBe(ORG);
    setId = await org('r3s_save_set', [{ title: 'Kept auction', section: 'UG' }]);
    const topic = await org('r3s_save_topic', [{ set_id: setId, name: 'Topic' }]);
    await org('r3s_save_question', [{ topic_id: topic, question_text: 'q', answer_text: 'a' }]);
    const { join_code: joinCode } = await org('r3s_publish_set', [setId]);
    for (const i of [1, 2, 3]) await org('save_team', [{ team_number: i, team_name: `T${i}`, participant_1: 'a', participant_2: 'b', college_name: 'X', section: 'UG' }]);
    const ids = (await db.query(`select id from public.teams where section = 'UG' order by team_number`)).rows.map((r) => r.id);
    const g = await org('r3s_start_session', ['00000000-0000-4000-8000-0000000000a1', joinCode, 'UG', ids, {}]);
    sessionId = g.session_id ?? g.id;
    expect(sessionId).toBeTruthy();
    expect(await rows('r3_sets')).toBe(1);
    expect(await rows('r3_sessions')).toBe(1);
  });

  it('disabling hides Round 3 rows from organizers (RLS) without deleting anything; re-enabling restores them', async () => {
    await org('set_round3_enabled', [false]);
    expect(await rows('r3_sets')).toBe(0);
    expect(await rows('r3_sessions')).toBe(0);
    expect(await rows('r3_session_teams')).toBe(0);
    expect(await errCode(org('r3s_board', [sessionId, true]))).toBe('ROUND3_DISABLED');
    expect(await errCode(org('r3s_end_auction', [sessionId]))).toBe('ROUND3_DISABLED');
    // the data is still there (service role / table owner)
    expect((await db.query('select count(*)::int as n from public.r3_sessions')).rows[0].n).toBe(1);
    expect((await db.query(`select status from public.r3_sessions where id = $1`, [sessionId])).rows[0].status).toBe('live');
    // RLS is still enabled on every Round 3 table
    const { rows: rls } = await db.query(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (relname like 'r3\\_%' or relname = 'app_settings')`);
    for (const t of rls) expect(t.relrowsecurity, t.relname).toBe(true);

    await org('set_round3_enabled', [true]);
    expect(await rows('r3_sets')).toBe(1);
    expect(await rows('r3_sessions')).toBe(1);
    const board = await org('r3s_board', [sessionId, true]);
    expect(board.teams).toHaveLength(3);
  });

  it('Round 1 and Round 2 RPCs are unaffected while Round 3 is disabled', async () => {
    await org('set_round3_enabled', [false]);
    expect(await errCode(org('r2s_overview'))).toBe('NO_ERROR');
    const r2 = await org('r2s_save_set', [{ title: 'Trivia', section: 'UG' }]);
    expect(r2).toBeTruthy();
    expect(await errCode(org('save_team', [{ team_number: 9, team_name: 'T9', participant_1: 'a', participant_2: 'b', college_name: 'X', section: 'UG' }]))).toBe('NO_ERROR');
    expect(await errCode(asRole(db, 'authenticated', ORG, 'select public.get_set_results()', [], { 'x-brainfreze-section': 'UG' }))).toBe('NO_ERROR');
  });
});
