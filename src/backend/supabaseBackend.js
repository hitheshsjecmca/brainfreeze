// SUPABASE MODE — every write is a SECURITY DEFINER RPC (see
// supabase/migrations). The browser never sends a score; the database
// computes it from the private answer key.
// Organizer RPCs act on the quiz set named by the x-brainfreze-set header
// (a set id), which every organizer call below sets explicitly. Without a set
// id they fall back to the newest active set of the x-brainfreze-section section.
import { toQuizError, fail } from '../lib/errors.js';
import { publicQuestion } from './publicView.js';
import { supabase } from './supabaseClient.js';
import { setStage } from '../lib/engine.js';
import { normalizeAppSettings } from '../lib/appSettings.js';

const keyPatch = (p) => ({ correct_option: p.correct_option, marks_correct: p.marks_correct, marks_incorrect: p.marks_incorrect });

const RPC = {
  saveTeam: (p) => ['save_team', { p }],
  deleteTeam: (p) => ['delete_team', { p_id: p.id, p_confirm: !!p.confirm }],
  importTeams: (p) => ['import_teams', { p_rows: p.rows, p_replace: !!p.replace, p_confirm: !!p.confirm }],
  removeDemoData: (p) => ['remove_demo_data', { p_teams: !!p.teams, p_questions: !!p.questions, p_confirm: !!p.confirm }],
  saveQuestion: (p) => ['save_question', { p }],
  deleteQuestion: (p) => ['delete_question', { p_id: p.id, p_confirm: !!p.confirm }],
  reorderQuestions: (p) => ['reorder_questions', { p_ids: p.ids }],
  importQuestions: (p) => ['import_questions', { p_items: p.items, p_replace: !!p.replace, p_confirm: !!p.confirm }],
  updateSettings: (p) => ['update_settings', { p }],
  startQuiz: () => ['start_quiz', {}],
  pauseQuiz: () => ['pause_quiz', {}],
  resumeQuiz: () => ['resume_quiz', {}],
  resetTimer: () => ['reset_timer', {}],
  endQuiz: () => ['end_quiz', {}],
  goToQuestion: (p) => ['go_to_question', { p_index: p.index }],
  setQuestionCompleted: (p) => ['set_question_completed', { p_question_id: p.question_id, p_completed: !!p.completed }],
  setProjectorView: (p) => ['set_projector_view', { p_view: p.view }],
  setCorrections: (p) => ['set_corrections', { p_enabled: !!p.enabled, p_reason: p.reason ?? null }],
  newSession: () => ['new_session', {}],
  recordAnswer: (p) => ['record_answer', {
    p_request_id: p.request_id, p_team_id: p.team_id, p_question_id: p.question_id,
    p_selected: p.selected ?? null, p_correction: !!p.correction, p_reason: p.reason ?? null,
  }],
  undoLast: (p) => ['undo_last_action', { p_request_id: p.request_id }],
  setTiebreak: (p) => ['set_tiebreak', { p_team_id: p.team_id, p_score: p.score === '' || p.score === undefined ? null : p.score, p_note: p.note ?? null }],
  confirmQualifiers: (p) => ['confirm_qualifiers', { p_team_ids: p.team_ids, p_override_reason: p.override_reason ?? null }],
  reopenResults: (p) => ['reopen_results', { p_reason: p.reason }],
  revealResults: (p) => ['reveal_results', { p_reveal: !!p.reveal }],
  restoreBackup: (p) => ['restore_backup', { p: p.backup }],
  updateQuizDetails: (p) => ['update_quiz_details', { p }],
  publishQuiz: () => ['publish_quiz', {}],
  unpublishQuiz: () => ['unpublish_quiz', {}],
  regenerateJoinCode: () => ['regenerate_join_code', {}],
  setRegistration: (p) => ['set_registration', { p_open: !!p.open }],
  revokeParticipant: (p) => ['revoke_participant', { p_team_id: p.team_id }],
  rotateTeamPin: (p) => ['rotate_team_pin', { p_team_id: p.team_id }],
  // quiz sets (migration 6)
  createSet: (p) => ['create_set', { p }],
  duplicateSet: (p) => ['duplicate_set', { p_id: p.id }],
  deleteSet: (p) => ['delete_set', { p_id: p.id }],
  archiveSet: (p) => ['archive_set', { p_id: p.id, p_reason: p.reason ?? null }],
  revokeJoinCode: () => ['revoke_join_code', {}],
  finalizeExpiredAttempts: () => ['finalize_expired_attempts', {}],
  finalizeAttempt: (p) => ['finalize_attempt', { p_team_id: p.team_id, p_reason: p.reason ?? null }],
  resetAttempt: (p) => ['reset_attempt', { p_team_id: p.team_id, p_reason: p.reason ?? null }],
  setSetTeams: (p) => ['set_set_teams', { p_set_id: p.set_id, p_team_ids: p.team_ids, p_reason: p.reason ?? null }],
  correctSetQuestion: (p) => ['correct_set_question', { p_question_id: p.question_id, p: keyPatch(p), p_reason: p.reason ?? null }],
};

