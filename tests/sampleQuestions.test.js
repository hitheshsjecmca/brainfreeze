import { describe, expect, it } from 'vitest';
import { SAMPLE_QUESTIONS } from '../src/data/sampleQuestions.js';
import { validateQuestion } from '../src/lib/validation.js';

// Independently written answer list (by meaning, not by letter). If an option
// is reordered without moving the key, this test fails.
const EXPECTED = {
  S01: 'RAM', S02: 'Hexadecimal', S03: '%d', S04: '7', S05: "<class 'list'>",
  S06: 'Stack', S07: '<a>', S08: 'HAVING', S09: 'extends', S10: 'Preemption',
  S11: 'Phishing', S12: 'useState', S13: 'Waterfall', S14: '11', S15: '&',
  S16: '443', S17: '8', S18: 'O(log n)', S19: 'DROP', S20: 'color',
  S21: '32 bits', S22: 'Excessive paging that leaves the CPU doing little useful work', S23: 'Filter network traffic according to security rules', S24: 'key', S25: 'Unit testing',
  S26: '8', S27: 'NULL', S28: 'DNS', S29: 'tuple', S30: 'O(n log n)',
  S31: 'PRIMARY KEY', S32: '"object"', S33: 'Bytecode (.class files)', S34: 'A program in execution', S35: 'Parameterized queries (prepared statements)',
  S36: 'A syntax extension for writing HTML-like markup in JavaScript', S37: 'git commit', S38: 'Local scope', S39: '2', S40: 'Network layer',
  S41: '3', S42: 'In-order', S43: 'Atomicity', S44: 'push()', S45: 'String',
  S46: 'Paging', S47: 'RSA', S48: 'POST', S49: 'Sprint', S50: 'Arithmetic Logic Unit (ALU)',
  S51: 'O(1)', S52: 'LEFT JOIN', S53: 'TCP', S54: 'ls', S55: 'Users get only the access needed to do their job',
  S56: 'alt', S57: '404', S58: 'Requirements and specifications, without looking at internal code', S59: 'Integrated Development Environment', S60: 'Basic Input/Output System',
};

const REQUIRED_TOPICS = ['Programming Fundamentals', 'C Programming', 'Java', 'Python', 'Data Structures & Algorithms', 'DBMS & SQL', 'Computer Networks', 'Operating Systems', 'Cybersecurity', 'HTML, CSS & JavaScript', 'React & Web Development', 'Software Engineering', 'Computer Fundamentals'];

describe('sample question bank', () => {
  it('has at least 50 valid, flagged sample questions', () => {
    expect(SAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(50);
    for (const q of SAMPLE_QUESTIONS) {
      const v = validateQuestion(q);
      expect(v.errors, q.sample_ref).toEqual({});
      expect(q.is_sample).toBe(true);
      expect(q.explanation).toBeTruthy();
    }
  });

  it('answer keys match the independent answer list', () => {
    for (const q of SAMPLE_QUESTIONS) {
      const keyed = q[`option_${q.correct_option.toLowerCase()}`];
      expect(keyed, `${q.sample_ref}: ${q.question_text}`).toBe(EXPECTED[q.sample_ref]);
    }
    expect(Object.keys(EXPECTED)).toHaveLength(SAMPLE_QUESTIONS.length);
  });

  it('covers every required topic and balances answer letters', () => {
    const cats = new Set(SAMPLE_QUESTIONS.map((q) => q.category));
    for (const t of REQUIRED_TOPICS) expect(cats.has(t), t).toBe(true);
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    for (const q of SAMPLE_QUESTIONS) counts[q.correct_option]++;
    expect(counts).toEqual({ A: 15, B: 15, C: 15, D: 15 });
  });
});
