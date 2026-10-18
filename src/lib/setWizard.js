// Round 1 set-creation wizard: pure logic shared by the UI and the tests.
// The wizard only edits a DRAFT set through the existing actions (createSet,
// updateQuizDetails, updateSettings, saveQuestion, importQuestions, publishQuiz);
// the server enforces every rule again.
import { DEFAULT_SETTINGS, OPTIONS, SECTIONS } from './constants.js';
import { parseCSVObjects } from './csv.js';
import { publishIssues } from './sets.js';
import { DURATION_ERROR, isValidDurationSeconds, validateQuestion, validateSettings } from './validation.js';

export const WIZARD_STEPS = [
  { key: 'details', label: 'Basic details' },
  { key: 'questions', label: 'Questions' },
  { key: 'rules', label: 'Rules' },
  { key: 'review', label: 'Review & publish' },
];

export const DEFAULT_RULES = Object.freeze({
  duration_minutes: DEFAULT_SETTINGS.duration_seconds / 60,
  marks_correct: DEFAULT_SETTINGS.marks_correct,
  marks_incorrect: DEFAULT_SETTINGS.marks_incorrect,
  marks_unanswered: DEFAULT_SETTINGS.marks_unanswered,
  qualify_count: DEFAULT_SETTINGS.qualify_count,
});

/** A draft set → the wizard's form. `questionIds` = the set's current selection (sessionQuestions order). */
export function formFromSet(session, settings, questionIds) {
  return {
    name: session.name || '',
    description: session.description || '',
    section: session.section || 'UG',
    self_registration: !!session.self_registration,
    question_ids: [...questionIds],
    rules: {
      duration_minutes: Number(settings.duration_seconds) / 60,
      marks_correct: Number(settings.marks_correct),
      marks_incorrect: Number(settings.marks_incorrect),
      marks_unanswered: Number(settings.marks_unanswered),
      qualify_count: Number(settings.qualify_count),
    },
  };
}

/** The form for a set that does not exist yet (step 1 of "New quiz set"). */
export function newSetForm(section = 'UG') {
  return { name: '', description: '', section, self_registration: false, question_ids: [], rules: { ...DEFAULT_RULES } };
}

