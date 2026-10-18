// Demo-mode mirror of Round 3 — THE KNOWLEDGE AUCTION (supabase/migrations/20261023000100_round3_auction.sql and
// 20261024000100_round3_timers.sql):
// same validation, same error codes, same phases, same scoring and the same visibility rules.
// State lives in state.round3; Round 1/2 data is only read (teams, qualifiers, Round 2 scores).
import { fail } from './errors.js';
import { uuid } from './ids.js';
import { randomJoinCode } from './joinCodes.js';
import {
  R3_DEFAULTS, START_BUDGET, bidOrder, bidProblem, outcomeDeltas, parseAnswerTimer, parseBidTimer, questionLabel, r3PublishIssues, rankTeams,
  tieOrderProblem, validateR3Question, validateR3SetFields, validateR3Topic, versionOrder,
} from './round3.js';

const iso = (ms) => new Date(ms).toISOString();
const SECTIONS2 = ['UG', 'PG'];

export function createRound3State() {
  return { sets: [], topics: [], questions: [], versions: [], sessions: [], bids: [], events: [], results: [], next_event_id: 1 };
}

/** Fill in Round 3 data and mirror the database's foreign keys (a deleted team leaves its auctions). */
export function normalizeRound3(state) {
  const r = state.round3 || createRound3State();
  const blank = createRound3State();
  for (const k of Object.keys(blank)) r[k] ??= blank[k];
  const teamIds = new Set((state.teams || []).map((t) => t.id));
  for (const g of r.sessions) {
    g.teams = (g.teams || []).filter((t) => teamIds.has(t.team_id));
    if (g.answer_seconds === undefined) { // auctions started before migration 14
      const v = r.versions.find((x) => x.id === g.version_id);
      g.bid_timer_default = v?.bid_seconds ?? null;
      g.answer_seconds = v?.answer_seconds ?? R3_DEFAULTS.answer_seconds;
      g.bid_seconds_current = g.phase === 'bidding' ? g.bid_timer_default : null;
    }
  }
  r.bids = r.bids.filter((b) => teamIds.has(b.team_id));
  for (const e of r.events) if (e.team_id && !teamIds.has(e.team_id)) e.team_id = null;
  state.round3 = r;
  return state;
}

const findSet = (r, id) => r.sets.find((s) => s.id === id);
function lockSet(r, id) {
  const s = findSet(r, id);
  if (!s) fail('R3_NOT_FOUND', 'Auction set not found.');
  if (s.archived_at) fail('R3_SET_ARCHIVED', 'This auction set is archived.');
  return s;
}
function touch(s, now) { s.draft_updated_at = iso(now); s.updated_at = iso(now); }
/** Bidding deadline in ms (null = untimed or not bidding). */
const bidDeadline = (g) => (g.phase === 'bidding' && g.bid_seconds_current != null && g.bid_started_at ? new Date(g.bid_started_at).getTime() + g.bid_seconds_current * 1000 : null);
/** Close an expired timed bidding AT its deadline (mirrors public._r3_auto_close). `this` = { now, actor }. */
function autoClose(st, r, g) {
  const d = bidDeadline(g);
  if (g.status === 'live' && d !== null && this.now >= d) closeBids.call(this, st, r, g, d, true);
}
/** A live auction, with an expired timed bidding closed first (mirrors public._r3_lock_session). */
function lockSession(st, r, id) {
  const g = r.sessions.find((x) => x.id === id);
  if (!g) fail('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.');
  if (g.status !== 'live') fail('R3_SESSION_ENDED', 'This auction has ended.');
  autoClose.call(this, st, r, g);
  return g;
}
function require_(g, questionId, phases) {
  if (!g.question_id || g.question_id !== questionId) fail('R3_NOT_SELECTED', 'That question is not the one open in this auction.');
  if (phases && !phases.includes(g.phase)) fail('R3_WRONG_PHASE', `That action is not possible in the current auction phase (${g.phase}).`);
}
function byCode(r, code) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  return r.sets.find((s) => s.join_code === c && !s.archived_at && s.published_version > 0) || null;
}
const latestVersion = (r, s) => r.versions.find((v) => v.set_id === s.id && v.version === s.published_version);
const versionOf = (r, g) => r.versions.find((v) => v.id === g.version_id);
const questionOf = (r, g, id = g.question_id) => versionOf(r, g).questions.find((q) => q.id === id) || null;
const used = (r, g, qid) => r.results.some((x) => x.session_id === g.id && x.question_id === qid);
const draftTopics = (r, setId) => r.topics.filter((t) => t.set_id === setId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
const draftQuestions = (r, setId) => r.questions.filter((q) => q.set_id === setId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
const unpublished = (s) => s.published_version > 0 && s.draft_updated_at > s.published_at;
const bidsOf = (r, g, qid = g.question_id) => r.bids.filter((b) => b.session_id === g.id && b.question_id === qid);
const teamRow = (g, teamId) => g.teams.find((t) => t.team_id === teamId);

function event(st, r, g, kind, teamId = null, extra = {}) {
  const t = teamId ? st.teams.find((x) => x.id === teamId) : null;
  const q = g.question_id ? questionOf(r, g) : null;
  const e = {
    id: r.next_event_id++, request_id: null, session_id: g.id, question_id: g.question_id, seq: q?.seq ?? null,
    team_id: teamId, team_number: t?.team_number ?? null, team_name: t?.team_name ?? null, kind, outcome: null, was_top: null, bid: null,
    score_delta: 0, budget_delta: 0, score_after: null, budget_after: null, detail: null, actor: this.actor || 'demo-organizer', created_at: iso(this.now), ...extra,
  };
  r.events.push(e);
  return e;
}

function complete(st, r, g, result, winner) {
  const q = questionOf(r, g);
  const top = g.bid_order[0] ?? null;
  const bids = bidsOf(r, g);
  r.results.push({
    session_id: g.id, question_id: q.id, seq: q.seq, topic_name: q.topic_name, mode: q.mode, result, winner_team_id: winner, top_team_id: top,
    top_bid: top ? bids.find((b) => b.team_id === top)?.amount ?? null : null, bid_order: [...g.bid_order],
    bids: [...bids].sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1)).map((b) => ({ team_id: b.team_id, status: b.status, amount: b.amount })),
    bid_seconds: g.bid_seconds_current ?? null, completed_at: iso(this.now),
  });
  Object.assign(g, { phase: 'done', current_team_id: null });
  event.call(this, st, r, g, 'question_completed', winner, { detail: { result } });
}

