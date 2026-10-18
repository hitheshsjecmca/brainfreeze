// Round 3 — THE KNOWLEDGE AUCTION: pure helpers shared by the demo engine, the organizer UI, the
// projector and the tests. The database (migration 13) is the authority; these mirror its rules for
// demo mode and for display (previews). Budget (public) and score (private) are always separate values.
import { validateTopicName } from './round2.js';

// Bidding timer: null = NO TIMER (manual close only); otherwise 1–3600 whole seconds (documented safety limit),
// closed automatically by the server at the deadline. Answer timer: 5–600 seconds per auction (default 25).
export const R3_DEFAULTS = Object.freeze({ bid_seconds: null, answer_seconds: 25 });
export const R3_LIMITS = Object.freeze({ minBidTimer: 1, maxBidTimer: 3600, minAnswer: 5, maxAnswer: 600, title: 80, description: 500, question: 1000, answer: 500, explanation: 1000, topicName: 60 });
export const START_BUDGET = 100;
export const MIN_BID = 10;
export const BID_STEP = 10;
export const LOWER_BIDDER_POINTS = 10;
export const R3_MODES = ['NORMAL', 'BLIND'];
export const R3_MODE_LABELS = { NORMAL: 'Normal topic', BLIND: 'Blind topic' };
export const R3_SECTIONS = ['UG', 'PG', 'BOTH'];
export const R3_SECTION_LABELS = { UG: 'UG only', PG: 'PG only', BOTH: 'UG and PG' };
export const R3_OUTCOMES = ['correct', 'wrong', 'pass', 'timeout'];
export const R3_OUTCOME_LABELS = { correct: 'Correct', wrong: 'Wrong', pass: 'Pass', timeout: 'Time out' };
export const R3_RESULT_LABELS = { correct: 'Answered correctly', no_correct: 'No correct answer', no_bids: 'No bids' };
export const R3_PHASE_LABELS = {
  idle: 'Choose a question', selected: 'Question selected', bidding: 'Bidding open', tie: 'Tie to resolve', closed: 'Bidding closed',
  answering: 'Answering', between: 'Next bidder', done: 'Question complete',
};

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * A bidding timer value (mirrors public._r3_timer_value): undefined → `fallback`; null / '' / 'none' → null (no timer);
 * otherwise 1–3600 whole seconds. Returns { value, error }.
 */
export function parseBidTimer(raw, fallback = null) {
  if (raw === undefined) return { value: fallback, error: null };
  if (raw === null) return { value: null, error: null };
  const t = String(raw).trim();
  if (t === '' || t.toLowerCase() === 'none') return { value: null, error: null };
  if (!/^[0-9]{1,6}$/.test(t) || Number(t) < R3_LIMITS.minBidTimer || Number(t) > R3_LIMITS.maxBidTimer) {
    return { value: null, error: `The bidding timer must be ${R3_LIMITS.minBidTimer}–${R3_LIMITS.maxBidTimer} whole seconds, or no timer.` };
  }
  return { value: Number(t), error: null };
}

/** An answer timer value (mirrors public._r3_answer_value): blank/undefined → `fallback`; else 5–600 whole seconds. */
export function parseAnswerTimer(raw, fallback = R3_DEFAULTS.answer_seconds) {
  const t = String(raw ?? '').trim();
  if (t === '') return { value: fallback, error: null };
  if (!/^[0-9]{1,6}$/.test(t) || Number(t) < R3_LIMITS.minAnswer || Number(t) > R3_LIMITS.maxAnswer) {
    return { value: fallback, error: `The answer timer must be ${R3_LIMITS.minAnswer}–${R3_LIMITS.maxAnswer} whole seconds.` };
  }
  return { value: Number(t), error: null };
}

/** "No timer" or "30 s". */
export const timerLabel = (secs) => (secs === null || secs === undefined ? 'No timer' : `${secs} s`);

