import { describe, expect, it } from 'vitest';
import { applyAction, backupData, createEmptyState, createDemoState, sectionView, setResults } from '../src/lib/engine.js';
import { computeQualification, computeStandings } from '../src/lib/scoring.js';
import { remainingMs, formatClock } from '../src/lib/timer.js';
import { buildBackup } from '../src/lib/backup.js';
import { selectTeams } from './helpers/engine.js';

// Demo state starts with one draft set per section; these tests use the UG set
// (organizer actions without a set id act on the newest UG set).
const ug = (s) => sectionView(s, 'UG');
const withSettings = (s, patch) => ({ ...s, sets: s.sets.map((x) => (x.session.id === ug(s).session.id ? { ...x, settings: { ...x.settings, ...patch } } : x)) });


const T0 = Date.parse('2026-10-14T09:00:00Z');
let rid = 0;
const req = () => `00000000-0000-4000-8000-${String(++rid).padStart(12, '0')}`;

function run(state, name, payload, now = T0) {
  return applyAction(state, name, payload, { now }).state;
}
function expectCode(fn, code) {
  try { fn(); } catch (e) { expect(e.code).toBe(code); return e; }
  throw new Error(`expected ${code}`);
}

// A set needs at least one question to be published; the draft uses the whole bank.
function setupState({ teams = 6, questions = 30 } = {}) {
  let s = createEmptyState(T0);
  for (let i = 1; i <= teams; i++) s = run(s, 'saveTeam', { team_number: i, team_name: `Team ${i}`, participant_1: `P${i}a`, participant_2: `P${i}b`, college_name: 'Test College' });
  for (let i = 1; i <= questions; i++) {
    s = run(s, 'saveQuestion', { question_text: `Q${i}?`, option_a: 'w', option_b: 'x', option_c: 'y', option_d: 'z', correct_option: 'ABCD'[(i - 1) % 4] });
  }
  return selectTeams(s, null, null, T0); // the organiser selects the set's participants
}
const team = (s, n) => s.teams.find((t) => t.section === 'UG' && t.team_number === n);
const qid = (s, pos) => s.questions.find((q) => q.position === pos).id;
const rec = (s, n, pos, sel, now = T0 + 1000, extra = {}) =>
  run(s, 'recordAnswer', { request_id: req(), team_id: team(s, n).id, question_id: qid(s, pos), selected: sel, ...extra }, now);
const standings = (s) => setResults(s, ug(s).session.id, T0 + 10_000);
/** Publish (freeze) the UG set and go live. */
const live = (s, now = T0) => run(run(s, 'publishQuiz', {}, now), 'startQuiz', {}, now);

describe('team management', () => {
  it('prevents duplicate team numbers and enforces two participants', () => {
    const s = setupState({ teams: 2, questions: 1 });
    expectCode(() => run(s, 'saveTeam', { team_number: 2, team_name: 'Dup', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }), 'DUPLICATE_TEAM_NUMBER');
    expectCode(() => run(s, 'saveTeam', { team_number: 3, team_name: 'Solo', participant_1: 'a', participant_2: '', college_name: 'Test College' }), 'VALIDATION');
  });

  it('has no fixed team capacity (import and single saves); team numbers go up to 99999', () => {
    let s = createEmptyState(T0);
    const rows = Array.from({ length: 120 }, (_, i) => ({ team_number: i + 1, team_name: `T${i + 1}`, participant_1: 'a', participant_2: 'b', college_name: 'Test College' }));
    s = run(s, 'importTeams', { rows });
    expect(s.teams).toHaveLength(120);
    s = run(s, 'saveTeam', { team_number: 99999, team_name: 'X', participant_1: 'a', participant_2: 'b', college_name: 'Test College' });
    expect(s.teams).toHaveLength(121);
    expectCode(() => run(s, 'saveTeam', { team_number: 100000, team_name: 'Y', participant_1: 'a', participant_2: 'b', college_name: 'Test College' }), 'VALIDATION');
  });

  it('import is all-or-nothing and rejects duplicate numbers inside the file', () => {
    const s = createEmptyState(T0);
    expectCode(() => run(s, 'importTeams', { rows: [
      { team_number: 1, team_name: 'A', participant_1: 'a', participant_2: 'b', college_name: 'Test College' },
      { team_number: 1, team_name: 'B', participant_1: 'a', participant_2: 'b', college_name: 'Test College' },
    ] }), 'DUPLICATE_TEAM_NUMBER');
  });

  it('requires confirmation to delete a team with recorded answers', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'A');
    expectCode(() => run(s, 'deleteTeam', { id: team(s, 1).id }), 'TEAM_HAS_ANSWERS');
    s = run(s, 'deleteTeam', { id: team(s, 1).id, confirm: true });
    expect(s.answers).toHaveLength(0);
    expect(s.events.at(-1).action).toBe('delete_team');
  });
});

