import { describe, expect, it } from 'vitest';
import { parseCSV, parseCSVObjects, questionsToCSV, teamTemplateCSV, toCSV } from '../src/lib/csv.js';
import { SAMPLE_QUESTIONS } from '../src/data/sampleQuestions.js';

describe('csv', () => {
  it('parses quoted fields, commas, quotes and newlines', () => {
    const rows = parseCSV('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
  });
  it('strips a UTF-8 byte-order mark (Excel exports)', () => {
    expect(parseCSVObjects(String.fromCharCode(0xfeff) + 'team_number,team_name\n1,A\n')[0]).toMatchObject({ team_number: '1', team_name: 'A' });
  });
  it('neutralizes formula injection on export and round-trips', () => {
    const csv = toCSV(['v'], [['=HYPERLINK("x")'], ['->'], ['-0.25']]);
    expect(csv).toContain("'=HYPERLINK");
    expect(parseCSVObjects(csv).map((r) => r.v)).toEqual(['=HYPERLINK("x")', '->', '-0.25']);
  });
  it('team template has the expected headers', () => {
    expect(parseCSVObjects(teamTemplateCSV())[0]).toMatchObject({ team_number: '1', team_name: 'Example Team One' });
  });
  it('question CSV export round-trips all sample questions', () => {
    const back = parseCSVObjects(questionsToCSV(SAMPLE_QUESTIONS));
    expect(back).toHaveLength(SAMPLE_QUESTIONS.length);
    back.forEach((r, i) => {
      expect(r.question_text).toBe(SAMPLE_QUESTIONS[i].question_text);
      expect(r.option_b).toBe(SAMPLE_QUESTIONS[i].option_b);
      expect(r.correct_option).toBe(SAMPLE_QUESTIONS[i].correct_option);
    });
  });
});