/** Lock the bids and build the order (mirrors public._r3_close). `atMs` = now (manual) or the deadline (automatic). */
function closeBids(st, r, g, atMs, auto) {
  for (const t of g.teams) {
    if (!bidsOf(r, g).some((b) => b.team_id === t.team_id)) r.bids.push({ session_id: g.id, question_id: g.question_id, team_id: t.team_id, status: 'no_bid', amount: null });
  }
  const { order, tie } = bidOrder(bidsOf(r, g), g.teams);
  Object.assign(g, { bids_closed_at: iso(atMs), bid_order: order });
  if (order.length && !tie) Object.assign(g, { phase: 'closed', order_pos: 1, current_team_id: order[0] });
  else if (order.length) Object.assign(g, { phase: 'tie', order_pos: 0, current_team_id: null });
  event.call(this, st, r, g, 'bidding_closed', null, { detail: { order, tie, auto, timer_seconds: g.bid_seconds_current ?? null } });
  if (!order.length) {
    complete.call(this, st, r, g, 'no_bids', null);
    return { ok: true, phase: 'done', result: 'no_bids' };
  }
  return { ok: true, phase: g.phase, order, tie };
}

function clearQuestion(g) {
  Object.assign(g, {
    phase: 'idle', question_id: null, topic_revealed: false, bid_started_at: null, bids_closed_at: null, bid_seconds_current: null, bid_order: [], order_pos: 0,
    current_team_id: null, question_revealed: false, answer_started_at: null, answer_revealed: false,
  });
}

function eligibleSection(r, code, section) {
  const s = byCode(r, code);
  if (!s) fail('R3_CODE_INVALID', 'No published auction set has that code.');
  const sec = String(section ?? '').trim().toUpperCase();
  if (!SECTIONS2.includes(sec)) fail('VALIDATION', 'Choose UG or PG.');
  const v = latestVersion(r, s);
  if (!['BOTH', sec].includes(v.section)) fail('R3_SECTION_MISMATCH', `This auction set is not for the ${sec} section.`);
  return { s, v, sec };
}

