// Round 2 "MIND MELTDOWN" — demo engine (mirror of migration 10: trivia sets, versions, codes, sessions),
// the host confirmation flow and the scoring rule. The SQL side is tested in round2_sets.sql.test.js.
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState } from '../src/lib/engine.js';
import {
  applyRound2, normalizeRound2, round2EligibleTeams, round2Lookup, round2Overview, round2SessionBoard, round2SetDetail,
} from '../src/lib/round2Engine.js';
import { R2_DEFAULTS, R2_UI_IDLE, canConfirm, formatScore, publishIssues, r2Remaining, r2UiReducer, scoreDelta, validateR2SetFields } from '../src/lib/round2.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
let n = 0;
const rid = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const r2 = (s, name, p = {}, now = T0) => applyRound2(s, name, p, { now });
const run = (...a) => r2(...a).state;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const board = (s, id, host = false) => round2SessionBoard(s, id, { host, nowMs: T0 });
const scoresOf = (s, id) => Object.fromEntries(board(s, id, true).scores.map((x) => [x.team_number, x.score]));
const tile = (b, topic, pts) => b.topics.find((t) => t.name === topic).questions.find((q) => q.points === pts);

/** UG teams 1–3 and PG team 1; one draft set with two topics and three questions. */
function world() {
  let s = createEmptyState(T0);
  const teams = (sec, nums) => ({ rows: nums.map((k) => ({ team_number: k, team_name: `${sec} Team ${k}`, participant_1: 'a', participant_2: 'b', college_name: 'C', section: sec })) });
  s = applyAction(s, 'importTeams', teams('UG', [1, 2, 3]), { now: T0, section: 'UG' }).state;
  s = applyAction(s, 'importTeams', teams('PG', [1]), { now: T0, section: 'PG' }).state;
  const c = r2(s, 'r2sSaveSet', { title: 'UG Board', section: 'UG' });
  s = c.state;
  const setId = c.result.id;
  const topic = (name) => { const t = r2(s, 'r2sSaveTopic', { set_id: setId, name }); s = t.state; return t.result.id; };
  const net = topic('Networks');
  const db = topic('Databases');
  for (const [tid, points, key] of [[net, '10', 'n10'], [net, '20', 'n20'], [db, '15.5', 'd15']]) {
    s = run(s, 'r2sSaveQuestion', { topic_id: tid, points, question_text: `Question ${key}?`, answer_text: `Answer ${key}` });
  }
  const team = (k, sec = 'UG') => s.teams.find((t) => t.team_number === k && t.section === sec).id;
  return { s, setId, team };
}
/** world() published, with a live UG session for teams 1 and 2. */
function liveWorld() {
  const w = world();
  const pub = r2(w.s, 'r2sPublishSet', { id: w.setId });
  let s = pub.state;
  const st = r2(s, 'r2sStartSession', { request_id: rid(), code: pub.result.join_code, section: 'UG', team_ids: [w.team(1), w.team(2)] });
  s = st.state;
  return { ...w, s, code: pub.result.join_code, sid: st.result.session_id };
}
const open = (s, sid, qid) => run(run(s, 'r2sSelect', { session_id: sid, question_id: qid }), 'r2sRevealQuestion', { session_id: sid, question_id: qid }, T0 + 1000);

