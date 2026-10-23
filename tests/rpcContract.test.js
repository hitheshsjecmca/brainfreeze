// Static contract check: every RPC the Supabase backend calls exists in the
// migrations with exactly the argument names used, and is granted to the right
// role (organizer RPCs → authenticated only; participant RPCs → anon too). The registration desk and the
// pre-registered team join (roster / PIN) are retired: the app no longer calls them and nobody may execute them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const read = (f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8');
const sql = files.map(read).join('\n');
const backend = readFileSync(join(root, 'src/backend/supabaseBackend.js'), 'utf8');

// Latest definition wins (later migrations replace functions and signatures).
const fns = new Map();
for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)) {
  const params = m[2].split(',').map((p) => p.trim()).filter((p) => p && !p.startsWith('out ')).map((p) => p.split(/\s+/)[0]);
  fns.set(m[1], params);
}
// The LAST migration that grants anything re-applies the complete permission set, so it is authoritative.
const lastGrantFile = [...files].reverse().map(read).find((t) => /grant execute on function/.test(t));
const grantBlocks = [...lastGrantFile.matchAll(/grant execute on function([\s\S]*?)to ([a-z, ]+);/g)].map((m) => ({ body: m[1], roles: m[2].split(',').map((r) => r.trim()) }));
const authGrants = grantBlocks.filter((b) => b.roles.includes('authenticated') && !b.roles.includes('anon')).map((b) => b.body).join('\n');
const anonGrants = grantBlocks.filter((b) => b.roles.includes('anon')).map((b) => b.body).join('\n');

const section = (name) => {
  const start = backend.indexOf(`const ${name} = {`);
  return backend.slice(start, backend.indexOf('\n};', start));
};
const parseCalls = (text) => [...text.matchAll(/\['(\w+)', \{([^}]*)\}\]/g)].map((m) => ({
  fn: m[1],
  args: [...m[2].matchAll(/(\w+):/g)].map((x) => x[1]).concat(/\{ p \}/.test(`{${m[2]}}`) ? ['p'] : []),
}));
const organizerCalls = parseCalls(section('RPC'));
const participantCalls = parseCalls(section('PARTICIPANT_RPC'));
const round2Calls = parseCalls(section('R2_RPC'));
const direct = [...backend.matchAll(/(?:supabase\.rpc|setRpc)\('(\w+)'/g)].map((m) => m[1]);

describe('Supabase RPC contract', () => {
  it('finds the RPC maps', () => {
    expect(organizerCalls.length).toBeGreaterThan(30);
    expect(backend).not.toContain('REG_RPC');
    expect(participantCalls).toHaveLength(7);
    // quiz sets (migration 6)
    for (const fn of ['create_set', 'duplicate_set', 'delete_set', 'archive_set', 'revoke_join_code', 'finalize_attempt', 'reset_attempt', 'correct_set_question',
      'save_set_question', 'previous_set_questions', 'import_set_questions']) {
      expect(organizerCalls.map((c) => c.fn)).toContain(fn);
    }
    expect(participantCalls.map((c) => c.fn)).toEqual(['join_lookup', 'join_quiz', 'participant_state', 'participant_start', 'participant_submit', 'participant_finish', 'participant_leave']);
    expect(direct).toEqual(expect.arrayContaining(['get_set_results', 'get_standings', 'server_now']));
  });

  it('finds the Round 2 RPC map (trivia sets and sessions, migration 10)', () => {
    expect(round2Calls.map((c) => c.fn)).toEqual(expect.arrayContaining([
      'r2s_save_set', 'r2s_publish_set', 'r2s_start_session', 'r2s_select', 'r2s_reveal_question', 'r2s_reveal_answer', 'r2s_score', 'r2s_close_question',
    ]));
    for (const fn of ['r2s_overview', 'r2s_set_detail', 'r2s_lookup', 'r2s_eligible_teams', 'r2s_board']) expect(backend).toContain(`supabase.rpc('${fn}'`);
    expect(authGrants).toContain('public.r2s_board(uuid, boolean)');
    expect(anonGrants).not.toContain('public.r2');
  });

  it('the app no longer calls any Round 3 RPC (Round 3 was removed from the app)', () => {
    expect(backend).not.toMatch(/r3s_|R3_RPC/);
  });

  for (const { fn, args } of [...organizerCalls, ...round2Calls]) {
    it(`${fn}(${args.join(', ')}) matches SQL, granted to authenticated only`, () => {
      expect(fns.has(fn), `function ${fn} missing`).toBe(true);
      for (const a of args) expect(fns.get(fn), `${fn} lacks param ${a}`).toContain(a);
      expect(authGrants).toContain(`public.${fn}(`);
      expect(anonGrants).not.toContain(`public.${fn}(`);
    });
  }
  for (const { fn, args } of participantCalls) {
    it(`participant ${fn}(${args.join(', ')}) matches SQL and is granted to anon`, () => {
      expect(fns.has(fn), `function ${fn} missing`).toBe(true);
      for (const a of args) expect(fns.get(fn), `${fn} lacks param ${a}`).toContain(a);
      expect(anonGrants).toContain(`public.${fn}(`);
    });
  }
  for (const fn of direct) {
    it(`direct rpc ${fn} exists and is granted`, () => {
      expect(fns.has(fn)).toBe(true);
      expect(authGrants).toContain(`public.${fn}(`);
    });
  }
  it('participant functions are granted with their current signatures', () => {
    expect(anonGrants).toContain('public.join_quiz(text, text, text, uuid, text, text)');
    expect(anonGrants).toContain('public.participant_state(text, integer)');
  });
  it('organizer RPCs are scoped by the x-brainfreze-set header', () => {
    expect(backend).toContain("const SET_HEADER = 'x-brainfreze-set'");
    expect(sql).toMatch(/_header\('x-brainfreze-set'\)/);
  });
  it('the backend never selects answer keys for the projector', () => {
    const pub = backend.slice(backend.indexOf('async loadPublicSnapshot'), backend.indexOf('subscribe(onChange'));
    expect(pub).not.toMatch(/correct_option|explanation|question_keys/);
  });
  it('retired registration-desk and pre-registered join functions are granted to nobody', () => {
    for (const f of ['reg_overview', 'reg_save_team', 'registration_access', 'is_registration_staff', 'join_roster', 'join_registered_team', 'join_team', 'register_team']) {
      expect(anonGrants).not.toContain(`public.${f}(`);
      expect(authGrants).not.toContain(`public.${f}(`);
      expect(backend).not.toContain(`'${f}'`);
    }
  });
});
