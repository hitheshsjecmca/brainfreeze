// Round 1 set wizard: step navigation, question/duration validation (no count limits), draft save/resume,
// CSV checks and publishing — driven through the same engine actions the UI calls
// (src/lib/engine.js mirrors the SQL functions).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, sessionQuestions, setView } from '../src/lib/engine.js';
import { DEFAULT_SETTINGS } from '../src/lib/constants.js';
import { questionTemplateCSV } from '../src/lib/csv.js';
import {
  DEFAULT_RULES, WIZARD_STEPS, addToSelection, checkQuestionImport, clearLocalDraft, draftChanges, formFromSet, goBack, goNext,
  importedQuestionIds, isDirty, maxReachableStep, newSetForm, parseQuestionFile, questionCountIssue, readLocalDraft, resumeStep,
  reviewIssues, rulesErrors, rulesToSettings, setupView, stepIssues, writeLocalDraft,
} from '../src/lib/setWizard.js';

const T0 = Date.parse('2026-10-17T09:00:00Z');
const call = (s, name, p = {}, setId = null) => applyAction(s, name, p, setId ? { now: T0, setId } : { now: T0, section: 'UG' });
const run = (...a) => call(...a).state;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const mcq = (i, key = 'ABCD'[i % 4]) => ({ question_text: `Question ${i}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: key });

function world(bankSize = 64) {
  let s = createEmptyState(T0);
  s = run(s, 'importQuestions', { items: Array.from({ length: bankSize }, (_, i) => mcq(i)) });
  const c = call(s, 'createSet', { name: 'UG Morning Set A', section: 'UG' });
  return [c.state, c.result.id];
}
const bankOf = (s) => new Map(s.questions.map((q) => [q.id, q]));
const serverForm = (s, id) => { const v = setView(s, id); return formFromSet(v.session, v.settings, sessionQuestions(v).map((q) => q.id)); };
/** What the wizard's Save draft / Next does: the minimal updateQuizDetails + updateSettings calls. */
function saveDraft(s, id, form) {
  const c = draftChanges(form, serverForm(s, id));
  if (c.details) s = run(s, 'updateQuizDetails', c.details, id);
  if (c.settings) s = run(s, 'updateSettings', c.settings, id);
  return s;
}
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size };
};

describe('wizard steps and navigation', () => {
  it('has four steps in order', () => {
    expect(WIZARD_STEPS.map((x) => x.label)).toEqual(['Basic details', 'Questions', 'Rules', 'Review & publish']);
  });

  it('Next is refused with explicit reasons; Back always works', () => {
    const [s] = world();
    const bank = bankOf(s);
    const form = newSetForm('PG');
    expect(goNext(0, form, bank)).toEqual({ step: 0, issues: ['Enter a quiz title.'] });
    form.name = '  PG Set  ';
    expect(goNext(0, form, bank)).toEqual({ step: 1, issues: [] });
    // step 2 needs at least one question — and nothing more
    const r = goNext(1, form, bank);
    expect(r).toEqual({ step: 1, issues: ['Add at least one question.'] });
    form.question_ids = [s.questions[0].id];
    expect(goNext(1, form, bank).step).toBe(2);
    expect(goNext(2, form, bank).step).toBe(3);
    expect(goNext(3, form, bank).step).toBe(3); // last step: publishing is a separate action
    expect([goBack(3), goBack(1), goBack(0)]).toEqual([2, 0, 0]);
  });

  it('later steps are reachable only when the earlier ones are valid; resume picks the right step', () => {
    const [s, id] = world();
    const bank = bankOf(s);
    const form = serverForm(s, id); // a new draft starts with the whole bank (64) selected — allowed
    expect(form.question_ids).toHaveLength(64);
    expect(maxReachableStep(form, bank)).toBe(3);
    form.rules = { ...form.rules, duration_minutes: '0' };
    expect(maxReachableStep(form, bank)).toBe(2);
    expect(resumeStep(form, bank, 3)).toBe(2); // a remembered step beyond the reachable one is clamped
    form.rules = { ...form.rules, duration_minutes: '30' };
    form.question_ids = [];
    expect(maxReachableStep(form, bank)).toBe(1);
    expect(resumeStep(form, bank)).toBe(1);
    form.question_ids = s.questions.slice(0, 40).map((q) => q.id);
    expect(maxReachableStep(form, bank)).toBe(3);
    expect(resumeStep(form, bank, 2)).toBe(2);
    expect(resumeStep(form, bank)).toBe(3);
  });

  it('the wizard is shown only for unpublished, non-archived sets', () => {
    expect(setupView({ published_at: null })).toBe('wizard');
    expect(setupView({ published_at: '2026-10-17T09:00:00Z' })).toBe('manage');
    expect(setupView({ published_at: null, is_current: false })).toBe('manage');
  });

  it('the new-set route exists and the setup page uses the wizard', () => {
    const app = readFileSync(join(import.meta.dirname, '../src/App.jsx'), 'utf8');
    expect(app).toContain('path="new" element={<NewSetWizard />}');
    const setup = readFileSync(join(import.meta.dirname, '../src/pages/QuizSetup.jsx'), 'utf8');
    expect(setup).toMatch(/setupView\(s\) === 'wizard'/);
    expect(setup).not.toMatch(/function QuestionPicker/);
  });
});

describe('question-count and rules validation', () => {
  it('has no minimum or maximum question count — only "at least one"', () => {
    expect(questionCountIssue(0)).toBe('Add at least one question.');
    for (const n of [1, 2, 29, 30, 60, 61, 250]) expect(questionCountIssue(n)).toBeNull();
  });

  it('no Round 1 setup text mentions a minimum or maximum question count', () => {
    const files = ['../src/components/SetWizard.jsx', '../src/lib/setWizard.js', '../src/lib/sets.js', '../src/lib/rounds.js', '../src/pages/QuizSets.jsx'];
    for (const f of files) {
      const text = readFileSync(join(import.meta.dirname, f), 'utf8');
      expect(text, f).not.toMatch(/30[–-]60|at most 60|minQuestions|maxQuestions|SET_LIMITS/);
    }
  });

  it('flags missing, duplicated and incomplete questions', () => {
    const [s] = world();
    let st = run(s, 'saveQuestion', { ...mcq(900), correct_option: 'B' });
    const bank = bankOf(st);
    const broken = { ...st.questions.at(-1), correct_option: '' }; // e.g. an old row without a key
    bank.set(broken.id, broken);
    const ids = [...st.questions.slice(0, 29).map((q) => q.id), broken.id, 'gone'];
    expect(stepIssues('questions', { ...newSetForm(), question_ids: ids.slice(0, 29) }, bank)).toEqual([]);
    const issues = stepIssues('questions', { ...newSetForm(), question_ids: ids }, bank);
    expect(issues).toContain('Question 30: Choose exactly one correct answer (A–D).');
    expect(issues).toContain('Question 31 no longer exists in the question bank — remove it.');
    expect(stepIssues('questions', { ...newSetForm(), question_ids: [ids[0], ids[0]] }, bank)).toContain('A question is selected more than once.');
  });

  it('rules default to 30 min, +1, −0.25, 0; the duration is any positive number of minutes', () => {
    expect(rulesToSettings(DEFAULT_RULES)).toEqual({ duration_seconds: 1800, marks_correct: 1, marks_incorrect: -0.25, marks_unanswered: 0, qualify_count: DEFAULT_SETTINGS.qualify_count });
    expect(rulesErrors(DEFAULT_RULES)).toEqual({});
    for (const ok of [1, 4, '12.5', 0.5, 45, '121', 300]) expect(rulesErrors({ ...DEFAULT_RULES, duration_minutes: ok }), String(ok)).toEqual({});
    for (const bad of [0, '0', -5, '-1', '', '   ', 'abc', null, 0.001, Infinity]) {
      expect(rulesErrors({ ...DEFAULT_RULES, duration_minutes: bad }).duration_minutes, String(bad)).toBe('The time limit must be a positive number of minutes.');
    }
    expect(rulesToSettings({ ...DEFAULT_RULES, duration_minutes: '12.5' }).duration_seconds).toBe(750);
    expect(rulesErrors({ ...DEFAULT_RULES, marks_incorrect: 0.5 }).marks_incorrect).toMatch(/between −100 and 0/);
    expect(rulesErrors({ ...DEFAULT_RULES, marks_correct: '' }).marks_correct).toBe('Enter a number.');
  });
});

describe('draft persistence', () => {
  it('Save draft stores details, questions and rules on the set; reopening resumes them', () => {
    let [s, id] = world();
    const form = serverForm(s, id);
    form.name = 'UG Morning Set A (final)';
    form.description = 'Read every question carefully.';
    form.question_ids = s.questions.slice(10, 45).map((q) => q.id).reverse();
    form.rules = { ...form.rules, duration_minutes: '20', marks_incorrect: '-0.5' }; // inputs give strings
    expect(isDirty(form, serverForm(s, id))).toBe(true);
    s = saveDraft(s, id, form);
    const reopened = serverForm(s, id);
    expect(isDirty(form, reopened)).toBe(false);
    expect(reopened).toMatchObject({ name: 'UG Morning Set A (final)', description: 'Read every question carefully.', section: 'UG' });
    expect(reopened.question_ids).toEqual(form.question_ids); // order kept
    expect(rulesToSettings(reopened.rules)).toMatchObject({ duration_seconds: 1200, marks_incorrect: -0.5 });
    expect(draftChanges(form, reopened)).toEqual({ details: null, settings: null, emptySelection: false });
    expect(resumeStep(reopened, bankOf(s))).toBe(3);
  });

  it('only changed fields are sent, and an empty selection is never sent', () => {
    const [s, id] = world();
    const server = serverForm(s, id);
    expect(draftChanges({ ...server, rules: { ...server.rules, duration_minutes: '30' } }, server)).toEqual({ details: null, settings: null, emptySelection: false });
    expect(draftChanges({ ...server, section: 'PG' }, server).details).toEqual({ section: 'PG' });
    const empty = draftChanges({ ...server, question_ids: [] }, server);
    expect(empty).toMatchObject({ details: null, emptySelection: true });
    expect(isDirty({ ...server, question_ids: [] }, server)).toBe(true);
  });

  it('unsaved edits survive a reload in this browser and are dropped once saved', () => {
    let [s, id] = world();
    const storage = memoryStorage();
    const server = serverForm(s, id);
    const form = { ...server, name: 'Renamed' };
    writeLocalDraft(storage, id, { form, server, step: 1 });
    expect(readLocalDraft(storage, id)).toEqual({ step: 1, form });
    s = saveDraft(s, id, form);
    writeLocalDraft(storage, id, { form, server: serverForm(s, id), step: 2 });
    expect(readLocalDraft(storage, id)).toEqual({ step: 2, form: null }); // only the step is remembered
    clearLocalDraft(storage, id);
    expect(readLocalDraft(storage, id)).toBeNull();
    // unreadable or unavailable storage never breaks the wizard
    expect(readLocalDraft({ getItem: () => '{bad json' }, id)).toBeNull();
    expect(readLocalDraft({ getItem: () => { throw new Error('denied'); } }, id)).toBeNull();
    expect(() => writeLocalDraft({ setItem: () => { throw new Error('full'); } }, id, { form, server, step: 0 })).not.toThrow();
  });
});

describe('CSV import checks', () => {
  it('parses CSV and JSON and reports missing columns', () => {
    const items = parseQuestionFile(questionTemplateCSV(), 'q.csv');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ correct_option: 'B', __line: 2 });
    expect(parseQuestionFile(JSON.stringify({ questions: [mcq(1)] }), 'q.json')).toHaveLength(1);
    expect(() => parseQuestionFile('question_text,option_a\nx,y', 'q.csv')).toThrow('Missing CSV columns: option_b, option_c, option_d, correct_option');
    expect(() => parseQuestionFile('question_text,option_a,option_b,option_c,option_d,correct_option\n', 'q.csv')).toThrow('No questions found');
    expect(() => parseQuestionFile('{"x":1}', 'q.json')).toThrow(/array of questions/);
  });

  it('validates every row with its line number and blocks the import on any invalid row', () => {
    const csv = [
      'question_text,option_a,option_b,option_c,option_d,correct_option',
      'Valid?,w,x,y,z,c',
      'No key?,w,x,y,z,',
      'Dup options?,same,same,y,z,A',
      ',w,x,y,z,A',
      'Bad key?,w,x,y,z,E',
    ].join('\n');
    const check = checkQuestionImport(parseQuestionFile(csv, 'q.csv'));
    expect(check.ok).toBe(false);
    expect(check.invalid.map((r) => r.line)).toEqual([3, 4, 5, 6]);
    expect(check.invalid[0].errors).toContain('Choose exactly one correct answer (A–D).');
    expect(check.invalid[1].errors.join(' ')).toMatch(/duplicates option A/);
    expect(check.invalid[2].errors).toContain('Question text is required.');
    expect(check.rows[0]).toMatchObject({ ok: true, key: 'C' });
  });

  it('skips duplicates (in the file or already in the bank); every valid row is added (no count limit)', () => {
    const [s] = world(5);
    const items = [mcq(0), mcq(100), mcq(100), mcq(101)];
    const check = checkQuestionImport(items, { bank: s.questions });
    expect(check.ok).toBe(true);
    expect(check.duplicates.map((r) => r.duplicate)).toEqual(['already in the question bank', 'duplicates line 2']);
    expect(check.toImport.map((x) => x.question_text)).toEqual(['Question 100?', 'Question 101?']);
    expect(check.reuseIds).toEqual([s.questions.find((q) => q.question_text === 'Question 0?').id]);
    expect(check).not.toHaveProperty('overflow');
  });

  it('after importing, exactly the imported questions are added to the selection, however many there are', () => {
    const [s0] = world(10);
    const before = new Set(s0.questions.map((q) => q.id));
    let s = run(s0, 'saveQuestion', mcq(500)); // someone else added a question meanwhile
    const items = [mcq(200), mcq(201)];
    s = run(s, 'importQuestions', { items });
    const ids = importedQuestionIds(before, s.questions, items);
    expect(ids.map((x) => s.questions.find((q) => q.id === x).question_text)).toEqual(['Question 200?', 'Question 201?']);
    const big = Array.from({ length: 59 }, (_, i) => `id${i}`);
    expect(addToSelection(big, ids)).toMatchObject({ added: 2 });
    expect(addToSelection(big, ids).ids).toHaveLength(61);
    expect(addToSelection(['a'], ['a', 'b', 'b'])).toEqual({ ids: ['a', 'b'], added: 1 });
  });
});

describe('publishing from the wizard', () => {
  it('an invalid set cannot be published (wizard and server agree)', () => {
    // no questions at all: an empty bank means an empty set
    let s = createEmptyState(T0);
    const c = call(s, 'createSet', { name: 'Empty', section: 'UG' });
    s = c.state;
    expect(reviewIssues(serverForm(s, c.result.id), bankOf(s))).toContain('Add at least one question.');
    expect(code(() => call(s, 'publishQuiz', {}, c.result.id))).toBe('QUESTION_COUNT');
    // a missing title or invalid duration blocks publishing; the server refuses the duration too
    const [s2, id2] = world();
    const form = serverForm(s2, id2);
    expect(reviewIssues({ ...form, name: ' ' }, bankOf(s2))).toEqual(['Enter a quiz title.']);
    expect(reviewIssues({ ...form, rules: { ...form.rules, duration_minutes: '-3' } }, bankOf(s2))).toEqual(['The time limit must be a positive number of minutes.']);
    expect(code(() => call(s2, 'updateSettings', { duration_seconds: 0 }, id2))).toBe('VALIDATION');
  });

  it('a one-question set publishes with a six-digit code and its chosen duration', () => {
    let [s, id] = world();
    const form = serverForm(s, id);
    form.question_ids = [s.questions[3].id];
    form.rules = { ...form.rules, duration_minutes: '7.5' };
    expect(reviewIssues(form, bankOf(s))).toEqual([]);
    s = saveDraft(s, id, form);
    const pub = call(s, 'publishQuiz', {}, id);
    expect(pub.result.join_code).toMatch(/^\d{6}$/);
    const v = setView(pub.state, id);
    expect(sessionQuestions(v).map((q) => q.id)).toEqual([s.questions[3].id]);
    expect(v.settings.duration_seconds).toBe(450);
  });

  it('"Ready to publish" (no review issues) exactly when publishing succeeds: 0, 1, 2, 65 questions and an incomplete MCQ', () => {
    const outcome = (s, id, form) => {
      const ready = reviewIssues(form, bankOf(s)).length === 0;
      let published;
      try { published = /^\d{6}$/.test(call(saveDraft(s, id, form), 'publishQuiz', {}, id).result.join_code); } catch { published = false; }
      return { ready, published };
    };
    // 0 questions (empty bank → empty set)
    const c = call(createEmptyState(T0), 'createSet', { name: 'Empty', section: 'UG' });
    expect(outcome(c.state, c.result.id, serverForm(c.state, c.result.id))).toEqual({ ready: false, published: false });
    for (const count of [1, 2, 65]) {
      const [s, id] = world(70);
      const form = { ...serverForm(s, id), question_ids: s.questions.slice(0, count).map((q) => q.id) };
      expect(outcome(s, id, form), `${count} questions`).toEqual({ ready: true, published: true });
    }
    // an incomplete MCQ (no answer key, e.g. an old row) blocks both
    const [s, id] = world(5);
    const broken = { ...s.questions[1], correct_option: null };
    const st = { ...s, questions: s.questions.map((q) => (q.id === broken.id ? broken : q)) };
    const form = { ...serverForm(st, id), question_ids: [s.questions[0].id, broken.id] };
    expect(outcome(st, id, form)).toEqual({ ready: false, published: false });
  });

  it('a 64-question set (more than the old 60 limit) publishes', () => {
    let [s, id] = world();
    const form = serverForm(s, id);
    expect(form.question_ids).toHaveLength(64);
    expect(reviewIssues(form, bankOf(s))).toEqual([]);
    s = saveDraft(s, id, form);
    expect(call(s, 'publishQuiz', {}, id).result.join_code).toMatch(/^\d{6}$/);
  });

  it('a valid draft publishes with a six-digit code; its questions and rules are then frozen', () => {
    let [s, id] = world();
    const form = serverForm(s, id);
    form.question_ids = s.questions.slice(0, 30).map((q) => q.id);
    expect(reviewIssues(form, bankOf(s))).toEqual([]);
    s = saveDraft(s, id, form);
    const pub = call(s, 'publishQuiz', {}, id);
    s = pub.state;
    expect(pub.result.join_code).toMatch(/^\d{6}$/);
    const v = setView(s, id);
    expect(setupView(v.session)).toBe('manage');
    expect(sessionQuestions(v)).toHaveLength(30);
    expect(code(() => call(s, 'updateQuizDetails', { question_ids: form.question_ids.slice(0, 31) }, id))).toBe('SET_FROZEN');
    expect(code(() => call(s, 'updateSettings', { duration_seconds: 1200 }, id))).toBe('SET_FROZEN');
    // editing the bank afterwards never changes the published snapshot
    const first = form.question_ids[0];
    s = run(s, 'saveQuestion', { ...mcq(0), id: first, question_text: 'Edited later?' });
    expect(sessionQuestions(setView(s, id))[0].question_text).toBe('Question 0?');
  });
});