const ACTIONS = {
  // ---- auction sets (draft editing)
  r3sSaveSet(st, r, p) {
    const existing = p.id ? lockSet(r, p.id) : null;
    const { value, errors, ok } = validateR3SetFields(p, existing || R3_DEFAULTS);
    if (!ok) fail('VALIDATION', Object.values(errors)[0]);
    if (!existing) {
      const now = iso(this.now);
      const s = { id: uuid(), ...value, join_code: null, published_version: 0, published_at: null, draft_updated_at: now, archived_at: null, created_at: now, updated_at: now };
      r.sets.push(s);
      return { id: s.id };
    }
    Object.assign(existing, value);
    touch(existing, this.now);
    return { id: existing.id };
  },

  r3sDeleteSet(st, r, { id }) {
    const s = findSet(r, id);
    if (!s) fail('R3_NOT_FOUND', 'Auction set not found.');
    if (s.published_version > 0) fail('R3_SET_PUBLISHED', 'A published auction set cannot be deleted. Archive it instead.');
    r.sets = r.sets.filter((x) => x.id !== id);
    r.topics = r.topics.filter((x) => x.set_id !== id);
    r.questions = r.questions.filter((x) => x.set_id !== id);
    return { deleted: true };
  },

  r3sArchiveSet(st, r, { id }) {
    const s = lockSet(r, id);
    if (r.sessions.some((g) => g.set_id === s.id && g.status === 'live')) fail('R3_SESSION_LIVE', 'End the live auction of this set first.');
    s.archived_at = iso(this.now);
    s.updated_at = iso(this.now);
    return { archived: true };
  },

  r3sSaveTopic(st, r, p) {
    const setId = p.id ? r.topics.find((t) => t.id === p.id)?.set_id : p.set_id;
    if (!setId) fail('R3_NOT_FOUND', 'Topic not found.');
    const s = lockSet(r, setId);
    const { value, error } = validateR3Topic(p.name, draftTopics(r, s.id), p.id || null);
    if (error) fail('VALIDATION', error.replace('already exists.', 'already exists in this set.'));
    let id = p.id;
    if (id) r.topics.find((t) => t.id === id).name = value;
    else {
      id = uuid();
      r.topics.push({ id, set_id: s.id, name: value, position: Math.max(0, ...draftTopics(r, s.id).map((t) => t.position)) + 1, created_at: iso(this.now) });
    }
    touch(s, this.now);
    return { id };
  },

  r3sDeleteTopic(st, r, { id }) {
    const t = r.topics.find((x) => x.id === id);
    if (!t) fail('R3_NOT_FOUND', 'Topic not found.');
    const s = lockSet(r, t.set_id);
    r.topics = r.topics.filter((x) => x.id !== id);
    r.questions = r.questions.filter((q) => q.topic_id !== id);
    touch(s, this.now);
    return { deleted: true };
  },

  r3sSaveQuestion(st, r, p) {
    const topic = r.topics.find((t) => t.id === p.topic_id);
    if (!topic) fail('VALIDATION', 'Choose a topic.');
    const s = lockSet(r, topic.set_id);
    const { value, errors, ok } = validateR3Question(p);
    if (!ok) fail('VALIDATION', Object.values(errors)[0]);
    const nextPos = () => Math.max(0, ...r.questions.filter((q) => q.topic_id === topic.id).map((q) => q.position)) + 1;
    let id = p.id;
    if (!id) {
      id = uuid();
      r.questions.push({ id, set_id: s.id, topic_id: topic.id, mode: value.mode, position: nextPos(), question_text: value.question_text, answer_text: value.answer_text,
        explanation: value.explanation, created_at: iso(this.now), updated_at: iso(this.now) });
    } else {
      const q = r.questions.find((x) => x.id === id && x.set_id === s.id);
      if (!q) fail('R3_NOT_FOUND', 'Question not found.');
      if (q.topic_id !== topic.id) q.position = nextPos();
      Object.assign(q, { topic_id: topic.id, mode: value.mode, question_text: value.question_text, answer_text: value.answer_text, explanation: value.explanation, updated_at: iso(this.now) });
    }
    touch(s, this.now);
    return { id };
  },

  r3sDeleteQuestion(st, r, { id }) {
    const q = r.questions.find((x) => x.id === id);
    if (!q) fail('R3_NOT_FOUND', 'Question not found.');
    const s = lockSet(r, q.set_id);
    r.questions = r.questions.filter((x) => x.id !== id);
    touch(s, this.now);
    return { deleted: true };
  },

  r3sMove(st, r, { kind, id, dir }) {
    if (![-1, 1].includes(Number(dir))) fail('VALIDATION', 'Move up (-1) or down (1).');
    let list;
    let s;
    if (kind === 'topic') {
      const t = r.topics.find((x) => x.id === id);
      if (!t) fail('R3_NOT_FOUND', 'Topic not found.');
      s = lockSet(r, t.set_id);
      list = draftTopics(r, s.id);
    } else if (kind === 'question') {
      const q = r.questions.find((x) => x.id === id);
      if (!q) fail('R3_NOT_FOUND', 'Question not found.');
      s = lockSet(r, q.set_id);
      list = draftQuestions(r, s.id).filter((x) => x.topic_id === q.topic_id);
    } else fail('VALIDATION', 'Unknown item.');
    const i = list.findIndex((x) => x.id === id);
    const j = i + Number(dir);
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, n) => { x.position = n + 1; });
    touch(s, this.now);
    return { ok: true };
  },

  r3sPublishSet(st, r, { id }) {
    const s = lockSet(r, id);
    const topics = draftTopics(r, s.id);
    const questions = draftQuestions(r, s.id);
    const issues = r3PublishIssues(topics, questions);
    if (issues.length) fail('VALIDATION', issues.join(' '));
    if (!s.join_code) {
      const taken = new Set([...r.sets.map((x) => x.join_code), ...(st.round2?.sets || []).map((x) => x.join_code), ...(st.sets || []).map((x) => x.session.join_code), ...(st.retired_codes || [])].filter(Boolean));
      let c;
      do c = randomJoinCode(); while (taken.has(c));
      s.join_code = c;
    }
    const v = {
      id: uuid(), set_id: s.id, version: s.published_version + 1, title: s.title, description: s.description, section: s.section,
      bid_seconds: s.bid_seconds, answer_seconds: s.answer_seconds, published_at: iso(this.now),
      questions: versionOrder(topics, questions).map((q) => ({
        id: uuid(), seq: q.seq, topic_name: q.topic_name, topic_position: q.topic_position, mode: q.mode, mystery_no: q.mystery_no,
        question_text: q.question_text, answer_text: q.answer_text, explanation: q.explanation ?? null,
      })),
    };
    r.versions.push(deepFreeze(v)); // immutable snapshot (the database refuses UPDATE/DELETE with a trigger)
    Object.assign(s, { published_version: v.version, published_at: v.published_at, updated_at: v.published_at });
    if (s.draft_updated_at > v.published_at) s.draft_updated_at = v.published_at;
    return { ok: true, join_code: s.join_code, version: v.version, version_id: v.id };
  },

  // ---- Join Round 3
  r3sStartSession(st, r, { request_id, code, section, team_ids, settings = {} }) {
    if (!request_id) fail('VALIDATION', 'A request id is required.');
    const dup = r.sessions.find((g) => g.request_id === request_id);
    if (dup) return { session_id: dup.id, duplicate_request: true };
    const { s, v, sec } = eligibleSection(r, code, section);
    const ids = team_ids || [];
    if (ids.length !== 3) fail('R3_TEAM_COUNT', 'Select exactly three teams.');
    if (new Set(ids).size !== 3) fail('R3_TEAM_COUNT', 'The three teams must be different.');
    if (!ids.every((id) => st.teams.some((t) => t.id === id && t.section === sec))) fail('R3_TEAM_NOT_ELIGIBLE', `Every selected team must be a registered ${sec} team.`);
    if (r.sessions.some((g) => g.status === 'live' && g.section === sec)) fail('R3_SESSION_LIVE', `A ${sec} auction is already live. End it before starting another.`);
    const bidT = parseBidTimer(settings?.bid_timer_seconds, v.bid_seconds ?? null);
    const ansT = parseAnswerTimer(settings?.answer_seconds ?? '', v.answer_seconds);
    if (bidT.error || ansT.error) fail('VALIDATION', bidT.error || ansT.error);
    const g = {
      id: uuid(), request_id, set_id: s.id, version_id: v.id, section: sec, status: 'live', results_revealed: false,
      phase: 'idle', question_id: null, topic_revealed: false, bid_started_at: null, bids_closed_at: null, bid_order: [], order_pos: 0,
      current_team_id: null, question_revealed: false, answer_started_at: null, answer_revealed: false, last_event_id: null,
      bid_timer_default: bidT.value, answer_seconds: ansT.value, bid_seconds_current: null, started_at: iso(this.now), ended_at: null, teams: ids.map((team_id, i) => ({ team_id, seat: i + 1, budget: START_BUDGET, score: 0 })),
    };
    r.sessions.push(g);
    return { session_id: g.id, duplicate_request: false, version: v.version, bid_timer_default: g.bid_timer_default, answer_seconds: g.answer_seconds };
  },

  r3sUpdateSessionSettings(st, r, { session_id, settings = {} }) {
    const g = lockSession.call(this, st, r, session_id);
    const bidT = parseBidTimer(settings.bid_timer_seconds, g.bid_timer_default);
    const ansT = parseAnswerTimer(settings.answer_seconds ?? '', g.answer_seconds);
    if (bidT.error || ansT.error) fail('VALIDATION', bidT.error || ansT.error);
    if (ansT.value !== g.answer_seconds && ['answering', 'between'].includes(g.phase)) fail('R3_WRONG_PHASE', 'The answer timer can be changed when no team is answering.');
    Object.assign(g, { bid_timer_default: bidT.value, answer_seconds: ansT.value });
    event.call(this, st, r, g, 'settings_changed', null, { detail: { bid_timer_seconds: bidT.value, answer_seconds: ansT.value } });
    return { ok: true, bid_timer_default: bidT.value, answer_seconds: ansT.value };
  },

  // ---- live auction
  r3sSelectQuestion(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    if (g.phase !== 'idle') {
      if (g.phase === 'selected' && g.question_id === question_id) return { ok: true, phase: g.phase };
      fail('R3_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
    }
    const q = questionOf(r, g, question_id);
    if (!q) fail('R3_NOT_FOUND', 'That question is not in this auction.');
    if (used(r, g, q.id)) fail('R3_QUESTION_USED', 'This question has already been played.');
    clearQuestion(g);
    Object.assign(g, { phase: 'selected', question_id: q.id, topic_revealed: q.mode === 'NORMAL', last_event_id: null });
    return { ok: true, phase: 'selected' };
  },

  r3sCancelQuestion(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, ['selected', 'bidding', 'tie', 'closed']);
    if (g.question_revealed) fail('R3_QUESTION_LIVE', 'The question is already revealed. Record the outcomes instead.');
    r.bids = r.bids.filter((b) => !(b.session_id === g.id && b.question_id === g.question_id));
    event.call(this, st, r, g, 'question_cancelled');
    clearQuestion(g);
    return { ok: true };
  },

  r3sStartBidding(st, r, { session_id, question_id, timer = null }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, null);
    if (g.phase === 'bidding') fail('R3_BIDDING_RUNNING', 'Bidding is already open. Its timer cannot be restarted or extended.');
    require_(g, question_id, ['selected']);
    const t = parseBidTimer(timer && 'bid_timer_seconds' in timer ? timer.bid_timer_seconds : undefined, g.bid_timer_default);
    if (t.error) fail('VALIDATION', t.error);
    Object.assign(g, { phase: 'bidding', bid_started_at: iso(this.now), bid_seconds_current: t.value });
    event.call(this, st, r, g, 'bidding_started', null, { detail: { timer_seconds: t.value, timed: t.value !== null } });
    return { ok: true, bid_started_at: g.bid_started_at, bid_seconds: t.value };
  },

  r3sRecordBid(st, r, { session_id, question_id, team_id, amount = null, pass = false }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, null);
    if (g.phase !== 'bidding') {
      if (g.bids_closed_at) fail('R3_BIDDING_CLOSED', 'Bidding is closed for this question; bids are locked.');
      fail('R3_WRONG_PHASE', 'Start bidding first.');
    }
    const tm = teamRow(g, team_id);
    if (!tm) fail('R3_TEAM_NOT_IN_AUCTION', 'That team is not in this auction.');
    const rest = r.bids.filter((b) => !(b.session_id === g.id && b.question_id === g.question_id && b.team_id === team_id));
    if (pass) r.bids = [...rest, { session_id: g.id, question_id: g.question_id, team_id, status: 'pass', amount: null }];
    else if (amount === null || amount === undefined || amount === '') r.bids = rest;
    else {
      const p = bidProblem(Number(amount), tm.budget);
      if (p) fail(p.code, p.message);
      r.bids = [...rest, { session_id: g.id, question_id: g.question_id, team_id, status: 'bid', amount: Number(amount) }];
    }
    event.call(this, st, r, g, 'bid', team_id, { detail: { amount: pass ? null : amount === '' ? null : amount, pass: !!pass } });
    return { ok: true };
  },

  r3sCloseBidding(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, null);
    if (g.phase !== 'bidding') {
      if (g.bids_closed_at) return { ok: true, phase: g.phase, already_closed: true };
      require_(g, question_id, ['bidding']);
    }
    return closeBids.call(this, st, r, g, this.now, false);
  },

  r3sResolveTie(st, r, { session_id, question_id, order, reason }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, ['tie']);
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
    if (!why || why.length > 200) fail('VALIDATION', 'Say how the tie was resolved (max 200 characters).');
    const amountOf = (id) => bidsOf(r, g).find((b) => b.team_id === id)?.amount ?? -1;
    const problem = tieOrderProblem(order, g.bid_order, amountOf);
    if (problem) fail('R3_TIE_ORDER', problem);
    Object.assign(g, { bid_order: [...order], phase: 'closed', order_pos: 1, current_team_id: order[0] });
    event.call(this, st, r, g, 'tie_resolved', order[0], { detail: { order: [...order], reason: why } });
    return { ok: true, order: [...order] };
  },

  r3sReopenBidding(st, r, { session_id, question_id, reason }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, ['tie', 'closed']);
    if (g.question_revealed) fail('R3_QUESTION_LIVE', 'The question is already revealed; bids are final.');
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
    if (!why || why.length > 200) fail('VALIDATION', 'Give a reason for reopening bidding (max 200 characters).');
    r.bids = r.bids.filter((b) => !(b.session_id === g.id && b.question_id === g.question_id && b.status === 'no_bid'));
    Object.assign(g, { phase: 'bidding', bid_started_at: iso(this.now), bids_closed_at: null, bid_order: [], order_pos: 0, current_team_id: null });
    event.call(this, st, r, g, 'bidding_reopened', null, { detail: { reason: why, timer_seconds: g.bid_seconds_current ?? null } });
    return { ok: true };
  },

  r3sRevealTopic(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, null);
    if (g.topic_revealed) return { ok: true };
    if (!g.bids_closed_at || ['selected', 'bidding'].includes(g.phase)) fail('R3_BIDDING_OPEN', 'Close bidding before revealing the topic of a blind question.');
    g.topic_revealed = true;
    event.call(this, st, r, g, 'topic_revealed');
    return { ok: true };
  },

  r3sRevealQuestion(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, null);
    if (g.question_revealed) return { ok: true, answer_started_at: g.answer_started_at };
    if (g.phase === 'tie') fail('R3_TIE_UNRESOLVED', 'Resolve the tie for the highest bid first.');
    if (g.phase !== 'closed') fail('R3_BIDDING_OPEN', 'Close bidding before revealing the question.');
    if (!g.topic_revealed) fail('R3_TOPIC_HIDDEN', 'Reveal the topic of this blind question first.');
    Object.assign(g, { phase: 'answering', question_revealed: true, answer_started_at: iso(this.now) });
    event.call(this, st, r, g, 'question_revealed', g.current_team_id);
    return { ok: true, answer_started_at: g.answer_started_at };
  },

  r3sRecordOutcome(st, r, { request_id, session_id, question_id, team_id, outcome }) {
    if (!request_id) fail('VALIDATION', 'A request id is required.');
    const dup = r.events.find((e) => e.request_id === request_id);
    if (dup) return { duplicate_request: true, event_id: dup.id, outcome: dup.outcome, team_id: dup.team_id, was_top: dup.was_top, bid: dup.bid, score_delta: dup.score_delta, budget_delta: dup.budget_delta };
    const g = lockSession.call(this, st, r, session_id);
    if (!['correct', 'wrong', 'pass', 'timeout'].includes(outcome)) fail('VALIDATION', 'The outcome must be correct, wrong, pass or timeout.');
    require_(g, question_id, ['answering']);
    if (g.current_team_id !== team_id) fail('R3_NOT_CURRENT_TEAM', "It is not this team's turn to answer.");
    if (r.events.some((e) => e.session_id === g.id && e.question_id === g.question_id && e.team_id === team_id && e.kind === 'outcome')) {
      fail('R3_ALREADY_ANSWERED', 'This team already had its turn on this question.');
    }
    if (outcome === 'timeout' && this.now < new Date(g.answer_started_at).getTime() + g.answer_seconds * 1000) fail('R3_TIMER_RUNNING', 'The answer timer is still running.');
    const tm = teamRow(g, team_id);
    const bid = bidsOf(r, g).find((b) => b.team_id === team_id && b.status === 'bid')?.amount ?? null;
    const wasTop = g.order_pos === 1;
    const d = outcomeDeltas(wasTop, outcome, bid);
    tm.score += d.score_delta;
    tm.budget += d.budget_delta;
    const e = event.call(this, st, r, g, 'outcome', team_id, {
      request_id, outcome, was_top: wasTop, bid, score_delta: d.score_delta, budget_delta: d.budget_delta, score_after: tm.score, budget_after: tm.budget,
    });
    g.last_event_id = e.id;
    let next;
    if (outcome === 'correct') { complete.call(this, st, r, g, 'correct', team_id); next = 'done'; } else if (g.order_pos < g.bid_order.length) { g.phase = 'between'; next = 'next_bidder'; } else { complete.call(this, st, r, g, 'no_correct', null); next = 'done'; }
    return { duplicate_request: false, event_id: e.id, outcome, team_id, was_top: wasTop, bid, score_delta: d.score_delta, budget_delta: d.budget_delta, next };
  },

  r3sNextBidder(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, ['between']);
    Object.assign(g, { phase: 'answering', current_team_id: g.bid_order[g.order_pos], order_pos: g.order_pos + 1, answer_started_at: iso(this.now) });
    event.call(this, st, r, g, 'next_bidder', g.current_team_id);
    return { ok: true, team_id: g.current_team_id };
  },

  r3sRevealAnswer(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    require_(g, question_id, ['answering', 'between', 'done']);
    if (!g.question_revealed) fail('R3_NOT_REVEALED', 'Reveal the question before its answer.');
    if (!g.answer_revealed) { g.answer_revealed = true; event.call(this, st, r, g, 'answer_revealed'); }
    return { ok: true };
  },

  r3sFinishQuestion(st, r, { session_id, question_id }) {
    const g = lockSession.call(this, st, r, session_id);
    if (g.phase === 'idle') return { ok: true };
    require_(g, question_id, ['done']);
    clearQuestion(g);
    return { ok: true };
  },

  r3sEndAuction(st, r, { session_id }) {
    const g = r.sessions.find((x) => x.id === session_id);
    if (!g) fail('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.');
    if (g.status === 'ended') return { ok: true };
    autoClose.call(this, st, r, g);
    if (!['idle', 'done'].includes(g.phase)) fail('R3_QUESTION_LIVE', 'Finish or cancel the open question before ending the auction.');
    clearQuestion(g);
    Object.assign(g, { status: 'ended', ended_at: iso(this.now) });
    event.call(this, st, r, g, 'auction_ended');
    return { ok: true };
  },

  r3sRevealResults(st, r, { session_id, reveal }) {
    const g = r.sessions.find((x) => x.id === session_id);
    if (!g) fail('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.');
    if (g.status !== 'ended') fail('R3_NOT_ENDED', 'End the auction before revealing the final results.');
    g.results_revealed = !!reveal;
    event.call(this, st, r, g, 'results_revealed', null, { detail: { revealed: g.results_revealed } });
    return { ok: true, results_revealed: g.results_revealed };
  },
};

function deepFreeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return o;
}

export const ROUND3_ACTIONS = Object.keys(ACTIONS);

/** Apply a Round 3 action to the whole demo state without mutating it. */
export function applyRound3(state, name, payload = {}, ctx = {}) {
  const fn = ACTIONS[name];
  if (!fn) throw new Error(`Unknown Round 3 action ${name}`);
  const st = normalizeRound3(structuredClone(state));
  const c = { now: ctx.now ?? Date.now(), actor: ctx.actor };
  const result = fn.call(c, st, st.round3, payload);
  st.updated_at = iso(c.now);
  return { state: st, result };
}

// ---- reads (same shapes as the r3s_* SQL functions)
const view = (state) => normalizeRound3(structuredClone(state));

export function round3Overview(state) {
  const st = view(state);
  const r = st.round3;
  const teamOf = (id) => st.teams.find((t) => t.id === id);
  return {
    sets: r.sets.map((s) => ({
      ...s, unpublished_changes: unpublished(s), topic_count: draftTopics(r, s.id).length, question_count: draftQuestions(r, s.id).length,
      live_sessions: r.sessions.filter((g) => g.set_id === s.id && g.status === 'live').length,
    })).sort((a, b) => (!!a.archived_at - !!b.archived_at) || b.created_at.localeCompare(a.created_at)),
    sessions: r.sessions.map((g) => {
      const v = versionOf(r, g);
      return {
        id: g.id, set_id: g.set_id, title: v.title, version: v.version, section: g.section, status: g.status, phase: g.phase, results_revealed: g.results_revealed,
        started_at: g.started_at, ended_at: g.ended_at, join_code: findSet(r, g.set_id)?.join_code ?? null,
        teams: g.teams.map((t) => ({ team_number: teamOf(t.team_id)?.team_number, team_name: teamOf(t.team_id)?.team_name })),
        played: r.results.filter((x) => x.session_id === g.id).length, question_count: v.questions.length,
      };
    }).sort((a, b) => (b.status === 'live') - (a.status === 'live') || b.started_at.localeCompare(a.started_at)),
  };
}

