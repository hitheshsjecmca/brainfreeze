// Round 2 "MIND MELTDOWN" against the real migrations (1–7) in PGlite: server-side
// scoring, one result per question, idempotent requests, hidden question/answer on
// the projector board, organizer-only access, and Round 1 left intact.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `abababab-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = []) => (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const as = (role, sub, fn, args = []) => asRole(db, role, sub, `select public.${fn}(${ph(args)}) as r`, args);
const board = () => org('r2_board');
const scores = async () => Object.fromEntries((await board()).scores.map((x) => [x.team_number, Number(x.score)]));
const teamId = async (num) => (await db.query(`select id from public.teams where section = 'UG' and team_number = $1`, [num])).rows[0].id;
const team = (num) => ({ team_number: num, team_name: `UG Team ${num}`, participant_1: 'A', participant_2: 'B', college_name: 'MCA College', section: 'UG' });

const Q = {};
async function open(id) {
  await org('r2_select_question', [id]);
  await org('r2_reveal_question', [id]);
}

beforeAll(async () => {
  db = await createDb();
  for (let i = 1; i <= 4; i++) await org('save_team', [team(i)]);
  const net = await org('r2_save_topic', [{ name: 'Networks' }]);
  const dbs = await org('r2_save_topic', [{ name: 'Databases' }]);
  for (const [key, topic, points] of [['n10', net, '10'], ['n20', net, '20'], ['n30', net, '30'], ['d15', dbs, '15'], ['d25', dbs, '25'], ['d40', dbs, '40']]) {
    Q[key] = await org('r2_save_question', [{ topic_id: topic, points, question_text: `Question ${key}?`, answer_text: `SECRET-ANSWER-${key}` }]);
  }
  await org('r2_set_teams', [[await teamId(1), await teamId(2), await teamId(3)]]);
}, 60_000);

describe('board, reveal and answer', () => {
  it('the board lists every topic and point tile, with defaults 18 s / 50 %', async () => {
    const b = await board();
    expect(b.topics.map((t) => [t.name, t.questions.map((x) => Number(x.points))])).toEqual([['Networks', [10, 20, 30]], ['Databases', [15, 25, 40]]]);
    expect(b.settings).toEqual({ timer_seconds: 18, wrong_penalty_percent: 50 });
    expect(b.game.phase).toBe('idle');
    expect(Object.keys(await scores())).toEqual(['1', '2', '3']);
  });

  it('selecting a tile reveals nothing; Cancel returns it unused', async () => {
    await org('r2_select_question', [Q.n10]);
    const b = await board();
    expect(b.game).toMatchObject({ phase: 'selected', topic: 'Networks', question_text: null, answer_text: null, revealed_at: null });
    expect(Number(b.game.points)).toBe(10);
    expect(JSON.stringify(b)).not.toMatch(/Question n10|SECRET-ANSWER/);
    expect(await errCode(org('r2_select_question', [Q.d15]))).toBe('TRIVIA_QUESTION_ACTIVE');
    await org('r2_cancel_selection');
    expect((await board()).game.phase).toBe('idle');
  });

  it('Reveal Question shows the stored question and stamps the server start time; Answer changes no score', async () => {
    await open(Q.n10);
    let b = await board();
    expect(b.game).toMatchObject({ phase: 'revealed', question_text: 'Question n10?', answer_text: null, answer_revealed: false });
    const started = b.game.revealed_at;
    expect(started).toBeTruthy();
    await org('r2_reveal_question', [Q.n10]); // repeat: timer not restarted
    expect((await board()).game.revealed_at).toBe(started);
    expect(await errCode(org('r2_cancel_selection'))).toBe('TRIVIA_ALREADY_REVEALED');
    const before = await scores();
    await org('r2_reveal_answer', [Q.n10]);
    b = await board();
    expect(b.game).toMatchObject({ answer_revealed: true, answer_text: 'SECRET-ANSWER-n10' });
    expect(await scores()).toEqual(before);
    expect((await db.query('select count(*)::int as c from public.r2_results')).rows[0].c).toBe(0);
  });
});

