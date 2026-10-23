import { APP_ID, BACKUP_FORMAT_VERSION, DEFAULT_SETTINGS, OPTIONS, PROJECTOR_VIEWS, SECTIONS } from './constants.js';
import { optionLetters } from './options.js';
import { fail } from './errors.js';
import { validateQuestion, validateSettings, validateTeam } from './validation.js';
import { uuid } from './ids.js';

/**
 * Backup JSON format 3 (identical for demo and Supabase modes):
 * { app, format_version: 3, exported_at, source_mode, teams[] (with section +
 *   college_name), questions[] (with correct_option + explanation),
 *   sessions[] = [{ session, settings, set_questions[], attempts[] }] (every
 *   quiz set, archived ones included; set_questions = the frozen snapshot of a
 *   published set, attempts = team attempts with their question/option order),
 *   answers[], events[], tiebreaks[], team_credentials[] (team PINs) }
 * Formats 1 (one `session`) and 2 (one session per section) still restore.
 * Backups contain ANSWER KEYS and TEAM PINS — store them privately.
 *
 * `data` = { teams, questions, sets: [{ session, settings, set_questions, attempts }], answers, events, tiebreaks, credentials }
 */
export function buildBackup(data, sourceMode) {
  return {
    app: APP_ID,
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    source_mode: sourceMode,
    warning: 'Contains private answer keys, team PINs and scores. Do not share publicly.',
    teams: data.teams,
    questions: data.questions,
    sessions: data.sets.map(({ session, settings, set_questions = [], attempts = [] }) => ({ session, settings, set_questions, attempts })),
    answers: data.answers,
    events: data.events,
    tiebreaks: data.tiebreaks,
    team_credentials: credentialList(data.credentials),
  };
}