export function round3SetDetail(state, id) {
  const r = view(state).round3;
  const s = findSet(r, id);
  if (!s) fail('R3_NOT_FOUND', 'Auction set not found.');
  const topics = draftTopics(r, s.id);
  const questions = draftQuestions(r, s.id);
  return {
    set: { ...s, unpublished_changes: unpublished(s) },
    topics: topics.map(({ set_id: _s, ...t }) => t),
    questions: questions.map(({ set_id: _s, updated_at: _u, ...q }) => q),
    issues: r3PublishIssues(topics, questions),
    live_sessions: r.sessions.filter((g) => g.set_id === s.id && g.status === 'live').length,
  };
}

export function round3Lookup(state, code) {
  const r = view(state).round3;
  const s = byCode(r, code);
  if (!s) fail('R3_CODE_INVALID', 'No published auction set has that code.');
  const v = latestVersion(r, s);
  return {
    set_id: s.id, join_code: s.join_code, version_id: v.id, version: v.version, title: v.title, description: v.description, section: v.section,
    bid_seconds: v.bid_seconds, answer_seconds: v.answer_seconds, published_at: v.published_at,
    questions: v.questions.map((q) => ({ seq: q.seq, mode: q.mode, topic_name: q.topic_name, mystery_no: q.mystery_no })),
    live_session_id: r.sessions.find((g) => g.status === 'live' && g.set_id === s.id)?.id ?? null,
  };
}

