// Round 2 — MIND MELTDOWN trivia sets and board: pure helpers shared by the demo engine,
// the organizer UI, the projector and the tests. The database (migrations 7 and 10) is the
// authority; these mirror its rules for demo mode and for display.
import { round2 as round2dp } from './scoring.js';

export const R2_DEFAULTS = Object.freeze({ timer_seconds: 18, wrong_penalty_percent: 50 });
export const R2_LIMITS = Object.freeze({ minTimer: 5, maxTimer: 120, maxPoints: 10000, topicName: 60, question: 1000, answer: 500 });
export const R2_RESULT_LABELS = { right: 'Right', wrong: 'Wrong', no_score: 'Closed — no points' };

/** Score change for a result (mirrors public._r2_delta): right = +value, wrong = −value × penalty %, else 0. */
export function scoreDelta(points, result, penaltyPercent = R2_DEFAULTS.wrong_penalty_percent) {
  const p = Number(points);
  if (result === 'right') return round2dp(p);
  if (result === 'wrong') {
    const v = -round2dp((p * Number(penaltyPercent)) / 100);
    return v === 0 ? 0 : v; // never −0
  }
  return 0;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function validateTopicName(name, topics = [], id = null) {
  const v = clean(name);
  if (!v || v.length > R2_LIMITS.topicName) return { value: v, error: `Topic name is required (max ${R2_LIMITS.topicName} characters).` };
  if (topics.some((t) => t.id !== id && t.name.toLowerCase() === v.toLowerCase())) return { value: v, error: 'A topic with that name already exists.' };
  return { value: v, error: null };
}

/** Mirrors the checks in public.r2_save_question. Returns { value, errors, ok }. */
export function validateR2Question(input, topics = []) {
  const errors = {};
  const raw = String(input.points ?? '').trim();
  const value = {
    topic_id: input.topic_id || null,
    points: /^[0-9]+(\.[0-9]{1,2})?$/.test(raw) ? Number(raw) : NaN,
    question_text: clean(input.question_text),
    answer_text: clean(input.answer_text),
  };
  if (!value.topic_id || (topics.length && !topics.some((t) => t.id === value.topic_id))) errors.topic_id = 'Choose a topic.';
  if (!Number.isFinite(value.points)) errors.points = 'Points must be a positive number (up to 2 decimals).';
  else if (value.points <= 0 || value.points > R2_LIMITS.maxPoints) errors.points = `Points must be between 0.01 and ${R2_LIMITS.maxPoints}.`;
  if (!value.question_text || value.question_text.length > R2_LIMITS.question) errors.question_text = `Question text is required (max ${R2_LIMITS.question} characters).`;
  if (!value.answer_text || value.answer_text.length > R2_LIMITS.answer) errors.answer_text = `The answer is required (max ${R2_LIMITS.answer} characters).`;
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

export function validateR2Settings(input) {
  const errors = {};
  const t = String(input.timer_seconds ?? '').trim();
  const p = String(input.wrong_penalty_percent ?? '').trim();
  if (!/^[0-9]+$/.test(t) || Number(t) < R2_LIMITS.minTimer || Number(t) > R2_LIMITS.maxTimer) errors.timer_seconds = `The question timer must be ${R2_LIMITS.minTimer}–${R2_LIMITS.maxTimer} whole seconds.`;
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(p) || Number(p) > 100) errors.wrong_penalty_percent = 'The wrong-answer penalty must be 0–100 % of the question value.';
  return { value: { timer_seconds: Number(t), wrong_penalty_percent: Number(p) }, errors, ok: Object.keys(errors).length === 0 };
}

export const R2_SECTIONS = ['UG', 'PG', 'BOTH'];
export const R2_SECTION_LABELS = { UG: 'UG only', PG: 'PG only', BOTH: 'UG and PG' };

/**
 * Trivia-set fields (mirrors public.r2s_save_set). Blank timer / penalty keep `base`
 * (the defaults for a new set, the current values when editing).
 */
export function validateR2SetFields(input, base = R2_DEFAULTS) {
  const errors = {};
  const title = clean(input.title);
  const section = String(input.section ?? '').trim().toUpperCase() || 'BOTH';
  const t = String(input.timer_seconds ?? '').trim();
  const p = String(input.wrong_penalty_percent ?? '').trim();
  if (!title || title.length > 80) errors.title = 'The trivia set title is required (max 80 characters).';
  if (!R2_SECTIONS.includes(section)) errors.section = 'Section must be UG, PG or both.';
  const rules = validateR2Settings({ timer_seconds: t || base.timer_seconds, wrong_penalty_percent: p || base.wrong_penalty_percent });
  Object.assign(errors, rules.errors);
  return { value: { title, section, ...rules.value }, errors, ok: Object.keys(errors).length === 0 };
}

/** Problems that block publishing a draft (mirrors public._r2s_publish_issues, same order and wording). */
export function publishIssues(topics, questions) {
  const issues = [];
  if (!topics.length) issues.push('Add at least one topic.');
  if (!questions.length) issues.push('Add at least one question.');
  const empty = [...topics].sort((a, b) => a.position - b.position).find((t) => !questions.some((q) => q.topic_id === t.id));
  if (empty) issues.push(`Topic "${empty.name}" has no questions — add one or delete the topic.`);
  if (questions.some((q) => !clean(q.answer_text))) issues.push('Every question needs an answer.');
  return issues;
}

/** Milliseconds left on the open question's timer (null when no question is revealed). Display only — never decides a score. */
export function r2Remaining(game, settings, nowMs) {
  if (!game || game.phase !== 'revealed' || !game.revealed_at) return null;
  const end = Date.parse(game.revealed_at) + Number(settings?.timer_seconds ?? R2_DEFAULTS.timer_seconds) * 1000;
  return Math.max(0, end - nowMs);
}

/** Roster teams with their Round 2 totals (non-voided results only), highest first, then team number. */
export function r2Scores(rosterIds, results, teams) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const totals = new Map();
  for (const r of results) if (!r.voided_at && r.team_id) totals.set(r.team_id, round2dp((totals.get(r.team_id) || 0) + Number(r.points)));
  return rosterIds.map((id) => byId.get(id)).filter(Boolean)
    .map((t) => ({ team_id: t.id, team_number: t.team_number, team_name: t.team_name, section: t.section, score: totals.get(t.id) || 0 }))
    .sort((a, b) => b.score - a.score || a.section.localeCompare(b.section) || a.team_number - b.team_number);
}