// Round 2 trivia board (migration 7). Not scoped to a quiz set.
// Round 2 trivia sets, versions and sessions (migration 10). Every write is an organizer RPC.
const R2_RPC = {
  r2sSaveSet: (p) => ['r2s_save_set', { p }],
  r2sDeleteSet: (p) => ['r2s_delete_set', { p_set_id: p.id }],
  r2sArchiveSet: (p) => ['r2s_archive_set', { p_set_id: p.id }],
  r2sSaveTopic: (p) => ['r2s_save_topic', { p }],
  r2sDeleteTopic: (p) => ['r2s_delete_topic', { p_id: p.id }],
  r2sSaveQuestion: (p) => ['r2s_save_question', { p }],
  r2sDeleteQuestion: (p) => ['r2s_delete_question', { p_id: p.id }],
  r2sPublishSet: (p) => ['r2s_publish_set', { p_set_id: p.id }],
  r2sStartSession: (p) => ['r2s_start_session', { p_request_id: p.request_id, p_code: p.code, p_section: p.section, p_team_ids: p.team_ids }],
  r2sEndSession: (p) => ['r2s_end_session', { p_session_id: p.session_id }],
  r2sSelect: (p) => ['r2s_select', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r2sCancel: (p) => ['r2s_cancel', { p_session_id: p.session_id }],
  r2sRevealQuestion: (p) => ['r2s_reveal_question', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r2sRevealAnswer: (p) => ['r2s_reveal_answer', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r2sScore: (p) => ['r2s_score', { p_request_id: p.request_id, p_session_id: p.session_id, p_question_id: p.question_id, p_team_id: p.team_id, p_result: p.result }],
  r2sCloseQuestion: (p) => ['r2s_close_question', { p_request_id: p.request_id, p_session_id: p.session_id, p_question_id: p.question_id }],
};
const R2_RETURNS_ID = new Set(['r2sSaveSet', 'r2sSaveTopic', 'r2sSaveQuestion']);
const r2Tiles = (topics) => (topics || []).map((t) => ({ ...t, questions: t.questions.map((x) => ({ ...x, points: Number(x.points) })) }));

// Round 3 auction sets, versions and live auctions (migration 13). Every write is an organizer RPC;
// scores, budgets and bid order are computed in the database.
const r3Settings = (p) => p.settings ?? {}; // auction timer defaults (absent keys keep the set's / auction's value)
const R3_RPC = {
  r3sSaveSet: (p) => ['r3s_save_set', { p }],
  r3sDeleteSet: (p) => ['r3s_delete_set', { p_set_id: p.id }],
  r3sArchiveSet: (p) => ['r3s_archive_set', { p_set_id: p.id }],
  r3sSaveTopic: (p) => ['r3s_save_topic', { p }],
  r3sDeleteTopic: (p) => ['r3s_delete_topic', { p_id: p.id }],
  r3sSaveQuestion: (p) => ['r3s_save_question', { p }],
  r3sDeleteQuestion: (p) => ['r3s_delete_question', { p_id: p.id }],
  r3sMove: (p) => ['r3s_move', { p_kind: p.kind, p_id: p.id, p_dir: p.dir }],
  r3sPublishSet: (p) => ['r3s_publish_set', { p_set_id: p.id }],
  r3sStartSession: (p) => ['r3s_start_session', { p_request_id: p.request_id, p_code: p.code, p_section: p.section, p_team_ids: p.team_ids, p_settings: r3Settings(p) }],
  r3sUpdateSessionSettings: (p) => ['r3s_update_session_settings', { p_session_id: p.session_id, p_settings: r3Settings(p) }],
  r3sSelectQuestion: (p) => ['r3s_select_question', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sCancelQuestion: (p) => ['r3s_cancel_question', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sStartBidding: (p) => ['r3s_start_bidding', { p_session_id: p.session_id, p_question_id: p.question_id, p_timer: p.timer ?? null }],
  r3sRecordBid: (p) => ['r3s_record_bid', { p_session_id: p.session_id, p_question_id: p.question_id, p_team_id: p.team_id, p_amount: p.amount ?? null, p_pass: !!p.pass }],
  r3sCloseBidding: (p) => ['r3s_close_bidding', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sResolveTie: (p) => ['r3s_resolve_tie', { p_session_id: p.session_id, p_question_id: p.question_id, p_order: p.order, p_reason: p.reason }],
  r3sReopenBidding: (p) => ['r3s_reopen_bidding', { p_session_id: p.session_id, p_question_id: p.question_id, p_reason: p.reason }],
  r3sRevealTopic: (p) => ['r3s_reveal_topic', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sRevealQuestion: (p) => ['r3s_reveal_question', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sRecordOutcome: (p) => ['r3s_record_outcome', { p_request_id: p.request_id, p_session_id: p.session_id, p_question_id: p.question_id, p_team_id: p.team_id, p_outcome: p.outcome }],
  r3sNextBidder: (p) => ['r3s_next_bidder', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sRevealAnswer: (p) => ['r3s_reveal_answer', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sFinishQuestion: (p) => ['r3s_finish_question', { p_session_id: p.session_id, p_question_id: p.question_id }],
  r3sEndAuction: (p) => ['r3s_end_auction', { p_session_id: p.session_id }],
  r3sRevealResults: (p) => ['r3s_reveal_results', { p_session_id: p.session_id, p_reveal: !!p.reveal }],
};
const R3_RETURNS_ID = new Set(['r3sSaveSet', 'r3sSaveTopic', 'r3sSaveQuestion']);

// RPCs that return a bare set id; the demo engine returns { id }.
const RETURNS_ID = new Set(['createSet', 'duplicateSet', 'newSession']);

// Participant functions (callable without an account; authorized by join code + registered team / device token).
const PARTICIPANT_RPC = {
  lookup: (code) => ['join_lookup', { p_code: code }],
  roster: (p) => ['join_roster', { p_code: p.code, p_section: p.section }],
  joinRegistered: (p) => ['join_registered_team', { p_code: p.code, p_section: p.section, p_team_number: Number(p.team_number), p_device_label: p.device_label ?? null }],
  joinTeam: (p) => ['join_team', { p_code: p.code, p_team_number: Number(p.team_number), p_pin: p.pin, p_device_label: p.device_label ?? null }],
  registerTeam: (p) => ['register_team', { p_code: p.code, p_team_name: p.team_name, p_participant_1: p.participant_1, p_participant_2: p.participant_2, p_college_name: p.college_name, p_device_label: p.device_label ?? null }],
  state: (token, position = null) => ['participant_state', { p_token: token, p_position: position }],
  start: (token) => ['participant_start', { p_token: token }],
  submit: (p) => ['participant_submit', { p_token: p.token, p_request_id: p.request_id, p_question_id: p.question_id, p_option: p.option }],
  finish: (token) => ['participant_finish', { p_token: token }],
  leave: (token) => ['participant_leave', { p_token: token }],
};

// Registration desk (registration staff or organizers; checked in SQL).
const REG_RPC = {
  access: () => ['registration_access', {}],
  overview: () => ['reg_overview', {}],
  saveTeam: (p) => ['reg_save_team', { p }],
};

const SET_HEADER = 'x-brainfreze-set';
const SECTION_HEADER = 'x-brainfreze-section';
/** An organizer RPC scoped to one quiz set ({ setId }) or, without one, a section's newest set. */
function setRpc(fn, args, to) {
  const t = typeof to === 'string' ? { setId: to } : to || {};
  const req = supabase.rpc(fn, args);
  return t.setId ? req.setHeader(SET_HEADER, t.setId) : req.setHeader(SECTION_HEADER, t.section || 'UG');
}

// A data-free "something changed, refresh now" signal. Participants still poll,
// so if public broadcast channels are disabled in the project nothing breaks.
const NUDGE_CHANNEL = 'brainfreze-participant-nudge';
let nudgeChannel = null;
let nudgeReady = false;
function organizerNudgeChannel() {
  if (!nudgeChannel) {
    nudgeChannel = supabase.channel(NUDGE_CHANNEL, { config: { broadcast: { self: false } } });
    nudgeChannel.subscribe((status) => { nudgeReady = status === 'SUBSCRIBED'; });
  }
  return nudgeChannel;
}

async function q(promise) {
  let res;
  try {
    res = await promise;
  } catch (e) {
    throw toQuizError(e);
  }
  if (res.error) throw toQuizError(res.error);
  return res.data;
}

/** PostgREST caps responses (default 1000 rows) — page through everything. */
async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const rows = await q(build().range(from, from + pageSize - 1));
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

async function measureOffset() {
  const t0 = Date.now();
  const serverNow = await q(supabase.rpc('server_now'));
  const t1 = Date.now();
  return Date.parse(serverNow) - (t0 + t1) / 2;
}

const SET_COLUMNS = 'id, name, section, status, is_current, join_code, join_code_active, registration_open, published_at, archived_at, created_at, question_ids, qualifiers, results_revealed, team_ids';

/** Every quiz set with its stage, question count and attempt count (organizer set list). */
async function loadSets() {
  const [sessions, settings, attempts] = await Promise.all([
    fetchAll(() => supabase.from('quiz_sessions').select(SET_COLUMNS).order('created_at')),
    fetchAll(() => supabase.from('quiz_settings').select('session_id, duration_seconds, qualify_count').order('session_id')),
    fetchAll(() => supabase.from('quiz_attempts').select('session_id, team_id, status').order('session_id')),
  ]);
  const cfg = new Map(settings.map((x) => [x.session_id, x]));
  return { sets: sessions.map((s) => ({
    id: s.id, name: s.name, section: s.section, stage: setStage(s), status: s.status,
    join_code: s.join_code, join_code_active: s.join_code_active, registration_open: s.registration_open,
    published_at: s.published_at, archived_at: s.archived_at, created_at: s.created_at,
    question_count: s.question_ids ? s.question_ids.length : null, // null = whole bank (draft)
    duration_seconds: Number(cfg.get(s.id)?.duration_seconds ?? 1800),
    attempts: attempts.filter((a) => a.session_id === s.id && a.status !== 'reset').length,
    qualify_count: Number(cfg.get(s.id)?.qualify_count ?? 5),
    qualifiers: s.qualifiers || null,
    results_revealed: !!s.results_revealed,
    team_ids: s.team_ids || [], // the organiser's chosen participants
    participants: attempts.filter((a) => a.session_id === s.id && a.status !== 'reset').map((a) => ({ team_id: a.team_id, status: a.status })),
  })) };
}

/** Pick a set id: the requested one if it exists, else the newest active UG set (then PG). */
function pickSet(sets, setId) {
  if (setId && sets.some((x) => x.id === setId)) return setId;
  const active = sets.filter((x) => x.stage !== 'archived');
  const newest = (sec) => active.filter((x) => x.section === sec).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return (newest('UG') || newest('PG') || active[0] || sets[0])?.id ?? null;
}

async function resolveSet(setId) {
  let { sets } = await loadSets();
  if (!sets.some((x) => x.stage !== 'archived')) {
    await q(setRpc('ensure_session', {}, { section: 'UG' }));
    ({ sets } = await loadSets());
  }
  return { sets, id: pickSet(sets, setId) };
}

let lastOffset = 0;
let offsetAt = 0;
async function serverOffset() {
  if (Date.now() - offsetAt > 60_000) {
    try {
      lastOffset = await measureOffset();
      offsetAt = Date.now();
    } catch {
      // keep previous offset; connection problems surface elsewhere
    }
  }
  return lastOffset;
}

const num = (v) => (v === null || v === undefined ? v : Number(v));
const normSettings = (s) => ({
  duration_seconds: num(s.duration_seconds), marks_correct: num(s.marks_correct), marks_incorrect: num(s.marks_incorrect),
  marks_unanswered: num(s.marks_unanswered), qualify_count: num(s.qualify_count), accuracy_tiebreak: !!s.accuracy_tiebreak,
});
const normSession = (s) => ({ ...s, elapsed_ms: Number(s.elapsed_ms), completed_question_ids: s.completed_question_ids || [] });
const normSetQuestion = (x) => ({ ...x, marks_correct: Number(x.marks_correct), marks_incorrect: Number(x.marks_incorrect) });
const normAttempt = (a) => ({ ...a, paused_ms: Number(a.paused_ms || 0) });
const normAnswer = (a) => ({ ...a, points: Number(a.points) });
const normEvent = (e) => ({ ...e, prev_points: num(e.prev_points), new_points: num(e.new_points) });
/** get_set_results rows → the shape computeStandings returns. */
const normResults = (rows, tiebreaks) => {
  const notes = new Map(tiebreaks.map((t) => [t.team_id, t.note || '']));
  return rows.map((r) => ({
    ...r, points: Number(r.points), tiebreak: num(r.tiebreak), elapsed_ms: Number(r.elapsed_ms),
    tiebreak_note: notes.get(r.team_id) || '', tied: !!r.tie_review, tie_review: !!r.tie_review,
  }));
};
const withKeys = (questions, keys) => {
  const keyMap = new Map(keys.map((k) => [k.question_id, k]));
  return questions.map((x) => ({
    ...x,
    marks_correct: num(x.marks_correct),
    marks_incorrect: num(x.marks_incorrect),
    correct_option: keyMap.get(x.id)?.correct_option ?? null,
    explanation: keyMap.get(x.id)?.explanation ?? null,
  }));
};

export const supabaseBackend = {
  mode: 'supabase',

  async getUser() {
    const { data } = await supabase.auth.getSession();
    return data.session?.user ?? null;
  },
  async signIn(email, password) {
    const data = await q(supabase.auth.signInWithPassword({ email, password }));
    return data.user;
  },
  async signOut() {
    await supabase.auth.signOut();
  },
  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  },
  async isOrganizer() {
    return !!(await q(supabase.rpc('is_organizer')));
  },

  /** One quiz set's data for the organizer console (the newest UG set when setId is unknown). */
  async loadSnapshot(setId = null) {
    const { sets, id } = await resolveSet(setId);
    const session = await q(supabase.from('quiz_sessions').select('*').eq('id', id).single());
    const section = session.section;
    const [settings, setQuestions, attempts, allTeams, questions, keys, answers, events, tiebreaks, credentials, participants, results, offset] = await Promise.all([
      q(supabase.from('quiz_settings').select('*').eq('session_id', id).maybeSingle()),
      fetchAll(() => supabase.from('set_questions').select('*').eq('session_id', id).order('position')),
      fetchAll(() => supabase.from('quiz_attempts').select('*').eq('session_id', id).order('created_at')),
      fetchAll(() => supabase.from('teams').select('*').order('section').order('team_number')),
      fetchAll(() => supabase.from('questions').select('*').order('position')),
      fetchAll(() => supabase.from('question_keys').select('*').order('question_id')),
      fetchAll(() => supabase.from('team_answers').select('*').eq('session_id', id).order('id')),
      fetchAll(() => supabase.from('score_events').select('*').eq('session_id', id).order('id')),
      fetchAll(() => supabase.from('tiebreak_results').select('*').eq('session_id', id).order('team_id')),
      fetchAll(() => supabase.from('team_credentials').select('team_id, pin, rotated_at').order('team_id')),
      loadParticipantRows(id),
      q(setRpc('get_set_results', {}, { setId: id })),
      serverOffset(),
    ]);
    const teams = allTeams.filter((t) => t.section === section);
    const teamIds = new Set(teams.map((t) => t.id));
    const tb = tiebreaks.map((t) => ({ ...t, score: Number(t.score) }));
    const bankSize = questions.length;
    return {
      setId: id,
      section,
      sets: sets.map((x) => ({ ...x, question_count: x.question_count ?? bankSize })),
      session: normSession(session),
      settings: normSettings(settings || {}),
      set_questions: setQuestions.map(normSetQuestion),
      attempts: attempts.map(normAttempt),
      teams,
      allTeams, // every team, both sections (Teams page and dashboard)
      questions: withKeys(questions, keys),
      answers: answers.map(normAnswer),
      events: events.map(normEvent),
      tiebreaks: tb,
      results: normResults(results, tb),
      credentials: credentials.filter((c) => teamIds.has(c.team_id)),
      participant_sessions: participants,
      serverOffsetMs: offset,
      loadedAt: Date.now(),
    };
  },

  /** Lightweight device-status refresh for the organizer monitor (no token hashes). */
  async loadParticipants(setId) {
    return setId ? loadParticipantRows(setId) : [];
  },

  /** Everything (every quiz set, archived ones included) for a JSON backup. */
  async loadBackupData() {
    const sessions = await fetchAll(() => supabase.from('quiz_sessions').select('*').order('created_at'));
    const [settings, setQuestions, attempts, teams, questions, keys, answers, events, tiebreaks, credentials] = await Promise.all([
      fetchAll(() => supabase.from('quiz_settings').select('*').order('session_id')),
      fetchAll(() => supabase.from('set_questions').select('*').order('session_id').order('position')),
      fetchAll(() => supabase.from('quiz_attempts').select('*').order('created_at')),
      fetchAll(() => supabase.from('teams').select('*').order('section').order('team_number')),
      fetchAll(() => supabase.from('questions').select('*').order('position')),
      fetchAll(() => supabase.from('question_keys').select('*').order('question_id')),
      fetchAll(() => supabase.from('team_answers').select('*').order('id')),
      fetchAll(() => supabase.from('score_events').select('*').order('id')),
      fetchAll(() => supabase.from('tiebreak_results').select('*').order('team_id')),
      fetchAll(() => supabase.from('team_credentials').select('team_id, pin').order('team_id')),
    ]);
    return {
      teams,
      questions: withKeys(questions, keys),
      sets: sessions.map((s) => ({
        session: normSession(s),
        settings: normSettings(settings.find((x) => x.session_id === s.id) || {}),
        set_questions: setQuestions.filter((x) => x.session_id === s.id).map(({ session_id: _s, ...x }) => normSetQuestion(x)),
        attempts: attempts.filter((a) => a.session_id === s.id).map(normAttempt),
      })),
      answers: answers.map(normAnswer),
      events: events.map(normEvent),
      tiebreaks: tiebreaks.map((t) => ({ ...t, score: Number(t.score) })),
      credentials,
    };
  },

  /** Projector data for one set: no answer keys, no per-answer rows, no explanations. */
  async loadPublicSnapshot(setId = null) {
    const { id } = await resolveSet(setId);
    const session = await q(supabase.from('quiz_sessions').select('*').eq('id', id).single());
    const published = !!session.published_at;
    const [settings, teams, questions, standings, offset] = await Promise.all([
      q(supabase.from('quiz_settings').select('*').eq('session_id', id).maybeSingle()),
      fetchAll(() => supabase.from('teams').select('id, team_number, team_name').eq('section', session.section).order('team_number')),
      published
        // frozen snapshot — select only public columns (never the key)
        ? fetchAll(() => supabase.from('set_questions').select('question_id, position, question_text, option_a, option_b, option_c, option_d, image_url')
          .eq('session_id', id).order('position')).then((rows) => rows.map(({ question_id, ...r }) => ({ ...r, id: question_id })))
        : fetchAll(() => supabase.from('questions').select('id, position, question_text, option_a, option_b, option_c, option_d, image_url').order('position'))
          .then((rows) => (session.question_ids ? rows.filter((r) => session.question_ids.includes(r.id)) : rows)),
      q(setRpc('get_standings', {}, { setId: id })),
      serverOffset(),
    ]);
    return {
      setId: id,
      section: session.section,
      session: normSession(session),
      settings: normSettings(settings || {}),
      teams,
      questions: questions.map(publicQuestion),
      standings: standings.map((r) => ({ ...r, points: Number(r.points), tiebreak: num(r.tiebreak) })),
      // Self-paced progress: total answers recorded so far (no per-team data).
      submitted: standings.reduce((n, r) => n + Number(r.recorded || 0), 0),
      serverOffsetMs: offset,
    };
  },

  subscribe(onChange, onStatus, { includePrivate = true } = {}) {
    const tables = ['quiz_sessions', 'quiz_settings', 'teams', 'questions', 'team_answers', 'tiebreak_results'];
    if (includePrivate) tables.push('score_events', 'quiz_attempts');
    let ch = supabase.channel(`brainfreze-${includePrivate ? 'host' : 'projector'}-${Math.random().toString(36).slice(2)}`);
    for (const table of tables) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange());
    ch.subscribe((status) => onStatus?.(status));
    return () => { supabase.removeChannel(ch); };
  },

  /** Run an organizer action on a quiz set (`to` = set id or { setId } / { section }). */
  async call(action, payload = {}, to = null) {
    const map = RPC[action];
    if (!map) fail('UNKNOWN', `Unknown action ${action}`);
    const [fn, args] = map(payload);
    const data = await q(setRpc(fn, args, to));
    return RETURNS_ID.has(action) ? { id: data } : data;
  },

  /** Tell participant devices to refresh immediately (best effort). */
  notifyParticipants() {
    try {
      const ch = organizerNudgeChannel();
      if (nudgeReady) ch.send({ type: 'broadcast', event: 'changed', payload: {} });
    } catch { /* polling covers it */ }
  },

  // Round 2: every read is an organizer RPC. Answers come back only where the SQL allows it
  // (set editor; the host's own board after Reveal Question; the projector board after Answer).
  // Scores, the last result and the score log come only with the private host board.
  round2: {
    async overview() {
      const o = await q(supabase.rpc('r2s_overview'));
      return {
        sets: o.sets.map((x) => ({ ...x, wrong_penalty_percent: Number(x.wrong_penalty_percent) })),
        sessions: o.sessions,
      };
    },
    async setDetail(id) {
      const d = await q(supabase.rpc('r2s_set_detail', { p_set_id: id }));
      return { ...d, set: { ...d.set, wrong_penalty_percent: Number(d.set.wrong_penalty_percent) }, questions: d.questions.map((x) => ({ ...x, points: Number(x.points) })) };
    },
    async lookup(code) {
      const d = await q(supabase.rpc('r2s_lookup', { p_code: code }));
      return { ...d, wrong_penalty_percent: Number(d.wrong_penalty_percent), topics: r2Tiles(d.topics) };
    },
    eligible: (code, section) => q(supabase.rpc('r2s_eligible_teams', { p_code: code, p_section: section })),
    async board(sessionId, { host = false } = {}) {
      const [b, offset] = await Promise.all([q(supabase.rpc('r2s_board', { p_session_id: sessionId, p_host: host })), serverOffset()]);
      return {
        ...b,
        settings: { timer_seconds: Number(b.settings.timer_seconds), wrong_penalty_percent: Number(b.settings.wrong_penalty_percent) },
        topics: r2Tiles(b.topics),
        game: { ...b.game, points: b.game.points === null || b.game.points === undefined ? null : Number(b.game.points) },
        // Present only on the host board (p_host); the projector board carries no scores at all.
        scores: b.scores ? b.scores.map((x) => ({ ...x, score: Number(x.score) })) : null,
        last_result: b.last_result ? { ...b.last_result, points: Number(b.last_result.points), point_value: Number(b.last_result.point_value) } : null,
        results: b.results ? b.results.map((x) => ({ ...x, points: Number(x.points), point_value: Number(x.point_value) })) : null,
        serverOffsetMs: offset,
      };
    },
    async call(action, payload = {}) {
      const map = R2_RPC[action];
      if (!map) fail('UNKNOWN', `Unknown action ${action}`);
      const [fn, args] = map(payload);
      const data = await q(supabase.rpc(fn, args));
      return R2_RETURNS_ID.has(action) ? { id: data } : data;
    },
    /**
     * Host screens watch sets, sessions and results; the projector only r2_sessions (every gameplay write
     * touches that row), so no score row ever reaches it. Answer tables are never published.
     */
    subscribe(onChange, onStatus, { host = true } = {}) {
      const tables = host ? ['r2_sets', 'r2_set_topics', 'r2_set_questions', 'r2_sessions', 'r2_session_teams', 'r2_session_results', 'teams']
        : ['r2_sessions'];
      let ch = supabase.channel(`brainfreze-r2-${host ? 'host' : 'projector'}-${Math.random().toString(36).slice(2)}`);
      for (const table of tables) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange());
      ch.subscribe((status) => onStatus?.(status));
      return () => { supabase.removeChannel(ch); };
    },
  },

  // Event-wide settings (migration 16): organizer-only RPCs; the database refuses Round 3 RPCs while it is disabled.
  appSettings: {
    get: async () => normalizeAppSettings(await q(supabase.rpc('get_app_settings'))),
    setRound3Enabled: async (enabled) => normalizeAppSettings(await q(supabase.rpc('set_round3_enabled', { p_enabled: !!enabled }))),
  },

  // Round 3: every read is an organizer RPC. The projector board (p_host = false) never carries scores or
  // unrevealed topics, questions or answers; the projector listens only to r3_sessions (every action touches it).
  round3: {
    overview: () => q(supabase.rpc('r3s_overview')),
    setDetail: (id) => q(supabase.rpc('r3s_set_detail', { p_set_id: id })),
    lookup: (code) => q(supabase.rpc('r3s_lookup', { p_code: code })),
    eligible: (code, section) => q(supabase.rpc('r3s_eligible_teams', { p_code: code, p_section: section })),
    async board(sessionId, { host = false } = {}) {
      const [b, offset] = await Promise.all([q(supabase.rpc('r3s_board', { p_session_id: sessionId, p_host: host })), serverOffset()]);
      return { ...b, serverOffsetMs: offset };
    },
    results: (sessionId) => q(supabase.rpc('r3s_results', { p_session_id: sessionId })),
    async call(action, payload = {}) {
      const map = R3_RPC[action];
      if (!map) fail('UNKNOWN', `Unknown action ${action}`);
      const [fn, args] = map(payload);
      const data = await q(supabase.rpc(fn, args));
      return R3_RETURNS_ID.has(action) ? { id: data } : data;
    },
    subscribe(onChange, onStatus, { host = true } = {}) {
      const tables = host ? ['r3_sets', 'r3_set_topics', 'r3_set_questions', 'r3_sessions', 'r3_session_teams', 'r3_bids', 'r3_events', 'teams'] : ['r3_sessions'];
      let ch = supabase.channel(`brainfreze-r3-${host ? 'host' : 'projector'}-${Math.random().toString(36).slice(2)}`);
      for (const table of tables) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange());
      ch.subscribe((status) => onStatus?.(status));
      return () => { supabase.removeChannel(ch); };
    },
  },

  registration: Object.fromEntries(Object.entries(REG_RPC).map(([name, map]) => [name, async (arg) => {
    const [fn, args] = map(arg);
    return q(supabase.rpc(fn, args));
  }])),

  participant: {
    ...Object.fromEntries(Object.entries(PARTICIPANT_RPC).map(([name, map]) => [name, async (...arg) => {
      const [fn, args] = map(...arg);
      return q(supabase.rpc(fn, args));
    }])),
    subscribe(onChange) {
      const ch = supabase.channel(`${NUDGE_CHANNEL}`, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'changed' }, () => onChange())
        .subscribe();
      return () => { supabase.removeChannel(ch); };
    },
  },
};

async function loadParticipantRows(sessionId) {
  return fetchAll(() => supabase.from('participant_sessions')
    .select('id, session_id, team_id, device_label, created_at, last_seen_at, expires_at, revoked_at, revoked_reason')
    .eq('session_id', sessionId).order('created_at'));
}
