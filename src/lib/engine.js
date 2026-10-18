// Local demo-mode engine. Each action mirrors a Supabase RPC in
// supabase/migrations/*.sql — same validation, same error codes — so demo
// rehearsals behave like the production database.
// Actions are pure: (state, payload, ctx) -> { state, result }; they never
// mutate the input state.
//
// Quiz sets (mirrors migration 6): state.sets holds any number of sets, each
// { session, settings, set_questions } (set_questions = the frozen snapshot of
// a published set). A set action runs on a VIEW of the state where
// st.session / st.settings / st.teams are the selected set's (ctx.setId, like
// the x-brainfreze-set header; without it the newest active set of
// ctx.section). Participant actions take their set from the join code or
// device token. Each team that joins gets ONE attempt (state.attempts) with its
// own random question and option order. The question bank is shared.

import { APP_ID, BACKUP_FORMAT_VERSION, DEFAULT_SETTINGS, OPTIONS, PROJECTOR_VIEWS, SECTIONS } from './constants.js';
import { fail } from './errors.js';
import { uuid } from './ids.js';
import { computeStandings, evaluateAnswer, marksFor, normalizeOption, round2, validateQualifierSelection } from './scoring.js';
import { elapsedMs, isTimeExpired } from './timer.js';
import { DURATION_ERROR, isValidDurationSeconds, quizReadinessIssues, validateQuestion, validateSettings, validateTeam } from './validation.js';
import { validateBackup } from './backup.js';
import { SAMPLE_QUESTIONS } from '../data/sampleQuestions.js';
import { DEMO_PG_TEAMS, DEMO_TEAMS } from '../data/demoTeams.js';
import { normalizeJoinCode, randomJoinCode, randomPin, randomToken } from './joinCodes.js';
import { normalizeRound2 } from './round2Engine.js';

const iso = (ms) => new Date(ms).toISOString();

export function newSession(nowMs, section = 'UG', name = 'COLD START') {
  return {
    id: uuid(),
    section,
    self_paced: true, // per-team shuffled order, teams answer at their own pace
    name,
    status: 'setup',
    is_current: true, // false = archived
    current_index: 0,
    completed_question_ids: [],
    started_at: null,
    timer_started_at: null,
    elapsed_ms: 0,
    paused_at: null,
    ended_at: null,
    corrections_enabled: false,
    projector_view: 'standby',
    results_revealed: false,
    qualifiers: null,
    qualifiers_confirmed_at: null,
    qualification_note: null,
    // participant joining
    description: null,
    question_ids: null, // null = whole question bank (drafts only)
    published_at: null,
    published_by: null,
    join_code: null,
    join_code_active: false,
    registration_open: false,
    self_registration: false,
    archived_at: null,
    team_ids: [], // the organiser's chosen participants (mirrors quiz_sessions.team_ids, migration 15)
    created_at: iso(nowMs),
    updated_at: iso(nowMs),
  };
}

export const newSet = (nowMs, section = 'UG', name = 'COLD START') => ({ session: newSession(nowMs, section, name), settings: { ...DEFAULT_SETTINGS }, set_questions: [] });

export function createEmptyState(nowMs = Date.now()) {
  return {
    app: APP_ID,
    format_version: BACKUP_FORMAT_VERSION,
    teams: [],
    questions: [],
    sets: SECTIONS.map((sec) => newSet(nowMs, sec)),
    attempts: [],
    answers: [],
    events: [],
    tiebreaks: [],
    credentials: {}, // team_id -> PIN
    participant_sessions: [],
    registration_events: [],
    join_failures: [], // timestamps of failed join attempts (rate limiting)
    retired_codes: [],
    next_event_id: 1,
    updated_at: iso(nowMs),
  };
}

/** 'draft' | 'published' | 'live' | 'completed' | 'archived' (mirrors public._set_stage). */
export function setStage(session) {
  if (session.is_current === false) return 'archived';
  if (['running', 'paused'].includes(session.status)) return 'live';
  if (['ended', 'finalized'].includes(session.status)) return 'completed';
  return session.published_at ? 'published' : 'draft';
}

/** Freeze a set's questions, keys and resolved marks (mirrors the publish_quiz snapshot). */
function snapshotOf(questions, settings) {
  return questions.map((q, i) => ({
    question_id: q.id, position: i + 1, question_text: q.question_text,
    option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
    image_url: q.image_url || null, category: q.category || null, correct_option: q.correct_option, explanation: q.explanation || null,
    marks_correct: q.marks_correct ?? settings.marks_correct, marks_incorrect: q.marks_incorrect ?? settings.marks_incorrect,
  }));
}

/** Fill in fields added after a demo state was first saved (older browsers' storage). */
export function normalizeState(state) {
  const s = state;
  const now = Date.now();
  if (!s.sets) {
    // Pre-sets demo data: each section's session (and archived ones) becomes a set.
    const old = s.sections || { UG: { session: s.session || newSession(now, 'UG'), settings: s.settings || { ...DEFAULT_SETTINGS } } };
    s.sets = [];
    for (const a of s.archives || []) {
      s.sets.push({ session: { ...a.session, is_current: false, archived_at: a.session.updated_at }, settings: a.settings, set_questions: [] });
      const known = new Set(s.answers.map((x) => x.id));
      s.answers.push(...(a.answers || []).filter((x) => !known.has(x.id)));
      s.tiebreaks = [...(s.tiebreaks || []), ...(a.tiebreaks || [])];
    }
    for (const sec of SECTIONS) if (old[sec]) s.sets.push({ session: { ...old[sec].session, section: sec }, settings: old[sec].settings, set_questions: [] });
    delete s.sections;
    delete s.session;
    delete s.settings;
    delete s.archives;
  }
  // Like the database (ensure_session / _lock_section_session): a set is created only when none is active;
  // other sections get one on demand (sectionSet).
  if (!s.sets.some((x) => x.session.is_current !== false)) s.sets.push(newSet(now, 'UG'));
  const teamIds = new Set((s.teams || []).map((t) => t.id));
  for (const set of s.sets) {
    // Sets from before manual selection: their participants are the teams that took part (like migration 15).
    if (!Array.isArray(set.session.team_ids)) {
      const took = new Set([...(s.attempts || []).filter((a) => a.session_id === set.session.id && a.status !== 'reset').map((a) => a.team_id),
        ...(s.answers || []).filter((a) => a.session_id === set.session.id).map((a) => a.team_id)]);
      set.session.team_ids = [...took];
    }
    set.session.team_ids = set.session.team_ids.filter((id) => teamIds.has(id)); // a deleted team leaves every selection
    const blank = newSession(now, set.session.section);
    for (const k of Object.keys(blank)) if (!(k in set.session)) set.session[k] = blank[k];
    set.settings = { ...DEFAULT_SETTINGS, ...(set.settings || {}) };
    set.set_questions ??= [];
    // A set published before snapshots existed is frozen now, from the current bank.
    if (set.session.published_at && set.set_questions.length === 0) {
      set.set_questions = snapshotOf(bankQuestions(set.session, s.questions), set.settings);
    }
  }
  s.attempts ??= [];
  s.credentials ??= {};
  s.participant_sessions ??= [];
  s.registration_events ??= [];
  s.join_failures ??= [];
  s.retired_codes ??= [];
  s.tiebreaks ??= [];
  for (const t of s.teams) {
    t.section ??= 'UG';
    t.college_name ??= null;
    t.self_registered ??= false;
    if (!s.credentials[t.id]) s.credentials[t.id] = randomPin();
  }
  for (const a of s.answers) a.source ??= 'organizer';
  for (const e of s.events) e.source ??= 'organizer';
  s.format_version = BACKUP_FORMAT_VERSION;
  normalizeRound2(s); // Round 2 data (separate slice; mirrors the r2_* foreign keys)
  return s;
}

