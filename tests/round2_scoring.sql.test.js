// Round 2 scoring with predefined question points (migration 20261026000100) against the real migrations in PGlite:
// Right = +the question's saved points, Wrong = 0, only the chosen team changes, nothing before Confirm Score, never
// twice, invalid session / question / team / result refused, and the board always carries the team list that the
// "Which Team Answered?" step renders (its absence blanked the page). Isolated in-memory database — never the live project.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `5c0e5c0e-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const as = async (sub, fn, args = []) => (await asRole(db, 'authenticated', sub, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const org = (fn, args) => as(ORG, fn, args);
const NOPE = '00000000-0000-4000-8000-0000000000ff';

let sid; let other; let T = {}; let Q = {};
const host = () => org('r2s_board', [sid, true]);
const scores = async (id = sid) => Object.fromEntries((await org('r2s_board', [id, true])).scores.map((s) => [s.team_number, Number(s.score)]));
const reveal = async (q, id = sid) => { await org('r2s_select', [id, q]); await org('r2s_reveal_question', [id, q]); };

beforeAll(async () => {
  db = await createDb();
  for (const i of [1, 2, 3, 4]) await org('save_team', [{ team_number: i, team_name: `Team ${i}`, participant_1: 'a', participant_2: 'b', college_name: 'C', section: 'UG' }]);
  const ids = (await db.query(`select id, team_number from public.teams where section = 'UG' order by team_number`)).rows;
  for (const r of ids) T[r.team_number] = r.id;
  const set = await org('r2s_save_set', [{ title: 'Points board', section: 'UG' }]);
  const topic = await org('r2s_save_topic', [{ set_id: set, name: 'General' }]);
  for (const pts of [10, 20, 30, 40]) Q[pts] = await org('r2s_save_question', [{ topic_id: topic, points: String(pts), question_text: `Q${pts}`, answer_text: `A${pts}` }]);
  const { join_code } = await org('r2s_publish_set', [set]);
  sid = (await org('r2s_start_session', [rid(), join_code, 'UG', [T[1], T[2], T[3]]])).session_id;
  other = (await org('r2s_start_session', [rid(), join_code, 'UG', [T[1], T[4]]])).session_id;
  // board question ids are the published version's ids
  const b = await host();
  Q = Object.fromEntries(b.topics[0].questions.map((q) => [q.points, q.id]));
}, 60_000);

describe('the board carries the team list for "Which Team Answered?"', () => {
  it('host and projector boards both list exactly the session teams (no scores on the projector)', async () => {
    const h = await host();
    const p = await org('r2s_board', [sid, false]);
    for (const b of [h, p]) expect(b.teams.map((t) => t.team_number)).toEqual([1, 2, 3]);
    expect(p.scores).toBeUndefined();
    expect(Object.keys(p.teams[0]).sort()).toEqual(['section', 'team_id', 'team_name', 'team_number']);
  });
});

describe('predefined points: Right = +points, Wrong = 0', () => {
  it('revealing a question changes no score; only Confirm Score (r2s_score) does', async () => {
    await reveal(Q[10]);
    expect(await scores()).toEqual({ 1: 0, 2: 0, 3: 0 });
  });

  it('Right on a 10-point question: +10 for the chosen team only', async () => {
    const r = await org('r2s_score', [rid(), sid, Q[10], T[1], 'right']);
    expect(r).toMatchObject({ duplicate_request: false, result: 'right', team_id: T[1] });
    expect(Number(r.points)).toBe(10);
    expect(await scores()).toEqual({ 1: 10, 2: 0, 3: 0 });
    const b = await host();
    expect(b.game.phase).toBe('idle'); // back to the board
    expect(b.topics[0].questions.find((q) => q.id === Q[10]).used).toBe(true);
  });

  it('Right on a 20-point question: +20; Right on a 30-point question: +30', async () => {
    await reveal(Q[20]);
    expect(Number((await org('r2s_score', [rid(), sid, Q[20], T[2], 'right'])).points)).toBe(20);
    await reveal(Q[30]);
    expect(Number((await org('r2s_score', [rid(), sid, Q[30], T[2], 'right'])).points)).toBe(30);
    expect(await scores()).toEqual({ 2: 50, 1: 10, 3: 0 });
  });

  it('Wrong scores 0 — nothing deducted, even though the set still stores a 50 % penalty', async () => {
    await reveal(Q[40]);
    const r = await org('r2s_score', [rid(), sid, Q[40], T[3], 'wrong']);
    expect(Number(r.points)).toBe(0);
    expect(await scores()).toEqual({ 2: 50, 1: 10, 3: 0 });
    expect((await host()).last_result).toMatchObject({ result: 'wrong', team_number: 3 });
    expect(Number((await host()).last_result.points)).toBe(0);
  });

  it('another session of the same set is untouched', async () => {
    expect(await scores(other)).toEqual({ 1: 0, 4: 0 });
  });
});

describe('integrity: duplicates and invalid input', () => {
  it('a double click / retry with the same request id scores once; a second request for a scored question is refused', async () => {
    await reveal(Q[10], other);
    const req = rid();
    const first = await org('r2s_score', [req, other, Q[10], T[4], 'right']);
    const again = await org('r2s_score', [req, other, Q[10], T[4], 'right']);
    expect(again).toMatchObject({ duplicate_request: true, result_id: first.result_id });
    expect(await errCode(org('r2s_score', [rid(), other, Q[10], T[1], 'right']))).toBe('TRIVIA_QUESTION_USED');
    expect(await scores(other)).toEqual({ 4: 10, 1: 0 });
    expect((await org('r2s_board', [other, true])).results).toHaveLength(1);
  });

  it('refuses an unknown session, a question that is not the revealed one, a team outside the session, and bad results', async () => {
    await reveal(Q[20], other);
    expect(await errCode(org('r2s_score', [rid(), NOPE, Q[20], T[1], 'right']))).toBe('TRIVIA_SESSION_NOT_FOUND');
    expect(await errCode(org('r2s_score', [rid(), other, NOPE, T[1], 'right']))).toBe('TRIVIA_NOT_REVEALED');
    expect(await errCode(org('r2s_score', [rid(), other, Q[30], T[1], 'right']))).toBe('TRIVIA_NOT_REVEALED');
    expect(await errCode(org('r2s_score', [rid(), other, Q[20], T[2], 'right']))).toBe('TRIVIA_TEAM_NOT_IN_ROUND'); // T2 plays only in sid
    expect(await errCode(org('r2s_score', [rid(), other, Q[20], NOPE, 'right']))).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(await errCode(org('r2s_score', [rid(), other, Q[20], T[1], 'maybe']))).toBe('VALIDATION');
    expect(await errCode(org('r2s_score', [null, other, Q[20], T[1], 'right']))).toBe('VALIDATION');
    expect(await errCode(as(STRANGER, 'r2s_score', [rid(), other, Q[20], T[1], 'right']))).toBe('NOT_AUTHORIZED');
    // nothing above changed a score, and the question is still open for a valid confirmation
    expect(await scores(other)).toEqual({ 4: 10, 1: 0 });
    expect((await org('r2s_board', [other, true])).game).toMatchObject({ phase: 'revealed', question_id: Q[20] });
    expect(Number((await org('r2s_score', [rid(), other, Q[20], T[1], 'right'])).points)).toBe(20);
  });
});
