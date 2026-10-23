// Answer options: 2 to 6 per question, lettered A–F in order, without gaps.
import { MAX_OPTIONS, MIN_OPTIONS, OPTIONS, OPTION_FIELDS } from './constants.js';

const filled = (v) => String(v ?? '').trim() !== '';

/**
 * How many options a question has: its explicit option_count (2–6) when given, else up to the last filled option
 * (never fewer than 2). Mirrors public._option_count for stored questions.
 */
export function optionCount(q) {
  const n = Number(q?.option_count);
  if (Number.isInteger(n) && n >= MIN_OPTIONS && n <= MAX_OPTIONS) return n;
  let last = 0;
  OPTIONS.forEach((l, i) => { if (filled(q?.[OPTION_FIELDS[l]])) last = i + 1; });
  return Math.max(MIN_OPTIONS, last);
}

/** The question's option letters, e.g. ['A', 'B', 'C']. */
export const optionLetters = (q) => OPTIONS.slice(0, optionCount(q));

/** Is `letter` one of the question's options? */
export const isOptionOf = (q, letter) => optionLetters(q).includes(letter);
