export const APP_ID = 'brainfreze-cold-start';
// 3 = any number of quiz sets (frozen questions + team attempts). Formats 1–2 still restore.
export const BACKUP_FORMAT_VERSION = 3;

// Teams belong to a section; any number of quiz sets per section, each with its own code and results.
export const SECTIONS = ['UG', 'PG'];

// Quiz sets have no question-count limit (at least one valid question to publish).
// The time limit is any positive whole number of seconds that fits quiz_settings.duration_seconds (integer).
export const MAX_DURATION_SECONDS = 2147483647;

export const SET_STAGE_LABELS = { draft: 'Draft', published: 'Published', live: 'Live', completed: 'Completed', archived: 'Archived' };

export const ATTEMPT_STATUS_LABELS = {
  none: 'Not joined',
  ready: 'Joined — not started',
  in_progress: 'In progress',
  submitted: 'Submitted early',
  timed_out: 'Timed out',
  organizer_finalized: 'Organizer-finalized',
  reset: 'Reset',
};
export const SECTION_LABELS = { UG: 'UG (undergraduate)', PG: 'PG (postgraduate)' };

export const OPTIONS = ['A', 'B', 'C', 'D'];
export const OPTION_FIELDS = { A: 'option_a', B: 'option_b', C: 'option_c', D: 'option_d' };

export const MAX_TEAM_NUMBER = 99999; // team numbers 1–99999 (numbering format, not a team limit; no cap per section)

export const DEFAULT_SETTINGS = Object.freeze({
  duration_seconds: 1800,
  marks_correct: 1,
  marks_incorrect: -0.25,
  marks_unanswered: 0,
  qualify_count: 5,
  accuracy_tiebreak: true,
});

export const SESSION_STATUS = Object.freeze({
  SETUP: 'setup',
  RUNNING: 'running',
  PAUSED: 'paused',
  ENDED: 'ended',
  FINALIZED: 'finalized',
});

export const PROJECTOR_VIEWS = ['standby', 'question', 'leaderboard', 'reveal'];

export const RESULT = Object.freeze({ CORRECT: 'correct', INCORRECT: 'incorrect', UNANSWERED: 'unanswered' });

export const STATUS_LABELS = {
  setup: 'Setup',
  running: 'Live',
  paused: 'Paused',
  ended: 'Ended',
  finalized: 'Finalized',
};

export const EVENT_LABELS = {
  record: 'Recorded',
  correction: 'Correction',
  undo: 'Undo',
  rescore: 'Rescored (key changed)',
  delete_team: 'Team deleted',
  delete_question: 'Question deleted',
  authorize: 'Corrections authorization',
  tiebreak: 'Tie-break result',
  qualify: 'Qualifiers confirmed',
  reopen: 'Results reopened',
  restore: 'Backup restored',
  attempt_reset: 'Attempt reset',
  attempt_finalize: 'Attempt finalized',
  key_change: 'Published key changed',
};
