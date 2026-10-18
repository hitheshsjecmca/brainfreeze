// Round 2 private scores and interactive projector (migration 20261021000100) against the real
// migrations in PGlite: projector privacy, organiser-only access, interactive tiles, synchronized
// reveals and protected scoring.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STAFF, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `5d5d5d5d-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const call = async (role, sub, fn, args = []) => (await asRole(db, role, sub, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const org = (fn, args) => call('authenticated', ORG, fn, args);
const projector = (sid) => org('r2s_board', [sid, false]);
const host = (sid) => org('r2s_board', [sid, true]);
const tile = (board, topic, pts) => board.topics.find((t) => t.name === topic).questions.find((q) => Number(q.points) === pts);
const PRIVATE = ['scores', 'last_result', 'results'];

let sid;
let code;
let ug1;
let ug2;
let ug3;

beforeAll(async () => {
  db = await createDb();
  for (const i of [1, 2, 3]) await org('save_team', [{ team_number: i, team_name: `UG P ${i}`, participant_1: `Alice${i}`, participant_2: `Bob${i}`, college_name: 'X', section: 'UG' }]);
  const id = async (k) => (await db.query(`select id from public.teams where section = 'UG' and team_number = $1`, [k])).rows[0].id;
  [ug1, ug2, ug3] = [await id(1), await id(2), await id(3)];
  const set = await org('r2s_save_set', [{ title: 'Projector Board', section: 'UG' }]);
  const topic = await org('r2s_save_topic', [{ set_id: set, name: 'Space' }]);
  for (const [p, q, a] of [[10, 'Red planet?', 'HIDDEN Mars'], [20, 'Largest planet?', 'HIDDEN Jupiter'], [30, 'Closest star?', 'HIDDEN Sun']]) {
    await org('r2s_save_question', [{ topic_id: topic, points: p, question_text: q, answer_text: a }]);
  }
  code = (await org('r2s_publish_set', [set])).join_code;
  sid = (await org('r2s_start_session', [rid(), code, 'UG', [ug1, ug2]])).session_id;
}, 60_000);

describe('projector privacy', () => {
  it('the projector board has no scores, rankings, score log, last result, join code or participant names — at any phase', async () => {
    const check = async () => {
      const b = await projector(sid);
      expect(b.view).toBe('projector');
      for (const k of PRIVATE) expect(b).not.toHaveProperty(k);
      expect(b.session).not.toHaveProperty('join_code');
      expect(b.game).not.toHaveProperty('last_result_id');
      expect(JSON.stringify(b)).not.toMatch(/"score"|Alice|Bob|college/);
      expect(JSON.stringify(b)).not.toContain(code);
      expect(b.teams.map((t) => t.team_number)).toEqual([1, 2]); // names for the team picker only
      expect(Object.keys(b.teams[0]).sort()).toEqual(['section', 'team_id', 'team_name', 'team_number']);
      return b;
    };
    const q = tile(await check(), 'Space', 10);
    await org('r2s_select', [sid, q.id]);
    await check();
    await org('r2s_reveal_question', [sid, q.id]);
    expect(JSON.stringify(await check())).not.toMatch(/HIDDEN/); // no answer peek on the projector
    await org('r2s_reveal_answer', [sid, q.id]);
    expect((await check()).game.answer_text).toBe('HIDDEN Mars');
    await org('r2s_score', [rid(), sid, q.id, ug1, 'right']);
    await check();
  });

  it('the private host board has the leaderboard, the last result and the score log', async () => {
    const b = await host(sid);
    expect(b.view).toBe('host');
    expect(b.session.join_code).toBe(code);
    expect(b.scores.map((s) => [s.team_number, Number(s.score)])).toEqual([[1, 10], [2, 0]]);
    expect(b.last_result).toMatchObject({ team_number: 1, result: 'right' });
    expect(b.results).toHaveLength(1);
  });
});