export function round3EligibleTeams(state, code, section) {
  const st = view(state);
  const { sec } = eligibleSection(st.round3, code, section);
  const r1q = new Set((st.sets || []).filter((x) => x.session.is_current !== false && x.session.section === sec).flatMap((x) => x.session.qualifiers || []));
  const r2 = st.round2 || { sessions: [], results: [], versions: [] };
  return st.teams.filter((t) => t.section === sec).sort((a, b) => a.team_number - b.team_number).map((t) => {
    const g2 = [...(r2.sessions || [])].filter((g) => (g.team_ids || []).includes(t.id)).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    const v2 = g2 ? r2.versions.find((v) => v.id === g2.version_id) : null;
    return {
      id: t.id, team_number: t.team_number, team_name: t.team_name, participant_1: t.participant_1, participant_2: t.participant_2,
      r1_qualified: r1q.has(t.id),
      round2: g2 ? { title: v2?.title ?? '', score: r2.results.filter((x) => x.session_id === g2.id && x.team_id === t.id).reduce((n, x) => n + Number(x.points), 0) } : null,
      in_live_auction: st.round3.sessions.some((g) => g.status === 'live' && g.teams.some((x) => x.team_id === t.id)),
    };
  });
}

function teamsView(st, r, g, host) {
  return [...g.teams].sort((a, b) => a.seat - b.seat).map((x) => {
    const t = st.teams.find((y) => y.id === x.team_id);
    const b = g.question_id ? bidsOf(r, g).find((y) => y.team_id === x.team_id) : null;
    return {
      team_id: x.team_id, team_number: t?.team_number ?? null, team_name: t?.team_name ?? '', section: t?.section ?? g.section, seat: x.seat, budget: x.budget,
      bid_status: b?.status ?? 'none', bid: b?.amount ?? null, ...(host ? { score: x.score } : {}),
    };
  });
}