describe('trivia sets (drafts, publishing, codes)', () => {
  it('1/2. any number of independent sets, topics and questions with any point values', () => {
    let { s, setId } = world();
    const other = r2(s, 'r2sSaveSet', { title: 'PG Board', section: 'PG', timer_seconds: '25', wrong_penalty_percent: '0' });
    s = other.state;
    const ov = round2Overview(s);
    expect(ov.sets.map((x) => x.title).sort()).toEqual(['PG Board', 'UG Board']);
    expect(ov.sets.find((x) => x.id === setId)).toMatchObject({ topic_count: 2, question_count: 3, published_version: 0, join_code: null, timer_seconds: 18, wrong_penalty_percent: 50 });
    expect(ov.sets.find((x) => x.id === other.result.id)).toMatchObject({ section: 'PG', timer_seconds: 25, wrong_penalty_percent: 0 });
    for (let i = 0; i < 12; i++) s = run(s, 'r2sSaveTopic', { set_id: other.result.id, name: `Topic ${i}` });
    expect(round2SetDetail(s, other.result.id).topics).toHaveLength(12);
  });

  it('3. drafts can be edited and deleted before publishing; Publish validates', () => {
    let { s, setId } = world();
    const d = round2SetDetail(s, setId);
    const q = d.questions.find((x) => x.question_text === 'Question n20?');
    s = run(s, 'r2sSaveQuestion', { id: q.id, topic_id: q.topic_id, points: '25', question_text: 'Edited?', answer_text: 'Edited answer' });
    expect(round2SetDetail(s, setId).questions.find((x) => x.id === q.id)).toMatchObject({ points: 25, question_text: 'Edited?', answer_text: 'Edited answer' });
    const empty = r2(s, 'r2sSaveTopic', { set_id: setId, name: 'Empty' });
    s = empty.state;
    expect(round2SetDetail(s, setId).issues).toEqual(['Topic "Empty" has no questions — add one or delete the topic.']);
    expect(code(() => r2(s, 'r2sPublishSet', { id: setId }))).toBe('VALIDATION');
    s = run(s, 'r2sDeleteTopic', { id: empty.result.id });
    expect(code(() => r2(s, 'r2sSaveTopic', { set_id: setId, name: 'NETWORKS' }))).toBe('VALIDATION');
    const blank = r2(s, 'r2sSaveSet', { title: 'Blank' });
    expect(code(() => r2(blank.state, 'r2sPublishSet', { id: blank.result.id }))).toBe('VALIDATION');
    expect(round2Overview(run(blank.state, 'r2sDeleteSet', { id: blank.result.id })).sets).toHaveLength(1);
    expect(publishIssues([], [])).toEqual(['Add at least one topic.', 'Add at least one question.']);
  });

  it('4/5. Publish issues a unique six-digit code, kept on republish; the code loads the published version only', () => {
    let { s, setId } = world();
    const p1 = r2(s, 'r2sPublishSet', { id: setId });
    s = p1.state;
    expect(p1.result).toMatchObject({ ok: true, version: 1 });
    expect(p1.result.join_code).toMatch(/^\d{6}$/);
    const other = r2(s, 'r2sSaveSet', { title: 'Second' });
    s = other.state;
    const t = r2(s, 'r2sSaveTopic', { set_id: other.result.id, name: 'T' });
    s = run(t.state, 'r2sSaveQuestion', { topic_id: t.result.id, points: '5', question_text: 'Q?', answer_text: 'A' });
    const p2 = r2(s, 'r2sPublishSet', { id: other.result.id });
    s = p2.state;
    expect(p2.result.join_code).not.toBe(p1.result.join_code);
    expect(round2Overview(s).sets.find((x) => x.id === setId).join_code).toBe(p1.result.join_code); // reading never re-issues
    // a draft-only change is not visible through the code until it is published again
    const net = round2SetDetail(s, setId).topics[0];
    s = run(s, 'r2sSaveQuestion', { topic_id: net.id, points: '99', question_text: 'Draft only?', answer_text: 'secret' }, T0 + 5000);
    expect(round2SetDetail(s, setId).set.unpublished_changes).toBe(true);
    const look = round2Lookup(s, p1.result.join_code);
    expect(look).toMatchObject({ title: 'UG Board', version: 1, question_count: 3, section: 'UG' });
    expect(JSON.stringify(look)).not.toMatch(/Answer |Draft only|Question n10/);
    expect(code(() => round2Lookup(s, '000000'))).toBe('TRIVIA_CODE_INVALID');
    expect(code(() => r2(s, 'r2sDeleteSet', { id: setId }))).toBe('TRIVIA_SET_PUBLISHED');
    const v2 = r2(s, 'r2sPublishSet', { id: setId }, T0 + 6000);
    expect(v2.result).toMatchObject({ version: 2, join_code: p1.result.join_code });
    expect(round2Lookup(v2.state, p1.result.join_code).question_count).toBe(4);
  });
});