function bankQuestions(session, questions) {
  const sorted = [...questions].sort((a, b) => a.position - b.position);
  if (!session.question_ids) return sorted;
  const byId = new Map(sorted.map((q) => [q.id, q]));
  // A draft's questions keep the organizer's selection order.
  return session.question_ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The set's questions: its frozen snapshot once published, else the bank
 * selection. `view` = { session, questions, set_questions }.
 */
export function sessionQuestions(view) {
  if (view.session.published_at && view.set_questions?.length) {
    return [...view.set_questions].sort((a, b) => a.position - b.position)
      .map(({ question_id, ...q }) => ({ ...q, id: question_id }));
  }
  return bankQuestions(view.session, view.questions);
}

/** Effective "now" for a set's attempt clocks: frozen at paused_at while paused (mirrors public._clock). */
export function setClock(session, nowMs) {
  return session.status === 'paused' && session.paused_at ? Math.min(Date.parse(session.paused_at), nowMs) : nowMs;
}

const findSet = (st, id) => st.sets.find((x) => x.session.id === id);
const activeSets = (st) => st.sets.filter((x) => x.session.is_current !== false);

/** The newest active set of a section (mirrors public._lock_section_session; created on demand). */
function sectionSet(st, section, nowMs) {
  let pick = null;
  for (const x of activeSets(st)) {
    if (x.session.section === section && (!pick || x.session.created_at >= pick.session.created_at)) pick = x;
  }
  if (!pick) {
    pick = newSet(nowMs, section);
    st.sets.push(pick);
  }
  return pick;
}

/** Summary of every set for the organizer's set list. */
export function setSummaries(state) {
  return state.sets.map(({ session: s, settings, set_questions }) => ({
    id: s.id, name: s.name, section: s.section, stage: setStage(s), status: s.status,
    join_code: s.join_code, join_code_active: s.join_code_active, registration_open: s.registration_open,
    published_at: s.published_at, archived_at: s.archived_at, created_at: s.created_at,
    question_count: s.published_at && set_questions.length ? set_questions.length : bankQuestions(s, state.questions).length,
    duration_seconds: settings.duration_seconds,
    attempts: state.attempts.filter((a) => a.session_id === s.id && a.status !== 'reset').length,
    qualify_count: settings.qualify_count,
    qualifiers: s.qualifiers || null, // confirmed qualifiers (finalized sets only)
    results_revealed: !!s.results_revealed,
    team_ids: s.team_ids || [], // the organiser's chosen participants
    // each team's current attempt status in this set (for dashboard and team status)
    participants: state.attempts.filter((a) => a.session_id === s.id && a.status !== 'reset').map((a) => ({ team_id: a.team_id, status: a.status })),
  }));
}

/** Read-only view of one set (organizer snapshot / projector). */
export function setView(state, setId) {
  const set = findSet(state, setId);
  if (!set) return null;
  const { session, settings, set_questions } = set;
  const view = {
    setId, section: session.section, session, settings, set_questions,
    teams: state.teams.filter((t) => t.section === session.section),
    questions: state.questions,
    answers: state.answers.filter((a) => a.session_id === session.id),
    events: state.events.filter((e) => e.session_id === session.id),
    tiebreaks: state.tiebreaks.filter((t) => t.session_id === session.id),
    attempts: state.attempts.filter((a) => a.session_id === session.id),
  };
  return view;
}

/** The newest active set of a section, as a read-only view (or null). */
export function sectionView(state, section) {
  const pick = activeSets(state).filter((x) => x.session.section === section)
    .reduce((best, x) => (!best || x.session.created_at >= best.session.created_at ? x : best), null);
  return pick ? setView(state, pick.session.id) : null;
}

/** Pick a set id: the requested one if it exists, else the newest active UG set (then PG). */
export function resolveSetId(state, setId) {
  if (setId && findSet(state, setId)) return setId;
  const act = activeSets(state);
  const newest = (sec) => act.filter((x) => x.session.section === sec).sort((a, b) => b.session.created_at.localeCompare(a.session.created_at))[0];
  return (newest('UG') || newest('PG') || act[0] || state.sets[0])?.session.id ?? null;
}

/** Results for one set (mirrors public.get_set_results): roster teams with points, times and status. */
export function setResults(state, setId, nowMs = Date.now()) {
  const view = setView(state, setId);
  if (!view) return [];
  const chosen = new Set(view.session.team_ids || []);
  const roster = view.teams.filter((t) => chosen.has(t.id));
  return computeStandings({
    teams: roster, questions: sessionQuestions(view), answers: view.answers, tiebreaks: view.tiebreaks,
    settings: view.settings, attempts: view.attempts, nowMs: setClock(view.session, nowMs),
  });
}

/** Every set's data, in the shape buildBackup() expects. */
export function backupData(state) {
  return {
    teams: state.teams, questions: state.questions,
    sets: state.sets.map((x) => ({ ...x, attempts: state.attempts.filter((a) => a.session_id === x.session.id) })),
    answers: state.answers, events: state.events, tiebreaks: state.tiebreaks, credentials: state.credentials,
  };
}

export function sampleQuestionRecords(nowMs = Date.now()) {
  return SAMPLE_QUESTIONS.map((sq, i) => {
    const { sample_ref: _ref, ...rest } = sq;
    return { ...rest, id: uuid(), position: i + 1, created_at: iso(nowMs), updated_at: iso(nowMs) };
  });
}

export function demoTeamRecords(nowMs = Date.now()) {
  const rec = (section) => (t) => ({ ...t, section, self_registered: false, id: uuid(), created_at: iso(nowMs), updated_at: iso(nowMs) });
  return [...DEMO_TEAMS.map(rec('UG')), ...DEMO_PG_TEAMS.map(rec('PG'))];
}

export function createDemoState(nowMs = Date.now()) {
  const s = createEmptyState(nowMs);
  s.teams = demoTeamRecords(nowMs);
  s.questions = sampleQuestionRecords(nowMs);
  return normalizeState(s);
}

// ---------------------------------------------------------------- helpers

function pushEvent(st, ctx, ev) {
  const e = {
    id: st.next_event_id++,
    session_id: st.session.id,
    request_id: null,
    team_id: null,
    team_number: null,
    question_id: null,
    question_position: null,
    prev_selected: null,
    prev_result: null,
    prev_points: null,
    new_selected: null,
    new_result: null,
    new_points: null,
    undone: false,
    undo_of: null,
    reason: null,
    actor: ctx.actor || 'demo-organizer',
    source: 'organizer',
    created_at: iso(ctx.now),
    ...ev,
  };
  st.events.push(e);
  return e;
}

const sessionAnswers = (st) => st.answers.filter((a) => a.session_id === st.session.id);
const allTeams = (st) => [...st.teams, ...(st._otherTeams || [])];

/** The team's current (non-reset) attempt in a set. */
const activeAttempt = (st, sessionId, teamId) => st.attempts.find((a) => a.session_id === sessionId && a.team_id === teamId && a.status !== 'reset') || null;

/** Is the team one of the set's chosen participants? (mirrors public._team_selected) */
const isSelected = (session, teamId) => (session.team_ids || []).includes(teamId);

/** Name of ANOTHER active set of the same section the team is selected for or takes part in (mirrors public._team_other_set). */
function teamOtherSet(st, session, teamId) {
  const other = st.sets
    .filter((x) => x.session.is_current !== false && x.session.section === session.section && x.session.id !== session.id)
    .sort((a, b) => a.session.created_at.localeCompare(b.session.created_at))
    .find((x) => (x.session.team_ids || []).includes(teamId)
      || st.attempts.some((a) => a.session_id === x.session.id && a.team_id === teamId && a.status !== 'reset')
      || st.answers.some((a) => a.session_id === x.session.id && a.team_id === teamId));
  return other ? other.session.name : null;
}

const randomInt = (n) => {
  const [v] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return v % n;
};
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** New attempt: random question order and per-question option order (mirrors public._make_attempt). */
function makeAttempt(st, teamId, ctx) {
  const order = shuffled(sessionQuestions(st).map((q) => q.id));
  const a = {
    id: uuid(), session_id: st.session.id, team_id: teamId, status: 'ready',
    question_order: order, option_orders: order.map(() => shuffled(OPTIONS).join('')),
    created_at: iso(ctx.now), started_at: null, deadline_at: null, paused_ms: 0, finished_at: null,
    finalized_by: null, finalize_reason: null, reset_at: null, reset_by: null, reset_reason: null,
  };
  st.attempts.push(a);
  return a;
}

/** Time out running attempts past their deadline; the final time is the deadline itself. */
function finalizeExpired(st, ctx) {
  const clock = setClock(st.session, ctx.now);
  let n = 0;
  for (const a of st.attempts) {
    if (a.session_id === st.session.id && a.status === 'in_progress' && Date.parse(a.deadline_at) <= clock) {
      Object.assign(a, { status: 'timed_out', finished_at: a.deadline_at });
      n++;
    }
  }
  return n;
}

function assertScoringOpen(st, ctx) {
  const s = st.session;
  if (s.status === 'setup') fail('QUIZ_NOT_STARTED');
  if (s.status === 'finalized') fail('RESULTS_FINALIZED');
  if (s.corrections_enabled) return;
  if (s.status === 'ended') fail('QUIZ_ENDED');
  if (isTimeExpired(s, st.settings, ctx.now)) fail('TIME_EXPIRED');
}

/** Bank edits never change a published set (it has a snapshot). Mirrors public._assert_not_in_published. */
function assertNotInPublished(st, questionId) {
  const hit = activeSets(st).filter((x) => x.session.published_at)
    .sort((a, b) => a.session.created_at.localeCompare(b.session.created_at))
    .find((x) => x.set_questions.some((q) => questionId === null || q.question_id === questionId));
  if (hit) fail('QUESTION_IN_PUBLISHED_SET', `Used by the published set "${hit.session.name}". Archive that set first.`);
}

function renumber(st) {
  st.questions.sort((a, b) => a.position - b.position);
  st.questions.forEach((q, i) => { q.position = i + 1; });
  const ids = new Set(st.questions.map((q) => q.id));
  for (const { session } of st.sets) {
    if (session.question_ids && !session.published_at) session.question_ids = session.question_ids.filter((id) => ids.has(id));
  }
}

function assertQuizReady(st, needTeams) {
  if (needTeams && st.teams.length === 0) fail('QUIZ_NOT_READY', `Add at least one ${st.section} team.`);
  const issues = quizReadinessIssues({ teams: [{}], questions: sessionQuestions(st) })
    .map((i) => i.replace('Add at least one question.', 'Select at least one question for this quiz.'));
  if (issues.length) fail('QUIZ_NOT_READY', issues.join(' '));
}

function issueJoinCode(st) {
  // Never reuse any code this browser has issued, so a stale code cannot reach a different set.
  const used = new Set([...st.retired_codes, ...st.sets.map((x) => x.session.join_code).filter(Boolean)]);
  for (let i = 0; i < 60; i++) {
    const c = randomJoinCode();
    if (!used.has(c)) {
      Object.assign(st.session, { join_code: c, join_code_active: true });
      return c;
    }
  }
  return fail('CODE_GENERATION_FAILED', 'Could not generate a unique join code. Try again.');
}

function retireJoinCode(st, session = st.session) {
  if (session.join_code && !st.retired_codes.includes(session.join_code)) st.retired_codes.push(session.join_code);
}

function revokeParticipantSessions(st, reason, ctx, teamId = null, sessionId = st.session.id) {
  let n = 0;
  for (const p of st.participant_sessions) {
    if (p.session_id === sessionId && !p.revoked_at && (!teamId || p.team_id === teamId)) {
      Object.assign(p, { revoked_at: iso(ctx.now), revoked_reason: reason });
      n++;
    }
  }
  return n;
}

const TEAM_FIELDS = ['section', 'team_number', 'team_name', 'participant_1', 'participant_2', 'college_name'];

/** Create/edit a team (mirrors public._upsert_team). The team may move to the other section. */
function upsertTeam(st, p, ctx, role) {
  const existing = p.id ? allTeams(st).find((x) => x.id === p.id) : null;
  if (p.id && !existing) fail('TEAM_NOT_FOUND');
  const { value, errors, ok } = validateTeam({ ...p, section: p.section || existing?.section || st.section }, allTeams(st), p.id || null);
  if (!ok) {
    if (errors.team_number?.includes('already in use')) fail('DUPLICATE_TEAM_NUMBER', errors.team_number);
    validationFail(errors);
  }
  if (existing && existing.section !== value.section
    && (st.answers.some((a) => a.team_id === existing.id) || st.participant_sessions.some((x) => x.team_id === existing.id && !x.revoked_at))) {
    fail('INVALID_STATE', 'A team that has joined or answered cannot change section.');
  }
  const isDemo = role === 'organizer' ? (p.is_demo ?? existing?.is_demo ?? false) : (existing?.is_demo ?? false);
  const fields = Object.fromEntries(TEAM_FIELDS.map((k) => [k, value[k]]));
  let team;
  let changes = {};
  if (existing) {
    for (const k of TEAM_FIELDS) if (existing[k] !== fields[k]) changes[k] = [existing[k] ?? null, fields[k]];
    Object.assign(existing, fields, { is_demo: isDemo, updated_at: iso(ctx.now) });
    team = existing;
  } else {
    team = { ...fields, is_demo: isDemo, self_registered: false, id: uuid(), created_at: iso(ctx.now), updated_at: iso(ctx.now) };
    st.teams.push(team);
    st.credentials[team.id] = randomPin();
    changes = {};
  }
  if (!existing || Object.keys(changes).length) {
    st.registration_events.push({
      id: st.registration_events.length + 1, team_id: team.id, section: team.section, team_number: team.team_number,
      action: existing ? 'update' : 'create', changes, actor: ctx.actor || `demo-${role}`, actor_role: role, created_at: iso(ctx.now),
    });
  }
  st.teams.sort((a, b) => a.team_number - b.team_number);
  return { id: team.id };
}

// ---- participant helpers (demo mirrors of the SQL participant functions)
const RATE_WINDOW_MS = 10 * 60 * 1000;
const rateLimited = (st, ctx) => st.join_failures.filter((t) => t > ctx.now - RATE_WINDOW_MS).length >= 30;
function logFailure(st, ctx) {
  st.join_failures = [...st.join_failures.filter((t) => t > ctx.now - RATE_WINDOW_MS), ctx.now];
}
/** The set a join code opens (mirrors public._quiz_by_code): published, active code, not completed or archived. */
function quizByCode(st, code) {
  const c = normalizeJoinCode(code);
  const s = st.session;
  if (!/^\d{6}$/.test(c)) return null;
  return s.join_code === c && s.join_code_active && s.is_current !== false && s.published_at && !['ended', 'finalized'].includes(s.status) ? s : null;
}
function participantSession(st, token, ctx) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  // Demo only: the token is kept as-is in this browser. Supabase stores only its SHA-256 hash.
  return st.participant_sessions.find((p) => p.token_hash === token && p.session_id === st.session.id
    && st.session.is_current !== false && !p.revoked_at && Date.parse(p.expires_at) > ctx.now) || null;
}
const teamPublic = (t) => ({ team_number: t.team_number, team_name: t.team_name, participant_1: t.participant_1, participant_2: t.participant_2 });
function openParticipantSession(st, team, device, ctx) {
  const token = randomToken();
  st.participant_sessions.push({
    id: uuid(), session_id: st.session.id, team_id: team.id, token_hash: token,
    device_label: device ? String(device).slice(0, 80) : null, created_at: iso(ctx.now), last_seen_at: iso(ctx.now),
    expires_at: iso(ctx.now + 12 * 3600 * 1000), revoked_at: null, revoked_reason: null,
  });
  return token;
}
const no = (error, extra = {}) => ({ ok: false, error, ...extra });
/** The team's signed-in, unexpired device session for a set, if any. */
const liveDevice = (st, sessionId, teamId, ctx) => st.participant_sessions.find((p) => p.session_id === sessionId && p.team_id === teamId
  && !p.revoked_at && Date.parse(p.expires_at) > ctx.now) || null;

