// Round 2 trivia sets, published versions, codes and live sessions (migration 20261020000100)
// against the real migrations in PGlite.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, createDb, errCode, ORG, STRANGER } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `7c7c7c7c-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const org = async (fn, args = []) => (await asRole(db, 'authenticated', ORG, `select public.${fn}(${ph(args)}) as r`, args)).rows[0].r;
const team = (num, section) => ({ team_number: num, team_name: `${section} R2 ${num}`, participant_1: 'A', participant_2: 'B', college_name: 'X', section });
const teamId = async (section, num) => (await db.query('select id from public.teams where section = $1 and team_number = $2', [section, num])).rows[0].id;
const ANSWER = /SECRET-ANSWER/;

/** A draft set with `topics` = { name: [[points, question, answer], …] }. Returns its id. */
async function makeSet(title, section, topics) {
  const id = await org('r2s_save_set', [{ title, section }]);
  for (const [name, qs] of Object.entries(topics)) {
    const tid = await org('r2s_save_topic', [{ set_id: id, name }]);
    for (const [points, q, a] of qs) await org('r2s_save_question', [{ topic_id: tid, points, question_text: q, answer_text: a }]);
  }
  return id;
}
const tile = (board, topic, pts) => board.topics.find((t) => t.name === topic).questions.find((q) => Number(q.points) === pts);

let setA;
let codeA;

beforeAll(async () => {
  db = await createDb();
  for (const i of [1, 2, 3]) await org('save_team', [team(i, 'UG')]);
  for (const i of [1, 2]) await org('save_team', [team(i, 'PG')]);
}, 60_000);

describe('trivia sets: drafts, publishing and codes', () => {
  it('creates several independent sets with any number of topics and questions', async () => {
    setA = await makeSet('UG Final Board', 'UG', {
      Networks: [[10, 'What does DNS stand for?', 'SECRET-ANSWER Domain Name System'], [20, 'Port of HTTPS?', 'SECRET-ANSWER 443'], [30, 'OSI layers?', 'SECRET-ANSWER 7']],
      Databases: [[10, 'SQL stands for?', 'SECRET-ANSWER Structured Query Language'], [25.5, 'ACID: the A?', 'SECRET-ANSWER Atomicity']],
      'AI & ML': [[50, 'Who coined "machine learning"?', 'SECRET-ANSWER Arthur Samuel']],
    });
    const setB = await makeSet('Mixed Board', 'BOTH', { Trivia: [[5, 'Q?', 'SECRET-ANSWER A']] });
    const ov = await org('r2s_overview');
    expect(ov.sets.map((s) => s.title).sort()).toEqual(['Mixed Board', 'UG Final Board']);
    const a = ov.sets.find((s) => s.id === setA);
    expect(a).toMatchObject({ topic_count: 3, question_count: 6, published_version: 0, join_code: null, timer_seconds: 18 });
    expect(Number(a.wrong_penalty_percent)).toBe(50);
    expect((await org('r2s_set_detail', [setB])).questions).toHaveLength(1);
  });

  it('drafts can be edited and deleted before publication; validation blocks an incomplete set', async () => {
    const d = await org('r2s_set_detail', [setA]);
    const q = d.questions.find((x) => x.question_text === 'OSI layers?');
    await org('r2s_save_question', [{ id: q.id, topic_id: q.topic_id, points: 40, question_text: 'How many OSI layers?', answer_text: 'SECRET-ANSWER Seven' }]);
    const extra = await org('r2s_save_topic', [{ set_id: setA, name: 'Empty' }]);
    expect((await org('r2s_set_detail', [setA])).issues).toEqual(['Topic "Empty" has no questions — add one or delete the topic.']);
    expect(await errCode(org('r2s_publish_set', [setA]))).toBe('VALIDATION');
    await org('r2s_delete_topic', [extra]);
    expect(await errCode(org('r2s_save_topic', [{ set_id: setA, name: 'networks' }]))).toBe('VALIDATION'); // duplicate topic
    expect(await errCode(org('r2s_save_question', [{ topic_id: q.topic_id, points: 0, question_text: 'x', answer_text: 'y' }]))).toBe('VALIDATION');
    const empty = await org('r2s_save_set', [{ title: 'Nothing yet', section: 'PG' }]);
    expect(await errCode(org('r2s_publish_set', [empty]))).toBe('VALIDATION');
    await org('r2s_delete_set', [empty]);
    const after = await org('r2s_set_detail', [setA]);
    expect(after.questions.find((x) => x.id === q.id)).toMatchObject({ question_text: 'How many OSI layers?', answer_text: 'SECRET-ANSWER Seven' });
    expect(Number(after.questions.find((x) => x.id === q.id).points)).toBe(40);
    expect(after.issues).toEqual([]);
  });

  it('publishing freezes a version and issues one unique six-digit code that is kept on republish', async () => {
    const p1 = await org('r2s_publish_set', [setA]);
    expect(p1).toMatchObject({ ok: true, version: 1 });
    expect(p1.join_code).toMatch(/^\d{6}$/);
    codeA = p1.join_code;
    const other = await org('r2s_publish_set', [(await org('r2s_overview')).sets.find((s) => s.title === 'Mixed Board').id]);
    expect(other.join_code).not.toBe(codeA);
    // reading the set again never issues a new code
    expect((await org('r2s_overview')).sets.find((s) => s.id === setA).join_code).toBe(codeA);
    expect((await org('r2s_set_detail', [setA])).set.unpublished_changes).toBe(false);
    expect(await errCode(org('r2s_delete_set', [setA]))).toBe('TRIVIA_SET_PUBLISHED');
  });

  it('the code loads the published set (latest version), never the unpublished draft', async () => {
    const d = await org('r2s_set_detail', [setA]);
    const net = d.topics.find((t) => t.name === 'Networks');
    await org('r2s_save_question', [{ topic_id: net.id, points: 99, question_text: 'Draft only?', answer_text: 'SECRET-ANSWER draft' }]);
    expect((await org('r2s_set_detail', [setA])).set.unpublished_changes).toBe(true);
    const look = await org('r2s_lookup', [codeA]);
    expect(look).toMatchObject({ set_id: setA, title: 'UG Final Board', section: 'UG', version: 1, question_count: 6 });
    expect(look.topics.map((t) => t.name)).toEqual(['Networks', 'Databases', 'AI & ML']);
    expect(JSON.stringify(look)).not.toMatch(ANSWER);
    expect(JSON.stringify(look)).not.toMatch(/Draft only|DNS stand/); // tiles only: no question text
    expect(await errCode(org('r2s_lookup', ['000000']))).toBe('TRIVIA_CODE_INVALID');
  });
});