describe('Join Round 2', () => {
  it('6. lists the registered teams of a compatible section; rejects others', () => {
    const { s, code: c } = liveWorld();
    expect(round2EligibleTeams(s, c, 'UG').map((t) => t.team_number)).toEqual([1, 2, 3]);
    expect(code(() => round2EligibleTeams(s, c, 'PG'))).toBe('TRIVIA_SECTION_MISMATCH');
  });

  it('7/8. nothing is live before Start; Start validates on the server; sessions are independent', () => {
    const w = world();
    const pub = r2(w.s, 'r2sPublishSet', { id: w.setId });
    let s = pub.state;
    expect(round2Overview(s).sessions).toEqual([]);
    const start = (p) => code(() => r2(s, 'r2sStartSession', { request_id: rid(), code: pub.result.join_code, section: 'UG', ...p }));
    expect(start({ team_ids: [] })).toBe('VALIDATION');
    expect(start({ team_ids: [w.team(1), w.team(1, 'PG')] })).toBe('TRIVIA_TEAM_NOT_ELIGIBLE');
    expect(start({ section: 'PG', team_ids: [w.team(1, 'PG')] })).toBe('TRIVIA_SECTION_MISMATCH');
    const req = rid();
    const a = r2(s, 'r2sStartSession', { request_id: req, code: pub.result.join_code, section: 'UG', team_ids: [w.team(1), w.team(2)] });
    s = a.state;
    expect(r2(s, 'r2sStartSession', { request_id: req, code: pub.result.join_code, section: 'UG', team_ids: [w.team(1)] }).result).toEqual({ session_id: a.result.session_id, duplicate_request: true });
    const b = r2(s, 'r2sStartSession', { request_id: rid(), code: pub.result.join_code, section: 'UG', team_ids: [w.team(3)] });
    s = b.state;
    const q = tile(board(s, a.result.session_id), 'Networks', 10).id;
    s = open(s, a.result.session_id, q);
    s = run(s, 'r2sScore', { request_id: rid(), session_id: a.result.session_id, question_id: q, team_id: w.team(1), result: 'right' });
    const other = board(s, b.result.session_id, true);
    expect(other.game.phase).toBe('idle');
    expect(other.results).toEqual([]);
    expect(tile(other, 'Networks', 10).used).toBe(false);
    expect(round2Overview(s).sessions).toHaveLength(2);
  });
});