/** Core scoring shared by organizer recording and participant submission (mirrors public._record). */
function applyAnswer(st, ctx, team, question, selected, p, source, extra = {}) {
  const { result, points } = evaluateAnswer(selected, question.correct_option, marksFor(question, st.settings));
  const existing = st.answers.find((a) => a.session_id === st.session.id && a.team_id === team.id && a.question_id === question.id);
  if (existing && !p.correction) fail('ALREADY_RECORDED');
  if (existing && !String(p.reason || '').trim()) fail('REASON_REQUIRED', 'A reason is required to correct a recorded answer.');
  if (existing && existing.selected_option === selected) fail('NO_CHANGE');
  const ev = pushEvent(st, ctx, {
    request_id: p.request_id,
    action: existing ? 'correction' : 'record',
    team_id: team.id, team_number: team.team_number,
    question_id: question.id, question_position: question.position,
    prev_selected: existing?.selected_option ?? null, prev_result: existing?.result ?? null, prev_points: existing?.points ?? null,
    new_selected: selected, new_result: result, new_points: points,
    reason: existing ? String(p.reason).trim() : null,
    source,
    actor: source === 'participant' ? null : ctx.actor || 'demo-organizer',
  });
  if (existing) Object.assign(existing, { selected_option: selected, result, points, source, updated_at: iso(ctx.now) });
  else {
    st.answers.push({
      id: uuid(), session_id: st.session.id, team_id: team.id, question_id: question.id,
      selected_option: selected, result, points, source,
      attempt_id: extra.attempt_id ?? null, displayed_option: extra.displayed_option ?? null, on_time: extra.on_time ?? null,
      created_at: iso(ctx.now), updated_at: iso(ctx.now),
    });
  }
  return { duplicate_request: false, event_id: ev.id, action: ev.action, result, points, selected };
}

/** Re-evaluate one set's recorded answers on a question after its key/marks change. */
function rescoreQuestion(st, ctx, question) {
  let changed = 0;
  const marks = marksFor(question, st.settings);
  for (const a of sessionAnswers(st).filter((x) => x.question_id === question.id)) {
    if (st.session.status === 'finalized') fail('RESULTS_FINALIZED');
    const { result, points } = evaluateAnswer(a.selected_option, question.correct_option, marks);
    if (result === a.result && points === round2(a.points)) continue;
    const team = allTeams(st).find((t) => t.id === a.team_id);
    pushEvent(st, ctx, {
      action: 'rescore', team_id: a.team_id, team_number: team?.team_number ?? null,
      question_id: question.id, question_position: question.position,
      prev_selected: a.selected_option, prev_result: a.result, prev_points: a.points,
      new_selected: a.selected_option, new_result: result, new_points: points,
      reason: 'Answer key or marks changed',
    });
    Object.assign(a, { result, points, updated_at: iso(ctx.now) });
    changed++;
  }
  return changed;
}

function questionRecord(value, extra) {
  return {
    question_text: value.question_text,
    option_a: value.option_a,
    option_b: value.option_b,
    option_c: value.option_c,
    option_d: value.option_d,
    correct_option: value.correct_option,
    explanation: value.explanation,
    image_url: value.image_url,
    category: value.category,
    marks_correct: value.marks_correct,
    marks_incorrect: value.marks_incorrect,
    is_sample: value.is_sample,
    ...extra,
  };
}

function validationFail(errors) {
  fail('VALIDATION', Object.values(errors).join(' '));
}

/** Drop a set's per-team rows in the order SQL's cascades would. */
function removeAnswers(st, pred) {
  st.answers = st.answers.filter((a) => !pred(a));
}

// ---------------------------------------------------------------- set actions (organizer)

