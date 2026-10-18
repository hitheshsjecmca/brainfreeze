import { MAX_DURATION_SECONDS, MAX_TEAM_NUMBER, OPTIONS, OPTION_FIELDS, SECTIONS } from './constants.js';

const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const optionalNumber = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

export function normalizeTeam(input, defaultSection = 'UG') {
  return {
    section: clean(input.section).toUpperCase() || defaultSection,
    team_number: Number(String(input.team_number ?? '').trim()),
    team_name: clean(input.team_name),
    participant_1: clean(input.participant_1),
    participant_2: clean(input.participant_2),
    college_name: clean(input.college_name) || null,
    is_demo: !!input.is_demo,
  };
}

/**
 * Returns { value, errors } — errors is an object keyed by field.
 * Team numbers are unique and capacity is counted WITHIN a section; pass all
 * teams (any section) as existingTeams. requireCollege is off only for old backups.
 */
export function validateTeam(input, existingTeams = [], editingId = null, { requireCollege = true, defaultSection = 'UG' } = {}) {
  const value = normalizeTeam(input, defaultSection);
  const errors = {};
  const same = existingTeams.filter((t) => (t.section || 'UG') === value.section && t.id !== editingId);
  if (!SECTIONS.includes(value.section)) errors.section = 'Section must be UG or PG.';
  if (!Number.isInteger(value.team_number) || value.team_number < 1 || value.team_number > MAX_TEAM_NUMBER) {
    errors.team_number = `Team number must be a whole number from 1 to ${MAX_TEAM_NUMBER}.`;
  } else if (same.some((t) => t.team_number === value.team_number)) {
    errors.team_number = `Team number ${value.team_number} is already in use in the ${value.section} section.`;
  }
  if (!value.team_name) errors.team_name = 'Team name is required.';
  else if (value.team_name.length > 80) errors.team_name = 'Team name must be 80 characters or fewer.';
  for (const f of ['participant_1', 'participant_2']) {
    if (!value[f]) errors[f] = 'Both participants are required (teams have exactly two members).';
    else if (value[f].length > 80) errors[f] = 'Name must be 80 characters or fewer.';
  }
  if (requireCollege && !value.college_name) errors.college_name = 'College name is required.';
  else if (value.college_name && value.college_name.length > 120) errors.college_name = 'College name must be 120 characters or fewer.';
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

export function normalizeQuestion(input) {
  const value = {
    question_text: clean(input.question_text),
    option_a: clean(input.option_a),
    option_b: clean(input.option_b),
    option_c: clean(input.option_c),
    option_d: clean(input.option_d),
    correct_option: clean(input.correct_option).toUpperCase(),
    explanation: clean(input.explanation) || null,
    image_url: clean(input.image_url) || null,
    category: clean(input.category) || null,
    marks_correct: optionalNumber(input.marks_correct),
    marks_incorrect: optionalNumber(input.marks_incorrect),
    is_sample: !!input.is_sample,
  };
  return value;
}

export function validateQuestion(input) {
  const value = normalizeQuestion(input);
  const errors = {};
  if (!value.question_text) errors.question_text = 'Question text is required.';
  else if (value.question_text.length > 1000) errors.question_text = 'Question text must be 1000 characters or fewer.';
  const seen = new Map();
  for (const letter of OPTIONS) {
    const f = OPTION_FIELDS[letter];
    if (!value[f]) errors[f] = `Option ${letter} is required.`;
    else if (value[f].length > 300) errors[f] = `Option ${letter} must be 300 characters or fewer.`;
    else {
      const k = value[f].toLowerCase();
      if (seen.has(k)) errors[f] = `Option ${letter} duplicates option ${seen.get(k)}.`;
      else seen.set(k, letter);
    }
  }
  if (!OPTIONS.includes(value.correct_option)) errors.correct_option = 'Choose exactly one correct answer (A–D).';
  if (value.image_url && !/^https:\/\//i.test(value.image_url) && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value.image_url)) {
    errors.image_url = 'Image must be an https:// URL (or an uploaded image in demo mode).';
  } else if (value.image_url && value.image_url.length > 700000) {
    errors.image_url = 'Image is too large (max ~500 KB).';
  }
  if (value.explanation && value.explanation.length > 2000) errors.explanation = 'Explanation must be 2000 characters or fewer.';
  for (const f of ['marks_correct', 'marks_incorrect']) {
    const v = value[f];
    if (v !== null && (!Number.isFinite(v) || v < -100 || v > 100)) errors[f] = 'Marks must be a number between −100 and 100.';
  }
  if (value.marks_correct !== null && value.marks_correct < 0) errors.marks_correct = 'Marks for a correct answer cannot be negative.';
  if (value.marks_incorrect !== null && value.marks_incorrect > 0) errors.marks_incorrect = 'Marks for an incorrect answer cannot be positive.';
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

export const DURATION_ERROR = 'The time limit must be a positive number of minutes.';

/** Any positive whole number of seconds (the organizer picks the time limit; only storage bounds it). */
export const isValidDurationSeconds = (d) => Number.isInteger(d) && d >= 1 && d <= MAX_DURATION_SECONDS;

export function validateSettings(input) {
  const value = {
    duration_seconds: Math.round(Number(input.duration_seconds)),
    marks_correct: Number(input.marks_correct),
    marks_incorrect: Number(input.marks_incorrect),
    marks_unanswered: Number(input.marks_unanswered),
    qualify_count: Math.round(Number(input.qualify_count)),
    accuracy_tiebreak: !!input.accuracy_tiebreak,
  };
  const errors = {};
  if (!isValidDurationSeconds(value.duration_seconds)) errors.duration_seconds = DURATION_ERROR;
  if (!(value.marks_correct >= 0 && value.marks_correct <= 100)) errors.marks_correct = 'Correct marks must be between 0 and 100.';
  if (!(value.marks_incorrect >= -100 && value.marks_incorrect <= 0)) errors.marks_incorrect = 'Incorrect marks must be between −100 and 0.';
  if (!(value.marks_unanswered >= -100 && value.marks_unanswered <= 100)) errors.marks_unanswered = 'Unanswered marks must be between −100 and 100.';
  if (!(Number.isInteger(value.qualify_count) && value.qualify_count >= 1)) errors.qualify_count = 'The results highlight must be a whole number of at least 1.';
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

/** Issues that block starting the quiz. Mirrors public.start_quiz checks. */
export function quizReadinessIssues({ teams, questions }) {
  const issues = [];
  if (teams.length === 0) issues.push('Add at least one team.');
  if (questions.length === 0) issues.push('Add at least one question.');
  questions.forEach((q, i) => {
    const { ok, errors } = validateQuestion(q);
    if (!ok) issues.push(`Q${i + 1}: ${Object.values(errors)[0]}`);
  });
  return issues;
}

/** Non-blocking warnings shown before starting. */
export function quizReadinessWarnings({ teams, questions }) {
  const w = [];
  const samples = questions.filter((q) => q.is_sample).length;
  if (samples) w.push(`${samples} question(s) are SAMPLE questions — review or replace them.`);
  const demo = teams.filter((t) => t.is_demo).length;
  if (demo) w.push(`${demo} team(s) are DEMO teams.`);
  return w;
}