describe('organiser authorization', () => {
  it('non-organisers (signed-in strangers, registration staff) cannot read either board or run any host action', async () => {
    const q = tile(await projector(sid), 'Space', 20);
    for (const sub of [STRANGER, STAFF]) {
      for (const [fn, args] of [
        ['r2s_board', [sid, false]], ['r2s_board', [sid, true]], ['r2s_overview', []], ['r2s_lookup', [code]],
        ['r2s_select', [sid, q.id]], ['r2s_reveal_question', [sid, q.id]], ['r2s_reveal_answer', [sid, q.id]],
        ['r2s_score', [rid(), sid, q.id, ug1, 'right']], ['r2s_close_question', [rid(), sid, q.id]], ['r2s_end_session', [sid]],
      ]) expect(await errCode(call('authenticated', sub, fn, args))).toBe('NOT_AUTHORIZED');
    }
    expect((await projector(sid)).game.phase).toBe('idle'); // nothing they tried changed the game
  });

  it('anyone holding only the join code (anon / participants) gets nothing: no RPC, no table, no Round 1 join', async () => {
    const q = tile(await projector(sid), 'Space', 20);
    for (const [fn, args] of [['r2s_board', [sid, false]], ['r2s_lookup', [code]], ['r2s_select', [sid, q.id]], ['r2s_score', [rid(), sid, q.id, ug1, 'right']]]) {
      expect(await errCode(call('anon', null, fn, args))).toMatch(/permission denied/);
    }
    for (const t of ['r2_sessions', 'r2_session_results', 'r2_session_teams', 'r2_version_answers']) {
      expect(await errCode(asRole(db, 'anon', null, `select * from public.${t}`))).toMatch(/permission denied/);
    }
    // A Round 2 code never opens a Round 1 participant join.
    expect(await call('anon', null, 'join_lookup', [code])).toEqual({ ok: false, error: 'INVALID_CODE' });
  });

  it('signed-in non-organisers see no score rows even through direct table reads (RLS)', async () => {
    for (const sub of [STRANGER, STAFF]) {
      const r = await asRole(db, 'authenticated', sub, 'select count(*)::int as c from public.r2_session_results');
      expect(r.rows[0].c).toBe(0);
    }
    expect((await asRole(db, 'authenticated', ORG, 'select count(*)::int as c from public.r2_session_results')).rows[0].c).toBe(1);
  });
});

describe('interactive tiles and synchronized reveals', () => {
  it('a tile picked on the projector opens the control step there and on the host screen, still hidden; Reveal syncs both', async () => {
    const q = tile(await projector(sid), 'Space', 20);
    expect(q.used).toBe(false);
    await org('r2s_select', [sid, q.id]);
    const [p, h] = [await projector(sid), await host(sid)];
    for (const b of [p, h]) expect(b.game).toMatchObject({ phase: 'selected', question_id: q.id, topic: 'Space', question_text: null, answer_text: null });
    await org('r2s_reveal_question', [sid, q.id]);
    const [p2, h2] = [await projector(sid), await host(sid)];
    for (const k of ['phase', 'question_id', 'question_text', 'revealed_at', 'answer_revealed']) expect(p2.game[k]).toEqual(h2.game[k]);
    expect(p2.game.question_text).toBe('Largest planet?');
    expect(p2.settings.timer_seconds).toBe(18);
    expect(p2.game.answer_text).toBeNull();
    expect(h2.game.answer_text).toBe('HIDDEN Jupiter'); // host peek only
    expect(await errCode(org('r2s_select', [sid, tile(p2, 'Space', 30).id]))).toBe('TRIVIA_QUESTION_ACTIVE'); // one question at a time
  });
});

describe('protected scoring', () => {
  it('scores only a revealed question, only for a session team, once — retries, refreshes and replays change nothing', async () => {
    const b = await projector(sid);
    const q = b.game.question_id; // still open from the previous test
    expect(await errCode(org('r2s_score', [rid(), sid, q, ug3, 'right']))).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(await errCode(org('r2s_score', [rid(), sid, tile(b, 'Space', 30).id, ug2, 'right']))).toBe('TRIVIA_NOT_REVEALED');
    const req = rid();
    const first = await org('r2s_score', [req, sid, q, ug2, 'wrong']);
    const again = await org('r2s_score', [req, sid, q, ug2, 'wrong']);
    expect(first.duplicate_request).toBe(false);
    expect(again).toMatchObject({ duplicate_request: true, result_id: first.result_id });
    expect(await errCode(org('r2s_score', [rid(), sid, q, ug1, 'right']))).toBe('TRIVIA_QUESTION_USED');
    expect(await errCode(org('r2s_select', [sid, q]))).toBe('TRIVIA_QUESTION_USED');
    // Fresh reads of both views (a refresh) keep the tile used and the score counted once.
    expect(tile(await projector(sid), 'Space', 20).used).toBe(true);
    const h = await host(sid);
    expect(h.scores.map((s) => [s.team_number, Number(s.score)])).toEqual([[1, 10], [2, 0]]); // the wrong answer scored 0
    expect(h.results).toHaveLength(2);
    expect(h.game.phase).toBe('idle');
  });

  it('repeating Reveal Question never restarts the timer', async () => {
    const q = tile(await projector(sid), 'Space', 30);
    await org('r2s_select', [sid, q.id]);
    await org('r2s_reveal_question', [sid, q.id]);
    await db.query(`update public.r2_sessions set revealed_at = revealed_at - interval '10 seconds' where id = $1`, [sid]);
    const at = (await projector(sid)).game.revealed_at;
    await org('r2s_reveal_question', [sid, q.id]);
    expect((await projector(sid)).game.revealed_at).toBe(at);
  });
});