const actions = {
  saveTeam(st, p, ctx) {
    return upsertTeam(st, p, ctx, 'organizer');
  },

  importTeams(st, { rows, replace = false, confirm = false }, ctx) {
    if (!Array.isArray(rows) || rows.length === 0) fail('VALIDATION', 'No team rows to import.');
    rows.forEach((r, i) => {
      const sec = String(r.section ?? '').trim().toUpperCase();
      if (sec && sec !== st.section) fail('VALIDATION', `Row ${r.__line ?? i + 1}: section ${sec} does not match the selected section ${st.section}.`);
    });
    const base = replace ? [] : st.teams;
    if (replace && sessionAnswers(st).length && !confirm) fail('TEAM_HAS_ANSWERS', 'Existing teams have recorded answers. Confirm to replace them.');
    const accepted = [];
    rows.forEach((r, i) => {
      const { value, errors, ok } = validateTeam({ ...r, section: st.section }, [...base, ...accepted], null);
      if (!ok) fail(errors.team_number?.includes('already') ? 'DUPLICATE_TEAM_NUMBER' : 'VALIDATION', `Row ${r.__line ?? i + 1}: ${Object.values(errors).join(' ')}`);
      accepted.push({ ...value, id: uuid(), created_at: iso(ctx.now), updated_at: iso(ctx.now) });
    });
    if (replace) {
      for (const t of st.teams) global.deleteTeam(st, { id: t.id, confirm: true }, ctx);
    }
    for (const t of accepted) {
      t.self_registered = false;
      st.credentials[t.id] = randomPin();
      st.registration_events.push({ id: st.registration_events.length + 1, team_id: t.id, section: t.section, team_number: t.team_number, action: 'create', changes: {}, actor: ctx.actor || 'demo-organizer', actor_role: 'organizer', created_at: iso(ctx.now) });
    }
    st.teams = [...st.teams, ...accepted].sort((a, b) => a.team_number - b.team_number);
    return { imported: accepted.length };
  },

  removeDemoData(st, { teams = true, questions = true, confirm = false }, ctx) {
    let removedTeams = 0;
    let removedQuestions = 0;
    if (questions && st.questions.some((q) => q.is_sample)) {
      const used = activeSets(st).find((x) => x.session.published_at && x.set_questions.some((sq) => st.questions.find((q) => q.id === sq.question_id)?.is_sample));
      if (used) fail('QUESTION_IN_PUBLISHED_SET', 'Sample questions are used by a published set. Archive it first.');
    }
    if (teams) {
      for (const t of st.teams.filter((x) => x.is_demo)) {
        global.deleteTeam(st, { id: t.id, confirm }, ctx);
        removedTeams++;
      }
    }
    if (questions) {
      for (const q of st.questions.filter((x) => x.is_sample)) {
        global.deleteQuestion(st, { id: q.id, confirm }, ctx);
        removedQuestions++;
      }
    }
    return { removedTeams, removedQuestions };
  },

  updateSettings(st, patch) {
    if (st.session.published_at || st.session.status !== 'setup') fail('SET_FROZEN', 'Timer and scoring are frozen once the set is published.');
    const d = patch.duration_seconds;
    if (d !== undefined && d !== null && !isValidDurationSeconds(Math.round(Number(d)))) fail('VALIDATION', DURATION_ERROR);
    const { value, errors, ok } = validateSettings({ ...st.settings, ...patch });
    if (!ok) validationFail(errors);
    st.settings = value;
    return { ok: true };
  },

  // "Go live": teams may now press Start. Requires a published (frozen) set.
  startQuiz(st, _p, ctx) {
    if (st.session.status !== 'setup') fail('INVALID_STATE', 'The set is already live or completed.');
    if (!st.session.published_at) fail('NOT_PUBLISHED', 'Publish the set before going live.');
    if (!st.teams.some((t) => isSelected(st.session, t.id))) fail('QUIZ_NO_TEAMS', 'Select and confirm the participating teams before starting the set.');
    Object.assign(st.session, {
      status: 'running', started_at: iso(ctx.now), timer_started_at: iso(ctx.now), elapsed_ms: 0,
      current_index: 0, projector_view: 'question', paused_at: null,
    });
    return { ok: true, server_now: iso(ctx.now) };
  },

  // Pause freezes every running team timer.
  pauseQuiz(st, _p, ctx) {
    if (st.session.status !== 'running') fail('INVALID_STATE', 'The set is not running.');
    finalizeExpired(st, ctx);
    const cap = st.settings.duration_seconds * 1000;
    Object.assign(st.session, { status: 'paused', paused_at: iso(ctx.now), elapsed_ms: Math.min(cap, Math.round(elapsedMs(st.session, ctx.now))), timer_started_at: null });
    return { ok: true };
  },

  // Resume: running attempts get their deadline moved by the paused time.
  resumeQuiz(st, _p, ctx) {
    if (st.session.status !== 'paused') fail('INVALID_STATE', 'The set is not paused.');
    finalizeExpired(st, ctx);
    const ms = Math.max(0, ctx.now - Date.parse(st.session.paused_at || iso(ctx.now)));
    for (const a of st.attempts) {
      if (a.session_id === st.session.id && a.status === 'in_progress') {
        Object.assign(a, { deadline_at: iso(Date.parse(a.deadline_at) + ms), paused_ms: Number(a.paused_ms || 0) + ms });
      }
    }
    Object.assign(st.session, { status: 'running', timer_started_at: iso(ctx.now), paused_at: null });
    return { ok: true, paused_ms: ms };
  },

  resetTimer(st, _p, ctx) {
    if (!['running', 'paused'].includes(st.session.status)) fail('INVALID_STATE', 'The timer can only be reset while the quiz is running or paused.');
    Object.assign(st.session, { elapsed_ms: 0, timer_started_at: st.session.status === 'running' ? iso(ctx.now) : null });
    return { ok: true };
  },

  goToQuestion(st, { index }) {
    const n = sessionQuestions(st).length;
    if (!Number.isInteger(index) || index < 0 || index >= n) fail('VALIDATION', 'Question index out of range.');
    st.session.current_index = index;
    return { ok: true };
  },

  setQuestionCompleted(st, { question_id, completed }) {
    if (!sessionQuestions(st).some((q) => q.id === question_id)) fail('QUESTION_NOT_FOUND');
    const set = new Set(st.session.completed_question_ids);
    if (completed) set.add(question_id); else set.delete(question_id);
    st.session.completed_question_ids = [...set];
    return { ok: true };
  },

  setProjectorView(st, { view }) {
    if (!PROJECTOR_VIEWS.includes(view)) fail('VALIDATION', 'Unknown projector view.');
    if (view === 'reveal' && !st.session.results_revealed) fail('NOT_FINALIZED', 'Reveal results (after confirming qualifiers) before showing the reveal screen.');
    st.session.projector_view = view;
    return { ok: true };
  },

  // End the set: expired attempts time out at their deadline; still-running ones are organizer-finalized now.
  endQuiz(st, _p, ctx) {
    if (!['running', 'paused'].includes(st.session.status)) fail('INVALID_STATE', 'The set is not live.');
    finalizeExpired(st, ctx);
    const clock = iso(setClock(st.session, ctx.now));
    let n = 0;
    for (const a of st.attempts) {
      if (a.session_id === st.session.id && a.status === 'in_progress') {
        Object.assign(a, { status: 'organizer_finalized', finished_at: clock, finalized_by: ctx.actor || 'demo-organizer', finalize_reason: 'Set ended by the organizer' });
        n++;
      }
    }
    const cap = st.settings.duration_seconds * 1000;
    Object.assign(st.session, {
      status: 'ended', elapsed_ms: Math.min(cap, Math.round(elapsedMs(st.session, ctx.now))), paused_at: null,
      timer_started_at: null, ended_at: iso(ctx.now), join_code_active: false, registration_open: false,
    });
    if (n > 0) pushEvent(st, ctx, { action: 'attempt_finalize', reason: `Set ended: ${n} running attempt(s) finalized by the organizer` });
    return { ok: true, finalized: n };
  },

  finalizeExpiredAttempts(st, _p, ctx) {
    return { ok: true, finalized: finalizeExpired(st, ctx) };
  },

  // Organizer: finish one team's running attempt now (audited).
  finalizeAttempt(st, { team_id, reason }, ctx) {
    if (!String(reason || '').trim()) fail('REASON_REQUIRED');
    finalizeExpired(st, ctx);
    const a = activeAttempt(st, st.session.id, team_id);
    if (!a || a.status !== 'in_progress') fail('INVALID_STATE', 'That team has no running attempt.');
    Object.assign(a, { status: 'organizer_finalized', finished_at: iso(setClock(st.session, ctx.now)), finalized_by: ctx.actor || 'demo-organizer', finalize_reason: String(reason).trim() });
    const t = allTeams(st).find((x) => x.id === team_id);
    pushEvent(st, ctx, { action: 'attempt_finalize', team_id, team_number: t?.team_number ?? null, reason: String(reason).trim() });
    return { ok: true };
  },

  // Organizer-authorized retake: the attempt is kept as 'reset', its answers are removed (audited).
  resetAttempt(st, { team_id, reason }, ctx) {
    if (!String(reason || '').trim()) fail('REASON_REQUIRED');
    if (st.session.status === 'finalized') fail('RESULTS_FINALIZED');
    const t = allTeams(st).find((x) => x.id === team_id);
    if (!t) fail('TEAM_NOT_FOUND');
    const a = activeAttempt(st, st.session.id, team_id);
    if (!a) fail('INVALID_STATE', 'That team has no attempt in this set.');
    const own = sessionAnswers(st).filter((x) => x.team_id === team_id);
    Object.assign(a, { status: 'reset', reset_at: iso(ctx.now), reset_by: ctx.actor || 'demo-organizer', reset_reason: String(reason).trim() });
    removeAnswers(st, (x) => x.session_id === st.session.id && x.team_id === team_id);
    st.tiebreaks = st.tiebreaks.filter((x) => !(x.session_id === st.session.id && x.team_id === team_id));
    pushEvent(st, ctx, {
      action: 'attempt_reset', team_id, team_number: t.team_number, prev_points: round2(own.reduce((s, x) => s + Number(x.points), 0)),
      reason: `Attempt reset (${own.length} answer(s) removed): ${String(reason).trim()}`,
    });
    return { ok: true, removed_answers: own.length };
  },

  // Explicit, audited change to a PUBLISHED set's key or marks; re-scores that set only.
  correctSetQuestion(st, { question_id, correct_option, marks_correct, marks_incorrect, reason }, ctx) {
    if (!String(reason || '').trim()) fail('REASON_REQUIRED');
    if (!st.session.published_at) fail('INVALID_STATE', 'Edit draft questions in the question bank.');
    if (st.session.status === 'finalized') fail('RESULTS_FINALIZED');
    const old = st.set_questions.find((q) => q.question_id === question_id);
    if (!old) fail('QUESTION_NOT_IN_QUIZ');
    const pick = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const key = String(correct_option ?? old.correct_option).trim().toUpperCase();
    const mc = pick(marks_correct, old.marks_correct);
    const mi = pick(marks_incorrect, old.marks_incorrect);
    if (!OPTIONS.includes(key) || !(mc >= 0 && mc <= 100) || !(mi <= 0 && mi >= -100)) fail('VALIDATION', 'Key must be A–D; correct marks 0–100; incorrect marks −100–0.');
    if (key === old.correct_option && mc === Number(old.marks_correct) && mi === Number(old.marks_incorrect)) fail('NO_CHANGE');
    pushEvent(st, ctx, {
      action: 'key_change', question_id, question_position: old.position,
      reason: `Q${old.position} key ${old.correct_option}→${key}, marks ${old.marks_correct}/${old.marks_incorrect}→${mc}/${mi}: ${String(reason).trim()}`,
    });
    Object.assign(old, { correct_option: key, marks_correct: mc, marks_incorrect: mi });
    const q = sessionQuestions(st).find((x) => x.id === question_id);
    return { ok: true, rescored: rescoreQuestion(st, ctx, q) };
  },

  setCorrections(st, { enabled, reason }, ctx) {
    if (st.session.status === 'setup' || st.session.status === 'finalized') fail('INVALID_STATE', 'Corrections can be authorized only after the quiz starts and before results are finalized.');
    if (enabled && !String(reason || '').trim()) fail('REASON_REQUIRED');
    st.session.corrections_enabled = !!enabled;
    pushEvent(st, ctx, { action: 'authorize', reason: enabled ? `Enabled: ${String(reason).trim()}` : 'Disabled' });
    return { ok: true };
  },

  recordAnswer(st, p, ctx) {
    if (!p.request_id) fail('VALIDATION', 'request_id is required.');
    const dup = st.events.find((e) => e.request_id === p.request_id);
    if (dup) {
      return { duplicate_request: true, event_id: dup.id, result: dup.new_result, points: dup.new_points, selected: dup.new_selected };
    }
    assertScoringOpen(st, ctx);
    const team = st.teams.find((t) => t.id === p.team_id);
    if (!team) fail('TEAM_NOT_FOUND', "That team is not in this set's section.");
    if (!isSelected(st.session, team.id)) fail('TEAM_NOT_SELECTED', `Team ${team.team_number} is not a participant of this set. Add it to the set's participants first.`);
    const other = teamOtherSet(st, st.session, team.id);
    if (other) fail('TEAM_IN_OTHER_SET', `Team ${team.team_number} takes part in "${other}".`);
    const question = sessionQuestions(st).find((q) => q.id === p.question_id);
    if (!question) fail(st.questions.some((q) => q.id === p.question_id) ? 'QUESTION_NOT_IN_QUIZ' : 'QUESTION_NOT_FOUND');
    const a = activeAttempt(st, st.session.id, team.id);
    const onTime = st.session.status === 'running' && elapsedMs(st.session, ctx.now) < st.settings.duration_seconds * 1000;
    return applyAnswer(st, ctx, team, question, normalizeOption(p.selected), p, 'organizer', { attempt_id: a?.id ?? null, on_time: onTime });
  },

  undoLast(st, { request_id }, ctx) {
    if (!request_id) fail('VALIDATION', 'request_id is required.');
    const dup = st.events.find((e) => e.request_id === request_id);
    if (dup) return { duplicate_request: true, event_id: dup.id, undo_of: dup.undo_of };
    assertScoringOpen(st, ctx);
    const target = [...st.events].reverse().find((e) => e.session_id === st.session.id && ['record', 'correction'].includes(e.action) && !e.undone);
    if (!target) fail('NOTHING_TO_UNDO');
    const ans = st.answers.find((a) => a.session_id === st.session.id && a.team_id === target.team_id && a.question_id === target.question_id);
    if (!ans || ans.selected_option !== target.new_selected) fail('UNDO_CONFLICT');
    const question = sessionQuestions(st).find((q) => q.id === target.question_id);
    let restored = null;
    if (target.action === 'record') {
      st.answers = st.answers.filter((a) => a !== ans);
    } else {
      restored = evaluateAnswer(target.prev_selected, question.correct_option, marksFor(question, st.settings));
      Object.assign(ans, { selected_option: target.prev_selected, ...restored, updated_at: iso(ctx.now) });
    }
    target.undone = true;
    const ev = pushEvent(st, ctx, {
      request_id, action: 'undo', undo_of: target.id,
      team_id: target.team_id, team_number: target.team_number,
      question_id: target.question_id, question_position: question?.position ?? target.question_position,
      prev_selected: target.new_selected,
      prev_result: target.new_result, prev_points: target.new_points,
      new_selected: restored ? target.prev_selected : null,
      new_result: restored ? restored.result : null,
      new_points: restored ? restored.points : null,
      reason: `Undo of #${target.id}`,
    });
    return { duplicate_request: false, event_id: ev.id, undo_of: target.id };
  },

  setTiebreak(st, { team_id, score, note }, ctx) {
    if (st.session.status === 'finalized') fail('RESULTS_FINALIZED');
    if (st.session.status !== 'ended') fail('INVALID_STATE', 'Tie-break results can be entered after the set ends.');
    const team = st.teams.find((t) => t.id === team_id);
    if (!team || teamOtherSet(st, st.session, team_id)) fail('TEAM_NOT_FOUND');
    st.tiebreaks = st.tiebreaks.filter((t) => !(t.session_id === st.session.id && t.team_id === team_id));
    if (score !== null && score !== undefined && score !== '') {
      const v = Number(score);
      if (!Number.isFinite(v) || Math.abs(v) > 100000) fail('VALIDATION', 'Tie-break result must be a number.');
      st.tiebreaks.push({ session_id: st.session.id, team_id, score: round2(v), note: String(note || '').trim() || null, recorded_at: iso(ctx.now) });
    }
    pushEvent(st, ctx, {
      action: 'tiebreak', team_id, team_number: team.team_number,
      reason: score === null || score === undefined || score === '' ? 'Cleared tie-break result' : `Tie-break result ${round2(Number(score))}${note ? ` — ${String(note).trim()}` : ''}`,
    });
    return { ok: true };
  },

  confirmQualifiers(st, { team_ids, override_reason }, ctx) {
    if (st.session.status !== 'ended') fail(st.session.status === 'finalized' ? 'RESULTS_FINALIZED' : 'QUIZ_NOT_ENDED');
    const standings = setResults(st, st.session.id, ctx.now);
    const v = validateQualifierSelection(standings, st.settings.qualify_count, team_ids || [], override_reason);
    Object.assign(st.session, {
      status: 'finalized', corrections_enabled: false, qualifiers: [...team_ids],
      qualifiers_confirmed_at: iso(ctx.now), qualification_note: v.override ? String(override_reason).trim() : null,
    });
    const nums = team_ids.map((id) => st.teams.find((t) => t.id === id)?.team_number).join(', ');
    pushEvent(st, ctx, { action: 'qualify', reason: `Qualifiers: teams ${nums}${v.override ? ` (tie override: ${String(override_reason).trim()})` : ''}` });
    return { ok: true, override: v.override };
  },

  reopenResults(st, { reason }, ctx) {
    if (st.session.status !== 'finalized') fail('INVALID_STATE', 'Results are not finalized.');
    if (!String(reason || '').trim()) fail('REASON_REQUIRED');
    Object.assign(st.session, {
      status: 'ended', qualifiers: null, qualifiers_confirmed_at: null, qualification_note: null,
      results_revealed: false, projector_view: st.session.projector_view === 'reveal' ? 'standby' : st.session.projector_view,
    });
    pushEvent(st, ctx, { action: 'reopen', reason: String(reason).trim() });
    return { ok: true };
  },

  revealResults(st, { reveal }) {
    if (st.session.status !== 'finalized') fail('NOT_FINALIZED');
    st.session.results_revealed = !!reveal;
    st.session.projector_view = reveal ? 'reveal' : 'standby';
    return { ok: true };
  },

  // A new draft copy of the selected set; the old one is archived.
  newSession(st, _p, ctx) {
    if (['running', 'paused'].includes(st.session.status)) fail('QUIZ_IN_PROGRESS', 'End the set first.');
    const { id } = global.duplicateSet(st, { id: st.session.id }, ctx);
    findSet(st, id).session.name = st.session.name;
    archive(st, st.session, 'Replaced by a new draft', ctx);
    return { id };
  },

  // ------------------------------------------------ set details & publishing (organizer)
  // Name and description always; section, questions and self-registration only while a draft.
  updateQuizDetails(st, p) {
    const s = st.session;
    const name = p.name === undefined ? s.name : String(p.name).replace(/\s+/g, ' ').trim() || s.name;
    if (name.length > 80) fail('VALIDATION', 'Quiz set name must be 80 characters or fewer.');
    const description = p.description === undefined ? s.description : String(p.description ?? '').replace(/\s+/g, ' ').trim() || null;
    if (description && description.length > 500) fail('VALIDATION', 'Description must be 500 characters or fewer.');
    const section = String(p.section ?? s.section).toUpperCase();
    if (!SECTIONS.includes(section)) fail('VALIDATION', 'Section must be UG or PG.');
    if ((section !== s.section || 'question_ids' in p) && s.published_at) fail('SET_FROZEN', "A published set's section and questions are frozen.");
    let ids = s.question_ids;
    if ('question_ids' in p) {
      if (p.question_ids === null) ids = null;
      else {
        if (!Array.isArray(p.question_ids)) fail('VALIDATION', 'question_ids must be an array or null.');
        if (new Set(p.question_ids).size !== p.question_ids.length) fail('VALIDATION', 'A question can be selected only once.');
        ids = [...p.question_ids];
        if (!ids.length) fail('VALIDATION', 'Select at least one question.');
        const known = new Set(st.questions.map((q) => q.id));
        if (!ids.every((id) => known.has(id))) fail('VALIDATION', 'A selected question no longer exists.');
      }
    }
    if (section !== s.section) {
      // st.teams is the old section's view; leave() rebuilds the full team list.
      s.section = section;
      st.section = section;
    }
    Object.assign(s, { name, description, question_ids: ids, self_registration: p.self_registration ?? s.self_registration, self_paced: true });
    return { ok: true };
  },

  // Validate, freeze (snapshot) and open for joining.
  publishQuiz(st, _p, ctx) {
    const s = st.session;
    if (s.is_current === false) fail('INVALID_STATE', 'An archived set cannot be published.');
    if (['ended', 'finalized'].includes(s.status)) fail('INVALID_STATE', 'A completed set cannot be published again. Duplicate it instead.');
    if (s.join_code_active) return { ok: true, join_code: s.join_code };
    if (s.published_at) fail('INVALID_STATE', "This set's code was revoked. Use \"New code\" to issue a fresh one.");
    const qs = sessionQuestions(st);
    if (qs.length === 0) fail('QUESTION_COUNT', 'Add at least one question before publishing.');
    assertQuizReady(st, false);
    if (!isValidDurationSeconds(st.settings.duration_seconds)) fail('VALIDATION', DURATION_ERROR);
    if (qs.some((q) => (q.marks_correct ?? st.settings.marks_correct) < 0 || (q.marks_incorrect ?? st.settings.marks_incorrect) > 0)) {
      fail('VALIDATION', 'Every question needs valid marks (correct ≥ 0, incorrect ≤ 0).');
    }
    st.set.set_questions = snapshotOf(qs, st.settings);
    st.set_questions = st.set.set_questions;
    Object.assign(s, { published_at: iso(ctx.now), published_by: ctx.actor || 'demo-organizer', self_paced: true, question_ids: qs.map((q) => q.id) });
    const code = issueJoinCode(st);
    s.registration_open = true;
    return { ok: true, join_code: code };
  },

  // Back to draft: only before going live and before any team has joined.
  unpublishQuiz(st, _p, ctx) {
    if (st.session.status !== 'setup') fail('INVALID_STATE', 'A started set cannot be returned to draft.');
    if (st.attempts.some((a) => a.session_id === st.session.id)) fail('INVALID_STATE', 'Teams have already joined this set. Revoke its code or archive it instead.');
    retireJoinCode(st);
    Object.assign(st.session, { join_code_active: false, registration_open: false, published_at: null, published_by: null });
    st.set.set_questions = [];
    st.set_questions = [];
    revokeParticipantSessions(st, 'Quiz returned to draft', ctx);
    return { ok: true };
  },

  // Stop the code working (never reused). Joined teams keep their access.
  revokeJoinCode(st) {
    if (!st.session.join_code_active) fail('INVALID_STATE', 'This set has no active code.');
    retireJoinCode(st);
    Object.assign(st.session, { join_code_active: false, registration_open: false });
    return { ok: true };
  },

  regenerateJoinCode(st) {
    const s = st.session;
    if (!s.published_at || ['ended', 'finalized'].includes(s.status)) fail('INVALID_STATE', 'Only a published quiz that has not ended has a join code.');
    retireJoinCode(st);
    const open = s.registration_open;
    const code = issueJoinCode(st);
    s.registration_open = open;
    return { ok: true, join_code: code };
  },

  setRegistration(st, { open }) {
    if (!st.session.join_code_active) fail('INVALID_STATE', 'Publish the quiz (or regenerate its code) first.');
    st.session.registration_open = !!open;
    return { ok: true };
  },

  revokeParticipant(st, { team_id }, ctx) {
    return { ok: true, revoked: revokeParticipantSessions(st, 'Disconnected by organizer', ctx, team_id) };
  },

  rotateTeamPin(st, { team_id }) {
    if (!allTeams(st).some((t) => t.id === team_id)) fail('TEAM_NOT_FOUND');
    st.credentials[team_id] = randomPin();
    return { ok: true };
  },

  // ------------------------------------------------ participants (no organizer login)
  // Set = the code's / token's set. Expected failures RETURN { ok: false, error } like SQL.
  joinLookup(st, { code }, ctx) {
    if (rateLimited(st, ctx)) return no('RATE_LIMITED');
    const s = quizByCode(st, code);
    if (!s) { logFailure(st, ctx); return no('INVALID_CODE'); }
    return {
      ok: true,
      quiz: {
        title: s.name, description: s.description, status: s.status, section: s.section,
        duration_seconds: st.settings.duration_seconds, total_questions: sessionQuestions(st).length,
        registration_open: s.registration_open, self_registration: s.self_registration && s.registration_open,
      },
    };
  },

  // Registered teams of the code's section (mirrors public.join_roster). Never ids, colleges or PINs.
  joinRoster(st, { code, section }, ctx) {
    if (rateLimited(st, ctx)) return no('RATE_LIMITED');
    const s = quizByCode(st, code);
    if (!s) { logFailure(st, ctx); return no('INVALID_CODE'); }
    const sec = String(section ?? '').trim().toUpperCase();
    if (!SECTIONS.includes(sec)) return no('VALIDATION', { message: 'Choose UG or PG.' });
    if (sec !== s.section) return no('SECTION_MISMATCH', { section: s.section });
    const teams = st.teams
      .filter((t) => isSelected(s, t.id) && !teamOtherSet(st, s, t.id) && (s.registration_open || activeAttempt(st, s.id, t.id)))
      .map((t) => ({ ...teamPublic(t), joined: !!liveDevice(st, s.id, t.id, ctx) }));
    return { ok: true, section: s.section, teams };
  },

  // Join as a registered team without a PIN (mirrors public.join_registered_team).
  // The team stays bound to its first device until an organizer releases it.
  joinRegisteredTeam(st, { code, section, team_number, device_label }, ctx) {
    if (rateLimited(st, ctx)) return no('RATE_LIMITED');
    const s = quizByCode(st, code);
    if (!s) { logFailure(st, ctx); return no('INVALID_CODE'); }
    const sec = String(section ?? '').trim().toUpperCase();
    if (!SECTIONS.includes(sec)) return no('VALIDATION', { message: 'Choose UG or PG.' });
    if (sec !== s.section) return no('SECTION_MISMATCH', { section: s.section });
    const team = st.teams.find((t) => t.team_number === Number(team_number));
    if (!team) { logFailure(st, ctx); return no('TEAM_NOT_REGISTERED'); }
    if (!isSelected(s, team.id)) return no('TEAM_NOT_SELECTED');
    if (teamOtherSet(st, s, team.id)) return no('TEAM_IN_OTHER_SET');
    if (!s.registration_open && !activeAttempt(st, s.id, team.id)) return no('REGISTRATION_CLOSED');
    if (liveDevice(st, s.id, team.id, ctx)) return no('TEAM_ALREADY_JOINED');
    if (!activeAttempt(st, s.id, team.id)) makeAttempt(st, team.id, ctx);
    return { ok: true, token: openParticipantSession(st, team, device_label, ctx), team: teamPublic(team), quiz_title: s.name, section: s.section };
  },

  joinTeam(st, { code, team_number, pin, device_label }, ctx) {
    if (rateLimited(st, ctx)) return no('RATE_LIMITED');
    const s = quizByCode(st, code);
    if (!s) { logFailure(st, ctx); return no('INVALID_CODE'); }
    // st.teams holds only this set's section, so a team number from the other section never matches.
    const team = st.teams.find((t) => t.team_number === Number(team_number));
    if (!team || st.credentials[team.id] !== String(pin ?? '').trim().toUpperCase()) { logFailure(st, ctx); return no('INVALID_TEAM_OR_PIN'); }
    if (!isSelected(s, team.id)) return no('TEAM_NOT_SELECTED');
    if (teamOtherSet(st, s, team.id)) return no('TEAM_IN_OTHER_SET');
    if (!s.registration_open && !activeAttempt(st, s.id, team.id)) return no('REGISTRATION_CLOSED');
    const active = st.participant_sessions.find((p) => p.session_id === s.id && p.team_id === team.id && !p.revoked_at);
    if (active) {
      if (Date.parse(active.last_seen_at) > ctx.now - 45000 && Date.parse(active.expires_at) > ctx.now) return no('TEAM_ALREADY_CONNECTED');
      Object.assign(active, { revoked_at: iso(ctx.now), revoked_reason: 'Replaced by a new device sign-in' });
    }
    // Create the team's attempt once; a reconnecting team resumes the same attempt.
    if (!activeAttempt(st, s.id, team.id)) makeAttempt(st, team.id, ctx);
    return { ok: true, token: openParticipantSession(st, team, device_label, ctx), team: teamPublic(team), quiz_title: s.name, section: s.section };
  },

  registerTeam(st, { code, team_name, participant_1, participant_2, college_name }, ctx) {
    if (rateLimited(st, ctx)) return no('RATE_LIMITED');
    const s = quizByCode(st, code);
    if (!s) { logFailure(st, ctx); return no('INVALID_CODE'); }
    if (!(s.registration_open && s.self_registration)) return no('SELF_REGISTRATION_CLOSED');
    const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    const [name, p1, p2, college] = [clean(team_name), clean(participant_1), clean(participant_2), clean(college_name)];
    if (!name || !p1 || !p2 || !college || name.length > 80 || p1.length > 80 || p2.length > 80 || college.length > 120) {
      return no('VALIDATION', { message: 'Team name, both participant names and the college name are required.' });
    }
    if (st.teams.some((t) => t.team_name.toLowerCase() === name.toLowerCase())) { logFailure(st, ctx); return no('TEAM_NAME_TAKEN'); }
    const used = new Set(st.teams.map((t) => t.team_number));
    let num = 1;
    while (used.has(num)) num++;
    const team = { section: s.section, team_number: num, team_name: name, participant_1: p1, participant_2: p2, college_name: college, is_demo: false, self_registered: true, id: uuid(), created_at: iso(ctx.now), updated_at: iso(ctx.now) };
    st.teams.push(team);
    st.teams.sort((a, b) => a.team_number - b.team_number);
    st.credentials[team.id] = randomPin();
    st.registration_events.push({ id: st.registration_events.length + 1, team_id: team.id, section: s.section, team_number: num, action: 'create', changes: {}, actor: null, actor_role: 'registration', created_at: iso(ctx.now) });
    // Registered, but it joins only after the organiser adds it to the set's participants (mirrors register_team).
    return no('TEAM_NOT_SELECTED', { registered: true, team_number: num, section: s.section });
  },

  // The team's attempt: status, server times, and (while running) one question in
  // the team's own order with options in the team's own order. Never keys or points.
  participantState(st, { token, position = null }, ctx) {
    const ps = participantSession(st, token, ctx);
    if (!ps) {
      const revoked = typeof token === 'string' && st.participant_sessions.find((p) => p.token_hash === token && p.revoked_at);
      return revoked ? no('SESSION_REVOKED', { message: revoked.revoked_reason }) : no('SESSION_INVALID');
    }
    if (Date.parse(ps.last_seen_at) < ctx.now - 10000) ps.last_seen_at = iso(ctx.now);
    const s = st.session;
    const team = st.teams.find((t) => t.id === ps.team_id);
    finalizeExpired(st, ctx);
    let a = activeAttempt(st, s.id, team.id);
    // After an organizer reset the team gets a fresh attempt (new order) on its next check-in.
    if (!a && ['setup', 'running', 'paused'].includes(s.status)) a = makeAttempt(st, team.id, ctx);
    const qs = sessionQuestions(st);
    const clock = setClock(s, ctx.now);
    const res = {
      ok: true, server_now: iso(ctx.now), team: teamPublic(team),
      quiz: {
        title: s.name, description: s.description, status: s.status, section: s.section, self_paced: true,
        registration_open: s.registration_open, total_questions: qs.length, duration_seconds: st.settings.duration_seconds,
        results_revealed: s.results_revealed,
        marks: { correct: st.settings.marks_correct, incorrect: st.settings.marks_incorrect, unanswered: st.settings.marks_unanswered },
      },
      attempt: {
        status: a?.status ?? 'none', started_at: a?.started_at ?? null, deadline_at: a?.deadline_at ?? null,
        finished_at: a?.finished_at ?? null, paused: s.status === 'paused',
        remaining_ms: a?.status === 'in_progress' ? Math.max(0, Math.floor(Date.parse(a.deadline_at) - clock)) : null,
      },
      // legacy timer shape used by older clients
      timer: { status: s.status, elapsed_ms: s.elapsed_ms, timer_started_at: s.timer_started_at, duration_seconds: st.settings.duration_seconds },
    };
    if (a?.status === 'in_progress' && s.status === 'running' && qs.length) {
      const byId = new Map(qs.map((q) => [q.id, q]));
      const mineFor = (qid) => sessionAnswers(st).find((x) => x.team_id === team.id && x.question_id === qid);
      const progress = a.question_order.map((qid) => !!mineFor(qid));
      let pos = Number.isInteger(position) && position >= 0 && position < a.question_order.length ? position : null;
      if (pos === null) { pos = progress.indexOf(false); if (pos < 0) pos = 0; }
      const perm = a.option_orders[pos];
      const q = byId.get(a.question_order[pos]);
      const opt = (k) => q[`option_${perm[k].toLowerCase()}`];
      const ans = mineFor(q.id);
      const shown = ans?.selected_option ? (ans.displayed_option || OPTIONS[perm.indexOf(ans.selected_option)]) : null;
      Object.assign(res, {
        question: { id: q.id, number: pos + 1, question_text: q.question_text, option_a: opt(0), option_b: opt(1), option_c: opt(2), option_d: opt(3), image_url: q.image_url || null },
        position: pos, progress, question_closed: false,
        my_answer: ans ? { selected: shown, submitted_at: ans.created_at, source: ans.source } : null,
      });
    }
    if (s.status === 'finalized' && s.results_revealed) {
      const r = setResults(st, s.id, ctx.now).find((x) => x.team_id === team.id);
      if (r) res.result = { rank: r.rank, points: r.points, qualified: s.qualifiers.includes(team.id) };
    }
    return res;
  },

  // The team presses Start: the server records the start and the deadline (idempotent).
  participantStart(st, { token }, ctx) {
    const ps = participantSession(st, token, ctx);
    if (!ps) return no('SESSION_INVALID');
    if (st.session.status !== 'running') return no('NOT_STARTED_YET');
    const a = activeAttempt(st, st.session.id, ps.team_id) || makeAttempt(st, ps.team_id, ctx);
    if (a.status === 'ready') {
      Object.assign(a, { status: 'in_progress', started_at: iso(ctx.now), deadline_at: iso(ctx.now + st.settings.duration_seconds * 1000) });
    }
    return { ok: true, status: a.status, started_at: a.started_at, deadline_at: a.deadline_at, server_now: iso(ctx.now) };
  },

  // p_option is the letter the team SAW; it is mapped back to the original option for scoring.
  // A team may change its own answer until it submits or its deadline passes (each change is a 'correction' event).
  participantSubmit(st, { token, request_id, question_id, option }, ctx) {
    const ps = participantSession(st, token, ctx);
    if (!ps) return no('SESSION_INVALID');
    if (!request_id || !question_id) return no('VALIDATION');
    // Idempotent retry: the original outcome, only for the team that made it.
    const dup = st.events.find((e) => e.request_id === request_id);
    if (dup) {
      if (dup.team_id !== ps.team_id || dup.source !== 'participant') return no('VALIDATION');
      const ex = sessionAnswers(st).find((x) => x.team_id === ps.team_id && x.question_id === dup.question_id);
      return { ok: true, duplicate_request: true, selected: ex?.displayed_option ?? dup.new_selected, question_id: dup.question_id };
    }
    const s = st.session;
    finalizeExpired(st, ctx);
    const a = activeAttempt(st, s.id, ps.team_id);
    if (!a || a.status === 'ready') return no('NOT_STARTED_YET');
    if (a.status === 'timed_out') return no('TIME_EXPIRED');
    if (a.status !== 'in_progress') return no('ATTEMPT_FINISHED');
    if (s.status !== 'running') return no('NOT_ACCEPTING');
    if (ctx.now >= Date.parse(a.deadline_at)) return no('TIME_EXPIRED');
    const i = a.question_order.indexOf(question_id);
    if (i < 0) return no('QUESTION_NOT_IN_QUIZ');
    const shown = String(option ?? '').trim().toUpperCase();
    if (!OPTIONS.includes(shown)) return no('INVALID_OPTION');
    const orig = a.option_orders[i][OPTIONS.indexOf(shown)];
    const ex = sessionAnswers(st).find((x) => x.team_id === ps.team_id && x.question_id === question_id);
    if (ex && ex.source !== 'participant') return no('ALREADY_SUBMITTED', { selected: ex.displayed_option || OPTIONS[a.option_orders[i].indexOf(ex.selected_option)] });
    if (ex && ex.selected_option === orig) return { ok: true, duplicate_request: false, selected: shown, question_id, submitted_at: ex.updated_at };
    const team = st.teams.find((t) => t.id === ps.team_id);
    const target = sessionQuestions(st).find((q) => q.id === question_id);
    applyAnswer(st, ctx, team, target, orig, ex ? { request_id, correction: true, reason: 'Changed by the team before submitting' } : { request_id, correction: false },
      'participant', { attempt_id: a.id, displayed_option: shown, on_time: true });
    if (ex) Object.assign(ex, { displayed_option: shown, on_time: true });
    // Deliberately no result/points: correctness is never revealed here.
    return { ok: true, duplicate_request: false, selected: shown, question_id, submitted_at: iso(ctx.now) };
  },

  // The team submits the whole quiz early: the server records the final time (idempotent).
  participantFinish(st, { token }, ctx) {
    const ps = participantSession(st, token, ctx);
    if (!ps) return no('SESSION_INVALID');
    finalizeExpired(st, ctx);
    const a = activeAttempt(st, st.session.id, ps.team_id);
    if (!a || a.status === 'ready') return no('NOT_STARTED_YET');
    if (a.status === 'in_progress') {
      if (st.session.status !== 'running') return no('NOT_ACCEPTING');
      Object.assign(a, { status: 'submitted', finished_at: iso(ctx.now) });
    }
    return { ok: true, status: a.status, finished_at: a.finished_at };
  },

  participantLeave(st, { token }, ctx) {
    const ps = participantSession(st, token, ctx);
    if (ps) Object.assign(ps, { revoked_at: iso(ctx.now), revoked_reason: 'Signed out on the device' });
    return { ok: true };
  },
};