/** Mirrors public.r3s_save_set. `base` supplies values for missing timers (existing set or defaults). */
export function validateR3SetFields(input, base = R3_DEFAULTS) {
  const errors = {};
  const bid = parseBidTimer(input.bid_seconds, base.bid_seconds ?? null);
  const ans = parseAnswerTimer(input.answer_seconds, Number(base.answer_seconds ?? R3_DEFAULTS.answer_seconds));
  const value = {
    title: clean(input.title),
    description: clean(input.description) || null,
    section: String(input.section || 'BOTH').trim().toUpperCase(),
    bid_seconds: bid.value,
    answer_seconds: ans.value,
  };
  if (!value.title || value.title.length > R3_LIMITS.title) errors.title = `The auction set title is required (max ${R3_LIMITS.title} characters).`;
  if (value.description && value.description.length > R3_LIMITS.description) errors.description = `The description can be at most ${R3_LIMITS.description} characters.`;
  if (!R3_SECTIONS.includes(value.section)) errors.section = 'Section must be UG, PG or both.';
  if (bid.error) errors.bid_seconds = bid.error;
  if (ans.error) errors.answer_seconds = ans.error;
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

export const validateR3Topic = (name, topics = [], id = null) => validateTopicName(name, topics, id);

/** Mirrors public.r3s_save_question. */
export function validateR3Question(input, topics = []) {
  const errors = {};
  const value = {
    topic_id: input.topic_id || null,
    mode: String(input.mode || 'NORMAL').trim().toUpperCase(),
    question_text: clean(input.question_text),
    answer_text: clean(input.answer_text),
    explanation: String(input.explanation ?? '').trim() || null,
  };
  if (!value.topic_id || (topics.length && !topics.some((t) => t.id === value.topic_id))) errors.topic_id = 'Choose a topic.';
  if (!R3_MODES.includes(value.mode)) errors.mode = 'The topic mode must be NORMAL or BLIND.';
  if (!value.question_text || value.question_text.length > R3_LIMITS.question) errors.question_text = `Question text is required (max ${R3_LIMITS.question} characters).`;
  if (!value.answer_text || value.answer_text.length > R3_LIMITS.answer) errors.answer_text = `The correct answer is required (max ${R3_LIMITS.answer} characters).`;
  if (value.explanation && value.explanation.length > R3_LIMITS.explanation) errors.explanation = `The explanation can be at most ${R3_LIMITS.explanation} characters.`;
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

/** Problems that block publishing (mirrors public._r3_publish_issues). */
export function r3PublishIssues(topics, questions) {
  const issues = [];
  if (!topics.length) issues.push('Add at least one topic.');
  if (!questions.length) issues.push('Add at least one question.');
  const empty = [...topics].sort((a, b) => a.position - b.position).find((t) => !questions.some((q) => q.topic_id === t.id));
  if (empty) issues.push(`Topic "${empty.name}" has no questions — add one or delete the topic.`);
  if (questions.some((q) => !clean(q.answer_text))) issues.push('Every question needs a correct answer.');
  return issues;
}

/**
 * Order of the published questions (mirrors r3s_publish_set): topics by position, then questions by position.
 * Returns [{ ...question, seq, topic_name, topic_position, mystery_no }].
 */
export function versionOrder(topics, questions) {
  const ts = [...topics].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const out = [];
  let mystery = 0;
  ts.forEach((t, ti) => {
    const qs = questions.filter((q) => q.topic_id === t.id).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const q of qs) out.push({ ...q, seq: out.length + 1, topic_name: t.name, topic_position: ti + 1, mystery_no: q.mode === 'BLIND' ? ++mystery : null });
  });
  return out;
}

/** Public label of a question: the topic for NORMAL, "MYSTERY QUESTION #n" for BLIND. */
export const questionLabel = (q) => (q.mode === 'BLIND' ? `MYSTERY QUESTION #${q.mystery_no}` : q.topic_name);

/** Why a bid is not allowed, or null (mirrors public.r3s_record_bid). */
export function bidProblem(amount, budget) {
  if (budget < MIN_BID) return { code: 'R3_CANNOT_BID', message: `This team has less than ${MIN_BID} left and must pass.` };
  const n = Number(amount);
  if (!Number.isInteger(n)) return { code: 'VALIDATION', message: 'Enter the bid as a whole number.' };
  if (n < MIN_BID) return { code: 'R3_BID_TOO_LOW', message: `The minimum bid is ${MIN_BID}.` };
  if (n % BID_STEP !== 0) return { code: 'R3_BID_STEP', message: `Bids go up in steps of ${BID_STEP}.` };
  if (n > budget) return { code: 'R3_BID_OVER_BUDGET', message: `The bid is more than the team's budget (${budget}).` };
  return null;
}

/** Valid bid amounts for a budget: 10, 20, … up to the budget. */
export const bidOptions = (budget) => Array.from({ length: Math.floor(Math.max(0, budget) / BID_STEP) }, (_, i) => (i + 1) * BID_STEP).filter((x) => x >= MIN_BID);

/**
 * Topic cards of the auction board (public data only): NORMAL questions grouped by topic, every BLIND question its
 * own MYSTERY QUESTION card, in auction order. Each card lists its questions and how many are still unused.
 */
export function topicCards(questions) {
  const cards = [];
  const byKey = new Map();
  for (const q of questions) {
    const key = q.mode === 'BLIND' ? `blind-${q.mystery_no}` : `topic-${q.label}`;
    let c = byKey.get(key);
    if (!c) { c = { key, label: q.label, blind: q.mode === 'BLIND', questions: [] }; byKey.set(key, c); cards.push(c); }
    c.questions.push(q);
  }
  return cards.map((c) => ({ ...c, left: c.questions.filter((q) => !q.used).length }));
}

export const BID_PANEL_LABELS = { ready: 'Ready', bidding: 'Bidding', passed: 'Passed', ineligible: 'Ineligible' };

/**
 * The +10 / −10 / Pass panel of one team while bidding is open. `team` is the board row (budget, bid_status, bid).
 * The buttons send ABSOLUTE amounts computed from the server-confirmed bid, so a double-click or a retried request
 * sets the same value again instead of adding 10 twice. −10 from 10 sends null (no valid bid). Budget never changes.
 */
export function bidPanel(team, open = true) {
  const passed = team.bid_status === 'pass';
  const current = team.bid_status === 'bid' ? Number(team.bid) : 0;
  const ineligible = !passed && team.budget < MIN_BID;
  const status = passed ? 'passed' : ineligible ? 'ineligible' : current > 0 ? 'bidding' : 'ready';
  const plus = current + BID_STEP;
  const minus = current - BID_STEP;
  return {
    status, current,
    plus: open && !passed && !ineligible && plus <= team.budget ? plus : undefined,
    minus: open && !passed && current >= MIN_BID ? (minus >= MIN_BID ? minus : null) : undefined,
    canPass: open && !passed,
    canUndoPass: open && passed,
  };
}

/**
 * The only scoring rule (mirrors public._r3_deltas). Integers; bids are multiples of 10.
 * Highest bidder: correct → score + bid/2; wrong → budget − bid/2. Lower bidder: correct → score + 10.
 * Pass and timeout never change anything.
 */
export function outcomeDeltas(wasTop, outcome, bid) {
  const b = Number(bid) || 0;
  const score_delta = outcome === 'correct' ? (wasTop ? Math.trunc(b / 2) : LOWER_BIDDER_POINTS) : 0;
  const budget_delta = outcome === 'wrong' && wasTop ? -Math.trunc(b / 2) : 0;
  return { score_delta, budget_delta: budget_delta === 0 ? 0 : budget_delta };
}

/** Bid order after closing: highest first, equal bids by seat; `tie` when any two bids are equal. */
export function bidOrder(bids, teams) {
  const seat = new Map(teams.map((t) => [t.team_id ?? t.id, t.seat]));
  const valid = bids.filter((b) => b.status === 'bid');
  const order = [...valid].sort((a, b) => b.amount - a.amount || seat.get(a.team_id) - seat.get(b.team_id)).map((b) => b.team_id);
  const tie = new Set(valid.map((b) => b.amount)).size !== valid.length;
  return { order, tie };
}

/** Is `order` a valid tie resolution (each bidder once; higher bids stay ahead)? */
export function tieOrderProblem(order, provisional, amountOf) {
  if (!Array.isArray(order) || order.length !== provisional.length || new Set(order).size !== order.length || provisional.some((x) => !order.includes(x))) {
    return 'The order must list each bidding team exactly once.';
  }
  for (let i = 0; i + 1 < order.length; i++) if (amountOf(order[i]) < amountOf(order[i + 1])) return 'Higher bids must stay ahead of lower bids; only equal bids can be reordered.';
  return null;
}

/** Final ranking: score high → low; equal scores share a rank (1, 1, 3) and are flagged `tied`. */
export function rankTeams(teams) {
  const sorted = [...teams].sort((a, b) => b.score - a.score || a.seat - b.seat);
  return sorted.map((t) => ({ ...t, rank: 1 + sorted.filter((x) => x.score > t.score).length, tied: sorted.filter((x) => x.score === t.score).length > 1 }));
}

/** Remaining ms of a server-timed phase (null when not started or untimed). */
export function remainingMs(startedAt, seconds, nowMs) {
  if (!startedAt || seconds === null || seconds === undefined) return null;
  return new Date(startedAt).getTime() + seconds * 1000 - nowMs;
}

/** Human description of an outcome's effect (for the organizer's confirmation preview). */
export function describeDeltas({ score_delta, budget_delta }) {
  const parts = [];
  parts.push(score_delta ? `private score +${score_delta}` : 'private score unchanged');
  parts.push(budget_delta ? `budget ${budget_delta}` : 'budget unchanged');
  return parts.join(' · ');
}

/** Is a BidTimerField value valid? ('default' | null | 1–3600). */
export const bidTimerValid = (v) => v === 'default' || v === null || (Number.isInteger(v) && v >= R3_LIMITS.minBidTimer && v <= R3_LIMITS.maxBidTimer);

/** "Timed · 30 s" / "No timer". */
export const timerModeText = (secs) => (secs === null || secs === undefined ? 'No timer — closed manually' : `Timed · ${timerLabel(secs)} — closes automatically`);
