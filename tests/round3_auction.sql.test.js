// Round 3 "THE KNOWLEDGE AUCTION" (migration 20261023000100) against the real migrations in PGlite.
// One UG auction (teams A, B, C) plays seven questions that walk every rule; numbers in test names refer to
// the required test list. Isolated in-memory database — never the live project.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STAFF, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `9a9a9a9a-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const as = async (role, sub, fn, args = []) => (await asRole(db, role, sub, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const org = (fn, args) => as('authenticated', ORG, fn, args);
const code = (p) => errCode(p);
const team = (num, section) => ({ team_number: num, team_name: `${section} Auction ${num}`, participant_1: `P${num}a`, participant_2: `P${num}b`, college_name: 'X', section });
const teamId = async (section, num) => (await db.query('select id from public.teams where section = $1 and team_number = $2', [section, num])).rows[0].id;
const SECRET = /SECRET-/;

let setId; let joinCode; let topics = {}; let qIds = {};
let A; let B; let C; let D; let PG1; let PG2; let PG3;
let sid;
const host = () => org('r3s_board', [sid, true]);
const proj = () => org('r3s_board', [sid, false]);
const tm = (b, id) => b.teams.find((t) => t.team_id === id);
const qBySeq = async (seq) => (await host()).question_list.find((q) => q.seq === seq).id;
const bid = (qid, team_id, amount, pass = false) => org('r3s_record_bid', [sid, qid, team_id, amount, pass]);
const outcome = (qid, team_id, o, req = rid()) => org('r3s_record_outcome', [req, sid, qid, team_id, o]);
const open = async (seq) => { const q = await qBySeq(seq); await org('r3s_select_question', [sid, q]); await org('r3s_start_bidding', [sid, q]); return q; };

beforeAll(async () => {
  db = await createDb();
  await org('set_round3_enabled', [true]); // Round 3 is disabled by default (migration 16)
  for (const i of [1, 2, 3, 4]) await org('save_team', [team(i, 'UG')]);
  for (const i of [1, 2, 3]) await org('save_team', [team(i, 'PG')]);
  [A, B, C, D] = [await teamId('UG', 1), await teamId('UG', 2), await teamId('UG', 3), await teamId('UG', 4)];
  [PG1, PG2, PG3] = [await teamId('PG', 1), await teamId('PG', 2), await teamId('PG', 3)];
}, 60_000);