/** Archive a set (mirrors public.archive_set's effects). `st` may be a view or the root state. */
function archive(st, session, reason, ctx) {
  retireJoinCode(st, session);
  Object.assign(session, { is_current: false, archived_at: iso(ctx.now), join_code_active: false, registration_open: false });
  revokeParticipantSessions(st, 'Quiz set archived', ctx, null, session.id);
  st.events.push({
    id: st.next_event_id++, session_id: session.id, request_id: null, team_id: null, team_number: null, question_id: null,
    question_position: null, prev_selected: null, prev_result: null, prev_points: null, new_selected: null, new_result: null,
    new_points: null, undone: false, undo_of: null, action: 'authorize', reason: `Set archived${reason ? `: ${reason}` : ''}`,
    actor: ctx.actor || 'demo-organizer', source: 'organizer', created_at: iso(ctx.now),
  });
}

// ---------------------------------------------------------------- set views

function enter(st, set) {
  const all = st.teams;
  st.set = set;
  st.section = set.session.section;
  st.session = set.session;
  st.settings = set.settings;
  st.set_questions = set.set_questions;
  st._otherTeams = all.filter((t) => t.section !== st.section);
  st.teams = all.filter((t) => t.section === st.section);
}

function leave(st) {
  st.set.session = st.session;
  st.set.settings = st.settings;
  st.teams = [...st._otherTeams, ...st.teams].sort((a, b) => a.section.localeCompare(b.section) || a.team_number - b.team_number);
  for (const k of ['set', 'section', 'session', 'settings', 'set_questions', '_otherTeams']) delete st[k];
}

