// Shared PGlite harness: runs every migration in order against a minimal stub
// of Supabase's auth schema and API roles (anon / authenticated).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export const MIG_DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
export const ORG = '11111111-1111-4111-8111-111111111111';
export const STRANGER = '22222222-2222-4222-8222-222222222222';
export const STAFF = '33333333-3333-4333-8333-333333333333';

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

export const migrationFiles = () => readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();

export async function createDb() {
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of migrationFiles()) await db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
  await db.exec(`insert into auth.users values ('${ORG}', 'host@example.com'), ('${STRANGER}', 'x@example.com'), ('${STAFF}', 'desk@example.com');
                 insert into public.organizers (user_id, display_name) values ('${ORG}', 'Host');`);
  // Registration staff exist only once migration 5 has run.
  await db.exec(`do $$ begin if to_regclass('public.registration_staff') is not null then
                   insert into public.registration_staff (user_id, display_name) values ('${STAFF}', 'Desk'); end if; end $$;`);
  return db;
}

/** Run SQL as an API role. `headers` simulates PostgREST's request.headers (client IP, x-brainfreze-section). */
export function asRole(db, role, sub, sql, params = [], headers = null) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })]);
    if (headers) await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)]);
    return tx.query(sql, params);
  });
}

/**
 * Round 1 (migration 15+): select a set's participants as the organiser — every registered team of its section, or
 * only the given team numbers. `set` is a set id, or 'UG' / 'PG' for the newest current set of that section.
 */
export async function selectTeams(db, set, numbers = null) {
  const setId = /^(UG|PG)$/.test(set)
    ? (await db.query('select id from public.quiz_sessions where section = $1 and is_current order by created_at desc limit 1', [set])).rows[0].id
    : set;
  const ids = (await db.query(`select t.id from public.teams t join public.quiz_sessions s on s.id = $1 and s.section = t.section
    where $2::int[] is null or t.team_number = any ($2::int[]) order by t.team_number`, [setId, numbers])).rows.map((r) => r.id);
  return (await asRole(db, 'authenticated', ORG, 'select public.set_set_teams($1, $2::uuid[]) as r', [setId, ids])).rows[0].r;
}

export async function errCode(promise) {
  try { await promise; } catch (e) { return (e.message.match(/^([A-Z][A-Z0-9_]{2,39}):/) || [null, e.message])[1]; }
  return 'NO_ERROR';
}

let joinSeq = 0;
/**
 * Join a published set as a participant (migration 17): the six-digit code plus the participant's own name and college,
 * as the anon role. Returns join_quiz's result (token, team, section…). `request` reuses a request id (retries).
 */
export async function joinQuiz(db, code, fullName, college = 'Test College', { ip = '10.200.0.1', request = null, section = null, device = null } = {}) {
  const req = request || `0a0a0a0a-0000-4000-8000-${String(++joinSeq).padStart(12, '0')}`;
  const r = await asRole(db, 'anon', null, 'select public.join_quiz($1, $2, $3, $4, $5, $6) as r',
    [code, fullName, college, req, section, device], { 'x-forwarded-for': ip });
  return { ...r.rows[0].r, request_id: req };
}

/** The entry (teams row) a participant created by joining `set` with this name. */
export async function joinedTeam(db, set, fullName) {
  return (await db.query('select * from public.teams where join_session_id = $1 and participant_1 = $2', [set, fullName])).rows[0] || null;
}

/**
 * TEST FIXTURE ONLY: attach a pre-registered, organizer-selected team (e.g. one scored on paper) to a device, so tests
 * of attempts, timers and scoring can use known team numbers. It calls the retired join_registered_team as the database
 * owner — that function is no longer granted to any API role (migration 17), so the app cannot call it. The real
 * participant path, join_quiz, is tested in self_join.sql.test.js.
 */
export async function attachTeam(db, code, section, num, ip = '10.250.0.1', device = null) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': ip })]);
    return (await tx.query('select public.join_registered_team($1, $2, $3, $4) as r', [code, section, num, device])).rows[0].r;
  });
}