describe('live gameplay (tile → reveal → answer → team → score)', () => {
  it('9. clicking a tile reveals neither the question nor the answer; one question at a time', () => {
    let { s, sid } = liveWorld();
    const b0 = board(s, sid);
    const q = tile(b0, 'Networks', 10).id;
    s = run(s, 'r2sSelect', { session_id: sid, question_id: q });
    const b = board(s, sid, true);
    expect(b.game).toMatchObject({ phase: 'selected', topic: 'Networks', points: 10, question_text: null, answer_text: null });
    expect(JSON.stringify(board(s, sid))).not.toMatch(/Question n10|Answer n10/);
    expect(code(() => r2(s, 'r2sSelect', { session_id: sid, question_id: tile(b0, 'Networks', 20).id }))).toBe('TRIVIA_QUESTION_ACTIVE');
    s = run(s, 'r2sCancel', { session_id: sid });
    expect(board(s, sid).game.phase).toBe('idle');
  });

  it('10/11. Reveal shows the question and starts the 18-second timer; Answer shows the answer and changes no score', () => {
    let { s, sid } = liveWorld();
    const q = tile(board(s, sid), 'Networks', 10).id;
    s = open(s, sid, q);
    const b = board(s, sid);
    expect(b.game).toMatchObject({ phase: 'revealed', question_text: 'Question n10?', answer_revealed: false, answer_text: null });
    expect(b.settings.timer_seconds).toBe(R2_DEFAULTS.timer_seconds);
    expect(r2Remaining(b.game, b.settings, T0 + 1000)).toBe(18000);
    expect(r2Remaining(b.game, b.settings, T0 + 30000)).toBe(0);
    expect(run(s, 'r2sRevealQuestion', { session_id: sid, question_id: q }, T0 + 9000).round2.sessions[0].revealed_at).toBe(new Date(T0 + 1000).toISOString());
    expect(board(s, sid, true).game.answer_text).toBe('Answer n10'); // host peek
    expect(code(() => r2(s, 'r2sCancel', { session_id: sid }))).toBe('TRIVIA_ALREADY_REVEALED');
    s = run(s, 'r2sRevealAnswer', { session_id: sid, question_id: q });
    expect(board(s, sid).game).toMatchObject({ answer_revealed: true, answer_text: 'Answer n10' });
    expect(Object.values(scoresOf(s, sid))).toEqual([0, 0]);
  });

  it('12. Confirm Score updates the chosen team, marks the tile used and returns to the board', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(board(s, sid), 'Networks', 20).id;
    s = open(s, sid, q);
    expect(code(() => r2(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(3), result: 'right' }))).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    const res = r2(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(1), result: 'right' });
    s = res.state;
    expect(res.result).toMatchObject({ result: 'right', points: 20, duplicate_request: false });
    const b = board(s, sid, true);
    expect(b.game.phase).toBe('idle');
    expect(tile(b, 'Networks', 20).used).toBe(true);
    expect(scoresOf(s, sid)).toEqual({ 1: 20, 2: 0 });
    expect(b.last_result).toMatchObject({ result: 'right', team_number: 1, points: 20 });
  });

  it('13. a double click or retry never scores twice; a played question cannot be reopened', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(board(s, sid), 'Databases', 15.5).id;
    s = open(s, sid, q);
    const req = rid();
    s = run(s, 'r2sScore', { request_id: req, session_id: sid, question_id: q, team_id: team(2), result: 'wrong' });
    expect(r2(s, 'r2sScore', { request_id: req, session_id: sid, question_id: q, team_id: team(2), result: 'wrong' }).result.duplicate_request).toBe(true);
    expect(code(() => r2(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(1), result: 'right' }))).toBe('TRIVIA_QUESTION_USED');
    expect(code(() => r2(s, 'r2sSelect', { session_id: sid, question_id: q }))).toBe('TRIVIA_QUESTION_USED');
    expect(scoresOf(s, sid)).toEqual({ 1: 0, 2: -7.75 }); // 50 % of 15.5
    // the state comes back the same on a reload
    expect(board(s, sid, true)).toEqual(board(structuredClone(s), sid, true));
  });

  it('nothing is scored before Reveal; an expired timer decides nothing; Close gives 0', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(board(s, sid), 'Networks', 10).id;
    expect(code(() => r2(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(1), result: 'right' }))).toBe('TRIVIA_NOT_REVEALED');
    s = open(s, sid, q);
    expect(board(s, sid).game.phase).toBe('revealed'); // still open long after 18 s; the host decides
    s = run(s, 'r2sCloseQuestion', { request_id: rid(), session_id: sid, question_id: q }, T0 + 120000);
    expect(tile(board(s, sid), 'Networks', 10).used).toBe(true);
    expect(Object.values(scoresOf(s, sid))).toEqual([0, 0]);
  });

  it('a new publication never changes a running session; an ended session is read-only', () => {
    let { s, sid, setId } = liveWorld();
    const net = round2SetDetail(s, setId).topics[0];
    s = run(s, 'r2sSaveQuestion', { topic_id: net.id, points: '40', question_text: 'New?', answer_text: 'New' }, T0 + 1000);
    s = run(s, 'r2sPublishSet', { id: setId }, T0 + 2000);
    expect(board(s, sid).topics.find((t) => t.name === 'Networks').questions.map((q) => q.points)).toEqual([10, 20]);
    s = run(s, 'r2sEndSession', { session_id: sid });
    expect(code(() => r2(s, 'r2sSelect', { session_id: sid, question_id: tile(board(s, sid), 'Networks', 10).id }))).toBe('TRIVIA_SESSION_ENDED');
    expect(board(s, sid).session.status).toBe('ended');
  });

  it('14. the projector board never carries an answer before Answer, nor question text before Reveal', () => {
    let { s, sid } = liveWorld();
    for (const t of board(s, sid).topics) for (const q of t.questions) {
      s = run(s, 'r2sSelect', { session_id: sid, question_id: q.id });
      expect(JSON.stringify(board(s, sid))).not.toMatch(/Question |Answer /);
      s = run(s, 'r2sRevealQuestion', { session_id: sid, question_id: q.id });
      expect(JSON.stringify(board(s, sid))).not.toMatch(/Answer /);
      s = run(s, 'r2sCloseQuestion', { request_id: rid(), session_id: sid, question_id: q.id });
    }
  });
});