/** Run fn on a set view of st (mutates st). */
function inSet(st, set, fn) {
  enter(st, set);
  try {
    return fn();
  } finally {
    leave(st);
  }
}

const BY_CODE = new Set(['joinLookup', 'joinRoster', 'joinRegisteredTeam', 'joinTeam', 'registerTeam']);
const BY_TOKEN = new Set(['participantState', 'participantStart', 'participantSubmit', 'participantFinish', 'participantLeave']);

function setFor(st, name, payload, ctx) {
  if (BY_CODE.has(name)) {
    const c = normalizeJoinCode(payload.code);
    // Only an active code identifies a set; anything else falls through to an INVALID_CODE answer.
    return activeSets(st).find((x) => x.session.join_code === c && x.session.join_code_active) || activeSets(st)[0];
  }
  if (BY_TOKEN.has(name)) {
    const p = typeof payload.token === 'string' && st.participant_sessions.find((x) => x.token_hash === payload.token);
    return (p && findSet(st, p.session_id)) || activeSets(st)[0];
  }
  if (ctx.setId) {
    const set = findSet(st, ctx.setId);
    if (!set) fail('NO_SESSION', 'That quiz set does not exist.');
    return set;
  }
  const sec = ctx.section ?? 'UG';
  if (!SECTIONS.includes(sec)) fail('VALIDATION', 'Unknown quiz section.');
  return sectionSet(st, sec, ctx.now);
}