export function rulesToSettings(rules) {
  return {
    duration_seconds: Math.round(Number(rules.duration_minutes) * 60),
    marks_correct: Number(rules.marks_correct),
    marks_incorrect: Number(rules.marks_incorrect),
    marks_unanswered: Number(rules.marks_unanswered),
    qualify_count: Math.round(Number(rules.qualify_count)),
  };
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Step 1 errors keyed by field. */
export function detailsErrors(form) {
  const errors = {};
  const name = clean(form.name);
  if (!name) errors.name = 'Enter a quiz title.';
  else if (name.length > 80) errors.name = 'The title must be 80 characters or fewer.';
  if (!SECTIONS.includes(form.section)) errors.section = 'Choose the UG or PG section.';
  if (clean(form.description).length > 500) errors.description = 'Instructions must be 500 characters or fewer.';
  return errors;
}

/** A set may have any number of questions; it only needs one. Null when the count is fine. */
export function questionCountIssue(n) {
  return n > 0 ? null : 'Add at least one question.';
}

/** Step 2 problems: count, missing bank questions, incomplete MCQs (missing key, duplicate options…). */
export function questionIssues(ids, bankById) {
  const issues = [];
  const count = questionCountIssue(ids.length);
  if (count) issues.push(count);
  if (new Set(ids).size !== ids.length) issues.push('A question is selected more than once.');
  ids.forEach((id, i) => {
    const q = bankById.get(id);
    if (!q) { issues.push(`Question ${i + 1} no longer exists in the question bank — remove it.`); return; }
    const v = validateQuestion(q);
    if (!v.ok) issues.push(`Question ${i + 1}: ${Object.values(v.errors)[0]}`);
  });
  return issues;
}

/** Step 3 errors keyed by field (the duration check mirrors publish_quiz / update_settings). */
export function rulesErrors(rules) {
  const { errors } = validateSettings({ ...rulesToSettings(rules), accuracy_tiebreak: true });
  const out = {};
  const mins = String(rules.duration_minutes ?? '').trim() === '' ? NaN : Number(rules.duration_minutes);
  if (!(mins > 0) || !isValidDurationSeconds(Math.round(mins * 60))) out.duration_minutes = DURATION_ERROR;
  for (const k of ['marks_correct', 'marks_incorrect', 'marks_unanswered', 'qualify_count']) {
    if (rules[k] === '' || !Number.isFinite(Number(rules[k]))) out[k] = 'Enter a number.';
    else if (errors[k]) out[k] = errors[k];
  }
  return out;
}

/** Problems that stop the organizer leaving `stepKey` with Next (step 4 = everything publishing checks). */
export function stepIssues(stepKey, form, bankById) {
  if (stepKey === 'details') return Object.values(detailsErrors(form));
  if (stepKey === 'questions') return questionIssues(form.question_ids, bankById);
  if (stepKey === 'rules') return Object.values(rulesErrors(form.rules));
  return reviewIssues(form, bankById);
}

/** Everything that blocks publishing (wizard checks + the shared mirror of public.publish_quiz). */
export function reviewIssues(form, bankById) {
  const issues = [
    ...Object.values(detailsErrors(form)),
    ...questionIssues(form.question_ids, bankById),
    ...Object.values(rulesErrors(form.rules)),
  ];
  const questions = form.question_ids.map((id) => bankById.get(id)).filter(Boolean);
  // Count, keys, duplicates and the time limit are already covered above; add the per-question marks check.
  issues.push(...publishIssues({ questions, settings: rulesToSettings(form.rules) }).filter((i) => /invalid marks/.test(i)));
  return issues;
}

/** Non-blocking notes shown on the review step. */
export function reviewWarnings(form, bankById) {
  const qs = form.question_ids.map((id) => bankById.get(id)).filter(Boolean);
  const w = [];
  const samples = qs.filter((q) => q.is_sample).length;
  if (samples) w.push(`${samples} selected question(s) are SAMPLE questions — review or replace them before the event.`);
  const custom = qs.filter((q) => q.marks_correct != null || q.marks_incorrect != null).length;
  if (custom) w.push(`${custom} question(s) have their own marks in the bank; they keep them instead of the set's scoring.`);
  return w;
}

/** The furthest step the organizer may open: every earlier step must be valid. */
export function maxReachableStep(form, bankById) {
  for (let i = 0; i < WIZARD_STEPS.length - 1; i++) {
    if (stepIssues(WIZARD_STEPS[i].key, form, bankById).length) return i;
  }
  return WIZARD_STEPS.length - 1;
}

/** Where to resume an existing draft: the remembered step if still reachable, else the first step with problems. */
export function resumeStep(form, bankById, remembered = null) {
  const max = maxReachableStep(form, bankById);
  if (Number.isInteger(remembered) && remembered >= 0 && remembered < WIZARD_STEPS.length) return Math.min(remembered, max);
  return max;
}

/** Next / Back. Next is refused (with the reasons) while the current step has problems. */
export function goNext(step, form, bankById) {
  const issues = stepIssues(WIZARD_STEPS[step].key, form, bankById);
  if (issues.length) return { step, issues };
  return { step: Math.min(step + 1, WIZARD_STEPS.length - 1), issues: [] };
}
export const goBack = (step) => Math.max(0, step - 1);

/**
 * Server calls needed to save the form as the draft:
 * { details: payload for updateQuizDetails | null, settings: payload for updateSettings | null }.
 * An empty selection cannot be stored (the server needs at least one question), so it is reported, not sent.
 */
export function draftChanges(form, server) {
  const details = {};
  if (clean(form.name) !== clean(server.name)) details.name = clean(form.name);
  if (clean(form.description) !== clean(server.description)) details.description = clean(form.description);
  if (form.section !== server.section) details.section = form.section;
  if (!!form.self_registration !== !!server.self_registration) details.self_registration = !!form.self_registration;
  const idsChanged = form.question_ids.join() !== server.question_ids.join();
  if (idsChanged && form.question_ids.length) details.question_ids = [...form.question_ids];
  const a = rulesToSettings(form.rules);
  const b = rulesToSettings(server.rules);
  const settings = Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== b[k]));
  return {
    details: Object.keys(details).length ? details : null,
    settings: Object.keys(settings).length ? settings : null,
    emptySelection: idsChanged && !form.question_ids.length,
  };
}

/** True while the form has edits the saved draft does not have (compared by meaning: "30" equals 30). */
export function isDirty(form, server) {
  const c = draftChanges(form, server);
  return !!(c.details || c.settings || c.emptySelection);
}

// ---- unsaved edits kept in this browser (per set), so a refresh or navigation never loses them

export const localDraftKey = (setId) => `brainfreze-cold-start:set-wizard:${setId}`;

