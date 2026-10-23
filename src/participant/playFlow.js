// Participant play screen logic (no React): which finish screen to show, which navigation / submit controls the
// current question gets, the submit confirmation text, and the submit call with safe retries.
import { ERROR_MESSAGES, toQuizError } from '../lib/errors.js';

/** Shown after a submission the server confirmed: manual submit or the timer running out. Never scores or results. */
export const THANK_YOU = {
  title: 'Thank You for Your Participation!',
  message: 'Your quiz has been submitted successfully. Thank you for participating in BRAINFREZE!',
  note: 'You may now wait for further instructions from the organizers.',
};

/**
 * The finish screen for an attempt status reported by the server (or a submission the server just confirmed).
 * Returns null while the attempt is not finished, so nothing claims success before the backend does.
 */
export function finishScreen(status, { confirmed = false } = {}) {
  if (status === 'submitted' || status === 'timed_out' || confirmed) {
    return { kind: 'thank_you', ...THANK_YOU, timedOut: status === 'timed_out' };
  }
  if (status === 'organizer_finalized') {
    return { kind: 'closed', title: 'Quiz closed', message: 'The organizer closed your attempt. Every answer accepted so far is saved.', note: THANK_YOU.note };
  }
  return null;
}

/** Controls for the question at `position` (0-based) of `total`: Submit only on the last one, Next everywhere else. */
export function questionControls(position, total) {
  const last = total > 0 && position === total - 1;
  return { canPrevious: position > 0, showNext: !last, showSubmit: last, isLast: last };
}

/** Answered / unanswered counts and the confirmation sentence for the submit dialog. */
export function submitSummary(answered, total) {
  const unanswered = Math.max(0, total - answered);
  const text = unanswered
    ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} still unanswered and will score as unanswered. `
    : 'Every question is answered. ';
  return { answered, unanswered, text: `${text}After submitting you cannot change any answer.` };
}

/**
 * Submit the quiz: wait for pending answers, then call finish (idempotent on the server), retrying network errors.
 * Resolves to { ok: true } only when the server confirmed; otherwise { ok: false, message } and nothing is lost.
 */
export async function submitQuiz({ finish, settle, retries = 6, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!(await settle())) return { ok: false, message: 'Your last answer is still being saved. Check the connection, then try again.' };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await finish();
      if (res?.ok) return { ok: true, status: res.status };
      return { ok: false, message: `${ERROR_MESSAGES[res?.error] || 'Could not submit.'} Your saved answers are kept.` };
    } catch (e) {
      if (toQuizError(e).code !== 'NETWORK' || attempt === retries - 1) {
        return { ok: false, message: 'Could not reach the server. Your answers are saved; check the connection and try again.' };
      }
      await wait(Math.min(4000, 500 * 2 ** attempt));
    }
  }
  return { ok: false, message: 'Could not submit. Try again.' };
}