describe('question bank', () => {
  it('validates options, duplicates and key', () => {
    const s = createEmptyState(T0);
    expectCode(() => run(s, 'saveQuestion', { question_text: 'x', option_a: 'a', option_b: 'a', option_c: 'c', option_d: 'd', correct_option: 'A' }), 'VALIDATION');
    expectCode(() => run(s, 'saveQuestion', { question_text: 'x', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_option: 'E' }), 'VALIDATION');
  });

  it('inserts at a position (duplicate below) and reorders', () => {
    let s = setupState({ questions: 3 });
    const q1 = s.questions[0];
    s = run(s, 'saveQuestion', { ...q1, id: undefined, question_text: 'copy', position: 2 });
    expect(s.questions.map((q) => q.question_text)).toEqual(['Q1?', 'copy', 'Q2?', 'Q3?']);
    s = run(s, 'reorderQuestions', { ids: [...s.questions].reverse().map((q) => q.id) });
    expect(s.questions.map((q) => q.question_text)).toEqual(['Q3?', 'Q2?', 'copy', 'Q1?']);
    expect(s.questions.map((q) => q.position)).toEqual([1, 2, 3, 4]);
  });

  it('blocks going live before publishing and publishing without questions; a small set publishes', () => {
    expectCode(() => run(createEmptyState(T0), 'startQuiz', {}), 'NOT_PUBLISHED');
    expectCode(() => run(createEmptyState(T0), 'publishQuiz', {}), 'QUESTION_COUNT');
    expect(applyAction(setupState({ questions: 4 }), 'publishQuiz', {}, { now: T0 }).result.join_code).toMatch(/^\d{6}$/);
  });

  it('bank edits never change a published set; a published key changes only through the audited correction', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'B'); // key A → incorrect
    expect(s.answers[0].result).toBe('incorrect');
    s = run(s, 'saveQuestion', { ...s.questions[0], correct_option: 'B' });
    expect(s.answers[0]).toMatchObject({ result: 'incorrect', points: -0.25 }); // frozen snapshot
    expectCode(() => run(s, 'correctSetQuestion', { question_id: qid(s, 1), correct_option: 'B' }), 'REASON_REQUIRED');
    s = run(s, 'correctSetQuestion', { question_id: qid(s, 1), correct_option: 'B', reason: 'Key typo' });
    expect(s.answers[0]).toMatchObject({ result: 'correct', points: 1 });
    expect(s.events.slice(-2).map((e) => e.action)).toEqual(['key_change', 'rescore']);
  });
});

