// Error codes are shared by the local demo engine and the Supabase SQL functions.
// SQL functions raise messages in the form "CODE: human readable detail".
export const ERROR_MESSAGES = {
  NOT_AUTHORIZED: 'This account is not authorized for this action.',
  DB_PERMISSION_MISSING: 'The database has not granted signed-in users permission to run this function. Apply the latest permissions migration in Supabase.',
  NO_SESSION: 'No active quiz session was found.',
  QUIZ_NOT_STARTED: 'The quiz has not started yet. Start the quiz before recording answers.',
  QUIZ_ENDED: 'The quiz has ended. Authorize post-time entry/corrections to change scores.',
  TIME_EXPIRED: 'Time has expired. Authorize post-time entry/corrections to change scores.',
  RESULTS_FINALIZED: 'Results are finalized. Reopen results before changing scores.',
  QUIZ_IN_PROGRESS: 'This action is not allowed while the quiz is running or paused.',
  INVALID_STATE: 'That action is not available in the current quiz state.',
  ALREADY_RECORDED: 'An answer is already recorded for this team and question. Use a correction to change it.',
  NO_CHANGE: 'The recorded answer is already the same — nothing changed.',
  REASON_REQUIRED: 'A reason is required for this action.',
  INVALID_OPTION: 'The answer must be A, B, C, D or unanswered.',
  NO_ANSWER_KEY: 'This question has no answer key.',
  TEAM_NOT_FOUND: 'Team not found.',
  QUESTION_NOT_FOUND: 'Question not found.',
  NOTHING_TO_UNDO: 'There is no score action to undo.',
  UNDO_CONFLICT: 'The last action can no longer be undone because the answer has changed since.',
  DUPLICATE_TEAM_NUMBER: 'That team number is already in use in this section.',
  TEAM_CAPACITY: 'The team could not be added.',
  QUIZ_NO_TEAMS: 'Select and confirm the participating teams before starting the set.',
  DUPLICATE_TEAM: 'A team is selected more than once.',
  TEAM_NOT_ELIGIBLE: "Every selected team must be a registered team of this set's section.",
  TEAM_STARTED: 'This team has started the quiz and cannot be removed.',
  SET_NOT_FOUND: 'Quiz set not found.',
  TEAM_HAS_ANSWERS: 'This team has recorded answers. Confirm to delete the team and its answers.',
  QUESTION_HAS_ANSWERS: 'This question has recorded answers. Confirm to delete it and remove those scores.',
  VALIDATION: 'Some fields are invalid.',
  QUIZ_NOT_READY: 'The quiz cannot start until the question bank and teams pass validation.',
  QUIZ_NOT_ENDED: 'End the quiz before confirming the results.',
  QUALIFIER_COUNT: 'The number of highlighted teams is wrong.',
  QUALIFIERS_MISMATCH: 'The selected teams do not match the computed top positions.',
  TIE_UNRESOLVED: 'There is an unresolved tie at the highlight cut-off. Enter tie-break results or give an override reason.',
  NOT_FINALIZED: 'Confirm the results before revealing them.',
  INVALID_BACKUP: 'This file is not a valid BRAINFREZE backup.',
  NETWORK: 'Network error — the action may not have reached the server.',
  // Round 2 trivia board
  TRIVIA_NOT_FOUND: 'That Round 2 topic or question no longer exists.',
  TRIVIA_QUESTION_ACTIVE: 'Another question is open on the board. Finish or cancel it first.',
  TRIVIA_QUESTION_USED: 'This question has already been played.',
  TRIVIA_NOT_SELECTED: 'That question is not the one open on the board.',
  TRIVIA_NOT_REVEALED: 'Reveal the question first.',
  TRIVIA_ALREADY_REVEALED: 'The question is already on screen. Score it, or close it without points.',
  TRIVIA_TEAM_NOT_IN_ROUND: 'That team is not in the Round 2 roster.',
  TRIVIA_HAS_RESULTS: 'This has Round 2 results. Reset Round 2 results first.',
  // participant joining
  QUESTION_NOT_IN_QUIZ: 'That question is not part of this quiz.',
  CODE_GENERATION_FAILED: 'Could not generate a unique join code. Try again.',
  INVALID_CODE: 'That code is not valid. Check the six digits — the quiz may not be published yet, or it has ended.',
  INVALID_TEAM_OR_PIN: 'Team number or PIN is incorrect. Check your team slip or ask an organizer.',
  REGISTRATION_CLOSED: 'Registration is closed. Ask an organizer for help.',
  SELF_REGISTRATION_CLOSED: 'New-team registration is not open. Choose your registered team from the list.',
  TEAM_ALREADY_JOINED: 'This team has already joined on another device. Ask an organizer to release it, then try again.',
  TEAM_NOT_REGISTERED: 'That team is not registered for this section. Ask an organizer for help.',
  SECTION_MISMATCH: 'This quiz is for a different section. Check UG or PG.',
  TEAM_ALREADY_CONNECTED: 'This team is already signed in on another device. Ask an organizer to disconnect it, or wait a minute and try again.',
  TEAM_NAME_TAKEN: 'A team with that name already exists. If it is your team, choose it from the list of registered teams.',
  RATE_LIMITED: 'Too many failed attempts from this network. Wait a few minutes or ask an organizer.',
  SESSION_INVALID: 'This device is no longer signed in to the quiz. Join again with the code and choose your team.',
  SESSION_REVOKED: 'This device was signed out.',
  NOT_ACCEPTING: 'Answers are not being accepted right now.',
  NOT_CURRENT_QUESTION: 'The organizer has moved to a different question.',
  QUESTION_CLOSED: 'This question is closed.',
  ALREADY_SUBMITTED: 'Your team has already answered this question.',
  // registration desk
  REGISTRATION_LOCKED: 'This team has started a quiz, so its registration is locked. Ask an organizer.',
  // quiz sets & attempts
  QUESTION_COUNT: 'A quiz set needs at least one question.',
  SET_FROZEN: 'This set is published: its questions, keys, timer and scoring are frozen.',
  NOT_PUBLISHED: 'Publish the set before going live.',
  QUESTION_IN_PUBLISHED_SET: 'This question is used by a published set. Archive that set first.',
  TEAM_IN_OTHER_SET: 'Your team is already taking part in another quiz set of this section. Ask an organizer.',
  TEAM_NOT_SELECTED: 'Your team is not on the participant list of this quiz. Ask an organizer to add it.',
  NOT_STARTED_YET: 'The quiz has not been opened yet — wait for the organizer, then press Start.',
  ATTEMPT_FINISHED: 'Your team has already submitted this quiz.',
};