// ---------------------------------------------------------------- whole-state actions

const global = {
  createSet(st, p, ctx) {
    const section = String(p.section ?? '').trim().toUpperCase();
    if (!SECTIONS.includes(section)) fail('VALIDATION', 'Choose the section (UG or PG).');
    const name = String(p.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80) fail('VALIDATION', 'Quiz set name is required (max 80 characters).');
    const set = newSet(ctx.now, section, name);
    set.session.description = String(p.description ?? '').replace(/\s+/g, ' ').trim() || null;
    st.sets.push(set);
    return { id: set.session.id };
  },

  // Copy a set's name, questions and settings into a new draft (any stage).
  duplicateSet(st, { id }, ctx) {
    const src = findSet(st, id);
    if (!src) fail('NO_SESSION', 'That quiz set does not exist.');
    const known = new Set(st.questions.map((q) => q.id));
    const ids = sessionQuestions({ session: src.session, questions: st.questions, set_questions: src.set_questions }).map((q) => q.id).filter((x) => known.has(x));
    const set = newSet(ctx.now, src.session.section, `${src.session.name} (copy)`.slice(0, 80));
    Object.assign(set.session, { description: src.session.description, self_registration: src.session.self_registration, question_ids: ids });
    set.settings = { ...src.settings };
    st.sets.push(set);
    return { id: set.session.id };
  },

  // Drafts only (never published, so no attempts, answers or codes).
  deleteSet(st, { id }) {
    const set = findSet(st, id);
    if (!set) fail('NO_SESSION', 'That quiz set does not exist.');
    if (setStage(set.session) !== 'draft' || set.session.join_code || st.events.some((e) => e.session_id === id)) {
      fail('INVALID_STATE', 'Only an unpublished draft can be deleted. Archive other sets instead.');
    }
    st.sets = st.sets.filter((x) => x !== set);
    st.attempts = st.attempts.filter((a) => a.session_id !== id);
    st.participant_sessions = st.participant_sessions.filter((p) => p.session_id !== id);
    st.tiebreaks = st.tiebreaks.filter((t) => t.session_id !== id);
    return { deleted: true };
  },

  // Archive (hide) a set that is not live. Its code is retired; devices are signed out; results are kept.
  archiveSet(st, { id, reason }, ctx) {
    const set = findSet(st, id);
    if (!set) fail('NO_SESSION', 'That quiz set does not exist.');
    if (['running', 'paused'].includes(set.session.status)) fail('QUIZ_IN_PROGRESS', 'End the set before archiving it.');
    archive(st, set.session, String(reason ?? '').trim() || null, ctx);
    return { ok: true };
  },

  // ---- question bank (shared): published sets keep their snapshot
  saveQuestion(st, p, ctx) {
    const { value, errors, ok } = validateQuestion(p);
    if (!ok) validationFail(errors);
    if (p.id) {
      const q = st.questions.find((x) => x.id === p.id);
      if (!q) fail('QUESTION_NOT_FOUND');
      Object.assign(q, questionRecord(value, { updated_at: iso(ctx.now) }));
      return { id: q.id, rescored: 0 };
    }
    const n = st.questions.length;
    const pos = Number.isInteger(p.position) && p.position >= 1 && p.position <= n + 1 ? p.position : n + 1;
    for (const q of st.questions) if (q.position >= pos) q.position += 1;
    const q = questionRecord(value, { id: uuid(), position: pos, created_at: iso(ctx.now), updated_at: iso(ctx.now) });
    st.questions.push(q);
    renumber(st);
    return { id: q.id, rescored: 0 };
  },

  deleteQuestion(st, { id, confirm }, ctx) {
    const q = st.questions.find((x) => x.id === id);
    if (!q) fail('QUESTION_NOT_FOUND');
    assertNotInPublished(st, id);
    const own = st.answers.filter((a) => a.question_id === id);
    if (own.length && !confirm) fail('QUESTION_HAS_ANSWERS', `Q${q.position} has ${own.length} recorded answer(s) in archived sets. Confirm to delete them too.`);
    for (const sid of new Set(own.map((a) => a.session_id))) {
      const n = own.filter((a) => a.session_id === sid).length;
      st.events.push({ ...auditEvent(st, ctx, sid), action: 'delete_question', question_position: q.position, reason: `Deleted bank Q${q.position} with ${n} recorded answer(s)` });
    }
    st.questions = st.questions.filter((x) => x.id !== id);
    st.answers = st.answers.filter((a) => a.question_id !== id);
    for (const e of st.events) if (e.question_id === id) e.question_id = null;
    for (const set of st.sets) set.set_questions = set.set_questions.filter((x) => x.question_id !== id);
    renumber(st);
    return { deleted: true };
  },

  reorderQuestions(st, { ids }) {
    const current = new Set(st.questions.map((q) => q.id));
    if (!Array.isArray(ids) || ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every((id) => current.has(id))) {
      fail('VALIDATION', 'Reorder list must contain every question exactly once.');
    }
    const pos = new Map(ids.map((id, i) => [id, i + 1]));
    for (const q of st.questions) q.position = pos.get(q.id);
    renumber(st);
    return { ok: true };
  },

  importQuestions(st, { items, replace = false, confirm = false }, ctx) {
    if (!Array.isArray(items) || items.length === 0) fail('VALIDATION', 'No questions to import.');
    const validated = items.map((it, i) => {
      const { value, errors, ok } = validateQuestion(it);
      if (!ok) fail('VALIDATION', `Question ${it.__line ? `on line ${it.__line}` : i + 1}: ${Object.values(errors).join(' ')}`);
      return value;
    });
    if (replace) {
      assertNotInPublished(st, null);
      if (st.answers.length && !confirm) fail('QUESTION_HAS_ANSWERS', 'Existing questions have recorded answers. Confirm to replace them.');
      for (const q of [...st.questions]) global.deleteQuestion(st, { id: q.id, confirm: true }, ctx);
    }
    let pos = st.questions.length;
    for (const v of validated) {
      pos += 1;
      st.questions.push(questionRecord(v, { id: uuid(), position: pos, created_at: iso(ctx.now), updated_at: iso(ctx.now) }));
    }
    renumber(st);
    return { imported: validated.length };
  },

  // Deleting a team removes its answers in every set (audited per set).
  deleteTeam(st, { id, confirm }, ctx) {
    const list = st._otherTeams ? allTeams(st) : st.teams;
    const t = list.find((x) => x.id === id);
    if (!t) fail('TEAM_NOT_FOUND');
    const { sets } = st;
    if (sets.some((x) => x.session.status === 'finalized' && x.session.qualifiers?.includes(id))) fail('RESULTS_FINALIZED');
    const own = st.answers.filter((a) => a.team_id === id);
    if (own.length && !confirm) fail('TEAM_HAS_ANSWERS', `Team ${t.team_number} has ${own.length} recorded answer(s). Confirm to delete them too.`);
    if (own.some((a) => sets.find((x) => x.session.id === a.session_id)?.session.status === 'finalized')) fail('RESULTS_FINALIZED');
    for (const sid of new Set(own.map((a) => a.session_id))) {
      const mine = own.filter((a) => a.session_id === sid);
      st.events.push({
        ...auditEvent(st, ctx, sid), action: 'delete_team', team_number: t.team_number,
        prev_points: round2(mine.reduce((s, a) => s + Number(a.points), 0)),
        reason: `Deleted ${t.section} team "${t.team_name}" with ${mine.length} recorded answer(s)`,
      });
    }
    st.teams = st.teams.filter((x) => x.id !== id);
    if (st._otherTeams) st._otherTeams = st._otherTeams.filter((x) => x.id !== id);
    delete st.credentials[id];
    st.participant_sessions = st.participant_sessions.filter((p) => p.team_id !== id);
    st.attempts = st.attempts.filter((a) => a.team_id !== id);
    st.answers = st.answers.filter((a) => a.team_id !== id);
    st.tiebreaks = st.tiebreaks.filter((x) => x.team_id !== id);
    for (const e of st.events) if (e.team_id === id) e.team_id = null;
    for (const e of st.registration_events) if (e.team_id === id) e.team_id = null;
    return { deleted: true };
  },

  restoreBackup(st, { backup }, ctx) {
    const b = validateBackup(backup);
    const next = createEmptyState(ctx.now);
    Object.assign(next, {
      teams: b.teams, questions: b.questions,
      sets: b.sets.map(({ session, settings, set_questions }) => ({ session, settings, set_questions })),
      attempts: b.attempts,
      answers: b.answers, events: b.events, tiebreaks: b.tiebreaks,
      credentials: Object.fromEntries(b.team_credentials.map((c) => [c.team_id, c.pin])),
      retired_codes: [...st.retired_codes, ...st.sets.map((x) => x.session.join_code).filter(Boolean)],
      next_event_id: b.events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1,
    });
    // Round 2 is not part of a Round 1 backup. Like restore_backup in SQL (teams are deleted and re-inserted),
    // session teams are cleared and results keep only their team snapshot.
    if (st.round2) {
      next.round2 = { ...st.round2, results: (st.round2.results || []).map((x) => ({ ...x, team_id: null })) };
      if (next.round2.sessions) next.round2.sessions = next.round2.sessions.map((g) => ({ ...g, team_ids: [] }));
      if (next.round2.teams) next.round2.teams = [];
    }
    // Demo data from the removed Round 3 (if any) is kept untouched; nothing reads it any more.
    if (st.round3) next.round3 = st.round3;
    // Restored live sets are paused now; the time since their clocks last ran counts as paused time.
    for (const { session, frozen_at } of b.sets) {
      if (session.status !== 'paused') continue;
      session.paused_at = iso(ctx.now);
      const frozen = Date.parse(frozen_at || '');
      const shift = Number.isFinite(frozen) ? Math.max(0, ctx.now - frozen) : 0;
      for (const a of next.attempts) {
        if (a.session_id === session.id && a.status === 'in_progress' && a.deadline_at) {
          Object.assign(a, { deadline_at: iso(Date.parse(a.deadline_at) + shift), paused_ms: Number(a.paused_ms || 0) + shift });
        }
      }
    }
    normalizeState(next);
    for (const sec of SECTIONS) sectionSet(next, sec, ctx.now); // like restore_backup: each section has an active set
    for (const { session } of b.sets) {
      next.events.push({ ...auditEvent(next, ctx, session.id), action: 'restore', reason: `Restored backup exported ${b.exported_at || 'at unknown time'}` });
    }
    renumber(next);
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, next);
    return { ok: true };
  },

  // ------------------------------------------------ registration desk (mirrors reg_overview / reg_save_team)
  regOverview(st) {
    return {
      capacity: null, // no fixed number of teams per section
      sections: SECTIONS.map((sec) => ({
        section: sec,
        team_count: st.teams.filter((t) => t.section === sec).length,
        live_sets: activeSets(st).filter((x) => x.session.section === sec && ['running', 'paused'].includes(x.session.status)).length,
        locked: false,
      })),
      teams: st.teams.map((t) => ({
        id: t.id, section: t.section, team_number: t.team_number, team_name: t.team_name, participant_1: t.participant_1,
        participant_2: t.participant_2, college_name: t.college_name, pin: st.credentials[t.id], self_registered: t.self_registered,
        is_demo: t.is_demo, locked: teamStarted(st, t.id), updated_at: t.updated_at,
      })),
    };
  },

  /** Replace a Round 1 set's participants (mirrors public.set_set_teams). */
  setSetTeams(st, { set_id, team_ids, reason = null }, ctx) {
    const set = findSet(st, set_id);
    if (!set) fail('SET_NOT_FOUND', 'Quiz set not found.');
    return inSet(st, set, () => {
      const s = st.session;
      if (s.is_current === false) fail('INVALID_STATE', 'This set is archived.');
      if (['ended', 'finalized'].includes(s.status)) fail('INVALID_STATE', 'This set has ended; its participants are final.');
      const ids = Array.isArray(team_ids) ? team_ids : [];
      if (ids.some((x) => typeof x !== 'string' || !x)) fail('VALIDATION', 'Unknown team.');
      if (new Set(ids).size !== ids.length) fail('DUPLICATE_TEAM', 'A team is selected more than once.');
      if (ids.some((id) => !st.teams.some((t) => t.id === id))) fail('TEAM_NOT_ELIGIBLE', `Every selected team must be a registered ${s.section} team.`);
      const busy = st.teams.filter((t) => ids.includes(t.id) && teamOtherSet(st, s, t.id)).sort((a, b) => a.team_number - b.team_number)[0];
      if (busy) fail('TEAM_IN_OTHER_SET', `Team ${busy.team_number} already takes part in "${teamOtherSet(st, s, busy.id)}". Archive that set first or choose another team.`);
      const live = ['running', 'paused'].includes(s.status);
      const old = (s.team_ids || []).filter((id) => st.teams.some((t) => t.id === id));
      const added = ids.filter((id) => !old.includes(id));
      const removed = old.filter((id) => !ids.includes(id));
      if (!added.length && !removed.length) return { ok: true, count: ids.length, added: 0, removed: 0 };
      const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
      if (live && (!why || why.length > 200)) fail('REASON_REQUIRED', 'The set is live: give a reason for changing its participants (max 200 characters).');
      if (live && !ids.length) fail('VALIDATION', 'A live set needs at least one team.');
      for (const id of removed) {
        const t = st.teams.find((x) => x.id === id);
        if (st.answers.some((a) => a.session_id === s.id && a.team_id === id)) fail('TEAM_HAS_ANSWERS', `Team ${t.team_number} already has recorded answers in this set and cannot be removed.`);
        const a = activeAttempt(st, s.id, id);
        if (a) {
          if (a.status !== 'ready') fail('TEAM_STARTED', `Team ${t.team_number} has started this quiz and cannot be removed.`);
          Object.assign(a, { status: 'reset', reset_at: iso(ctx.now), reset_by: ctx.actor || 'demo-organizer', reset_reason: "Removed from the set's participants" });
        }
        revokeParticipantSessions(st, "Removed from the set's participants", ctx, id, s.id);
      }
      s.team_ids = [...ids];
      pushEvent(st, ctx, {
        action: 'participants',
        reason: `Participants: ${ids.length} selected (+${added.length}, −${removed.length})${live ? ` — correction: ${why}` : why ? ` — ${why}` : ''}`,
      });
      return { ok: true, count: ids.length, added: added.length, removed: removed.length };
    });
  },

  regSaveTeam(st, p, ctx) {
    const existing = p.id ? st.teams.find((t) => t.id === p.id) : null;
    if (p.id && !existing) fail('TEAM_NOT_FOUND');
    if (existing && teamStarted(st, existing.id)) {
      fail('REGISTRATION_LOCKED', `${existing.section} team ${existing.team_number} has started a quiz, so its registration is locked. Ask an organizer.`);
    }
    const section = String(p.section || existing?.section || '').trim().toUpperCase();
    if (!SECTIONS.includes(section)) fail('VALIDATION', 'Choose the section (UG or PG).');
    const { is_demo: _ignored, ...rest } = p;
    const res = inSet(st, sectionSet(st, section, ctx.now), () => upsertTeam(st, { ...rest, section }, ctx, ctx.role === 'organizer' ? 'organizer' : 'registration'));
    return { ...res, pin: st.credentials[res.id] };
  },
};