describe('Join Round 2: section, teams and Start', () => {
  it('lists the registered teams of a compatible section only', async () => {
    const ug = await org('r2s_eligible_teams', [codeA, 'UG']);
    expect(ug.map((t) => t.team_number)).toEqual([1, 2, 3]);
    expect(ug[0]).toMatchObject({ team_name: 'UG R2 1', qualified: false });
    expect(await errCode(org('r2s_eligible_teams', [codeA, 'PG']))).toBe('TRIVIA_SECTION_MISMATCH');
  });

  it('nothing is live until Start; Start validates the section and every team on the server', async () => {
    expect((await org('r2s_overview')).sessions).toEqual([]);
    const pg1 = await teamId('PG', 1);
    expect(await errCode(org('r2s_start_session', [rid(), codeA, 'PG', [pg1]]))).toBe('TRIVIA_SECTION_MISMATCH');
    expect(await errCode(org('r2s_start_session', [rid(), codeA, 'UG', [await teamId('UG', 1), pg1]]))).toBe('TRIVIA_TEAM_NOT_ELIGIBLE');
    expect(await errCode(org('r2s_start_session', [rid(), codeA, 'UG', []]))).toBe('VALIDATION');
    expect(await errCode(org('r2s_start_session', [rid(), codeA, 'UG', ['00000000-0000-4000-8000-000000000000']]))).toBe('TRIVIA_TEAM_NOT_ELIGIBLE');
    expect((await org('r2s_overview')).sessions).toEqual([]);
  });
});

