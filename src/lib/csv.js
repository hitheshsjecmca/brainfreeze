// Minimal RFC 4180 CSV parser/serializer (quoted fields, embedded commas,
// quotes and newlines). Formula-like cells are prefixed with ' on export to
// prevent spreadsheet formula injection.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Parse CSV with a header row into objects keyed by normalized header names. */
export function parseCSVObjects(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 };
    // Undo the export-side formula-injection guard so CSV round-trips cleanly.
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, ''); });
    return o;
  });
}

function escapeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(headers, rows) {
  return [headers, ...rows].map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

// Required import columns. An optional `section` column must match the section being imported into.
export const TEAM_CSV_HEADERS = ['team_number', 'team_name', 'participant_1', 'participant_2', 'college_name'];
export const TEAM_EXPORT_HEADERS = ['section', ...TEAM_CSV_HEADERS];
// option_e / option_f (and option_c / option_d) may be empty: a question has 2 to 6 options.
export const QUESTION_CSV_HEADERS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f', 'correct_option', 'explanation', 'image_url', 'category', 'marks_correct', 'marks_incorrect'];

export function teamTemplateCSV() {
  return toCSV(TEAM_CSV_HEADERS, [
    [1, 'Example Team One', 'Participant A', 'Participant B', 'Example College'],
    [2, 'Example Team Two', 'Participant C', 'Participant D', 'Example College'],
  ]);
}

export function questionTemplateCSV() {
  return toCSV(QUESTION_CSV_HEADERS, [
    ['Which data structure works first-in, first-out?', 'Stack', 'Queue', 'Tree', 'Graph', '', '', 'B', '', '', 'Data structures', '', ''],
    ['What does CPU stand for?', 'Central Processing Unit', 'Computer Personal Unit', 'Central Program Utility', 'Core Processing Unit', '', '', 'A', '', '', 'Hardware', '', ''],
    ['HTTP is a stateless protocol.', 'True', 'False', '', '', '', '', 'A', '', '', 'Networking', '', ''],
    ['Which of these is NOT a programming language?', 'Python', 'Rust', 'Kotlin', 'Linux', 'Go', 'Swift', 'D', '', '', 'Languages', '', ''],
  ]);
}

export function questionsToCSV(questions) {
  return toCSV(QUESTION_CSV_HEADERS, questions.map((q) => QUESTION_CSV_HEADERS.map((h) => q[h] ?? '')));
}