describe('scoring (server-side, atomic, once)', () => {
  it('Right adds the stored value; the result row records question, team, value, points, host and time', async () => {
    const id = rid();
    const r = await org('r2_score_question', [id, Q.n10, await teamId(2), 'right']);
    expect(r).toMatchObject({ duplicate_request: false, result: 'right' });
    expect(Number(r.points)).toBe(10);
    expect(await scores()).toEqual({ 1: 0, 2: 10, 3: 0 });
    const row = (await db.query('select * from public.r2_results where request_id = $1', [id])).rows[0];
    expect(row).toMatchObject({ question_id: Q.n10, team_id: await teamId(2), team_number: 2, result: 'right', topic_name: 'Networks', actor: ORG, answer_revealed: true });
    expect([Number(row.point_value), Number(row.points)]).toEqual([10, 10]);
    expect(row.created_at).toBeTruthy();
    const b = await board();
    expect(b.game).toMatchObject({ phase: 'idle', question_id: null });
    expect(b.topics[0].questions[0].used).toBe(true);
    expect(b.last_result).toMatchObject({ team_number: 2, result: 'right' });
  });

  it('a repeated request is recognised (no double score); a second request for the same question is refused', async () => {
    const first = (await db.query('select request_id from public.r2_results where question_id = $1', [Q.n10])).rows[0].request_id;
    const dup = await org('r2_score_question', [first, Q.n10, await teamId(2), 'right']);
    expect(dup.duplicate_request).toBe(true);
    expect(await scores()).toEqual({ 1: 0, 2: 10, 3: 0 });
    expect(await errCode(org('r2_score_question', [rid(), Q.n10, await teamId(1), 'right']))).toBe('TRIVIA_QUESTION_USED');
    expect(await errCode(org('r2_select_question', [Q.n10]))).toBe('TRIVIA_QUESTION_USED');
    // the database itself allows only one live result per question
    expect(await errCode(db.query(`insert into public.r2_results (request_id, question_id, topic_name, question_text, result, point_value, points)
      values ('${rid()}', '${Q.n10}', 'x', 'x', 'right', 10, 10)`))).toMatch(/duplicate key|unique/i);
  });

  it('Wrong deducts the configured penalty (half by default; configurable; 2-decimal values)', async () => {
    await open(Q.n20);
    await org('r2_score_question', [rid(), Q.n20, await teamId(1), 'wrong']);
    expect((await scores())[1]).toBe(-10);
    await org('r2_update_settings', [{ wrong_penalty_percent: '25' }]);
    await open(Q.d15);
    const r = await org('r2_score_question', [rid(), Q.d15, await teamId(1), 'wrong']);
    expect(Number(r.points)).toBe(-3.75);
    expect((await scores())[1]).toBe(-13.75);
    await org('r2_update_settings', [{ wrong_penalty_percent: '50' }]);
  });

  it('nothing is scored before Reveal, for teams outside the roster, or with a client-chosen score', async () => {
    expect(await errCode(org('r2_score_question', [rid(), Q.n30, await teamId(1), 'right']))).toBe('TRIVIA_NOT_REVEALED');
    await org('r2_select_question', [Q.n30]);
    expect(await errCode(org('r2_score_question', [rid(), Q.n30, await teamId(1), 'right']))).toBe('TRIVIA_NOT_REVEALED');
    await org('r2_reveal_question', [Q.n30]);
    expect(await errCode(org('r2_score_question', [rid(), Q.n30, await teamId(4), 'right']))).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(await errCode(org('r2_score_question', [rid(), Q.n30, await teamId(1), 'bonus']))).toBe('VALIDATION');
    expect(await errCode(org('r2_score_question', [null, Q.n30, await teamId(1), 'right']))).toBe('VALIDATION');
    // the RPC has no score parameter at all
    const fn = (await db.query(`select pg_get_function_arguments('public.r2_score_question'::regproc) as a`)).rows[0].a;
    expect(fn).toBe('p_request_id uuid, p_question_id uuid, p_team_id uuid, p_result text');
  });

  it('an expired question stays open; closing it without points gives 0 and marks it used', async () => {
    // Q.n30 is open from the previous test. Pretend the 18 s are long over.
    await db.query(`update public.r2_game set revealed_at = now() - interval '5 minutes'`);
    const b = await board();
    expect(b.game.phase).toBe('revealed');
    const before = await scores();
    const r = await org('r2_close_question', [rid(), Q.n30]);
    expect(r).toMatchObject({ result: 'no_score' });
    expect(await scores()).toEqual(before);
    expect((await board()).topics[0].questions[2].used).toBe(true);
    expect(await errCode(org('r2_close_question', [rid(), Q.n30]))).toBe('TRIVIA_QUESTION_USED');
  });
});