describe('live gameplay', () => {
  let s1;
  let s2;
  let ug1;
  let ug2;

  beforeAll(async () => {
    ug1 = await teamId('UG', 1);
    ug2 = await teamId('UG', 2);
    const req = rid();
    s1 = (await org('r2s_start_session', [req, codeA, 'UG', [ug1, ug2]])).session_id;
    expect(await org('r2s_start_session', [req, codeA, 'UG', [ug1, ug2]])).toMatchObject({ session_id: s1, duplicate_request: true });
    s2 = (await org('r2s_start_session', [rid(), codeA, 'UG', [ug1, await teamId('UG', 3)]])).session_id;
  });

  it('the session plays the published version: the draft-only question is not on its board', async () => {
    const b = await org('r2s_board', [s1, true]);
    expect(b.session).toMatchObject({ status: 'live', section: 'UG', title: 'UG Final Board', version: 1 });
    expect(b.settings).toMatchObject({ timer_seconds: 18 });
    expect(b.topics.find((t) => t.name === 'Networks').questions.map((q) => Number(q.points))).toEqual([10, 20, 40]);
    expect(b.scores.map((s) => s.team_number).sort()).toEqual([1, 2]);
  });

  it('clicking a tile reveals nothing; Cancel returns it unused', async () => {
    const b = await org('r2s_board', [s1, false]);
    const q = tile(b, 'Networks', 10);
    await org('r2s_select', [s1, q.id]);
    const sel = await org('r2s_board', [s1, true]);
    expect(sel.game).toMatchObject({ phase: 'selected', topic: 'Networks', question_text: null, answer_text: null });
    expect(Number(sel.game.points)).toBe(10);
    expect(JSON.stringify(sel)).not.toMatch(/DNS stand|SECRET-ANSWER/);
    expect(await errCode(org('r2s_select', [s1, tile(b, 'Networks', 20).id]))).toBe('TRIVIA_QUESTION_ACTIVE');
    await org('r2s_cancel', [s1]);
    expect((await org('r2s_board', [s1, false])).game.phase).toBe('idle');
  });

  it('Reveal Question shows the question and stamps the 18-second timer start; Answer changes no score', async () => {
    const q = tile(await org('r2s_board', [s1, false]), 'Networks', 10);
    await org('r2s_select', [s1, q.id]);
    const r = await org('r2s_reveal_question', [s1, q.id]);
    const b = await org('r2s_board', [s1, false]);
    expect(b.game).toMatchObject({ phase: 'revealed', question_text: 'What does DNS stand for?', answer_revealed: false, answer_text: null });
    expect(Date.parse(b.game.revealed_at)).toBe(Date.parse(r.revealed_at));
    expect((await org('r2s_reveal_question', [s1, q.id])).revealed_at).toBe(r.revealed_at); // never restarts
    expect(JSON.stringify(b)).not.toMatch(ANSWER); // projector view: no answer yet
    expect((await org('r2s_board', [s1, true])).game.answer_text).toMatch(/Domain Name System/); // host may peek
    expect(await errCode(org('r2s_cancel', [s1]))).toBe('TRIVIA_ALREADY_REVEALED');
    await org('r2s_reveal_answer', [s1, q.id]);
    const after = await org('r2s_board', [s1, false]);
    expect(after.game).toMatchObject({ answer_revealed: true, answer_text: 'SECRET-ANSWER Domain Name System' });
    expect((await org('r2s_board', [s1, true])).scores.every((s) => Number(s.score) === 0)).toBe(true);
  });

  it('Confirm Score records the chosen team once, marks the tile used and returns to the board', async () => {
    const b = await org('r2s_board', [s1, false]);
    const q = tile(b, 'Networks', 10);
    expect(await errCode(org('r2s_score', [rid(), s1, q.id, await teamId('UG', 3), 'right']))).toBe('TRIVIA_TEAM_NOT_IN_ROUND');
    expect(await errCode(org('r2s_score', [rid(), s1, q.id, ug1, 'maybe']))).toBe('VALIDATION');
    const req = rid();
    const res = await org('r2s_score', [req, s1, q.id, ug1, 'right']);
    expect(res).toMatchObject({ duplicate_request: false, result: 'right' });
    expect(Number(res.points)).toBe(10);
    expect(await org('r2s_score', [req, s1, q.id, ug1, 'right'])).toMatchObject({ duplicate_request: true }); // double click
    expect(await errCode(org('r2s_score', [rid(), s1, q.id, ug2, 'wrong']))).toBe('TRIVIA_QUESTION_USED');
    expect(await errCode(org('r2s_select', [s1, q.id]))).toBe('TRIVIA_QUESTION_USED');
    const after = await org('r2s_board', [s1, true]);
    expect(after.game.phase).toBe('idle');
    expect(tile(after, 'Networks', 10).used).toBe(true);
    expect(Number(after.scores.find((s) => s.team_id === ug1).score)).toBe(10);
    expect(after.results).toHaveLength(1);
    expect(after.results[0]).toMatchObject({ team_number: 1, result: 'right', topic_name: 'Networks', answer_revealed: true });
  });

  it('Wrong deducts the configured penalty (50 % by default); nothing is scored before Reveal', async () => {
    const q = tile(await org('r2s_board', [s1, false]), 'Databases', 25.5);
    expect(await errCode(org('r2s_score', [rid(), s1, q.id, ug2, 'wrong']))).toBe('TRIVIA_NOT_REVEALED');
    await org('r2s_select', [s1, q.id]);
    expect(await errCode(org('r2s_score', [rid(), s1, q.id, ug2, 'wrong']))).toBe('TRIVIA_NOT_REVEALED');
    await org('r2s_reveal_question', [s1, q.id]);
    expect(Number((await org('r2s_score', [rid(), s1, q.id, ug2, 'wrong'])).points)).toBe(-12.75);
  });

  it('an expired timer scores nothing; the host can close a question without points', async () => {
    const q = tile(await org('r2s_board', [s1, false]), 'AI & ML', 50);
    await org('r2s_select', [s1, q.id]);
    await org('r2s_reveal_question', [s1, q.id]);
    await db.query(`update public.r2_sessions set revealed_at = now() - interval '5 minutes' where id = $1`, [s1]);
    const b = await org('r2s_board', [s1, true]);
    expect(b.game.phase).toBe('revealed');
    expect(b.scores.map((s) => Number(s.score)).sort()).toEqual([-12.75, 10]);
    expect(await org('r2s_close_question', [rid(), s1, q.id])).toMatchObject({ result: 'no_score' });
    expect(tile(await org('r2s_board', [s1, false]), 'AI & ML', 50).used).toBe(true);
  });

  it('sessions are independent: the second session of the same set is untouched', async () => {
    const b2 = await org('r2s_board', [s2, true]);
    expect(b2.game.phase).toBe('idle');
    expect(b2.results).toEqual([]);
    expect(b2.topics.every((t) => t.questions.every((q) => !q.used))).toBe(true);
    expect(b2.scores.every((s) => Number(s.score) === 0)).toBe(true);
    // the same question can be played in the other session
    const q = tile(b2, 'Networks', 10);
    await org('r2s_select', [s2, q.id]);
    await org('r2s_reveal_question', [s2, q.id]);
    await org('r2s_score', [rid(), s2, q.id, ug1, 'right']);
    expect((await org('r2s_board', [s1, true])).results).toHaveLength(3);
  });

  it('a new publication does not change a live session; state survives a reload; an ended session is read-only', async () => {
    const p2 = await org('r2s_publish_set', [setA]); // includes the draft-only question
    expect(p2).toMatchObject({ version: 2, join_code: codeA });
    const b = await org('r2s_board', [s1, true]);
    expect(b.session.version).toBe(1);
    expect(b.topics.find((t) => t.name === 'Networks').questions.map((x) => Number(x.points))).toEqual([10, 20, 40]);
    expect((await org('r2s_lookup', [codeA])).version).toBe(2);
    expect(await org('r2s_board', [s1, true])).toEqual({ ...b, server_now: expect.any(String) }); // a reload returns the same state
    await org('r2s_end_session', [s1]);
    expect(await errCode(org('r2s_select', [s1, tile(b, 'Networks', 20).id]))).toBe('TRIVIA_SESSION_ENDED');
    expect((await org('r2s_board', [s1, true])).session.status).toBe('ended');
  });
});

describe('security', () => {
  it('only organizers can call Round 2 functions; anon cannot call them at all; answers are not readable as tables', async () => {
    expect(await errCode(asRole(db, 'authenticated', STRANGER, 'select public.r2s_overview()'))).toBe('NOT_AUTHORIZED');
    expect(await errCode(asRole(db, 'anon', null, `select public.r2s_lookup('${codeA}')`))).not.toBe('NO_ERROR');
    for (const t of ['r2_set_answers', 'r2_version_answers']) {
      expect(await errCode(asRole(db, 'authenticated', ORG, `select * from public.${t}`))).not.toBe('NO_ERROR');
    }
    const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
    expect(pub).toContain('r2_sessions');
    expect(pub).not.toContain('r2_set_answers');
    expect(pub).not.toContain('r2_version_answers');
  });
});