/** `storage` = localStorage (or a test double). Every access is guarded: storage may be unavailable. */
export function readLocalDraft(storage, setId) {
  try {
    const raw = storage?.getItem(localDraftKey(setId));
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return null;
    const form = v.form && Array.isArray(v.form.question_ids) && v.form.rules ? v.form : null;
    return { step: Number.isInteger(v.step) ? v.step : null, form };
  } catch {
    return null;
  }
}

/** Stores the form and the step while it differs from the saved draft; otherwise only the step. */
export function writeLocalDraft(storage, setId, { form, server, step }) {
  try {
    const value = { step, form: form && server && isDirty(form, server) ? form : null };
    storage?.setItem(localDraftKey(setId), JSON.stringify(value));
  } catch { /* storage full or disabled: the server draft is still saved by Next / Save draft */ }
}

export function clearLocalDraft(storage, setId) {
  try { storage?.removeItem(localDraftKey(setId)); } catch { /* ignore */ }
}

// ---- CSV / JSON question import

export const REQUIRED_QUESTION_COLUMNS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option'];

/** Parse an uploaded CSV or JSON question file into items. Throws an Error with a readable message. */
export function parseQuestionFile(text, fileName = '') {
  const trimmed = String(text ?? '').trim();
  let items;
  if (/\.json$/i.test(fileName) || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('The JSON file could not be read.'); }
    items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : null;
    if (!items) throw new Error('JSON must be an array of questions or an object with a "questions" array.');
  } else {
    items = parseCSVObjects(trimmed);
    const missing = REQUIRED_QUESTION_COLUMNS.filter((h) => items.length && !(h in items[0]));
    if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}`);
  }
  if (!items.length) throw new Error('No questions found in the file.');
  return items;
}

const questionKey = (q) => [q.question_text, q.option_a, q.option_b, q.option_c, q.option_d].map((v) => clean(v).toLowerCase()).join('|');

/**
 * Check parsed rows before importing: per-row validation (line numbers), duplicates
 * inside the file or already in the bank.
 * Import is all-or-nothing: any invalid row blocks it.
 */
export function checkQuestionImport(items, { bank = [] } = {}) {
  const inBank = new Map(bank.map((q) => [questionKey(q), q.id]));
  const seen = new Map();
  const rows = items.map((it, i) => {
    const line = it.__line ?? i + 1;
    const v = validateQuestion(it);
    const errors = Object.values(v.errors);
    const k = questionKey(v.value);
    let duplicate = null;
    if (seen.has(k)) duplicate = `duplicates line ${seen.get(k)}`;
    else if (inBank.has(k)) duplicate = 'already in the question bank';
    if (!seen.has(k)) seen.set(k, line);
    return {
      line, item: it, ok: v.ok, errors, duplicate, bankId: duplicate && inBank.has(k) ? inBank.get(k) : null,
      text: v.value.question_text, key: OPTIONS.includes(v.value.correct_option) ? v.value.correct_option : null,
    };
  });
  // New bank questions to create (first copy of each), and existing bank questions to reuse.
  const toImport = rows.filter((r) => r.ok && !r.duplicate).map((r) => r.item);
  const reuseIds = [...new Set(rows.filter((r) => r.ok && r.bankId).map((r) => r.bankId))];
  const invalid = rows.filter((r) => !r.ok);
  return {
    rows,
    invalid,
    duplicates: rows.filter((r) => r.ok && r.duplicate),
    toImport,
    reuseIds,
    ok: invalid.length === 0,
  };
}

/** Add ids to a selection in order, without duplicates (no upper limit). Returns { ids, added }. */
export function addToSelection(selected, ids) {
  const out = [...selected];
  const seen = new Set(out);
  let added = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    added++;
  }
  return { ids: out, added };
}

/** After an import: ids of the new bank questions that match the imported items (not added by anyone else meanwhile). */
export function importedQuestionIds(beforeIds, questions, items) {
  const keys = new Set(items.map((it) => questionKey(validateQuestion(it).value)));
  return [...questions].sort((a, b) => a.position - b.position)
    .filter((q) => !beforeIds.has(q.id) && keys.has(questionKey(q)))
    .map((q) => q.id);
}

/** Which Set setup view a set gets: the wizard while it is an unpublished, non-archived draft. */
export function setupView(session) {
  if (session.is_current === false) return 'manage';
  return session.published_at ? 'manage' : 'wizard';
}