/** Has the team started (or been scored in) any active set? (mirrors public._team_started) */
function teamStarted(st, teamId) {
  const active = new Set(activeSets(st).map((x) => x.session.id));
  return st.attempts.some((a) => a.team_id === teamId && active.has(a.session_id) && !['reset', 'ready'].includes(a.status))
    || st.answers.some((a) => a.team_id === teamId && active.has(a.session_id));
}

/** A blank audit event for a set (used where no set view is entered). */
function auditEvent(st, ctx, sessionId) {
  return {
    id: st.next_event_id++, session_id: sessionId, request_id: null, team_id: null, team_number: null, question_id: null,
    question_position: null, prev_selected: null, prev_result: null, prev_points: null, new_selected: null, new_result: null,
    new_points: null, undone: false, undo_of: null, reason: null, actor: ctx.actor || 'demo-organizer', source: 'organizer',
    created_at: iso(ctx.now),
  };
}

export const ACTION_NAMES = [...Object.keys(actions), ...Object.keys(global)];

/** Apply an action without mutating the given state. ctx.setId (or ctx.section) picks the organizer's set. */
export function applyAction(state, name, payload = {}, ctx = {}) {
  const fn = actions[name] || global[name];
  if (!fn) throw new Error(`Unknown action ${name}`);
  const st = normalizeState(structuredClone(state));
  const c = { now: ctx.now ?? Date.now(), actor: ctx.actor, role: ctx.role };
  let result;
  if (global[name]) {
    result = global[name](st, payload, c);
  } else {
    result = inSet(st, setFor(st, name, payload, { ...ctx, now: c.now }), () => {
      const r = fn(st, payload, c);
      st.session.updated_at = iso(c.now);
      return r;
    });
  }
  normalizeRound2(st); // like the database's foreign keys: a deleted team leaves its Round 2 sessions at once
  st.updated_at = iso(c.now);
  return { state: st, result };
}

export { OPTIONS };