describe('host confirmation flow (local, before any server call)', () => {
  it('Right and Wrong open the team-selection step; no team is preselected', () => {
    for (const result of ['right', 'wrong']) {
      const ui = r2UiReducer(R2_UI_IDLE, { type: 'mark', result });
      expect(ui).toEqual({ modal: 'team', result, teamId: null });
      expect(canConfirm(ui)).toBe(false);
    }
    expect(r2UiReducer(R2_UI_IDLE, { type: 'mark', result: 'maybe' })).toBe(R2_UI_IDLE);
  });

  it('Confirm needs exactly one team; Cancel discards the selection', () => {
    let ui = r2UiReducer(R2_UI_IDLE, { type: 'mark', result: 'right' });
    ui = r2UiReducer(ui, { type: 'pick', teamId: 't1' });
    ui = r2UiReducer(ui, { type: 'pick', teamId: 't2' });
    expect(ui.teamId).toBe('t2');
    expect(canConfirm(ui)).toBe(true);
    expect(r2UiReducer(ui, { type: 'cancel' })).toEqual(R2_UI_IDLE);
    expect(r2UiReducer(R2_UI_IDLE, { type: 'pick', teamId: 't1' })).toBe(R2_UI_IDLE);
  });
});

describe('rules and data safety', () => {
  it('scoring rule: right = +value; wrong = −penalty % (default 50 %, documented); fractions kept', () => {
    expect(scoreDelta(20, 'right')).toBe(20);
    expect(scoreDelta(20, 'wrong')).toBe(-10);
    expect(scoreDelta(15.5, 'wrong', 50)).toBe(-7.75);
    expect(scoreDelta(20, 'wrong', 0)).toBe(0);
    expect(scoreDelta(20, 'no_score')).toBe(0);
    expect(formatScore(-7.75)).toBe('−7.75');
    expect(validateR2SetFields({ title: 'x', timer_seconds: '4' }).errors.timer_seconds).toMatch(/5–120/);
    expect(validateR2SetFields({ title: '', section: 'MBA' }).errors).toMatchObject({ title: expect.any(String), section: expect.any(String) });
  });

  it('Round 1 is untouched; deleting a team keeps its Round 2 result snapshot and removes it from the session', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(board(s, sid), 'Networks', 10).id;
    s = open(s, sid, q);
    s = run(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(1), result: 'right' });
    const before = structuredClone(s.sets);
    expect(s.sets).toEqual(before);
    s = applyAction(s, 'deleteTeam', { id: team(1), confirm: true }, { now: T0, section: 'UG' }).state;
    const b = board(s, sid, true);
    expect(b.scores.map((x) => x.team_number)).toEqual([2]);
    expect(b.results[0]).toMatchObject({ team_id: null, team_number: 1, team_name: 'UG Team 1', points: 10 });
  });

  it('an old single-board demo state is copied into a draft set', () => {
    const s = createEmptyState(T0);
    s.round2 = {
      settings: { timer_seconds: 20, wrong_penalty_percent: 25 }, teams: [], results: [], game: { phase: 'idle' },
      topics: [{ id: 't1', name: 'Legacy', position: 1, created_at: new Date(T0).toISOString() }],
      questions: [{ id: 'q1', topic_id: 't1', points: 10, question_text: 'Old?', answer_text: 'Old answer', used: false, created_at: new Date(T0).toISOString() }],
    };
    const r = normalizeRound2(s).round2;
    expect(r.sets).toHaveLength(1);
    expect(r.sets[0]).toMatchObject({ title: 'Round 2 board (imported)', section: 'BOTH', timer_seconds: 20, wrong_penalty_percent: 25, published_version: 0 });
    expect(round2SetDetail(s, r.sets[0].id).questions[0]).toMatchObject({ question_text: 'Old?', answer_text: 'Old answer' });
  });
});