describe('scoring', () => {
  it('requires the quiz to be started', () => {
    expectCode(() => rec(setupState(), 1, 1, 'A'), 'QUIZ_NOT_STARTED');
  });

  it('scores correct +1, incorrect −0.25, unanswered 0 against the private key', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'A');
    s = rec(s, 1, 2, 'A');
    s = rec(s, 1, 3, null);
    const row = standings(s).find((r) => r.team_number === 1);
    expect(row).toMatchObject({ points: 0.75, correct: 1, incorrect: 1, unanswered: 28 });
  });

  it('prevents duplicate scoring for the same team and question', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'A');
    expectCode(() => rec(s, 1, 1, 'A'), 'ALREADY_RECORDED');
    expectCode(() => rec(s, 1, 1, 'B'), 'ALREADY_RECORDED');
  });

  it('is idempotent for a repeated request id (network retry)', () => {
    let s = live(setupState());
    const payload = { request_id: req(), team_id: team(s, 1).id, question_id: qid(s, 1), selected: 'A' };
    s = run(s, 'recordAnswer', payload);
    const again = applyAction(s, 'recordAnswer', payload, { now: T0 + 2000 });
    expect(again.result.duplicate_request).toBe(true);
    expect(again.state.answers).toHaveLength(1);
    expect(again.state.events.filter((e) => e.action === 'record')).toHaveLength(1);
  });

  it('allows corrections only with a reason and audits them', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'B');
    expectCode(() => rec(s, 1, 1, 'A', T0 + 2000, { correction: true }), 'REASON_REQUIRED');
    expectCode(() => rec(s, 1, 1, 'B', T0 + 2000, { correction: true, reason: 'x' }), 'NO_CHANGE');
    s = rec(s, 1, 1, 'A', T0 + 2000, { correction: true, reason: 'Misread sheet' });
    expect(s.answers[0]).toMatchObject({ selected_option: 'A', result: 'correct', points: 1 });
    expect(s.events.at(-1)).toMatchObject({ action: 'correction', prev_selected: 'B', new_selected: 'A', reason: 'Misread sheet' });
  });

  it('undo reverts the last action as a stack', () => {
    let s = live(setupState());
    s = rec(s, 1, 1, 'B');
    s = rec(s, 1, 1, 'A', T0 + 2000, { correction: true, reason: 'fix' });
    s = rec(s, 2, 1, 'A');
    s = run(s, 'undoLast', { request_id: req() }, T0 + 3000);
    expect(s.answers.find((a) => a.team_id === team(s, 2).id)).toBeUndefined();
    s = run(s, 'undoLast', { request_id: req() }, T0 + 3000);
    expect(s.answers[0]).toMatchObject({ selected_option: 'B', result: 'incorrect', points: -0.25 });
    s = run(s, 'undoLast', { request_id: req() }, T0 + 3000);
    expect(s.answers).toHaveLength(0);
    expectCode(() => run(s, 'undoLast', { request_id: req() }, T0 + 3000), 'NOTHING_TO_UNDO');
    expect(s.events.filter((e) => e.action === 'undo')).toHaveLength(3);
  });

  it('uses configurable scoring (frozen once published)', () => {
    let s = setupState();
    s = run(s, 'updateSettings', { marks_correct: 4, marks_incorrect: -1 });
    expectCode(() => run(s, 'updateSettings', { duration_seconds: 0 }), 'VALIDATION');
    s = live(s);
    expectCode(() => run(s, 'updateSettings', { marks_correct: 2 }), 'SET_FROZEN');
    s = rec(s, 1, 1, 'A');
    s = rec(s, 1, 2, 'A');
    expect(standings(s)[0].points).toBe(3);
  });
});

describe('timer', () => {
  it('derives remaining time from timestamps across pause/resume and reload', () => {
    let s = live(setupState());
    expect(formatClock(remainingMs(ug(s).session, ug(s).settings, T0 + 60_000))).toBe('29:00');
    s = run(s, 'pauseQuiz', {}, T0 + 60_000);
    // Paused: time does not advance, even much later (e.g. after a refresh).
    expect(remainingMs(ug(s).session, ug(s).settings, T0 + 3_600_000)).toBe(29 * 60_000);
    s = run(s, 'resumeQuiz', {}, T0 + 120_000);
    const reloaded = JSON.parse(JSON.stringify(s)); // simulates localStorage / DB round trip
    expect(remainingMs(ug(reloaded).session, ug(reloaded).settings, T0 + 180_000)).toBe(28 * 60_000);
  });

  it('reset timer restores full duration', () => {
    let s = live(setupState());
    s = run(s, 'resetTimer', {}, T0 + 600_000);
    expect(remainingMs(ug(s).session, ug(s).settings, T0 + 600_000)).toBe(1_800_000);
  });

  it('rejects score changes after time expires unless corrections are authorized', () => {
    let s = live(setupState());
    const late = T0 + 1_800_001;
    expectCode(() => rec(s, 1, 1, 'A', late), 'TIME_EXPIRED');
    expectCode(() => run(s, 'setCorrections', { enabled: true }, late), 'REASON_REQUIRED');
    s = run(s, 'setCorrections', { enabled: true, reason: 'Entering paper sheets' }, late);
    s = rec(s, 1, 1, 'A', late);
    expect(s.answers).toHaveLength(1);
    s = run(s, 'endQuiz', {}, late);
    s = run(s, 'setCorrections', { enabled: false }, late);
    expectCode(() => rec(s, 2, 1, 'A', late), 'QUIZ_ENDED');
  });
});