describe('1–3. auction sets: drafts, publishing, codes, immutable snapshots', () => {
  it('1. creates a draft with any number of topics and NORMAL/BLIND questions; edits, deletes and reorders before publishing', async () => {
    setId = await org('r3s_save_set', [{ title: 'UG Final Auction', description: 'Grand finale', section: 'UG' }]);
    expect(await code(org('r3s_save_set', [{ title: '  ' }]))).toBe('VALIDATION');
    for (const name of ['Networks', 'Security', 'Cloud', 'Scrap']) topics[name] = await org('r3s_save_topic', [{ set_id: setId, name }]);
    expect(await code(org('r3s_save_topic', [{ set_id: setId, name: 'networks' }]))).toBe('VALIDATION');
    const add = (t, mode, text) => org('r3s_save_question', [{ topic_id: topics[t], mode, question_text: text, answer_text: `SECRET-${text}`, explanation: `Because ${text}` }]);
    qIds.n1 = await add('Networks', 'NORMAL', 'Q one');
    qIds.n2 = await add('Networks', 'NORMAL', 'Q two');
    qIds.n3 = await add('Networks', 'NORMAL', 'Q three');
    qIds.b1 = await add('Security', 'BLIND', 'Q blind');
    qIds.c1 = await add('Cloud', 'NORMAL', 'Q five');
    qIds.c2 = await add('Cloud', 'NORMAL', 'Q six');
    qIds.c3 = await add('Cloud', 'BLIND', 'Q seven');
    const scrap = await add('Scrap', 'NORMAL', 'Q scrap');
    expect(await code(org('r3s_save_question', [{ topic_id: topics.Cloud, mode: 'SECRET', question_text: 'x', answer_text: 'y' }]))).toBe('VALIDATION');
    expect(await code(org('r3s_save_question', [{ topic_id: topics.Cloud, mode: 'NORMAL', question_text: 'x', answer_text: '' }]))).toBe('VALIDATION');
    // edit, delete, reorder
    await org('r3s_save_question', [{ id: qIds.n2, topic_id: topics.Networks, mode: 'NORMAL', question_text: 'Q two (edited)', answer_text: 'SECRET-two' }]);
    await org('r3s_delete_question', [scrap]);
    await org('r3s_delete_topic', [topics.Scrap]);
    await org('r3s_move', ['question', qIds.n2, -1]); // Q two before Q one
    await org('r3s_move', ['question', qIds.n2, 1]); // and back
    await org('r3s_move', ['topic', topics.Cloud, -1]); // Cloud before Security
    await org('r3s_move', ['topic', topics.Cloud, 1]); // and back
    const d = await org('r3s_set_detail', [setId]);
    expect(d.topics.map((t) => t.name)).toEqual(['Networks', 'Security', 'Cloud']);
    expect(d.questions.filter((q) => q.topic_id === topics.Networks).map((q) => q.question_text)).toEqual(['Q one', 'Q two (edited)', 'Q three']);
    expect(d.questions.find((q) => q.id === qIds.b1)).toMatchObject({ mode: 'BLIND', answer_text: 'SECRET-Q blind', explanation: 'Because Q blind' });
    expect(d.issues).toEqual([]);
  });

  it('2. publishing validates, issues a unique six-digit code (kept on republish) and refuses empty sets', async () => {
    const empty = await org('r3s_save_set', [{ title: 'Empty auction' }]);
    expect(await code(org('r3s_publish_set', [empty]))).toBe('VALIDATION');
    const t = await org('r3s_save_topic', [{ set_id: empty, name: 'Lonely' }]);
    expect(await code(org('r3s_publish_set', [empty]))).toBe('VALIDATION'); // topic without questions
    await org('r3s_save_question', [{ topic_id: t, question_text: 'q', answer_text: 'a' }]);
    const other = await org('r3s_publish_set', [empty]);
    const p = await org('r3s_publish_set', [setId]);
    joinCode = p.join_code;
    expect(joinCode).toMatch(/^\d{6}$/);
    expect(other.join_code).not.toBe(joinCode);
    expect(await code(db.query(`update public.r3_sets set join_code = $1 where id = $2`, [joinCode, empty]))).toMatch(/duplicate key|unique/);
    const look = await org('r3s_lookup', [joinCode]);
    expect(look).toMatchObject({ title: 'UG Final Auction', version: 1, section: 'UG', bid_seconds: null, answer_seconds: 25 }); // new sets: no bidding timer
    expect(look.questions.map((q) => [q.seq, q.mode, q.mode === 'BLIND' ? q.mystery_no : q.topic_name])).toEqual([
      [1, 'NORMAL', 'Networks'], [2, 'NORMAL', 'Networks'], [3, 'NORMAL', 'Networks'], [4, 'BLIND', 1], [5, 'NORMAL', 'Cloud'], [6, 'NORMAL', 'Cloud'], [7, 'BLIND', 2]]);
    expect(JSON.stringify(look)).not.toMatch(SECRET);
    expect(await code(org('r3s_lookup', ['000000']))).toBe('R3_CODE_INVALID');
    expect(await code(org('r3s_delete_set', [setId]))).toBe('R3_SET_PUBLISHED');
  });

  it('3. a published snapshot is immutable: no direct writes (even as owner); editing the draft never changes it', async () => {
    const vq = (await db.query(`select q.id from public.r3_version_questions q join public.r3_versions v on v.id = q.version_id where v.set_id = $1 order by q.seq limit 1`, [setId])).rows[0].id;
    expect(await code(db.query(`update public.r3_version_questions set question_text = 'hacked' where id = $1`, [vq]))).toBe('R3_SNAPSHOT_IMMUTABLE');
    expect(await code(db.query(`update public.r3_version_answers set answer_text = 'hacked' where question_id = $1`, [vq]))).toBe('R3_SNAPSHOT_IMMUTABLE');
    expect(await code(db.query(`delete from public.r3_version_questions where id = $1`, [vq]))).toBe('R3_SNAPSHOT_IMMUTABLE');
    expect(await code(db.query(`update public.r3_versions set title = 'x' where set_id = $1`, [setId]))).toBe('R3_SNAPSHOT_IMMUTABLE');
    expect(await code(asRole(db, 'authenticated', ORG, `update public.r3_version_questions set question_text = 'x'`))).toMatch(/permission denied/);
    await org('r3s_save_question', [{ id: qIds.n1, topic_id: topics.Networks, mode: 'NORMAL', question_text: 'Q one (draft only)', answer_text: 'SECRET-one' }]);
    const v1 = await db.query(`select question_text from public.r3_version_questions q join public.r3_versions v on v.id = q.version_id where v.set_id = $1 and v.version = 1 and q.seq = 1`, [setId]);
    expect(v1.rows[0].question_text).toBe('Q one');
    expect((await org('r3s_overview')).sets.find((s) => s.id === setId).unpublished_changes).toBe(true);
  });
});