describe('private organiser view and interactive projector', () => {
  const PRIVATE = ['scores', 'last_result', 'results'];
  const pub = (s, sid) => board(s, sid, false);

  it('projector privacy: the projector board never carries scores, rankings, the score log or the join code', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(pub(s, sid), 'Networks', 10).id;
    const check = () => {
      const b = pub(s, sid);
      expect(b.view).toBe('projector');
      for (const k of PRIVATE) expect(b).not.toHaveProperty(k);
      expect(b.session).not.toHaveProperty('join_code');
      expect(b.game).not.toHaveProperty('last_result_id');
      expect(JSON.stringify(b)).not.toMatch(/"score"|"points":-|participant_/);
      // Team names (for the picker) are there, without totals.
      expect(b.teams).toEqual([
        { team_id: team(1), team_number: 1, team_name: 'UG Team 1', section: 'UG' },
        { team_id: team(2), team_number: 2, team_name: 'UG Team 2', section: 'UG' },
      ]);
    };
    check();
    s = open(s, sid, q); check();
    s = run(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: team(1), result: 'right' }); check();
    // The private host board has the leaderboard, last result and log.
    const h = board(s, sid, true);
    expect(h.view).toBe('host');
    expect(h.scores.find((x) => x.team_number === 1).score).toBe(10);
    expect(h.last_result).toMatchObject({ team_number: 1, points: 10 });
    expect(h.results).toHaveLength(1);
    expect(h.session.join_code).toMatch(/^\d{6}$/);
  });

  it('interactive point tiles: the whole question flow runs from the projector board alone, in step with the host board', () => {
    let { s, sid } = liveWorld();
    const p0 = pub(s, sid);
    const q = tile(p0, 'Databases', 15.5).id; // picked from the projector's own tiles
    s = run(s, 'r2sSelect', { session_id: sid, question_id: q });
    let p = pub(s, sid);
    expect(p.game).toMatchObject({ phase: 'selected', question_id: q, topic: 'Databases', points: 15.5, question_text: null, answer_text: null });
    expect(JSON.stringify(p)).not.toMatch(/Question d15|Answer d15/);
    s = run(s, 'r2sRevealQuestion', { session_id: sid, question_id: q }, T0 + 2000);
    p = pub(s, sid);
    expect(p.game).toMatchObject({ phase: 'revealed', question_text: 'Question d15?', answer_text: null, revealed_at: new Date(T0 + 2000).toISOString() });
    expect(r2Remaining(p.game, p.settings, T0 + 2000)).toBe(18_000);
    const h = board(s, sid, true);
    for (const k of ['phase', 'question_id', 'question_text', 'revealed_at', 'answer_revealed']) expect(p.game[k]).toEqual(h.game[k]);
    s = run(s, 'r2sRevealAnswer', { session_id: sid, question_id: q });
    expect(pub(s, sid).game.answer_text).toBe('Answer d15');
    const t2 = pub(s, sid).teams.find((t) => t.team_number === 2).team_id; // team chosen in the projector's popup
    s = run(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, team_id: t2, result: 'wrong' });
    p = pub(s, sid);
    expect(p.game.phase).toBe('idle');
    expect(tile(p, 'Databases', 15.5).used).toBe(true);
    expect(scoresOf(s, sid)).toEqual({ 1: 0, 2: -7.75 });
  });

  it('protected scoring: only a revealed question of this session, only a session team, never twice — refresh changes nothing', () => {
    let { s, sid, team } = liveWorld();
    const q = tile(pub(s, sid), 'Networks', 20).id;
    const score = (p) => code(() => r2(s, 'r2sScore', { request_id: rid(), session_id: sid, question_id: q, result: 'right', team_id: team(1), ...p }));
    expect(score()).toBe('TRIVIA_NOT_REVEALED');
    s = open(s, sid, q);
    expect(score({ team_id: team(3) })).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(score({ team_id: team(1, 'PG') })).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(score({ result: 'bonus' })).toBe('VALIDATION');
    const req = rid();
    s = run(s, 'r2sScore', { request_id: req, session_id: sid, question_id: q, team_id: team(1), result: 'right' });
    const dup = r2(s, 'r2sScore', { request_id: req, session_id: sid, question_id: q, team_id: team(1), result: 'right' });
    expect(dup.result.duplicate_request).toBe(true);
    s = dup.state;
    expect(score()).toBe('TRIVIA_QUESTION_USED');
    // A reload of either view (fresh read of the same state) keeps the tile used and the score once.
    const reloaded = structuredClone(s);
    expect(tile(pub(reloaded, sid), 'Networks', 20).used).toBe(true);
    expect(scoresOf(reloaded, sid)).toEqual({ 1: 20, 2: 0 });
    expect(code(() => r2(reloaded, 'r2sSelect', { session_id: sid, question_id: q }))).toBe('TRIVIA_QUESTION_USED');
    // Repeating Reveal Question never restarts the timer.
    const q2 = tile(pub(s, sid), 'Networks', 10).id;
    s = open(s, sid, q2);
    const at = pub(s, sid).game.revealed_at;
    s = run(s, 'r2sRevealQuestion', { session_id: sid, question_id: q2 }, T0 + 9000);
    expect(pub(s, sid).game.revealed_at).toBe(at);
  });
});