export class QuizError extends Error {
  constructor(code, detail) {
    super(detail || ERROR_MESSAGES[code] || code);
    this.name = 'QuizError';
    this.code = code;
  }
}

export function fail(code, detail) {
  throw new QuizError(code, detail);
}

const NETWORK_PATTERNS = /(failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|ECONNRE)/i;

// A database without migration 20261018000100 still enforces the removed 30–60 question rule.
const OUTDATED_COUNT_RULE = /30 to 60|at most 60/;
export const OUTDATED_DATABASE_MESSAGE = 'The database still enforces the old 30–60 question rule. Apply supabase/migrations/20261018000100_round1_simplify_setup.sql to the Supabase project, then publish again.';

// The newest migration always re-applies the complete function permission set (and is safe to re-run).
export const PERMISSIONS_REPAIR_MIGRATION = '20261025000100_manual_team_selection.sql';

// Normalize anything thrown by Supabase / fetch / engine into a QuizError.
export function toQuizError(err) {
  if (err instanceof QuizError) return err;
  const message = String(err?.message || err || 'Unknown error');
  const m = message.match(/^([A-Z][A-Z0-9_]{2,39}):\s*(.*)$/s);
  if (m) {
    if (m[1] === 'QUESTION_COUNT' && OUTDATED_COUNT_RULE.test(m[2])) return new QuizError('QUESTION_COUNT', OUTDATED_DATABASE_MESSAGE);
    return new QuizError(m[1], m[2] || ERROR_MESSAGES[m[1]]);
  }
  if (err?.code === '23505' && /team_number/.test(message)) return new QuizError('DUPLICATE_TEAM_NUMBER');
  // "permission denied for function x" is a missing GRANT in the database (e.g. a migration applied out of
  // order), not a rejected account: the organizer check inside a function raises "NOT_AUTHORIZED: …" instead.
  const fn = message.match(/permission denied for function (\w+)/i);
  if (fn) return new QuizError('DB_PERMISSION_MISSING', `The database does not allow signed-in users to run ${fn[1]} (missing EXECUTE permission — usually a migration applied out of order). Re-run the newest migration, supabase/migrations/${PERMISSIONS_REPAIR_MIGRATION}, in the Supabase SQL Editor; it re-applies every permission and is safe to run again.`);
  if (err?.code === '42501' || /permission denied|row-level security/i.test(message)) return new QuizError('NOT_AUTHORIZED');
  if (NETWORK_PATTERNS.test(message)) return new QuizError('NETWORK', message);
  return new QuizError('UNKNOWN', message);
}

export const isNetworkError = (err) => toQuizError(err).code === 'NETWORK';