function ranking(st, g) {
  return rankTeams(teamsView(st, st.round3, g, true)).map((t) => ({
    rank: t.rank, tied: t.tied, team_id: t.team_id, team_number: t.team_number, team_name: t.team_name, section: t.section, score: t.score, budget: t.budget,
  }));
}

/**
 * Board of one auction (mirrors r3s_board). host=false is the PUBLIC projector view: budgets and bids, the topic
 * only when revealed (BLIND), the question only after Reveal Question, the answer only after Reveal Answer — never
 * a score. host=true adds the private scores, the question and answer, the question list, the ranking and the log.
 */
export function round3SessionBoard(state, sessionId, { host = false, nowMs = Date.now() } = {}) {
  const st = view(state);
  const r = st.round3;
  const g = r.sessions.find((x) => x.id === sessionId);
  if (!g) fail('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.');
  autoClose.call({ now: nowMs }, st, r, g); // same result the database stores on its next read or action
  const v = versionOf(r, g);
  const q = g.question_id ? questionOf(r, g) : null;
  const e = g.last_event_id && ['between', 'done'].includes(g.phase) ? r.events.find((x) => x.id === g.last_event_id) : null;
  const board = {
    server_now: iso(nowMs),
    view: host ? 'host' : 'projector',
    session: { id: g.id, status: g.status, section: g.section, title: v.title, version: v.version, results_revealed: g.results_revealed, started_at: g.started_at, ended_at: g.ended_at },
    settings: { bid_timer_default: g.bid_timer_default, answer_seconds: g.answer_seconds, set_bid_seconds: v.bid_seconds ?? null, min_bid: 10, bid_step: 10, max_timer: 3600 },
    questions: v.questions.map((x) => ({ id: x.id, seq: x.seq, mode: x.mode, mystery_no: x.mystery_no, label: questionLabel(x), used: used(r, g, x.id) })),
    current: {
      phase: g.phase, question_id: g.question_id, seq: q?.seq ?? null, mode: q?.mode ?? null, mystery_no: q?.mystery_no ?? null, label: q ? questionLabel(q) : null,
      topic: g.topic_revealed && q ? q.topic_name : null, topic_revealed: g.topic_revealed,
      question_text: g.question_revealed && q ? q.question_text : null, question_revealed: g.question_revealed,
      answer_text: g.answer_revealed && q ? q.answer_text : null, explanation: g.answer_revealed && q ? q.explanation : null, answer_revealed: g.answer_revealed,
      bid_started_at: g.bid_started_at, bid_seconds: g.bid_seconds_current ?? null, bid_deadline: bidDeadline(g) === null ? null : iso(bidDeadline(g)),
      bids_closed_at: g.bids_closed_at, answer_started_at: g.answer_started_at,
      bid_order: [...g.bid_order], order_pos: g.order_pos, current_team_id: g.current_team_id,
    },
    teams: teamsView(st, r, g, host),
    last_outcome: e?.kind === 'outcome' ? { team_id: e.team_id, team_name: e.team_name, team_number: e.team_number, outcome: e.outcome, was_top: e.was_top, budget_delta: e.budget_delta } : null,
    final: g.status === 'ended' && g.results_revealed ? ranking(st, g) : null,
  };
  if (!host) return board;
  return {
    ...board,
    current: { ...board.current, topic: q?.topic_name ?? null, question_text: q?.question_text ?? null, answer_text: q?.answer_text ?? null, explanation: q?.explanation ?? null },
    session: { ...board.session, join_code: findSet(r, g.set_id)?.join_code ?? null },
    question_list: v.questions.map((x) => ({ id: x.id, seq: x.seq, mode: x.mode, mystery_no: x.mystery_no, topic_name: x.topic_name, question_text: x.question_text, used: used(r, g, x.id) })),
    last_outcome: e?.kind === 'outcome' ? { team_id: e.team_id, team_name: e.team_name, team_number: e.team_number, outcome: e.outcome, was_top: e.was_top, bid: e.bid, score_delta: e.score_delta, budget_delta: e.budget_delta } : null,
    ranking: ranking(st, g),
    log: r.events.filter((x) => x.session_id === g.id).sort((a, b) => b.id - a.id).slice(0, 60).map(({ request_id: _r, ...x }) => x),
  };
}