describe('setup locks', () => {
  it('validates input and locks played questions, open questions and scored teams', async () => {
    const topic = (await board()).topics[1].id;
    expect(await errCode(org('r2_save_topic', [{ name: ' networks ' }]))).toBe('VALIDATION');
    expect(await errCode(org('r2_save_question', [{ topic_id: topic, points: 'abc', question_text: 'Q?', answer_text: 'A' }]))).toBe('VALIDATION');
    expect(await errCode(org('r2_save_question', [{ topic_id: topic, points: '10', question_text: 'Q?', answer_text: ' ' }]))).toBe('VALIDATION');
    expect(await errCode(org('r2_save_question', [{ id: Q.n10, topic_id: topic, points: '10', question_text: 'Q?', answer_text: 'A' }]))).toBe('TRIVIA_QUESTION_USED');
    expect(await errCode(org('r2_delete_question', [Q.n10]))).toBe('TRIVIA_HAS_RESULTS');
    expect(await errCode(org('r2_set_teams', [[await teamId(3)]]))).toBe('TRIVIA_HAS_RESULTS');
    expect(await errCode(org('r2_update_settings', [{ timer_seconds: '2' }]))).toBe('VALIDATION');
    await org('r2_select_question', [Q.d40]);
    expect(await errCode(org('r2_update_settings', [{ timer_seconds: '20' }]))).toBe('TRIVIA_QUESTION_ACTIVE');
    expect(await errCode(org('r2_delete_question', [Q.d40]))).toBe('TRIVIA_QUESTION_ACTIVE');
    await org('r2_cancel_selection');
  });
});

describe('security', () => {
  it('only organizers can call Round 2 functions; anon cannot call them at all', async () => {
    expect(await errCode(as('authenticated', STRANGER, 'r2_board'))).toBe('NOT_AUTHORIZED');
    expect(await errCode(as('authenticated', STRANGER, 'r2_score_question', [rid(), Q.d40, await teamId(1), 'right']))).toBe('NOT_AUTHORIZED');
    expect(await errCode(as('anon', null, 'r2_board'))).toMatch(/permission denied/);
    expect(await errCode(as('anon', null, 'r2_select_question', [Q.d40]))).toMatch(/permission denied/);
  });

  it('answers are readable by organizers only and never published to Realtime', async () => {
    const stranger = await asRole(db, 'authenticated', STRANGER, 'select * from public.r2_answers');
    expect(stranger.rows).toHaveLength(0);
    expect(await errCode(asRole(db, 'anon', null, 'select * from public.r2_answers'))).toMatch(/permission denied/);
    expect(await errCode(asRole(db, 'authenticated', ORG, `insert into public.r2_results (request_id, topic_name, question_text, result, point_value, points) values ('${rid()}', 'x', 'x', 'right', 1, 1)`))).toMatch(/permission denied/);
    const published = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'r2_%'`)).rows.map((r) => r.tablename);
    expect(published).toEqual(expect.arrayContaining(['r2_game', 'r2_results', 'r2_questions']));
    expect(published).not.toContain('r2_answers');
  });
});

describe('Round 1 coexistence and data safety', () => {
  it('Round 1 functions still work; a deleted team keeps its Round 2 result snapshot', async () => {
    const set = await org('create_set', [{ name: 'UG Set', section: 'UG' }]);
    expect(set).toBeTruthy();
    await org('r2_set_teams', [[await teamId(1), await teamId(2), await teamId(3), await teamId(4)]]);
    await open(Q.d25);
    await org('r2_score_question', [rid(), Q.d25, await teamId(4), 'right']);
    const t4 = await teamId(4);
    await asRole(db, 'authenticated', ORG, 'select public.delete_team($1, true)', [t4], { 'x-brainfreze-set': set });
    const row = (await db.query('select team_id, team_name, points from public.r2_results where question_id = $1 and voided_at is null', [Q.d25])).rows[0];
    expect(row.team_id).toBeNull();
    expect(row.team_name).toBe('UG Team 4');
    expect((await db.query('select count(*)::int as c from public.r2_teams where team_id = $1', [t4])).rows[0].c).toBe(0);
  });

  it('a rehearsal reset needs a reason, voids results (kept) and frees every question', async () => {
    expect(await errCode(org('r2_reset_results', [' ']))).toBe('REASON_REQUIRED');
    const r = await org('r2_reset_results', ['rehearsal']);
    expect(r.voided).toBeGreaterThan(0);
    expect(Object.values(await scores()).every((v) => v === 0)).toBe(true);
    expect((await board()).topics.flatMap((t) => t.questions).every((x) => !x.used)).toBe(true);
    expect((await db.query('select count(*)::int as c from public.r2_results where voided_at is not null')).rows[0].c).toBe(r.voided);
    // a question can be played again after the reset
    await open(Q.n10);
    expect(Number((await org('r2_score_question', [rid(), Q.n10, await teamId(1), 'right'])).points)).toBe(10);
  });
});