describe('leaderboard, ties and qualification', () => {
  function scoredState() {
    let s = live(setupState({ teams: 7 }));
    // keys: Q1 A, Q2 B, Q3 C, Q4 D
    const sheets = {
      1: ['A', 'B', 'C', 'D'], // 4
      2: ['A', 'B', 'C', 'A'], // 2.75
      3: ['A', 'B', 'C', null], // 3
      4: ['A', 'B', null, null], // 2
      5: ['A', 'B', 'A', 'A'], // 1.5
      6: ['A', 'B', null, null], // 2 (tied with 4)
      7: ['A', null, null, null], // 1
    };
    for (const [n, sheet] of Object.entries(sheets)) sheet.forEach((sel, i) => { s = rec(s, Number(n), i + 1, sel); });
    return run(s, 'endQuiz', {}, T0 + 5000);
  }

  it('sorts by score and shares rank on ties', () => {
    const rows = standings(scoredState());
    expect(rows.map((r) => [r.team_number, r.points, r.rank])).toEqual([
      [1, 4, 1], [3, 3, 2], [2, 2.75, 3], [4, 2, 4], [6, 2, 4], [5, 1.5, 6], [7, 1, 7],
    ]);
  });

  it('fewer incorrect answers no longer breaks ties: equal points and equal time share a rank and are flagged', () => {
    let s = live(setupState({ teams: 2 }));
    // Team 1: 1 correct, 0 wrong = 1. Team 2: 2 correct, 4 wrong = 1. No device attempts → both at the full limit.
    ['A', null, null, null, null, null].forEach((v, i) => { s = rec(s, 1, i + 1, v); });
    ['A', 'B', 'A', 'A', 'B', 'A'].forEach((v, i) => { s = rec(s, 2, i + 1, v); });
    const rows = standings(s);
    expect(rows.map((r) => [r.team_number, r.points, r.rank, r.tie_review])).toEqual([[1, 1, 1, true], [2, 1, 1, true]]);
    expect(rows.every((r) => r.elapsed_ms === 1_800_000)).toBe(true);
    expect(computeStandings({ ...ug(s), questions: ug(s).questions.slice(0, 30), settings: { ...ug(s).settings, accuracy_tiebreak: true } }).map((r) => r.rank)).toEqual([1, 1]);
  });

  it('detects an unresolved tie at the fifth position and never silently eliminates', () => {
    const s = scoredState();
    const q = computeQualification(standings(s), 5);
    // ranks: 1,2,3,4,4,6 → top 5 = 1,3,2,4,6 (rank 4 group fits exactly in slots 4-5)
    expect(q.unresolved).toBe(false);
    expect(q.proposed).toHaveLength(5);
    const q4 = computeQualification(standings(s), 4);
    expect(q4.unresolved).toBe(true);
    expect(q4.tied.map((id) => s.teams.find((t) => t.id === id).team_number).sort()).toEqual([4, 6]);
    expect(q4.certain).toHaveLength(3);
  });

  it('tie-break results resolve the cut-off only when every tied team has one', () => {
    let s = scoredState();
    s = run(s, 'setTiebreak', { team_id: team(s, 4).id, score: 3 });
    let q = computeQualification(standings(s), 4);
    expect(q.unresolved).toBe(true); // team 6 has no tie-break result yet
    s = run(s, 'setTiebreak', { team_id: team(s, 6).id, score: 5 });
    const rows = standings(s);
    expect(rows.find((r) => r.team_number === 6).rank).toBe(4);
    expect(rows.find((r) => r.team_number === 4).rank).toBe(5);
    q = computeQualification(rows, 4);
    expect(q.unresolved).toBe(false);
  });

  it('confirms qualifiers only when valid; override needs a reason; reveal needs confirmation', () => {
    let s = scoredState();
    s = withSettings(s, { qualify_count: 4 });
    expectCode(() => run(s, 'revealResults', { reveal: true }), 'NOT_FINALIZED');
    const ids = (nums) => nums.map((n) => team(s, n).id);
    expectCode(() => run(s, 'confirmQualifiers', { team_ids: ids([1, 3, 2, 4]) }), 'TIE_UNRESOLVED');
    expectCode(() => run(s, 'confirmQualifiers', { team_ids: ids([1, 3, 2, 5]), override_reason: 'x' }), 'QUALIFIERS_MISMATCH');
    expectCode(() => run(s, 'confirmQualifiers', { team_ids: ids([1, 3, 2]) }), 'QUALIFIER_COUNT');
    s = run(s, 'confirmQualifiers', { team_ids: ids([1, 3, 2, 6]), override_reason: 'Buzzer round won by team 6' });
    expect(ug(s).session.status).toBe('finalized');
    expectCode(() => rec(s, 7, 2, 'B', T0 + 9000), 'RESULTS_FINALIZED');
    s = run(s, 'revealResults', { reveal: true });
    expect(ug(s).session).toMatchObject({ results_revealed: true, projector_view: 'reveal' });
  });

  it('supports any number of selected teams (120 here)', () => {
    let s = createEmptyState(T0);
    s = run(s, 'importTeams', { rows: Array.from({ length: 120 }, (_, i) => ({ team_number: i + 1, team_name: `T${i + 1}`, participant_1: 'a', participant_2: 'b', college_name: 'Test College' })) });
    for (let i = 0; i < 30; i++) s = run(s, 'saveQuestion', { question_text: `q${i}`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_option: 'C' });
    s = live(selectTeams(s, null, null, T0));
    for (let n = 1; n <= 120; n++) s = rec(s, n, 1, n % 2 ? 'C' : 'A');
    const rows = standings(s);
    expect(rows).toHaveLength(120);
    expect(rows.filter((r) => r.rank === 1)).toHaveLength(60);
    expect(computeQualification(rows, 5).unresolved).toBe(true);
  });
});