/** Organizer results summary (mirrors r3s_results). */
export function round3Results(state, sessionId) {
  const st = view(state);
  const r = st.round3;
  const g = r.sessions.find((x) => x.id === sessionId);
  if (!g) fail('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.');
  const v = versionOf(r, g);
  const outcomes = r.events.filter((e) => e.session_id === g.id && e.kind === 'outcome');
  const nameOf = (id) => st.teams.find((t) => t.id === id)?.team_name ?? null;
  return {
    session: { id: g.id, title: v.title, version: v.version, section: g.section, status: g.status, results_revealed: g.results_revealed, started_at: g.started_at, ended_at: g.ended_at },
    ranking: ranking(st, g),
    summary: [...g.teams].sort((a, b) => a.seat - b.seat).map((t) => {
      const mine = outcomes.filter((e) => e.team_id === t.team_id);
      return {
        team_id: t.team_id, correct: mine.filter((e) => e.outcome === 'correct').length, wrong: mine.filter((e) => e.outcome === 'wrong').length,
        passes: mine.filter((e) => ['pass', 'timeout'].includes(e.outcome)).length,
        points_awarded: mine.reduce((n, e) => n + e.score_delta, 0), budget_deducted: -mine.reduce((n, e) => n + e.budget_delta, 0) || 0,
      };
    }),
    questions: r.results.filter((x) => x.session_id === g.id).map((x) => ({ ...x, winner_name: nameOf(x.winner_team_id), top_name: nameOf(x.top_team_id) })),
    outcomes: outcomes.map(({ request_id: _r, ...x }) => x),
  };
}