describe('4–6. Join Round 3: teams chosen by the organiser; budget 100, private score 0', () => {
  it('4. distinct registered teams of the section (no fixed count); one live auction per section; idempotent Start', async () => {
    const start = (ids, sec = 'UG', req = rid()) => org('r3s_start_session', [req, joinCode, sec, ids]);
    expect(await code(start([]))).toBe('R3_TEAM_COUNT');
    expect(await code(start([A, A, B]))).toBe('DUPLICATE_TEAM');
    expect(await code(start([A, B, PG1]))).toBe('R3_TEAM_NOT_ELIGIBLE');
    expect(await code(start([PG1, PG2, PG3], 'PG'))).toBe('R3_SECTION_MISMATCH');
    const elig = await org('r3s_eligible_teams', [joinCode, 'UG']);
    expect(elig.map((t) => t.team_number)).toEqual([1, 2, 3, 4]);
    const req = rid();
    sid = (await start([A, B, C], 'UG', req)).session_id;
    expect(await start([A, B, C], 'UG', req)).toEqual({ session_id: sid, duplicate_request: true });
    expect(await code(start([A, B, D]))).toBe('R3_SESSION_LIVE');
    expect((await org('r3s_eligible_teams', [joinCode, 'UG'])).find((t) => t.id === A).in_live_auction).toBe(true);
  });

  it('5/6. every team starts with a public budget of 100 and a private score of 0 (separate values)', async () => {
    const h = await host();
    expect(h.teams.map((t) => [t.seat, t.budget, t.score])).toEqual([[1, 100, 0], [2, 100, 0], [3, 100, 0]]);
    const p = await proj();
    expect(p.teams.map((t) => t.budget)).toEqual([100, 100, 100]);
    for (const t of p.teams) expect(t).not.toHaveProperty('score');
    const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'r3_session_teams'`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['budget', 'score']));
  });
});

describe('7–14. bidding rules and visibility', () => {
  it('11/14. NORMAL topic: the topic is shown once selected; the question and answer stay hidden on the projector', async () => {
    const q = await qBySeq(1);
    await org('r3s_select_question', [sid, q]);
    const p = await proj();
    expect(p.current).toMatchObject({ phase: 'selected', mode: 'NORMAL', label: 'Networks', topic: 'Networks', question_text: null, answer_text: null });
    expect(JSON.stringify(p)).not.toMatch(SECRET);
    expect((await host()).current).toMatchObject({ question_text: 'Q one', answer_text: 'SECRET-Q one' }); // private screen sees it
    expect(await code(bid(q, A, 40))).toBe('R3_WRONG_PHASE'); // bidding not open yet
  });

  it('7–9. minimum 10, steps of 10, never above the budget; a bid changes neither budget nor score; open bids can be corrected', async () => {
    const q = await qBySeq(1);
    await org('r3s_start_bidding', [sid, q]);
    expect(await code(bid(q, A, 0))).toBe('R3_BID_TOO_LOW');
    expect(await code(bid(q, A, 5))).toBe('R3_BID_TOO_LOW');
    expect(await code(bid(q, A, 15))).toBe('R3_BID_STEP');
    expect(await code(bid(q, A, 110))).toBe('R3_BID_OVER_BUDGET');
    expect(await code(bid(q, D, 10))).toBe('R3_TEAM_NOT_IN_AUCTION');
    await bid(q, A, 30);
    await bid(q, A, 40); // correction while open
    await bid(q, B, 30);
    await bid(q, C, null, true); // pass
    const p = await proj();
    expect(p.teams.map((t) => [t.bid_status, t.bid])).toEqual([['bid', 40], ['bid', 30], ['pass', null]]); // public bids
    expect((await host()).teams.map((t) => [t.budget, t.score])).toEqual([[100, 0], [100, 0], [100, 0]]);
  });

  it('untimed bidding (the default here): no countdown, no deadline, never closes by itself; an open bidding cannot be restarted', async () => {
    const q = await qBySeq(1);
    expect((await proj()).current).toMatchObject({ phase: 'bidding', bid_seconds: null, bid_deadline: null });
    await db.query(`update public.r3_sessions set bid_started_at = now() - interval '2 hours' where id = $1`, [sid]);
    expect((await proj()).current.phase).toBe('bidding'); // still open after two hours
    await bid(q, B, 30); // bids still accepted
    expect(await code(org('r3s_start_bidding', [sid, q, null]))).toBe('R3_BIDDING_RUNNING');
  });

  it('15. highest bidder correct: + half the bid to the private score; budget unchanged; question used', async () => {
    const q = await qBySeq(1);
    expect(await code(org('r3s_reveal_question', [sid, q]))).toBe('R3_BIDDING_OPEN');
    const closed = await org('r3s_close_bidding', [sid, q]);
    expect(closed).toMatchObject({ phase: 'closed', order: [A, B], tie: false });
    expect(await code(bid(q, B, 50))).toBe('R3_BIDDING_CLOSED'); // bids locked
    await org('r3s_reveal_question', [sid, q]);
    const p = await proj();
    expect(p.current).toMatchObject({ phase: 'answering', question_text: 'Q one', answer_text: null, current_team_id: A, order_pos: 1 });
    const r = await outcome(q, A, 'correct');
    expect(r).toMatchObject({ was_top: true, bid: 40, score_delta: 20, budget_delta: 0, next: 'done' });
    const h = await host();
    expect([tm(h, A).score, tm(h, A).budget]).toEqual([20, 100]);
    expect(h.current.phase).toBe('done');
    await org('r3s_reveal_answer', [sid, q]);
    expect((await proj()).current).toMatchObject({ answer_text: 'SECRET-Q one', explanation: 'Because Q one' });
    await org('r3s_finish_question', [sid, q]);
    expect((await proj()).questions.find((x) => x.seq === 1).used).toBe(true);
    expect(await code(org('r3s_select_question', [sid, q]))).toBe('R3_QUESTION_USED');
  });

  it('16/18. highest bidder wrong: − half the bid from the budget (score unchanged); the next bidder answers correctly: +10', async () => {
    const q = await open(2);
    await bid(q, A, 40);
    await bid(q, B, 30);
    await org('r3s_close_bidding', [sid, q]);
    await org('r3s_reveal_question', [sid, q]);
    expect(await code(outcome(q, B, 'correct'))).toBe('R3_NOT_CURRENT_TEAM');
    expect(await outcome(q, A, 'wrong')).toMatchObject({ was_top: true, score_delta: 0, budget_delta: -20, next: 'next_bidder' });
    let h = await host();
    expect([tm(h, A).score, tm(h, A).budget]).toEqual([20, 80]);
    expect(h.current.phase).toBe('between');
    expect((await proj()).last_outcome).toEqual({ team_id: A, team_name: 'UG Auction 1', team_number: 1, outcome: 'wrong', was_top: true, budget_delta: -20 });
    await org('r3s_next_bidder', [sid, q]);
    expect((await proj()).current).toMatchObject({ phase: 'answering', current_team_id: B, order_pos: 2 });
    expect(await code(outcome(q, A, 'correct'))).toBe('R3_NOT_CURRENT_TEAM'); // A cannot answer twice
    expect(await outcome(q, B, 'correct')).toMatchObject({ was_top: false, score_delta: 10, budget_delta: 0 });
    h = await host();
    expect([tm(h, B).score, tm(h, B).budget]).toEqual([10, 100]);
    await org('r3s_finish_question', [sid, q]);
  });

  it('17/19/20/22. highest bidder pass, lower bidder wrong, lower bidder pass: no changes; nobody left → completed, no points', async () => {
    const q = await open(3);
    await bid(q, A, 30); await bid(q, B, 20); await bid(q, C, 10);
    await org('r3s_close_bidding', [sid, q]);
    await org('r3s_reveal_question', [sid, q]);
    const before = (await host()).teams.map((t) => [t.budget, t.score]);
    expect(await outcome(q, A, 'pass')).toMatchObject({ score_delta: 0, budget_delta: 0, next: 'next_bidder' });
    await org('r3s_next_bidder', [sid, q]);
    expect(await outcome(q, B, 'wrong')).toMatchObject({ was_top: false, score_delta: 0, budget_delta: 0, next: 'next_bidder' });
    await org('r3s_next_bidder', [sid, q]);
    expect(await outcome(q, C, 'pass')).toMatchObject({ score_delta: 0, budget_delta: 0, next: 'done' });
    const h = await host();
    expect(h.teams.map((t) => [t.budget, t.score])).toEqual(before);
    expect(h.current.phase).toBe('done');
    expect(await code(org('r3s_next_bidder', [sid, q]))).toBe('R3_WRONG_PHASE');
    const res = (await org('r3s_results', [sid])).questions.find((x) => x.seq === 3);
    expect(res).toMatchObject({ result: 'no_correct', winner_team_id: null, top_team_id: A, top_bid: 30 });
    await org('r3s_finish_question', [sid, q]);
  });

  it('12/13/14/23/24. BLIND topic hidden until Reveal Topic after bidding; tie resolution; question hidden until revealed; timer persists; timeout', async () => {
    const q = await qBySeq(4);
    await org('r3s_select_question', [sid, q]);
    let p = await proj();
    expect(p.current).toMatchObject({ mode: 'BLIND', label: 'MYSTERY QUESTION #1', topic: null, topic_revealed: false, question_text: null });
    expect(JSON.stringify(p)).not.toMatch(/Security|Q blind|SECRET/);
    expect(await code(org('r3s_reveal_topic', [sid, q]))).toBe('R3_BIDDING_OPEN');
    await org('r3s_start_bidding', [sid, q]);
    expect(await code(org('r3s_reveal_topic', [sid, q]))).toBe('R3_BIDDING_OPEN');
    await bid(q, A, 30); await bid(q, B, 30); await bid(q, C, 20);
    expect(await org('r3s_close_bidding', [sid, q])).toMatchObject({ phase: 'tie', tie: true });
    p = await proj();
    expect(p.current.topic).toBeNull(); // closing never reveals a blind topic
    expect(await code(org('r3s_reveal_question', [sid, q]))).toBe('R3_TIE_UNRESOLVED');
    // 23. tie resolution: only equal bids may be reordered, with a reason
    expect(await code(org('r3s_resolve_tie', [sid, q, [C, A, B], 'coin toss']))).toBe('R3_TIE_ORDER');
    expect(await code(org('r3s_resolve_tie', [sid, q, [A, B], 'coin toss']))).toBe('R3_TIE_ORDER');
    expect(await code(org('r3s_resolve_tie', [sid, q, [B, A, C], ' ']))).toBe('VALIDATION');
    await org('r3s_reopen_bidding', [sid, q, 'B wanted to correct its bid']); // audited correction path
    expect((await proj()).current.phase).toBe('bidding');
    await org('r3s_close_bidding', [sid, q]);
    await org('r3s_resolve_tie', [sid, q, [B, A, C], 'Coin toss won by B']);
    expect((await proj()).current).toMatchObject({ phase: 'closed', bid_order: [B, A, C], current_team_id: B });
    expect(await code(org('r3s_reveal_question', [sid, q]))).toBe('R3_TOPIC_HIDDEN');
    await org('r3s_reveal_topic', [sid, q]);
    p = await proj();
    expect(p.current).toMatchObject({ topic: 'Security', question_text: null }); // topic shown, question still hidden
    await org('r3s_reveal_question', [sid, q]);
    // 24. the answer timer is a server timestamp: reads and repeated reveals never restart it
    const t0 = (await proj()).current.answer_started_at;
    await org('r3s_reveal_question', [sid, q]);
    expect((await proj()).current.answer_started_at).toBe(t0);
    expect((await host()).current.answer_started_at).toBe(t0);
    expect(await code(outcome(q, B, 'timeout'))).toBe('R3_TIMER_RUNNING');
    await db.query(`update public.r3_sessions set answer_started_at = answer_started_at - interval '30 seconds' where id = $1`, [sid]);
    expect(await outcome(q, B, 'timeout')).toMatchObject({ was_top: true, score_delta: 0, budget_delta: 0 }); // timeout alone never deducts
    await org('r3s_next_bidder', [sid, q]);
    expect(await outcome(q, A, 'wrong')).toMatchObject({ was_top: false, budget_delta: 0, score_delta: 0 }); // A is a lower bidder here
    await org('r3s_next_bidder', [sid, q]);
    expect(await outcome(q, C, 'correct')).toMatchObject({ was_top: false, score_delta: 10 });
    await org('r3s_finish_question', [sid, q]);
  });

  it('21/25. order is by bid, highest first; a retried or double-clicked confirmation scores once', async () => {
    const q = await open(5);
    await bid(q, A, 20); await bid(q, B, 50); await bid(q, C, 30);
    expect((await org('r3s_close_bidding', [sid, q])).order).toEqual([B, C, A]);
    await org('r3s_reveal_question', [sid, q]);
    const req = rid();
    const first = await outcome(q, B, 'correct', req);
    const again = await outcome(q, B, 'correct', req);
    expect(first).toMatchObject({ duplicate_request: false, score_delta: 25 });
    expect(again).toMatchObject({ duplicate_request: true, event_id: first.event_id, score_delta: 25 });
    expect(await code(outcome(q, B, 'correct'))).toBe('R3_WRONG_PHASE'); // a second click with a new id
    expect(tm(await host(), B).score).toBe(35);
    expect((await db.query(`select count(*)::int as c from public.r3_events where session_id = $1 and question_id = $2 and kind = 'outcome'`, [sid, q])).rows[0].c).toBe(1);
    await org('r3s_finish_question', [sid, q]);
  });

  it('a question nobody bids on is completed without points; a cancelled question stays unused', async () => {
    const q6 = await open(6);
    await bid(q6, A, null, true);
    expect(await org('r3s_close_bidding', [sid, q6])).toMatchObject({ phase: 'done', result: 'no_bids' });
    await org('r3s_finish_question', [sid, q6]);
    const q7 = await open(7);
    await bid(q7, A, 10);
    expect(await code(org('r3s_end_auction', [sid]))).toBe('R3_QUESTION_LIVE'); // nothing may be pending
    await org('r3s_cancel_question', [sid, q7]);
    expect((await proj()).questions.find((x) => x.seq === 7).used).toBe(false);
    expect((await db.query(`select count(*)::int as c from public.r3_bids where session_id = $1 and question_id = $2`, [sid, q7])).rows[0].c).toBe(0);
  });

  it('10. a team with a budget below 10 cannot bid and must pass (PG auction)', async () => {
    const pgSet = await org('r3s_save_set', [{ title: 'PG Auction', section: 'PG' }]);
    const t = await org('r3s_save_topic', [{ set_id: pgSet, name: 'Ops' }]);
    await org('r3s_save_question', [{ topic_id: t, question_text: 'pg q', answer_text: 'pg a' }]);
    const pgCode = (await org('r3s_publish_set', [pgSet])).join_code;
    const pg = (await org('r3s_start_session', [rid(), pgCode, 'PG', [PG1, PG2, PG3]])).session_id;
    await db.query(`update public.r3_session_teams set budget = 5 where session_id = $1 and team_id = $2`, [pg, PG1]);
    const q = (await org('r3s_board', [pg, true])).question_list[0].id;
    await org('r3s_select_question', [pg, q]);
    await org('r3s_start_bidding', [pg, q]);
    expect(await code(org('r3s_record_bid', [pg, q, PG1, 10, false]))).toBe('R3_CANNOT_BID');
    await org('r3s_record_bid', [pg, q, PG1, null, true]);
    await org('r3s_record_bid', [pg, q, PG2, 100, false]); // all-in is allowed
    expect(await code(db.query(`update public.r3_session_teams set budget = -10 where session_id = $1 and team_id = $2`, [pg, PG2]))).toMatch(/check/);
    await org('r3s_cancel_question', [pg, q]);
    await org('r3s_end_auction', [pg]);
  });
});

describe('final results', () => {
  it('End Auction freezes the auction; rankings come from private scores; the projector shows them only after reveal', async () => {
    expect(await code(org('r3s_reveal_results', [sid, true]))).toBe('R3_NOT_ENDED');
    await org('r3s_end_auction', [sid]);
    expect(await code(org('r3s_select_question', [sid, await qBySeq(7)]))).toBe('R3_SESSION_ENDED');
    const res = await org('r3s_results', [sid]);
    expect(res.ranking.map((r) => [r.rank, r.team_id, r.score, r.budget, r.tied])).toEqual([[1, B, 35, 100, false], [2, A, 20, 80, false], [3, C, 10, 100, false]]);
    const sum = Object.fromEntries(res.summary.map((s) => [s.team_id, s]));
    expect(sum[A]).toMatchObject({ correct: 1, wrong: 2, passes: 1, points_awarded: 20, budget_deducted: 20 });
    expect(sum[B]).toMatchObject({ correct: 2, wrong: 1, passes: 1, points_awarded: 35, budget_deducted: 0 });
    expect(sum[C]).toMatchObject({ correct: 1, wrong: 0, passes: 1, points_awarded: 10, budget_deducted: 0 });
    expect(res.questions.map((q) => [q.seq, q.result])).toEqual([[1, 'correct'], [2, 'correct'], [3, 'no_correct'], [4, 'correct'], [5, 'correct'], [6, 'no_bids']]);
    expect((await proj()).final).toBeNull();
    await org('r3s_reveal_results', [sid, true]);
    const p = await proj();
    expect(p.final.map((r) => [r.rank, r.team_name, r.score])).toEqual([[1, 'UG Auction 2', 35], [2, 'UG Auction 1', 20], [3, 'UG Auction 3', 10]]);
  });
});

describe('optional bidding timer (migration 14) — a second auction of the same set', () => {
  let s2;
  const b2 = (host = false) => org('r3s_board', [s2, host]);
  const q2 = async (seq) => (await b2(true)).question_list.find((q) => q.seq === seq).id;
  const shift = (secs) => db.query(`update public.r3_sessions set bid_started_at = bid_started_at - make_interval(secs => $2) where id = $1`, [s2, secs]);
  const start = (q, timer) => org('r3s_start_bidding', [s2, q, timer === undefined ? null : { bid_timer_seconds: timer }]);

  it('a new auction of the same set is separate; the first auction’s results are preserved', async () => {
    const start2 = (settings) => org('r3s_start_session', [rid(), joinCode, 'UG', [A, B, D], settings]);
    expect(await code(start2({ bid_timer_seconds: 0 }))).toBe('VALIDATION');
    expect(await code(start2({ bid_timer_seconds: 3601 }))).toBe('VALIDATION');
    expect(await code(start2({ bid_timer_seconds: 'abc' }))).toBe('VALIDATION');
    expect(await code(start2({ answer_seconds: 3 }))).toBe('VALIDATION');
    s2 = (await start2({ bid_timer_seconds: 20, answer_seconds: 40 })).session_id;
    expect(s2).not.toBe(sid);
    expect((await b2()).settings).toMatchObject({ bid_timer_default: 20, answer_seconds: 40 });
    expect((await b2(true)).teams.map((t) => [t.budget, t.score])).toEqual([[100, 0], [100, 0], [100, 0]]);
    expect((await org('r3s_results', [sid])).ranking.map((r) => r.score)).toEqual([35, 20, 10]); // history untouched
  });

  it('timed (session default 20 s): countdown data, no restart; after the deadline bidding closes itself at the deadline', async () => {
    const q = await q2(1);
    await org('r3s_select_question', [s2, q]);
    await start(q);
    let p = await b2();
    expect(p.current).toMatchObject({ phase: 'bidding', bid_seconds: 20 });
    expect(new Date(p.current.bid_deadline).getTime() - new Date(p.current.bid_started_at).getTime()).toBe(20_000);
    expect(await code(start(q, 60))).toBe('R3_BIDDING_RUNNING'); // cannot extend an active timer
    await org('r3s_record_bid', [s2, q, A, 30, false]);
    await org('r3s_record_bid', [s2, q, B, 20, false]);
    await shift(25);
    // No board read yet: the next organizer action closes the expired bidding before it runs.
    expect(await code(org('r3s_record_bid', [s2, q, B, 40, false]))).toBe('R3_BIDDING_CLOSED');
    p = await b2();
    expect(p.current).toMatchObject({ phase: 'closed', bid_order: [A, B], current_team_id: A });
    const ev = (await b2(true)).log.find((e) => e.kind === 'bidding_closed');
    expect(ev.detail).toMatchObject({ auto: true, timer_seconds: 20 });
    const closedAt = (await db.query('select bids_closed_at, bid_started_at from public.r3_sessions where id = $1', [s2])).rows[0];
    expect(new Date(closedAt.bids_closed_at).getTime() - new Date(closedAt.bid_started_at).getTime()).toBe(20_000); // closed AT the deadline
    expect(await org('r3s_close_bidding', [s2, q])).toMatchObject({ already_closed: true }); // manual close afterwards is harmless
    await org('r3s_cancel_question', [s2, q]);
  });

  it('a board read alone (refresh / reconnect) closes an expired timed bidding — even with nobody acting', async () => {
    const q = await q2(1);
    await org('r3s_select_question', [s2, q]);
    await start(q, 45); // per-question override: 45 s
    expect((await b2()).current.bid_seconds).toBe(45);
    await org('r3s_record_bid', [s2, q, A, 10, false]);
    await shift(30);
    expect((await b2()).current.phase).toBe('bidding'); // 30 s in: still open
    await shift(20);
    expect((await b2()).current).toMatchObject({ phase: 'closed', bid_order: [A] }); // 50 s in: closed by the read
    await org('r3s_cancel_question', [s2, q]);
  });

  it('per-question "no timer" override on a timed auction: never closes by itself; manual Close Bidding works', async () => {
    const q = await q2(2);
    await org('r3s_select_question', [s2, q]);
    await start(q, null);
    expect((await b2()).current).toMatchObject({ bid_seconds: null, bid_deadline: null });
    await shift(3600);
    expect((await b2()).current.phase).toBe('bidding');
    await org('r3s_record_bid', [s2, q, B, 50, false]);
    expect(await org('r3s_close_bidding', [s2, q])).toMatchObject({ phase: 'closed', order: [B] });
    await org('r3s_cancel_question', [s2, q]);
  });

  it('an expired timed bidding with no bids completes the question without points', async () => {
    const q = await q2(3);
    await org('r3s_select_question', [s2, q]);
    await start(q, 5);
    await shift(6);
    expect((await b2()).current).toMatchObject({ phase: 'done' });
    expect((await org('r3s_results', [s2])).questions.find((x) => x.seq === 3)).toMatchObject({ result: 'no_bids', bid_seconds: 5 });
    await org('r3s_finish_question', [s2, q]);
  });

  it('the session defaults can be changed (audited); the answer timer uses the auction setting', async () => {
    await org('r3s_update_session_settings', [s2, { bid_timer_seconds: null, answer_seconds: 30 }]);
    expect((await b2()).settings).toMatchObject({ bid_timer_default: null, answer_seconds: 30 });
    const q = await q2(5);
    await org('r3s_select_question', [s2, q]);
    await start(q);
    expect((await b2()).current.bid_seconds).toBeNull();
    await org('r3s_record_bid', [s2, q, A, 20, false]);
    await org('r3s_close_bidding', [s2, q]);
    await org('r3s_reveal_question', [s2, q]);
    expect(await code(org('r3s_update_session_settings', [s2, { answer_seconds: 60 }]))).toBe('R3_WRONG_PHASE');
    await db.query(`update public.r3_sessions set answer_started_at = now() - interval '25 seconds' where id = $1`, [s2]);
    expect(await code(org('r3s_record_outcome', [rid(), s2, q, A, 'timeout']))).toBe('R3_TIMER_RUNNING'); // 25 s < 30 s
    await db.query(`update public.r3_sessions set answer_started_at = now() - interval '31 seconds' where id = $1`, [s2]);
    expect(await org('r3s_record_outcome', [rid(), s2, q, A, 'timeout'])).toMatchObject({ score_delta: 0, budget_delta: 0, next: 'done' });
    await org('r3s_finish_question', [s2, q]);
    await org('r3s_end_auction', [s2]);
  });
});

describe('26–27. privacy and authorization', () => {
  it('26. the projector board never carries a private score (keys or values) at any point', async () => {
    const p = await proj();
    expect(p.view).toBe('projector');
    for (const t of p.teams) expect(Object.keys(t).sort()).toEqual(['bid', 'bid_status', 'budget', 'seat', 'section', 'team_id', 'team_name', 'team_number']);
    expect(p).not.toHaveProperty('ranking');
    expect(p).not.toHaveProperty('log');
    expect(p).not.toHaveProperty('question_list');
    expect(p.session).not.toHaveProperty('join_code');
  });

  it('27. strangers and registration staff are refused; anon cannot call anything or read any table; nobody writes tables directly', async () => {
    const calls = [['r3s_overview', []], ['r3s_board', [sid, false]], ['r3s_board', [sid, true]], ['r3s_results', [sid]], ['r3s_save_set', [{ title: 'x' }]],
      ['r3s_publish_set', [setId]], ['r3s_start_session', [rid(), joinCode, 'UG', [A, B, C]]], ['r3s_record_bid', [sid, sid, A, 10, false]],
      ['r3s_record_outcome', [rid(), sid, sid, A, 'correct']], ['r3s_end_auction', [sid]], ['r3s_reveal_results', [sid, false]]];
    for (const sub of [STRANGER, STAFF]) for (const [fn, args] of calls) expect(await code(as('authenticated', sub, fn, args))).toBe('NOT_AUTHORIZED');
    for (const [fn, args] of calls) expect(await code(as('anon', null, fn, args))).toMatch(/permission denied/);
    for (const t of ['r3_sets', 'r3_sessions', 'r3_session_teams', 'r3_bids', 'r3_events', 'r3_set_answers', 'r3_version_answers']) {
      expect(await code(asRole(db, 'anon', null, `select * from public.${t}`))).toMatch(/permission denied/);
    }
    for (const sub of [STRANGER, STAFF]) expect((await asRole(db, 'authenticated', sub, 'select count(*)::int as c from public.r3_session_teams')).rows[0].c).toBe(0);
    for (const t of ['r3_set_answers', 'r3_version_answers']) expect(await code(asRole(db, 'authenticated', ORG, `select * from public.${t}`))).toMatch(/permission denied/);
    expect(await code(asRole(db, 'authenticated', ORG, `update public.r3_session_teams set score = 999`))).toMatch(/permission denied/);
    expect(await code(asRole(db, 'authenticated', ORG, `insert into public.r3_events (session_id, kind) values ('${sid}', 'bid')`))).toMatch(/permission denied/);
    const leaked = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and (p.proname like 'r3s\\_%' or p.proname like '\\_r3\\_%') and has_function_privilege('anon', p.oid, 'execute')`);
    expect(leaked.rows).toEqual([]);
    // Every Round 2 / Round 3 organizer function is executable by signed-in users (the organizer check runs inside).
    const missing = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and (p.proname like 'r2s\\_%' or p.proname like 'r3s\\_%') and not has_function_privilege('authenticated', p.oid, 'execute')`);
    expect(missing.rows).toEqual([]);
  });
});

describe('any number of teams (migration 15)', () => {
  it('an auction takes one team or four teams — whatever the organiser selects; never none or duplicates', async () => {
    await db.query(`update public.r3_sessions set status = 'ended', ended_at = now(), phase = 'idle', question_id = null where section = 'UG' and status = 'live'`);
    const four = (await org('r3s_start_session', [rid(), joinCode, 'UG', [D, C, B, A]])).session_id;
    const b4 = await org('r3s_board', [four, true]);
    expect(b4.teams.map((t) => [t.seat, t.team_id, t.budget, t.score])).toEqual([[1, D, 100, 0], [2, C, 100, 0], [3, B, 100, 0], [4, A, 100, 0]]);
    const q = b4.question_list[0].id;
    await org('r3s_select_question', [four, q]);
    await org('r3s_start_bidding', [four, q, null]);
    for (const [t, amt] of [[A, 40], [B, 30], [C, 20], [D, 10]]) await org('r3s_record_bid', [four, q, t, amt, false]);
    await org('r3s_close_bidding', [four, q]);
    expect((await org('r3s_board', [four, true])).current.bid_order).toEqual([A, B, C, D]);
    await db.query(`update public.r3_sessions set status = 'ended', ended_at = now(), phase = 'idle', question_id = null where id = $1`, [four]);
    const one = (await org('r3s_start_session', [rid(), joinCode, 'UG', [B]])).session_id;
    expect((await org('r3s_board', [one, false])).teams.map((t) => t.budget)).toEqual([100]);
  });
});