describe('backup', () => {
  it('round-trips through JSON backup and restore', () => {
    let s = live(selectTeams(createDemoState(T0), null, null, T0));
    s = run(s, 'recordAnswer', { request_id: req(), team_id: team(s, 1).id, question_id: s.questions[0].id, selected: 'B' }, T0 + 1000);
    const backup = JSON.parse(JSON.stringify(buildBackup(backupData(s), 'demo')));
    let r = run(createEmptyState(T0), 'restoreBackup', { backup });
    expect(r.teams).toHaveLength(18); // 12 UG + 6 PG demo teams
    expect(r.questions).toHaveLength(60);
    expect(r.answers).toHaveLength(1);
    expect(ug(r).session.status).toBe('paused'); // live sets restore paused
    expect(ug(r).session.published_at).toBeTruthy(); // keeps its frozen snapshot…
    expect(ug(r).session.join_code_active).toBe(false); // …but never an active code
    expect(ug(r).set_questions).toHaveLength(60);
    expect(standings(r)[0].points).toBe(1);
    expect(ug(r).session.team_ids).toEqual(ug(s).session.team_ids); // the chosen participants survive a restore
    const old = JSON.parse(JSON.stringify(backup));
    for (const x of old.sessions) delete x.session.team_ids; // a backup from before manual selection
    r = run(createEmptyState(T0), 'restoreBackup', { backup: old });
    expect(ug(r).session.team_ids).toEqual([team(s, 1).id]); // → the teams that took part
    expectCode(() => run(r, 'restoreBackup', { backup: { app: 'other' } }), 'INVALID_BACKUP');
  });
});
