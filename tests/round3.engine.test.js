// Round 3 "THE KNOWLEDGE AUCTION" — rule helpers and the demo engine (mirror of migration 13).
// The SQL side is tested in round3_auction.sql.test.js; these keep demo mode identical.
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState } from '../src/lib/engine.js';
import {
  applyRound3, round3EligibleTeams, round3Lookup, round3Overview, round3Results, round3SessionBoard, round3SetDetail,
} from '../src/lib/round3Engine.js';
import {
  bidOptions, bidOrder, bidPanel, bidProblem, describeDeltas, outcomeDeltas, parseAnswerTimer, parseBidTimer, rankTeams, remainingMs, tieOrderProblem, topicCards, validateR3Question, validateR3SetFields, versionOrder,
} from '../src/lib/round3.js';

const T0 = Date.parse('2026-10-23T10:00:00Z');
let n = 0;
const rid = () => `eeee3333-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const r3 = (s, name, p = {}, now = T0) => applyRound3(s, name, p, { now });
const run = (...a) => r3(...a).state;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const host = (s, id, now = T0) => round3SessionBoard(s, id, { host: true, nowMs: now });
const proj = (s, id, now = T0) => round3SessionBoard(s, id, { host: false, nowMs: now });

/** A published set (Networks: 2 NORMAL; Security: 1 BLIND) and a live UG auction for teams 1–3. */
function world() {
  let s = createEmptyState(T0);
  const teams = (sec, nums) => ({ rows: nums.map((k) => ({ team_number: k, team_name: `${sec} Team ${k}`, participant_1: 'a', participant_2: 'b', college_name: 'C', section: sec })) });
  s = applyAction(s, 'importTeams', teams('UG', [1, 2, 3, 4]), { now: T0, section: 'UG' }).state;
  s = applyAction(s, 'importTeams', teams('PG', [1]), { now: T0, section: 'PG' }).state;
  const team = (k, sec = 'UG') => s.teams.find((t) => t.team_number === k && t.section === sec).id;
  const c = r3(s, 'r3sSaveSet', { title: 'UG Auction', section: 'UG' });
  s = c.state;
  const setId = c.result.id;
  const topic = (name) => { const t = r3(s, 'r3sSaveTopic', { set_id: setId, name }); s = t.state; return t.result.id; };
  const net = topic('Networks');
  const sec = topic('Security');
  for (const [tid, mode, key] of [[net, 'NORMAL', 'n1'], [net, 'NORMAL', 'n2'], [sec, 'BLIND', 'b1']]) {
    s = run(s, 'r3sSaveQuestion', { topic_id: tid, mode, question_text: `Question ${key}?`, answer_text: `Answer ${key}`, explanation: `Why ${key}` });
  }
  const pub = r3(s, 'r3sPublishSet', { id: setId });
  s = pub.state;
  const st = r3(s, 'r3sStartSession', { request_id: rid(), code: pub.result.join_code, section: 'UG', team_ids: [team(1), team(2), team(3)] });
  s = st.state;
  const [A, B, C] = [team(1), team(2), team(3)];
  return { s, setId, code: pub.result.join_code, sid: st.result.session_id, team, A, B, C };
}
const qOf = (s, sid, seq) => host(s, sid).question_list.find((q) => q.seq === seq).id;
const teamOf = (b, id) => b.teams.find((t) => t.team_id === id);

describe('rule helpers', () => {
  it('outcome deltas: top correct +bid/2 score; top wrong −bid/2 budget; lower correct +10; everything else 0', () => {
    expect(outcomeDeltas(true, 'correct', 40)).toEqual({ score_delta: 20, budget_delta: 0 });
    expect(outcomeDeltas(true, 'wrong', 40)).toEqual({ score_delta: 0, budget_delta: -20 });
    expect(outcomeDeltas(true, 'pass', 40)).toEqual({ score_delta: 0, budget_delta: 0 });
    expect(outcomeDeltas(true, 'timeout', 40)).toEqual({ score_delta: 0, budget_delta: 0 });
    expect(outcomeDeltas(false, 'correct', 30)).toEqual({ score_delta: 10, budget_delta: 0 });
    expect(outcomeDeltas(false, 'wrong', 30)).toEqual({ score_delta: 0, budget_delta: 0 });
    expect(outcomeDeltas(false, 'pass', 30)).toEqual({ score_delta: 0, budget_delta: 0 });
    expect(describeDeltas(outcomeDeltas(true, 'wrong', 40))).toBe('private score unchanged · budget -20');
  });

  it('bids: minimum 10, steps of 10, at most the budget; below 10 left → must pass', () => {
    expect(bidProblem(5, 100).code).toBe('R3_BID_TOO_LOW');
    expect(bidProblem(25, 100).code).toBe('R3_BID_STEP');
    expect(bidProblem(110, 100).code).toBe('R3_BID_OVER_BUDGET');
    expect(bidProblem(10, 5).code).toBe('R3_CANNOT_BID');
    expect(bidProblem(100, 100)).toBeNull();
    expect(bidOptions(45)).toEqual([10, 20, 30, 40]);
    expect(bidOptions(5)).toEqual([]);
  });

  it('+10 / −10 / Pass panel: exact steps of 10, never negative, capped by the budget, locked after a pass or close', () => {
    const t = (bid_status, bid, budget = 100) => ({ bid_status, bid, budget });
    expect(bidPanel(t('none', null))).toMatchObject({ status: 'ready', current: 0, plus: 10, minus: undefined, canPass: true });
    expect(bidPanel(t('bid', 20))).toMatchObject({ status: 'bidding', current: 20, plus: 30, minus: 10 });
    expect(bidPanel(t('bid', 10)).minus).toBeNull(); // −10 from 10 → no valid bid (sent as null), never −0 or negative
    expect(bidPanel(t('bid', 100, 100)).plus).toBeUndefined(); // the next raise would exceed the budget
    expect(bidPanel(t('bid', 40, 45)).plus).toBeUndefined();
    expect(bidPanel(t('bid', 30, 45)).plus).toBe(40);
    expect(bidPanel(t('pass', null))).toMatchObject({ status: 'passed', plus: undefined, minus: undefined, canPass: false, canUndoPass: true });
    expect(bidPanel(t('none', null, 5))).toMatchObject({ status: 'ineligible', plus: undefined, canPass: true });
    expect(bidPanel(t('bid', 20), false)).toMatchObject({ plus: undefined, minus: undefined, canPass: false, canUndoPass: false });
  });

  it('topic cards: NORMAL questions grouped by topic, each BLIND question its own mystery card; used vs unused', () => {
    let { s: st, sid } = world();
    const b = proj(st, sid);
    const cards = topicCards(b.questions);
    expect(cards.map((c) => [c.label, c.blind, c.questions.length, c.left])).toEqual([['Networks', false, 2, 2], ['MYSTERY QUESTION #1', true, 1, 1]]);
    expect(JSON.stringify(cards)).not.toMatch(/Security|Answer|Question n1/); // public data only: no hidden topic, question or answer
    const q = qOf(st, sid, 1);
    st = run(st, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    st = run(st, 'r3sStartBidding', { session_id: sid, question_id: q });
    st = run(st, 'r3sCloseBidding', { session_id: sid, question_id: q }); // no bids → completed, used
    st = run(st, 'r3sFinishQuestion', { session_id: sid, question_id: q });
    expect(topicCards(proj(st, sid).questions)[0]).toMatchObject({ label: 'Networks', left: 1 });
    expect(code(() => r3(st, 'r3sSelectQuestion', { session_id: sid, question_id: q }))).toBe('R3_QUESTION_USED');
  });

  it('bid order: highest first; equal bids are a tie the organiser must resolve (only equal bids may swap)', () => {
    const teams = [{ team_id: 'a', seat: 1 }, { team_id: 'b', seat: 2 }, { team_id: 'c', seat: 3 }];
    expect(bidOrder([{ team_id: 'a', status: 'bid', amount: 20 }, { team_id: 'b', status: 'bid', amount: 50 }, { team_id: 'c', status: 'pass' }], teams)).toEqual({ order: ['b', 'a'], tie: false });
    expect(bidOrder([{ team_id: 'a', status: 'bid', amount: 30 }, { team_id: 'b', status: 'bid', amount: 30 }], teams).tie).toBe(true);
    const amt = { a: 30, b: 30, c: 20 };
    expect(tieOrderProblem(['b', 'a', 'c'], ['a', 'b', 'c'], (x) => amt[x])).toBeNull();
    expect(tieOrderProblem(['c', 'a', 'b'], ['a', 'b', 'c'], (x) => amt[x])).toMatch(/Higher bids/);
    expect(tieOrderProblem(['a', 'b'], ['a', 'b', 'c'], (x) => amt[x])).toMatch(/exactly once/);
  });

  it('final ranking: equal scores share a rank and are flagged as tied (never broken arbitrarily)', () => {
    const r = rankTeams([{ team_id: 'a', seat: 1, score: 20 }, { team_id: 'b', seat: 2, score: 35 }, { team_id: 'c', seat: 3, score: 20 }]);
    expect(r.map((x) => [x.team_id, x.rank, x.tied])).toEqual([['b', 1, false], ['a', 2, true], ['c', 2, true]]);
  });

  it('validation and publish order', () => {
    expect(validateR3SetFields({ title: ' ', bid_seconds: '0' }).errors).toMatchObject({ title: expect.any(String), bid_seconds: expect.any(String) });
    expect(validateR3SetFields({ title: 'X', bid_seconds: '3601' }).errors.bid_seconds).toMatch(/1–3600/);
    expect(validateR3SetFields({ title: 'X', bid_seconds: '7' }).value.bid_seconds).toBe(7); // any duration in range, no fixed list
    expect(validateR3SetFields({ title: 'X', bid_seconds: '', answer_seconds: '' }).value).toMatchObject({ bid_seconds: null, answer_seconds: 25 }); // blank = no timer
    expect(parseBidTimer(undefined, 45)).toEqual({ value: 45, error: null });
    expect(parseBidTimer('none', 45)).toEqual({ value: null, error: null });
    expect(parseAnswerTimer('4').error).toMatch(/5–600/);
    expect(validateR3Question({ topic_id: 't', mode: 'blind', question_text: 'q', answer_text: '' }).errors.answer_text).toBeTruthy();
    const topics = [{ id: 't2', name: 'B', position: 2, created_at: 'x' }, { id: 't1', name: 'A', position: 1, created_at: 'x' }];
    const qs = [{ id: 'q3', topic_id: 't2', mode: 'BLIND', position: 1, created_at: 'x' }, { id: 'q1', topic_id: 't1', mode: 'BLIND', position: 2, created_at: 'x' }, { id: 'q2', topic_id: 't1', mode: 'NORMAL', position: 1, created_at: 'x' }];
    expect(versionOrder(topics, qs).map((q) => [q.id, q.seq, q.mystery_no])).toEqual([['q2', 1, null], ['q1', 2, 1], ['q3', 3, 2]]);
    expect(remainingMs('2026-10-23T10:00:00.000Z', 25, T0 + 5000)).toBe(20_000);
  });
});

describe('demo engine (mirrors the SQL)', () => {
  it('sets: draft editing, reorder, publish code, snapshot unaffected by later draft edits', () => {
    let { s, setId, code: c, sid } = world();
    const d = round3SetDetail(s, setId);
    expect(d.topics.map((t) => t.name)).toEqual(['Networks', 'Security']);
    s = run(s, 'r3sMove', { kind: 'topic', id: d.topics[1].id, dir: -1 }, T0 + 1000);
    expect(round3SetDetail(s, setId).topics.map((t) => t.name)).toEqual(['Security', 'Networks']);
    s = run(s, 'r3sSaveQuestion', { id: d.questions[0].id, topic_id: d.questions[0].topic_id, mode: 'NORMAL', question_text: 'Edited draft', answer_text: 'x' }, T0 + 1000);
    expect(c).toMatch(/^\d{6}$/);
    expect(round3Lookup(s, c).questions.map((q) => q.seq)).toEqual([1, 2, 3]);
    expect(host(s, sid).question_list[0].question_text).toBe('Question n1?'); // the running auction keeps the published version
    expect(round3Overview(s).sets[0].unpublished_changes).toBe(true);
    expect(code(() => r3(s, 'r3sDeleteSet', { id: setId }))).toBe('R3_SET_PUBLISHED');
    const empty = r3(s, 'r3sSaveSet', { title: 'Empty' });
    expect(code(() => r3(empty.state, 'r3sPublishSet', { id: empty.result.id }))).toBe('VALIDATION');
  });

  it('start: exactly three distinct eligible teams, budget 100 / score 0, one live auction per section', () => {
    const w = world();
    const start = (ids, sec = 'UG') => code(() => r3(w.s, 'r3sStartSession', { request_id: rid(), code: w.code, section: sec, team_ids: ids }));
    expect(start([w.A, w.B])).toBe('R3_TEAM_COUNT');
    expect(start([w.A, w.A, w.B])).toBe('R3_TEAM_COUNT');
    expect(start([w.A, w.B, w.team(4)])).toBe('R3_SESSION_LIVE');
    expect(start([w.A, w.B, w.team(1, 'PG')])).toBe('R3_TEAM_NOT_ELIGIBLE');
    expect(host(w.s, w.sid).teams.map((t) => [t.budget, t.score])).toEqual([[100, 0], [100, 0], [100, 0]]);
    expect(round3EligibleTeams(w.s, w.code, 'UG').find((t) => t.id === w.A).in_live_auction).toBe(true);
  });

  it('a full question: bids, close, reveal, wrong top bidder (budget −bid/2), next bidder correct (+10), duplicate confirmation once', () => {
    let { s, sid, A, B, C } = world();
    const q = qOf(s, sid, 1);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    expect(proj(s, sid).current).toMatchObject({ topic: 'Networks', question_text: null, answer_text: null });
    s = run(s, 'r3sStartBidding', { session_id: sid, question_id: q, timer: { bid_timer_seconds: 30 } });
    expect(code(() => r3(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 15 }))).toBe('R3_BID_STEP');
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 40 });
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: B, amount: 30 });
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: C, pass: true });
    expect(code(() => r3(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: B, amount: 50 }, T0 + 33_000))).toBe('R3_BIDDING_CLOSED'); // timer expired
    s = run(s, 'r3sCloseBidding', { session_id: sid, question_id: q });
    expect(proj(s, sid).current).toMatchObject({ phase: 'closed', bid_order: [A, B], current_team_id: A });
    s = run(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }, T0 + 1000);
    const req = rid();
    const w1 = r3(s, 'r3sRecordOutcome', { request_id: req, session_id: sid, question_id: q, team_id: A, outcome: 'wrong' });
    expect(w1.result).toMatchObject({ was_top: true, budget_delta: -20, score_delta: 0, next: 'next_bidder' });
    s = w1.state;
    expect(r3(s, 'r3sRecordOutcome', { request_id: req, session_id: sid, question_id: q, team_id: A, outcome: 'wrong' }).result.duplicate_request).toBe(true);
    s = run(s, 'r3sNextBidder', { session_id: sid, question_id: q }, T0 + 5000);
    expect(proj(s, sid).current).toMatchObject({ current_team_id: B, answer_started_at: new Date(T0 + 5000).toISOString() });
    s = run(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: B, outcome: 'correct' });
    const h = host(s, sid);
    expect([teamOf(h, A).budget, teamOf(h, A).score, teamOf(h, B).budget, teamOf(h, B).score]).toEqual([80, 0, 100, 10]);
    expect(h.current.phase).toBe('done');
    s = run(s, 'r3sFinishQuestion', { session_id: sid, question_id: q });
    expect(proj(s, sid).questions[0].used).toBe(true);
  });

  it('+10 / −10 / Pass buttons drive the server: retries apply once, budgets never move, pass is excluded, close locks bids', () => {
    let { s, sid, A, B, C } = world();
    const q = qOf(s, sid, 1);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    s = run(s, 'r3sStartBidding', { session_id: sid, question_id: q });
    const panel = (id) => bidPanel(teamOf(host(s, sid), id));
    const press = (id, key) => { const p = panel(id); s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: id, ...(key === 'pass' ? { pass: true } : { amount: p[key] }) }); };
    expect([A, B, C].map((id) => panel(id).current)).toEqual([0, 0, 0]);
    press(A, 'plus'); press(A, 'plus'); press(A, 'plus');
    expect(panel(A)).toMatchObject({ current: 30, status: 'bidding' });
    press(A, 'minus');
    expect(panel(A).current).toBe(20);
    // A retried +10 resends the same absolute amount computed before the first request landed → one raise only.
    const retry = { session_id: sid, question_id: q, team_id: B, amount: panel(B).plus };
    s = run(s, 'r3sRecordBid', retry); s = run(s, 'r3sRecordBid', retry);
    expect(panel(B).current).toBe(10);
    press(B, 'minus');
    expect(panel(B)).toMatchObject({ current: 0, status: 'ready' }); // 10 − 10 = no valid bid
    press(B, 'plus');
    press(C, 'pass');
    expect(panel(C)).toMatchObject({ status: 'passed', plus: undefined });
    expect(code(() => r3(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 110 }))).toBe('R3_BID_OVER_BUDGET');
    expect(host(s, sid).teams.map((t) => [t.budget, t.score])).toEqual([[100, 0], [100, 0], [100, 0]]);
    s = run(s, 'r3sCloseBidding', { session_id: sid, question_id: q });
    expect(host(s, sid).current.bid_order).toEqual([A, B]);
    expect(code(() => r3(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 30 }))).toBe('R3_BIDDING_CLOSED');
  });

  it('BLIND: mystery label; topic only after close + Reveal Topic; question only after Reveal Question; tie resolution; timeout', () => {
    let { s, sid, A, B, C } = world();
    const q = qOf(s, sid, 3);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    expect(proj(s, sid).current).toMatchObject({ label: 'MYSTERY QUESTION #1', topic: null });
    expect(JSON.stringify(proj(s, sid))).not.toMatch(/Security|Question b1|Answer b1/);
    s = run(s, 'r3sStartBidding', { session_id: sid, question_id: q });
    expect(code(() => r3(s, 'r3sRevealTopic', { session_id: sid, question_id: q }))).toBe('R3_BIDDING_OPEN');
    for (const [t, a] of [[A, 30], [B, 30], [C, 20]]) s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: t, amount: a });
    s = run(s, 'r3sCloseBidding', { session_id: sid, question_id: q });
    expect(proj(s, sid).current).toMatchObject({ phase: 'tie', topic: null });
    expect(code(() => r3(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }))).toBe('R3_TIE_UNRESOLVED');
    expect(code(() => r3(s, 'r3sResolveTie', { session_id: sid, question_id: q, order: [C, A, B], reason: 'toss' }))).toBe('R3_TIE_ORDER');
    s = run(s, 'r3sResolveTie', { session_id: sid, question_id: q, order: [B, A, C], reason: 'Coin toss' });
    expect(code(() => r3(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }))).toBe('R3_TOPIC_HIDDEN');
    s = run(s, 'r3sRevealTopic', { session_id: sid, question_id: q });
    expect(proj(s, sid).current).toMatchObject({ topic: 'Security', question_text: null });
    s = run(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }, T0 + 1000);
    expect(proj(s, sid).current.question_text).toBe('Question b1?');
    expect(code(() => r3(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: B, outcome: 'timeout' }, T0 + 2000))).toBe('R3_TIMER_RUNNING');
    s = run(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: B, outcome: 'timeout' }, T0 + 30_000);
    expect(teamOf(host(s, sid), B)).toMatchObject({ budget: 100, score: 0 }); // timeout alone never deducts
  });

  it('projector privacy, end, results and reveal', () => {
    let { s, sid, A, B } = world();
    const q = qOf(s, sid, 2);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    s = run(s, 'r3sStartBidding', { session_id: sid, question_id: q });
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 60 });
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: B, amount: 10 });
    s = run(s, 'r3sCloseBidding', { session_id: sid, question_id: q });
    s = run(s, 'r3sRevealQuestion', { session_id: sid, question_id: q });
    s = run(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: A, outcome: 'correct' });
    const p = proj(s, sid);
    expect(JSON.stringify(p)).not.toMatch(/"score"/);
    expect(p).not.toHaveProperty('ranking');
    expect(code(() => r3(s, 'r3sEndAuction', { session_id: sid }))).toBe('NO_ERROR'); // phase done → allowed
    expect(code(() => r3(s, 'r3sRevealResults', { session_id: sid, reveal: true }))).toBe('R3_NOT_ENDED');
    s = run(s, 'r3sEndAuction', { session_id: sid });
    const res = round3Results(s, sid);
    expect(res.ranking[0]).toMatchObject({ team_id: A, score: 30, rank: 1 });
    expect(res.summary.find((x) => x.team_id === A)).toMatchObject({ correct: 1, points_awarded: 30 });
    expect(proj(s, sid).final).toBeNull();
    s = run(s, 'r3sRevealResults', { session_id: sid, reveal: true });
    expect(proj(s, sid).final[0]).toMatchObject({ team_id: A, score: 30 });
  });
});

describe('optional bidding timer (mirrors migration 14)', () => {
  const start = (s, sid, q, timer, now = T0) => r3(s, 'r3sStartBidding', { session_id: sid, question_id: q, ...(timer === undefined ? {} : { timer: { bid_timer_seconds: timer } }) }, now);

  it('untimed (the set default): no deadline, never closes by itself; manual close works; no restart', () => {
    let { s, sid, A } = world();
    const q = qOf(s, sid, 1);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    s = start(s, sid, q).state;
    expect(proj(s, sid, T0 + 3_600_000).current).toMatchObject({ phase: 'bidding', bid_seconds: null, bid_deadline: null });
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 20 }, T0 + 3_600_000); // an hour later: still open
    expect(code(() => start(s, sid, q, 30))).toBe('R3_BIDDING_RUNNING');
    expect(r3(s, 'r3sCloseBidding', { session_id: sid, question_id: q }).result).toMatchObject({ phase: 'closed', order: [A] });
  });

  it('timed: closes itself AT the deadline (on any read or action), audited as automatic; different durations', () => {
    for (const secs of [10, 45, 90]) {
      let { s, sid, A, B } = world();
      const q = qOf(s, sid, 1);
      s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
      s = start(s, sid, q, secs).state;
      s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: A, amount: 30 });
      s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: B, amount: 20 }, T0 + secs * 1000 - 1);
      expect(proj(s, sid, T0 + secs * 1000 - 1).current.phase).toBe('bidding');
      const after = proj(s, sid, T0 + secs * 1000 + 5000); // a refresh after the deadline
      expect(after.current).toMatchObject({ phase: 'closed', bid_order: [A, B], bids_closed_at: new Date(T0 + secs * 1000).toISOString() });
      expect(code(() => r3(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: B, amount: 40 }, T0 + secs * 1000))).toBe('R3_BIDDING_CLOSED');
      s = run(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }, T0 + secs * 1000 + 6000); // the next action persists the close
      expect(host(s, sid, T0 + secs * 1000 + 6000).log.find((e) => e.kind === 'bidding_closed').detail).toMatchObject({ auto: true, timer_seconds: secs });
    }
  });

  it('session default chosen at Start, changeable later; per-question override; answer timer from the auction', () => {
    const w = world();
    let s = run(w.s, 'r3sEndAuction', { session_id: w.sid });
    expect(code(() => r3(s, 'r3sStartSession', { request_id: rid(), code: w.code, section: 'UG', team_ids: [w.A, w.B, w.C], settings: { bid_timer_seconds: 0 } }))).toBe('VALIDATION');
    const st = r3(s, 'r3sStartSession', { request_id: rid(), code: w.code, section: 'UG', team_ids: [w.A, w.B, w.C], settings: { bid_timer_seconds: 20, answer_seconds: 40 } });
    s = st.state;
    const sid = st.result.session_id;
    expect(proj(s, sid).settings).toMatchObject({ bid_timer_default: 20, answer_seconds: 40 });
    expect(proj(s, w.sid).session.status).toBe('ended'); // the first auction is kept
    const q = qOf(s, sid, 1);
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    s = start(s, sid, q, null).state; // override: no timer for this question
    expect(proj(s, sid, T0 + 100_000).current).toMatchObject({ phase: 'bidding', bid_seconds: null });
    s = run(s, 'r3sCancelQuestion', { session_id: sid, question_id: q });
    s = run(s, 'r3sUpdateSessionSettings', { session_id: sid, settings: { bid_timer_seconds: 15 } });
    s = run(s, 'r3sSelectQuestion', { session_id: sid, question_id: q });
    s = start(s, sid, q).state;
    expect(proj(s, sid).current.bid_seconds).toBe(15);
    s = run(s, 'r3sRecordBid', { session_id: sid, question_id: q, team_id: w.A, amount: 10 });
    s = run(s, 'r3sRevealQuestion', { session_id: sid, question_id: q }, T0 + 20_000); // auto-closed at 15 s, then revealed
    expect(code(() => r3(s, 'r3sUpdateSessionSettings', { session_id: sid, settings: { answer_seconds: 60 } }, T0 + 21_000))).toBe('R3_WRONG_PHASE');
    expect(code(() => r3(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: w.A, outcome: 'timeout' }, T0 + 50_000))).toBe('R3_TIMER_RUNNING'); // 30 s < 40 s
    expect(r3(s, 'r3sRecordOutcome', { request_id: rid(), session_id: sid, question_id: q, team_id: w.A, outcome: 'timeout' }, T0 + 61_000).result).toMatchObject({ score_delta: 0, budget_delta: 0 });
  });
});
