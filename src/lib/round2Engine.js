// Demo-mode mirror of Round 2 trivia sets, versions and sessions
// (supabase/migrations/20261020000100_round2_trivia_sets.sql): same validation, same error codes,
// same visibility rules. State lives in state.round2; Round 1 data is only read (teams, qualifiers).
import { fail } from './errors.js';
import { uuid } from './ids.js';
import { randomJoinCode } from './joinCodes.js';
import { R2_DEFAULTS, publishIssues, r2Scores, scoreDelta, validateR2Question, validateR2SetFields, validateTopicName } from './round2.js';

const iso = (ms) => new Date(ms).toISOString();
const SECTIONS2 = ['UG', 'PG'];

export function createRound2State() {
  return {
    sets: [], // { id, title, section, timer_seconds, wrong_penalty_percent, join_code, published_version, published_at, draft_updated_at, archived_at, created_at, updated_at }
    topics: [], // draft: { id, set_id, name, position, created_at }
    questions: [], // draft: { id, set_id, topic_id, points, question_text, answer_text, created_at, updated_at }
    versions: [], // { id, set_id, version, title, section, timer_seconds, wrong_penalty_percent, published_at, questions: [{ id, topic_name, topic_position, points, question_text, answer_text, sort_index }] }
    sessions: [], // { id, request_id, set_id, version_id, section, status, phase, question_id, revealed_at, answer_revealed, last_result_id, started_at, ended_at, team_ids }
    results: [], // { id, request_id, session_id, question_id, topic_name, question_text, team_id, team_number, team_name, team_section, result, point_value, points, answer_revealed, revealed_at, actor, created_at }
    next_result_id: 1,
  };
}

/**
 * Fill in Round 2 data and mirror the database's foreign keys. A demo board from the old single-board
 * model (migration 7) is copied into a draft set "Round 2 board (imported)", like the migration does.
 */
export function normalizeRound2(state) {
  const old = state.round2 || {};
  const legacy = Array.isArray(old.topics) && old.topics.some((t) => !t.set_id) && !(old.sets || []).length;
  const r = legacy ? createRound2State() : old;
  const blank = createRound2State();
  for (const k of Object.keys(blank)) r[k] ??= blank[k];
  if (legacy) {
    const now = new Date().toISOString();
    const set = newSet({ title: 'Round 2 board (imported)', section: 'BOTH', timer_seconds: old.settings?.timer_seconds ?? 18, wrong_penalty_percent: old.settings?.wrong_penalty_percent ?? 50 }, now);
    r.sets.push(set);
    for (const t of old.topics) r.topics.push({ id: t.id, set_id: set.id, name: t.name, position: t.position, created_at: t.created_at || now });
    for (const q of old.questions || []) {
      r.questions.push({ id: q.id, set_id: set.id, topic_id: q.topic_id, points: Number(q.points), question_text: q.question_text, answer_text: q.answer_text, created_at: q.created_at || now, updated_at: q.updated_at || now });
    }
  }
  const teamIds = new Set((state.teams || []).map((t) => t.id));
  for (const g of r.sessions) g.team_ids = (g.team_ids || []).filter((id) => teamIds.has(id));
  for (const x of r.results) if (x.team_id && !teamIds.has(x.team_id)) x.team_id = null;
  state.round2 = r;
  return state;
}

function newSet(v, now) {
  return {
    id: uuid(), title: v.title, section: v.section, timer_seconds: Number(v.timer_seconds), wrong_penalty_percent: Number(v.wrong_penalty_percent),
    join_code: null, published_version: 0, published_at: null, draft_updated_at: now, archived_at: null, created_at: now, updated_at: now,
  };
}