/** Snapshots hold credentials as [{team_id, pin}]; raw demo state holds {team_id: pin}. */
export function credentialList(c) {
  if (!c) return [];
  return Array.isArray(c) ? c.map(({ team_id, pin }) => ({ team_id, pin })) : Object.entries(c).map(([team_id, pin]) => ({ team_id, pin }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);

function restoredSession(s, section, questionIds, teamIds, published, bad) {
  if (!s || !isUuid(s.id)) bad(`missing ${section} session`);
  if (!['setup', 'running', 'paused', 'ended', 'finalized'].includes(s.status)) bad(`${section} session status`);
  const live = s.status === 'running' || s.status === 'paused';
  return {
    id: s.id,
    section,
    self_paced: true,
    name: s.name || 'COLD START',
    // A restored live set is paused for safety; the organizer resumes it (team deadlines move like a pause).
    status: live ? 'paused' : s.status,
    is_current: s.is_current !== false,
    current_index: Number(s.current_index) || 0,
    completed_question_ids: (s.completed_question_ids || []).filter((id) => questionIds.has(id)),
    started_at: s.started_at || null,
    timer_started_at: null,
    elapsed_ms: Math.max(0, Number(s.elapsed_ms) || 0),
    paused_at: s.status === 'paused' ? s.paused_at || null : null, // reset to the restore time by the restore itself
    ended_at: s.ended_at || null,
    corrections_enabled: !!s.corrections_enabled,
    projector_view: PROJECTOR_VIEWS.includes(s.projector_view) && (s.projector_view !== 'reveal' || s.results_revealed) ? s.projector_view : 'standby',
    results_revealed: !!s.results_revealed,
    qualifiers: Array.isArray(s.qualifiers) ? s.qualifiers.filter((id) => teamIds.has(id)) : null,
    // The set's chosen participants; absent in older backups (then the teams that took part — see normalizeState).
    ...(Array.isArray(s.team_ids) ? { team_ids: [...new Set(s.team_ids)].filter((id) => teamIds.has(id)) } : {}),
    qualifiers_confirmed_at: s.qualifiers_confirmed_at || null,
    qualification_note: s.qualification_note || null,
    description: s.description || null,
    question_ids: Array.isArray(s.question_ids) ? s.question_ids.filter((id) => questionIds.has(id)) : null,
    self_registration: !!s.self_registration,
    // A set with a frozen snapshot stays published, but never with an active code: issue a new one.
    published_at: published ? s.published_at || new Date().toISOString() : null,
    published_by: published ? s.published_by || null : null,
    join_code: null,
    join_code_active: false,
    registration_open: false,
    archived_at: s.is_current === false ? s.archived_at || s.updated_at || null : null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

const ATTEMPT_STATUSES = ['ready', 'in_progress', 'submitted', 'timed_out', 'organizer_finalized', 'reset'];

/** Structural validation before a restore. Returns normalized data or throws INVALID_BACKUP. */
export function validateBackup(b) {
  const bad = (why) => fail('INVALID_BACKUP', `Invalid backup: ${why}`);
  if (!b || typeof b !== 'object') bad('not an object');
  if (b.app !== APP_ID) bad('not a BRAINFREZE backup file');
  if (![1, 2, 3].includes(b.format_version)) bad(`unsupported format version ${b.format_version}`);
  for (const k of ['teams', 'questions', 'answers', 'events', 'tiebreaks']) if (!Array.isArray(b[k])) bad(`missing ${k}`);
  const rawSections = b.format_version === 1
    ? [{ session: b.session && { ...b.session, section: 'UG' }, settings: b.settings }]
    : b.sessions;
  if (!Array.isArray(rawSections) || rawSections.length === 0) bad('missing sessions');

  const teams = b.teams.map((t, i) => {
    if (!isUuid(t.id)) bad(`team ${i + 1} has no valid id`);
    // Older backups have no college names; they are completed later on the Teams page.
    const { value, ok, errors } = validateTeam(t, b.teams.slice(0, i), null, { requireCollege: false, requirePartner: !t.join_session_id });
    if (!ok) bad(`team ${i + 1}: ${Object.values(errors)[0]}`);
    return {
      ...value, self_registered: !!t.self_registered, id: t.id, created_at: t.created_at, updated_at: t.updated_at,
      join_session_id: isUuid(t.join_session_id) ? t.join_session_id : null, join_request_id: isUuid(t.join_request_id) ? t.join_request_id : null,
    };
  });
  const teamIds = new Set(teams.map((t) => t.id));

  const questions = [...b.questions].sort((x, y) => x.position - y.position).map((q, i) => {
    if (!isUuid(q.id)) bad(`question ${i + 1} has no valid id`);
    const { option_count: _n, ...rest } = q;
    const { value, ok, errors } = validateQuestion(rest);
    if (!ok) bad(`question ${i + 1}: ${Object.values(errors)[0]}`);
    const { option_count: _c, ...stored } = value;
    return { ...stored, id: q.id, position: i + 1, created_at: q.created_at, updated_at: q.updated_at, source_question_id: isUuid(q.source_question_id) ? q.source_question_id : null };
  });
  const questionIds = new Set(questions.map((q) => q.id));
  for (const q of questions) if (q.source_question_id && !questionIds.has(q.source_question_id)) q.source_question_id = null;

  const seenSets = new Set();
  const attempts = [];
  const sets = rawSections.map((item) => {
    const section = String(item?.session?.section || 'UG').toUpperCase();
    if (!SECTIONS.includes(section)) bad('unknown section');
    if (seenSets.has(item?.session?.id)) bad('a quiz set appears twice');
    seenSets.add(item?.session?.id);
    const settingsCheck = validateSettings({ ...DEFAULT_SETTINGS, ...(item.settings || {}) });
    if (!settingsCheck.ok) bad(`${section} settings: ${Object.values(settingsCheck.errors)[0]}`);
    const setQuestions = (Array.isArray(item.set_questions) ? item.set_questions : []).filter((q) => questionIds.has(q.question_id)).map((q) => {
      if (!optionLetters(q).includes(q.correct_option)) bad('a frozen set question has no valid answer key');
      return {
        question_id: q.question_id, position: Number(q.position), question_text: q.question_text, option_a: q.option_a, option_b: q.option_b,
        option_c: q.option_c || null, option_d: q.option_d || null, option_e: q.option_e || null, option_f: q.option_f || null,
        image_url: q.image_url || null, category: q.category || null, correct_option: q.correct_option,
        explanation: q.explanation || null, marks_correct: Number(q.marks_correct), marks_incorrect: Number(q.marks_incorrect),
      };
    });
    const session = restoredSession(item.session, section, questionIds, teamIds, setQuestions.length > 0, bad);
    for (const a of Array.isArray(item.attempts) ? item.attempts : []) {
      if (!teamIds.has(a.team_id)) continue;
      if (!isUuid(a.id) || !ATTEMPT_STATUSES.includes(a.status) || !Array.isArray(a.question_order) || !Array.isArray(a.option_orders)
        || a.question_order.length !== a.option_orders.length) bad('invalid team attempt');
      attempts.push({
        id: a.id, session_id: session.id, team_id: a.team_id, status: a.status, question_order: a.question_order, option_orders: a.option_orders,
        created_at: a.created_at || null, started_at: a.started_at || null, deadline_at: a.deadline_at || null, paused_ms: Number(a.paused_ms) || 0,
        finished_at: a.finished_at || null, finalized_by: a.finalized_by || null, finalize_reason: a.finalize_reason || null,
        reset_at: a.reset_at || null, reset_by: a.reset_by || null, reset_reason: a.reset_reason || null,
      });
    }
    // When this set's clocks were last frozen: its pause, else the export time (shifts restored team deadlines).
    const frozenAt = item.session.status === 'paused' ? item.session.paused_at || b.exported_at : item.session.status === 'running' ? b.exported_at : null;
    return { session, settings: settingsCheck.value, set_questions: setQuestions, frozen_at: frozenAt || null };
  });
  const sessionIds = new Set(sets.map((x) => x.session.id));
  for (const t of teams) if (t.join_session_id && !sessionIds.has(t.join_session_id)) t.join_session_id = null;

  const seen = new Set();
  const answers = b.answers.filter((a) => sessionIds.has(a.session_id)).map((a, i) => {
    if (!teamIds.has(a.team_id) || !questionIds.has(a.question_id)) bad(`answer ${i + 1} references a missing team or question`);
    const key = `${a.session_id}|${a.team_id}|${a.question_id}`;
    if (seen.has(key)) bad(`duplicate answer for team/question in answer ${i + 1}`);
    seen.add(key);
    if (!['correct', 'incorrect', 'unanswered'].includes(a.result)) bad(`answer ${i + 1} result`);
    if (!(a.selected_option === null || OPTIONS.includes(a.selected_option))) bad(`answer ${i + 1} option`);
    return {
      id: isUuid(a.id) ? a.id : uuid(), session_id: a.session_id, team_id: a.team_id, question_id: a.question_id,
      selected_option: a.selected_option, result: a.result, points: Number(a.points), source: a.source === 'participant' ? 'participant' : 'organizer',
      attempt_id: attempts.some((x) => x.id === a.attempt_id) ? a.attempt_id : null,
      displayed_option: OPTIONS.includes(a.displayed_option) ? a.displayed_option : null,
      on_time: typeof a.on_time === 'boolean' ? a.on_time : null,
      created_at: a.created_at, updated_at: a.updated_at,
    };
  });

  const events = b.events.filter((e) => sessionIds.has(e.session_id)).map((e) => ({
    ...e,
    team_id: teamIds.has(e.team_id) ? e.team_id : null,
    question_id: questionIds.has(e.question_id) ? e.question_id : null,
  }));
  const tiebreaks = b.tiebreaks.filter((t) => sessionIds.has(t.session_id) && teamIds.has(t.team_id));

  const team_credentials = (Array.isArray(b.team_credentials) ? b.team_credentials : [])
    .filter((c) => teamIds.has(c.team_id) && /^[A-HJ-NP-Z2-9]{6}$/.test(c.pin));
  return { exported_at: b.exported_at, teams, questions, sets, attempts, answers, events, tiebreaks, team_credentials };
}
