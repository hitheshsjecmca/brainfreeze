// Participant play screen: the thank-you screen (only after the server confirms), Submit Quiz only on the final
// question, the unanswered-question confirmation, and safe submit retries — plus the demo engine behind it
// (manual submit, timer expiry, no automatic submit when the last question is opened).
import { describe, expect, it } from 'vitest';
import { finishScreen, questionControls, submitQuiz, submitSummary, THANK_YOU } from '../src/participant/playFlow.js';
import { applyAction, createEmptyState } from '../src/lib/engine.js';

const T0 = Date.parse('2026-10-23T09:00:00Z');
let r = 0;
const req = () => `9c9c9c9c-0000-4000-8000-${String(++r).padStart(12, '0')}`;
const call = (s, name, p = {}, setId = null, now = T0) => applyAction(s, name, p, setId ? { now, setId } : { now, section: 'UG' });
const run = (...a) => call(...a).state;
const noWait = () => Promise.resolve();
const networkError = () => new TypeError('Failed to fetch');

/** A live set of 5 questions, one participant joined and started. */
function liveAttempt() {
  let s = createEmptyState(T0);
  const c = call(s, 'createSet', { name: 'Finish set', section: 'UG' });
  const id = c.result.id;
  s = c.state;
  for (let i = 1; i <= 5; i++) s = run(s, 'saveSetQuestion', { question_text: `Q${i}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_count: 3, correct_option: 'B' }, id);
  s = run(s, 'updateSettings', { duration_seconds: 600 }, id);
  const pub = call(s, 'publishQuiz', {}, id);
  const j = call(pub.state, 'joinQuiz', { code: pub.result.join_code, full_name: 'Ravi', college_name: 'NITK', request_id: req() });
  s = run(j.state, 'startQuiz', {}, id);
  s = call(s, 'participantStart', { token: j.result.token }).state;
  return { s, id, token: j.result.token };
}
const stateAt = (s, token, position, now = T0 + 1000) => call(s, 'participantState', { token, position }, null, now);

describe('thank-you screen', () => {
  it('a confirmed manual submission shows the thank-you message without results or "watch the main screen"', () => {
    const f = finishScreen('submitted');
    expect(f).toMatchObject({ kind: 'thank_you', title: 'Thank You for Your Participation!', timedOut: false });
    expect(f.message).toBe('Your quiz has been submitted successfully. Thank you for participating in BRAINFREZE!');
    expect(f.note).toBe('You may now wait for further instructions from the organizers.');
    expect(JSON.stringify(f)).not.toMatch(/main screen|score|rank|correct|result/i);
    // the server's confirmation of this device's submit shows it at once, before the next poll
    expect(finishScreen('in_progress', { confirmed: true })).toMatchObject({ kind: 'thank_you', title: THANK_YOU.title });
  });

  it('automatic submission when the timer expires shows the same thank-you message', () => {
    expect(finishScreen('timed_out')).toMatchObject({ kind: 'thank_you', title: THANK_YOU.title, message: THANK_YOU.message, note: THANK_YOU.note, timedOut: true });
  });

  it('nothing claims success while the attempt is not finished on the server', () => {
    for (const status of ['none', 'ready', 'in_progress', undefined]) expect(finishScreen(status)).toBeNull();
    expect(finishScreen('organizer_finalized').kind).toBe('closed');
  });
});

describe('submitting (with retries)', () => {
  it('a confirmed submission resolves ok', async () => {
    let calls = 0;
    const res = await submitQuiz({ finish: async () => { calls++; return { ok: true, status: 'submitted' }; }, settle: async () => true, wait: noWait });
    expect(res).toEqual({ ok: true, status: 'submitted' });
    expect(calls).toBe(1);
  });

  it('a refused submission is not a success and keeps the answers (clear error, retry possible)', async () => {
    const res = await submitQuiz({ finish: async () => ({ ok: false, error: 'NOT_ACCEPTING' }), settle: async () => true, wait: noWait });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not being accepted.*saved answers are kept/i);
    expect(finishScreen('in_progress')).toBeNull(); // the screen stays on the quiz
  });

  it('network errors are retried; a lasting outage fails without a false success', async () => {
    let n = 0;
    const flaky = await submitQuiz({ finish: async () => { if (++n < 3) throw networkError(); return { ok: true, status: 'submitted' }; }, settle: async () => true, wait: noWait });
    expect(flaky.ok).toBe(true);
    expect(n).toBe(3);
    const down = await submitQuiz({ finish: async () => { throw networkError(); }, settle: async () => true, wait: noWait, retries: 3 });
    expect(down).toMatchObject({ ok: false });
    expect(down.message).toMatch(/answers are saved.*try again/i);
  });

  it('does not submit while the last answer is still being saved', async () => {
    let calls = 0;
    const res = await submitQuiz({ finish: async () => { calls++; return { ok: true }; }, settle: async () => false, wait: noWait });
    expect(res.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('retrying after a lost response is safe: the server answers ok for an already submitted attempt', () => {
    const { s, token } = liveAttempt();
    const first = call(s, 'participantFinish', { token }, null, T0 + 5000);
    expect(first.result).toMatchObject({ ok: true, status: 'submitted' });
    const again = call(first.state, 'participantFinish', { token }, null, T0 + 6000);
    expect(again.result).toMatchObject({ ok: true, status: 'submitted', finished_at: first.result.finished_at });
    expect(finishScreen(stateAt(again.state, token, 0, T0 + 7000).result.attempt.status).kind).toBe('thank_you');
  });
});

describe('Submit Quiz only on the final question', () => {
  it('is hidden on questions 1 to N−1 (Next is shown) and appears on question N (Next is hidden)', () => {
    for (let pos = 0; pos < 4; pos++) expect(questionControls(pos, 5)).toMatchObject({ showSubmit: false, showNext: true });
    expect(questionControls(4, 5)).toMatchObject({ showSubmit: true, showNext: false, canPrevious: true });
    expect(questionControls(0, 1)).toMatchObject({ showSubmit: true, showNext: false, canPrevious: false }); // a one-question quiz
  });

  it('jumping between numbered questions updates the controls for the displayed question', () => {
    const jumps = [0, 4, 2, 4, 1];
    expect(jumps.map((p) => questionControls(p, 5).showSubmit)).toEqual([false, true, false, true, false]);
  });

  it('opening the final question never submits: the attempt stays in progress until the participant confirms', () => {
    const { s, token } = liveAttempt();
    const st = stateAt(s, token, 4);
    expect(st.result).toMatchObject({ position: 4, attempt: { status: 'in_progress' } });
    expect(questionControls(st.result.position, st.result.progress.length).showSubmit).toBe(true);
    expect(stateAt(st.state, token, 4, T0 + 3000).result.attempt.status).toBe('in_progress');
    expect(finishScreen(st.result.attempt.status)).toBeNull();
  });

  it('the timer running out submits automatically and shows the thank-you screen', () => {
    const { s, token } = liveAttempt();
    const st = stateAt(s, token, 2, T0 + 601_000);
    expect(st.result.attempt.status).toBe('timed_out');
    expect(finishScreen(st.result.attempt.status)).toMatchObject({ kind: 'thank_you', timedOut: true });
  });
});

describe('unanswered-question confirmation', () => {
  it('says how many questions are still unanswered', () => {
    expect(submitSummary(3, 5)).toMatchObject({ answered: 3, unanswered: 2 });
    expect(submitSummary(3, 5).text).toMatch(/^2 questions are still unanswered/);
    expect(submitSummary(4, 5).text).toMatch(/^1 question is still unanswered/);
    expect(submitSummary(5, 5)).toMatchObject({ unanswered: 0 });
    expect(submitSummary(5, 5).text).toMatch(/^Every question is answered.*cannot change any answer/);
  });

  it('counts come from the server progress of the real attempt', () => {
    const { s, token } = liveAttempt();
    let cur = s;
    for (const pos of [0, 3]) {
      const st = stateAt(cur, token, pos).result;
      cur = call(cur, 'participantSubmit', { token, request_id: req(), question_id: st.question.id, option: 'A' }, null, T0 + 2000).state;
    }
    const progress = stateAt(cur, token, 4).result.progress;
    expect(submitSummary(progress.filter(Boolean).length, progress.length)).toMatchObject({ answered: 2, unanswered: 3 });
  });
});