const findSet = (r, id) => r.sets.find((s) => s.id === id);
function lockSet(r, id) {
  const s = findSet(r, id);
  if (!s) fail('TRIVIA_NOT_FOUND', 'Trivia set not found.');
  if (s.archived_at) fail('TRIVIA_SET_ARCHIVED', 'This trivia set is archived.');
  return s;
}
function touch(s, now) { s.draft_updated_at = iso(now); s.updated_at = iso(now); }
function lockSession(r, id) {
  const g = r.sessions.find((x) => x.id === id);
  if (!g) fail('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.');
  if (g.status !== 'live') fail('TRIVIA_SESSION_ENDED', 'This Round 2 session has ended.');
  return g;
}
/** The published set a code opens (mirrors public._r2s_by_code). */
function byCode(r, code) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  return r.sets.find((s) => s.join_code === c && !s.archived_at && s.published_version > 0) || null;
}
const latestVersion = (r, s) => r.versions.find((v) => v.set_id === s.id && v.version === s.published_version);
const versionOf = (r, g) => r.versions.find((v) => v.id === g.version_id);
const played = (r, sessionId, qid) => r.results.some((x) => x.session_id === sessionId && x.question_id === qid);
const draftQuestions = (r, setId) => r.questions.filter((q) => q.set_id === setId);
const draftTopics = (r, setId) => r.topics.filter((t) => t.set_id === setId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
const unpublished = (s) => s.published_version > 0 && s.draft_updated_at > s.published_at;

function eligibleSection(r, code, section) {
  const s = byCode(r, code);
  if (!s) fail('TRIVIA_CODE_INVALID', 'No published trivia set has that code.');
  const sec = String(section ?? '').trim().toUpperCase();
  if (!SECTIONS2.includes(sec)) fail('VALIDATION', 'Choose UG or PG.');
  const v = latestVersion(r, s);
  if (!['BOTH', sec].includes(v.section)) fail('TRIVIA_SECTION_MISMATCH', `This trivia set is not for the ${sec} section.`);
  return { s, v, sec };
}

function toIdle(g, lastId = null) {
  Object.assign(g, { phase: 'idle', question_id: null, revealed_at: null, answer_revealed: false, last_result_id: lastId });
}

const ACTIONS = {
  // ---- trivia sets (draft editing)
  r2sSaveSet(st, r, p) {
    const existing = p.id ? lockSet(r, p.id) : null;
    const { value, errors, ok } = validateR2SetFields(p, existing || R2_DEFAULTS);
    if (!ok) fail('VALIDATION', Object.values(errors)[0]);
    if (!existing) {
      const s = newSet(value, iso(this.now));
      r.sets.push(s);
      return { id: s.id };
    }
    Object.assign(existing, value);
    touch(existing, this.now);
    return { id: existing.id };
  },

  r2sDeleteSet(st, r, { id }) {
    const s = findSet(r, id);
    if (!s) fail('TRIVIA_NOT_FOUND', 'Trivia set not found.');
    if (s.published_version > 0) fail('TRIVIA_SET_PUBLISHED', 'A published trivia set cannot be deleted. Archive it instead.');
    r.sets = r.sets.filter((x) => x.id !== id);
    r.topics = r.topics.filter((x) => x.set_id !== id);
    r.questions = r.questions.filter((x) => x.set_id !== id);
    return { deleted: true };
  },

  r2sArchiveSet(st, r, { id }) {
    const s = lockSet(r, id);
    if (r.sessions.some((g) => g.set_id === s.id && g.status === 'live')) fail('TRIVIA_SESSION_LIVE', 'End the live Round 2 session of this set first.');
    s.archived_at = iso(this.now);
    s.updated_at = iso(this.now);
    return { archived: true };
  },

  r2sSaveTopic(st, r, p) {
    const setId = p.id ? r.topics.find((t) => t.id === p.id)?.set_id : p.set_id;
    if (!setId) fail('TRIVIA_NOT_FOUND', 'Topic not found.');
    const s = lockSet(r, setId);
    const { value, error } = validateTopicName(p.name, draftTopics(r, s.id), p.id || null);
    if (error) fail('VALIDATION', error.replace('already exists.', 'already exists in this set.'));
    let id = p.id;
    if (id) r.topics.find((t) => t.id === id).name = value;
    else {
      id = uuid();
      r.topics.push({ id, set_id: s.id, name: value, position: draftTopics(r, s.id).reduce((m, x) => Math.max(m, x.position), 0) + 1, created_at: iso(this.now) });
    }
    touch(s, this.now);
    return { id };
  },

  r2sDeleteTopic(st, r, { id }) {
    const t = r.topics.find((x) => x.id === id);
    if (!t) fail('TRIVIA_NOT_FOUND', 'Topic not found.');
    const s = lockSet(r, t.set_id);
    r.topics = r.topics.filter((x) => x.id !== id);
    r.questions = r.questions.filter((q) => q.topic_id !== id);
    touch(s, this.now);
    return { deleted: true };
  },

  r2sSaveQuestion(st, r, p) {
    const topic = r.topics.find((t) => t.id === p.topic_id);
    if (!topic) fail('VALIDATION', 'Choose a topic.');
    const s = lockSet(r, topic.set_id);
    const { value, errors, ok } = validateR2Question(p, draftTopics(r, s.id));
    if (!ok) fail('VALIDATION', Object.values(errors)[0]);
    let id = p.id;
    if (id) {
      const q = r.questions.find((x) => x.id === id && x.set_id === s.id);
      if (!q) fail('TRIVIA_NOT_FOUND', 'Question not found.');
      Object.assign(q, value, { updated_at: iso(this.now) });
    } else {
      id = uuid();
      r.questions.push({ id, set_id: s.id, ...value, created_at: iso(this.now), updated_at: iso(this.now) });
    }
    touch(s, this.now);
    return { id };
  },

  r2sDeleteQuestion(st, r, { id }) {
    const q = r.questions.find((x) => x.id === id);
    if (!q) fail('TRIVIA_NOT_FOUND', 'Question not found.');
    const s = lockSet(r, q.set_id);
    r.questions = r.questions.filter((x) => x.id !== id);
    touch(s, this.now);
    return { deleted: true };
  },

  r2sPublishSet(st, r, { id }) {
    const s = lockSet(r, id);
    const issues = publishIssues(draftTopics(r, s.id), draftQuestions(r, s.id));
    if (issues.length) fail('VALIDATION', issues.join(' '));
    if (!s.join_code) {
      const used = new Set([...r.sets.map((x) => x.join_code), ...(st.sets || []).map((x) => x.session.join_code), ...(st.retired_codes || [])].filter(Boolean));
      let c;
      do c = randomJoinCode(); while (used.has(c));
      s.join_code = c;
    }
    const topics = draftTopics(r, s.id);
    const sorted = draftQuestions(r, s.id).slice().sort((a, b) => Number(a.points) - Number(b.points) || a.created_at.localeCompare(b.created_at));
    const v = {
      id: uuid(), set_id: s.id, version: s.published_version + 1, title: s.title, section: s.section, timer_seconds: s.timer_seconds,
      wrong_penalty_percent: s.wrong_penalty_percent, published_at: iso(this.now),
      questions: sorted.map((q, i) => {
        const ti = topics.findIndex((t) => t.id === q.topic_id);
        return { id: uuid(), topic_name: topics[ti].name, topic_position: ti + 1, points: Number(q.points), question_text: q.question_text, answer_text: q.answer_text, sort_index: i + 1 };
      }),
    };
    r.versions.push(v);
    Object.assign(s, { published_version: v.version, published_at: v.published_at, updated_at: v.published_at });
    if (s.draft_updated_at > v.published_at) s.draft_updated_at = v.published_at;
    return { ok: true, join_code: s.join_code, version: v.version, version_id: v.id };
  },

  // ---- Join Round 2
  r2sStartSession(st, r, { request_id, code, section, team_ids }) {
    if (!request_id) fail('VALIDATION', 'A request id is required.');
    const dup = r.sessions.find((g) => g.request_id === request_id);
    if (dup) return { session_id: dup.id, duplicate_request: true };
    const { s, v, sec } = eligibleSection(r, code, section);
    const ids = team_ids || [];
    if (!ids.length) fail('VALIDATION', 'Select at least one team.');
    if (new Set(ids).size !== ids.length) fail('VALIDATION', 'A team is selected more than once.');
    if (!ids.every((id) => st.teams.some((t) => t.id === id && t.section === sec))) fail('TRIVIA_TEAM_NOT_ELIGIBLE', `Every selected team must be a registered ${sec} team.`);
    const g = {
      id: uuid(), request_id, set_id: s.id, version_id: v.id, section: sec, status: 'live', phase: 'idle', question_id: null, revealed_at: null,
      answer_revealed: false, last_result_id: null, started_at: iso(this.now), ended_at: null, team_ids: [...ids],
    };
    r.sessions.push(g);
    return { session_id: g.id, duplicate_request: false, version: v.version };
  },

  r2sEndSession(st, r, { session_id }) {
    const g = r.sessions.find((x) => x.id === session_id);
    if (!g) fail('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.');
    if (g.status === 'live') { toIdle(g, g.last_result_id); Object.assign(g, { status: 'ended', ended_at: iso(this.now) }); }
    return { ok: true };
  },

  // ---- gameplay (per session)
  r2sSelect(st, r, { session_id, question_id }) {
    const g = lockSession(r, session_id);
    if (g.phase !== 'idle') {
      if (g.phase === 'selected' && g.question_id === question_id) return { ok: true, phase: 'selected' };
      fail('TRIVIA_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
    }
    if (!versionOf(r, g).questions.some((q) => q.id === question_id)) fail('TRIVIA_NOT_FOUND', 'That question is not on this board.');
    if (played(r, g.id, question_id)) fail('TRIVIA_QUESTION_USED', 'This question has already been played.');
    Object.assign(g, { phase: 'selected', question_id, revealed_at: null, answer_revealed: false, last_result_id: null });
    return { ok: true, phase: 'selected' };
  },

  r2sCancel(st, r, { session_id }) {
    const g = lockSession(r, session_id);
    if (g.phase === 'revealed') fail('TRIVIA_ALREADY_REVEALED', 'The question is already on screen. Score it, or close it without points.');
    if (g.phase === 'selected') toIdle(g);
    return { ok: true };
  },

  r2sRevealQuestion(st, r, { session_id, question_id }) {
    const g = lockSession(r, session_id);
    if (g.phase === 'idle' || g.question_id !== question_id) fail('TRIVIA_NOT_SELECTED', 'That question is not the one open on the board.');
    if (g.phase === 'selected') Object.assign(g, { phase: 'revealed', revealed_at: iso(this.now) });
    return { ok: true, revealed_at: g.revealed_at };
  },

  r2sRevealAnswer(st, r, { session_id, question_id }) {
    const g = lockSession(r, session_id);
    if (g.phase !== 'revealed' || g.question_id !== question_id) fail('TRIVIA_NOT_REVEALED', 'Reveal the question before its answer.');
    g.answer_revealed = true;
    return { ok: true };
  },

  r2sScore(st, r, { request_id, session_id, question_id, team_id, result }) {
    if (!request_id) fail('VALIDATION', 'A request id is required.');
    const dup = r.results.find((x) => x.request_id === request_id);
    if (dup) return { duplicate_request: true, result_id: dup.id, result: dup.result, team_id: dup.team_id, points: dup.points };
    const g = lockSession(r, session_id);
    if (!['right', 'wrong'].includes(result)) fail('VALIDATION', 'The result must be right or wrong.');
    if (played(r, g.id, question_id)) fail('TRIVIA_QUESTION_USED', 'This question has already been scored.');
    if (g.phase !== 'revealed' || g.question_id !== question_id) fail('TRIVIA_NOT_REVEALED', 'Reveal the question before scoring it.');
    const team = g.team_ids.includes(team_id) ? st.teams.find((t) => t.id === team_id) : null;
    if (!team) fail('TRIVIA_TEAM_NOT_IN_ROUND', 'That team is not playing in this Round 2 session.');
    const v = versionOf(r, g);
    const q = v.questions.find((x) => x.id === question_id);
    return record.call(this, r, g, q, { request_id, team, result, points: scoreDelta(q.points, result, v.wrong_penalty_percent) });
  },

  r2sCloseQuestion(st, r, { request_id, session_id, question_id }) {
    if (!request_id) fail('VALIDATION', 'A request id is required.');
    const dup = r.results.find((x) => x.request_id === request_id);
    if (dup) return { duplicate_request: true, result_id: dup.id, result: dup.result, points: dup.points };
    const g = lockSession(r, session_id);
    if (played(r, g.id, question_id)) fail('TRIVIA_QUESTION_USED', 'This question has already been scored.');
    if (g.phase !== 'revealed' || g.question_id !== question_id) fail('TRIVIA_NOT_REVEALED', 'Only a revealed question can be closed without points. Use Cancel instead.');
    const q = versionOf(r, g).questions.find((x) => x.id === question_id);
    return record.call(this, r, g, q, { request_id, team: null, result: 'no_score', points: 0 });
  },
};

function record(r, g, q, { request_id, team, result, points }) {
  const row = {
    id: r.next_result_id++, request_id, session_id: g.id, question_id: q.id, topic_name: q.topic_name, question_text: q.question_text,
    team_id: team?.id ?? null, team_number: team?.team_number ?? null, team_name: team?.team_name ?? null, team_section: team?.section ?? null,
    result, point_value: Number(q.points), points, answer_revealed: g.answer_revealed, revealed_at: g.revealed_at,
    actor: this.actor || 'demo-organizer', created_at: iso(this.now),
  };
  r.results.push(row);
  toIdle(g, row.id);
  return { duplicate_request: false, result_id: row.id, result, team_id: row.team_id, points };
}

export const ROUND2_ACTIONS = Object.keys(ACTIONS);

/** Apply a Round 2 action to the whole demo state without mutating it. */
export function applyRound2(state, name, payload = {}, ctx = {}) {
  const fn = ACTIONS[name];
  if (!fn) throw new Error(`Unknown Round 2 action ${name}`);
  const st = normalizeRound2(structuredClone(state));
  const c = { now: ctx.now ?? Date.now(), actor: ctx.actor };
  const result = fn.call(c, st, st.round2, payload);
  st.updated_at = iso(c.now);
  return { state: st, result };
}

// ---- reads (same shapes as the r2s_* SQL functions)
const view = (state) => normalizeRound2(structuredClone(state));

/** Topics → point tiles of a version; `used` for a session (mirrors public._r2s_board_topics). */
export function versionBoard(v, results = [], sessionId = null) {
  const byTopic = new Map();
  for (const q of [...v.questions].sort((a, b) => a.topic_position - b.topic_position || Number(a.points) - Number(b.points) || a.sort_index - b.sort_index)) {
    if (!byTopic.has(q.topic_position)) byTopic.set(q.topic_position, { id: `v${q.topic_position}`, name: q.topic_name, questions: [] });
    byTopic.get(q.topic_position).questions.push({ id: q.id, points: Number(q.points), used: results.some((x) => x.session_id === sessionId && x.question_id === q.id) });
  }
  return [...byTopic.values()];
}

export function round2Overview(state) {
  const r = view(state).round2;
  return {
    sets: r.sets.map((s) => ({
      ...s, unpublished_changes: unpublished(s), topic_count: draftTopics(r, s.id).length, question_count: draftQuestions(r, s.id).length,
      live_sessions: r.sessions.filter((g) => g.set_id === s.id && g.status === 'live').length,
    })).sort((a, b) => (!!a.archived_at - !!b.archived_at) || b.created_at.localeCompare(a.created_at)),
    sessions: r.sessions.map((g) => {
      const v = versionOf(r, g);
      return {
        id: g.id, set_id: g.set_id, title: v.title, version: v.version, section: g.section, status: g.status, started_at: g.started_at, ended_at: g.ended_at,
        join_code: findSet(r, g.set_id)?.join_code ?? null, team_count: g.team_ids.length,
        played: r.results.filter((x) => x.session_id === g.id).length, question_count: v.questions.length,
      };
    }).sort((a, b) => (b.status === 'live') - (a.status === 'live') || b.started_at.localeCompare(a.started_at)),
  };
}

export function round2SetDetail(state, id) {
  const r = view(state).round2;
  const s = findSet(r, id);
  if (!s) fail('TRIVIA_NOT_FOUND', 'Trivia set not found.');
  const topics = draftTopics(r, id);
  const questions = draftQuestions(r, id).sort((a, b) => Number(a.points) - Number(b.points) || a.created_at.localeCompare(b.created_at));
  return {
    set: { ...s, unpublished_changes: unpublished(s) }, topics, questions, issues: publishIssues(topics, questions),
    live_sessions: r.sessions.filter((g) => g.set_id === id && g.status === 'live').length,
  };
}

export function round2Lookup(state, code) {
  const r = view(state).round2;
  const s = byCode(r, code);
  if (!s) fail('TRIVIA_CODE_INVALID', 'No published trivia set has that code.');
  const v = latestVersion(r, s);
  return {
    set_id: s.id, join_code: s.join_code, version_id: v.id, version: v.version, title: v.title, section: v.section, timer_seconds: v.timer_seconds,
    wrong_penalty_percent: v.wrong_penalty_percent, published_at: v.published_at, question_count: v.questions.length, topics: versionBoard(v),
  };
}

export function round2EligibleTeams(state, code, section) {
  const st = view(state);
  const { sec } = eligibleSection(st.round2, code, section);
  const qualified = new Set((st.sets || []).filter((x) => x.session.is_current !== false && x.session.section === sec).flatMap((x) => x.session.qualifiers || []));
  return st.teams.filter((t) => t.section === sec).sort((a, b) => a.team_number - b.team_number).map((t) => ({
    id: t.id, team_number: t.team_number, team_name: t.team_name, participant_1: t.participant_1, participant_2: t.participant_2, qualified: qualified.has(t.id),
  }));
}

/**
 * Board of one session, same shape as r2s_board. host=false is the PUBLIC projector view: tiles, the
 * open question (after Reveal Question), the answer (after Answer) and team names — never scores, the
 * last result, the score log or the join code. host=true adds those for the organiser's private screen.
 */
export function round2SessionBoard(state, sessionId, { host = false, nowMs = Date.now() } = {}) {
  const st = view(state);
  const r = st.round2;
  const g = r.sessions.find((x) => x.id === sessionId);
  if (!g) fail('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.');
  const v = versionOf(r, g);
  const q = g.question_id ? v.questions.find((x) => x.id === g.question_id) : null;
  const board = {
    server_now: iso(nowMs),
    view: host ? 'host' : 'projector',
    session: { id: g.id, status: g.status, section: g.section, started_at: g.started_at, ended_at: g.ended_at, title: v.title, version: v.version, set_id: g.set_id },
    settings: { timer_seconds: v.timer_seconds, wrong_penalty_percent: v.wrong_penalty_percent },
    topics: versionBoard(v, r.results, g.id),
    game: {
      phase: g.phase, question_id: g.question_id, topic: q?.topic_name ?? null, points: q ? Number(q.points) : null,
      question_text: g.phase === 'revealed' && q ? q.question_text : null,
      answer_revealed: !!g.answer_revealed,
      answer_text: g.phase === 'revealed' && q && (g.answer_revealed || host) ? q.answer_text : null,
      revealed_at: g.revealed_at,
    },
    teams: st.teams.filter((t) => g.team_ids.includes(t.id)).sort((a, b) => a.team_number - b.team_number)
      .map((t) => ({ team_id: t.id, team_number: t.team_number, team_name: t.team_name, section: t.section })),
  };
  if (!host) return board;
  const mine = r.results.filter((x) => x.session_id === g.id);
  const last = mine.find((x) => x.id === g.last_result_id);
  return {
    ...board,
    session: { ...board.session, join_code: findSet(r, g.set_id)?.join_code ?? null },
    game: { ...board.game, last_result_id: g.last_result_id },
    scores: r2Scores(g.team_ids, mine, st.teams),
    last_result: last ? { id: last.id, result: last.result, points: last.points, point_value: last.point_value, topic: last.topic_name, team_name: last.team_name, team_number: last.team_number, section: last.team_section } : null,
    results: mine.map(({ request_id: _r, ...x }) => x),
  };
}

