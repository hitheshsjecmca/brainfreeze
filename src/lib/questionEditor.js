// Question editor: pure form logic shared by the editor modal and the tests.
// Options are a list of 2–6 texts labelled A–F in order; removing one relabels the ones after it.
import { DEFAULT_OPTION_COUNT, MAX_OPTIONS, MIN_OPTIONS, OPTIONS, OPTION_FIELDS } from './constants.js';
import { optionCount } from './options.js';
import { validateQuestion } from './validation.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));

/** The editor form for a question (a new one when `q` has no id): options as an array, the key as a letter. */
export function editorForm(q = {}) {
  const n = q.id ? optionCount(q) : (Number.isInteger(q.option_count) ? optionCount(q) : DEFAULT_OPTION_COUNT);
  return {
    question_text: str(q.question_text),
    options: OPTIONS.slice(0, n).map((l) => str(q[OPTION_FIELDS[l]])),
    correct_option: OPTIONS.slice(0, n).includes(str(q.correct_option).toUpperCase()) ? str(q.correct_option).toUpperCase() : '',
    explanation: str(q.explanation),
    image_url: str(q.image_url),
    category: str(q.category),
    marks_correct: str(q.marks_correct),
    marks_incorrect: str(q.marks_incorrect),
    is_sample: !!q.is_sample,
  };
}

export const canAddOption = (form) => form.options.length < MAX_OPTIONS;
export const canRemoveOption = (form) => form.options.length > MIN_OPTIONS;

/** Add an empty option at the end (no-op at six). */
export function addOption(form) {
  return canAddOption(form) ? { ...form, options: [...form.options, ''] } : form;
}

/**
 * Remove the option shown as `letter` (no-op at two). Later options move up one letter. The key follows its option:
 * removing the correct option clears the key (the organizer must choose again); a key after it moves up one letter.
 */
export function removeOption(form, letter) {
  const i = OPTIONS.indexOf(letter);
  if (!canRemoveOption(form) || i < 0 || i >= form.options.length) return form;
  const k = OPTIONS.indexOf(form.correct_option);
  const correct = k < 0 || k === i ? '' : k > i ? OPTIONS[k - 1] : form.correct_option;
  return { ...form, options: form.options.filter((_, j) => j !== i), correct_option: correct };
}

/** The save payload: exactly the active options (later ones null), with option_count. */
export function toPayload(form) {
  return {
    question_text: form.question_text,
    ...Object.fromEntries(OPTIONS.map((l, i) => [OPTION_FIELDS[l], i < form.options.length ? form.options[i] : null])),
    option_count: form.options.length,
    correct_option: form.correct_option,
    explanation: form.explanation,
    image_url: form.image_url,
    category: form.category,
    marks_correct: form.marks_correct,
    marks_incorrect: form.marks_incorrect,
    is_sample: form.is_sample,
  };
}

/** Validation of the form as it will be saved (same rules as the server). */
export const checkForm = (form) => validateQuestion(toPayload(form));

/** True when the form differs from what it was opened with. */
export const isFormDirty = (form, initial) => JSON.stringify(form) !== JSON.stringify(initial);

/**
 * Header lines inside the editor: the saved total, and which question is being edited.
 * `saved` = questions saved in the set (an unsaved question is never counted); `number` = position of an existing question.
 */
export function countLines({ saved, isNew, number, noun = 'this set' }) {
  return {
    total: `Questions in ${noun}: ${saved}`,
    current: isNew ? `New question — Question ${saved + 1}` : `Editing question ${number} of ${saved}`,
  };
}
