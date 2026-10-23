// Question editor form logic (flexible 2–6 options, key handling, validation, count lines) and participant join details.
import { describe, expect, it } from 'vitest';
import { addOption, canAddOption, canRemoveOption, checkForm, countLines, editorForm, isFormDirty, removeOption, toPayload } from '../src/lib/questionEditor.js';
import { joinDetailsErrors, normalizeJoinDetails } from '../src/lib/joinDetails.js';
import { optionCount, optionLetters } from '../src/lib/options.js';
import { validateQuestion } from '../src/lib/validation.js';

const filled = (n, key = 'A') => {
  let f = editorForm({});
  while (f.options.length < n) f = addOption(f);
  while (f.options.length > n) f = removeOption(f, 'ABCDEF'[f.options.length - 1]);
  return { ...f, question_text: 'Which one?', options: f.options.map((_, i) => `Option ${i + 1}`), correct_option: key };
};

describe('flexible answer options', () => {
  it('a new question starts with four empty options and no key', () => {
    const f = editorForm({});
    expect(f.options).toEqual(['', '', '', '']);
    expect(f.correct_option).toBe('');
  });

  it('supports 2, 3, 4, 5 and 6 options, lettered A–F in order', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const f = filled(n, 'ABCDEF'[n - 1]);
      const c = checkForm(f);
      expect(c.ok, `${n} options`).toBe(true);
      expect(c.value.option_count).toBe(n);
      expect(optionLetters(c.value)).toEqual([...'ABCDEF'.slice(0, n)]);
    }
  });

  it('adding a seventh option is prevented; removing below two is prevented', () => {
    const six = filled(6);
    expect(canAddOption(six)).toBe(false);
    expect(addOption(six)).toBe(six);
    const two = filled(2);
    expect(canRemoveOption(two)).toBe(false);
    expect(removeOption(two, 'A')).toBe(two);
    expect(validateQuestion({ ...toPayload(six), option_count: 7 }).errors.option_count).toMatch(/2 to 6/);
  });

  it('removing an option relabels the later ones and keeps the key on its option', () => {
    const f = { ...filled(5, 'D'), options: ['v', 'w', 'x', 'y', 'z'] };
    const r = removeOption(f, 'B');
    expect(r.options).toEqual(['v', 'x', 'y', 'z']);
    expect(r.correct_option).toBe('C'); // "y" was D, is now C
    expect(removeOption(f, 'E').correct_option).toBe('D'); // a later option: the key is unchanged
  });

  it('removing the correct option clears the key, so saving is refused until a new key is chosen', () => {
    const f = removeOption(filled(4, 'C'), 'C');
    expect(f.correct_option).toBe('');
    const c = checkForm(f);
    expect(c.ok).toBe(false);
    expect(c.errors.correct_option).toMatch(/A–C/);
    expect(checkForm({ ...f, correct_option: 'B' }).ok).toBe(true);
  });

  it('every active option needs text and exactly one available option must be the key', () => {
    const f = filled(3, 'A');
    expect(checkForm({ ...f, options: ['a', '', 'c'] }).errors.option_b).toMatch(/required/);
    expect(checkForm({ ...f, options: ['a', 'A', 'c'] }).errors.option_b).toMatch(/duplicates/);
    expect(checkForm({ ...f, correct_option: 'D' }).errors.correct_option).toBeTruthy(); // D is not one of 3 options
    expect(checkForm({ ...f, question_text: ' ' }).errors.question_text).toBeTruthy();
  });

  it('removed options never reach the saved data', () => {
    const f = removeOption(removeOption(filled(6, 'A'), 'F'), 'E');
    const p = checkForm(f).value;
    expect(p).toMatchObject({ option_count: 4, option_e: null, option_f: null });
    // stale text in a removed slot is dropped too
    expect(validateQuestion({ ...toPayload(f), option_e: 'leftover', option_count: 4 }).value.option_e).toBeNull();
  });

  it('opening an existing question keeps its own options, key and image/category fields', () => {
    const q = { id: 'q1', question_text: 'Q?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: null, correct_option: 'C', image_url: 'https://x/y.png', category: 'Net' };
    const f = editorForm(q);
    expect(f.options).toEqual(['a', 'b', 'c']);
    expect(f).toMatchObject({ correct_option: 'C', image_url: 'https://x/y.png', category: 'Net' });
    expect(optionCount(q)).toBe(3);
    expect(isFormDirty(f, editorForm(q))).toBe(false);
    expect(isFormDirty({ ...f, question_text: 'Changed?' }, editorForm(q))).toBe(true);
  });
});

describe('question count lines inside the editor', () => {
  it('distinguishes the saved total from the question being edited', () => {
    expect(countLines({ saved: 0, isNew: true })).toEqual({ total: 'Questions in this set: 0', current: 'New question — Question 1' });
    expect(countLines({ saved: 7, isNew: true })).toEqual({ total: 'Questions in this set: 7', current: 'New question — Question 8' });
    expect(countLines({ saved: 7, isNew: false, number: 3 })).toEqual({ total: 'Questions in this set: 7', current: 'Editing question 3 of 7' });
  });
});

describe('participant join details', () => {
  it('name and college are required, trimmed and length-checked', () => {
    expect(normalizeJoinDetails({ full_name: '  Asha   Rao ', college_name: ' SJEC ' })).toEqual({ full_name: 'Asha Rao', college_name: 'SJEC' });
    expect(joinDetailsErrors({ full_name: 'Asha', college_name: 'SJEC' })).toEqual({});
    expect(Object.keys(joinDetailsErrors({ full_name: ' ', college_name: '' }))).toEqual(['full_name', 'college_name']);
    expect(joinDetailsErrors({ full_name: 'a'.repeat(81), college_name: 'x' }).full_name).toMatch(/80/);
    expect(joinDetailsErrors({ full_name: 'Asha', college_name: 'c'.repeat(121) }).college_name).toMatch(/120/);
    expect(joinDetailsErrors({ full_name: '<script>', college_name: 'x' }).full_name).toBeTruthy();
    expect(joinDetailsErrors({ full_name: '12345', college_name: 'x' }).full_name).toBeTruthy();
  });
});
