// Participant join details: pure checks shared by the Join page and the tests. The server (join_quiz) checks again.
export const MAX_NAME = 80;
export const MAX_COLLEGE = 120;

const clean = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
// Must contain a letter; no control characters or angle brackets.
const malformed = (v) => !/\p{L}/u.test(v) || /[\p{Cc}<>]/u.test(v);

/** Trimmed, single-spaced full name and college. */
export const normalizeJoinDetails = (d) => ({ full_name: clean(d.full_name), college_name: clean(d.college_name) });

/** Field errors ({} when valid). */
export function joinDetailsErrors(d) {
  const { full_name: name, college_name: college } = normalizeJoinDetails(d);
  const e = {};
  if (!name) e.full_name = 'Enter your full name.';
  else if (name.length > MAX_NAME) e.full_name = `Your name must be ${MAX_NAME} characters or fewer.`;
  else if (malformed(name)) e.full_name = 'Enter your name using letters (no < or > characters).';
  if (!college) e.college_name = 'Enter your college name.';
  else if (college.length > MAX_COLLEGE) e.college_name = `The college name must be ${MAX_COLLEGE} characters or fewer.`;
  else if (malformed(college)) e.college_name = 'Enter the college name using letters (no < or > characters).';
  return e;
}