/** Topics → { id, name, questions: [{ id, points, used }] } in board order (mirrors r2_board). */
export function boardTopics(topics, questions) {
  return [...topics].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)).map((t) => ({
    id: t.id,
    name: t.name,
    questions: questions.filter((q) => q.topic_id === t.id)
      .sort((a, b) => Number(a.points) - Number(b.points) || a.created_at.localeCompare(b.created_at))
      .map((q) => ({ id: q.id, points: Number(q.points), used: !!q.used })),
  }));
}

/** Formats a score or point value: integers plainly, otherwise up to 2 decimals. */
export function formatScore(n, { sign = false } = {}) {
  const v = Number(n) || 0;
  const s = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(2).replace(/0$/, '');
  if (v < 0) return `−${s}`;
  return sign && v > 0 ? `+${s}` : s;
}

/**
 * The host's local confirmation flow (no server state until Confirm Score):
 *   { modal: null } —mark(right|wrong)→ { modal: 'team', result, teamId: null }
 *   —pick(teamId)→ teamId set —cancel→ { modal: null }.
 * `canConfirm` is true only with a result AND exactly one chosen team.
 */
export const R2_UI_IDLE = Object.freeze({ modal: null, result: null, teamId: null });
export function r2UiReducer(state, event) {
  switch (event.type) {
    case 'mark':
      if (!['right', 'wrong'].includes(event.result)) return state;
      return { modal: 'team', result: event.result, teamId: null };
    case 'pick':
      return state.modal === 'team' ? { ...state, teamId: event.teamId } : state;
    case 'cancel':
    case 'done':
      return R2_UI_IDLE;
    default:
      return state;
  }
}
export const canConfirm = (ui) => ui.modal === 'team' && !!ui.result && !!ui.teamId;
