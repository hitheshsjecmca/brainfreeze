// UG/PG sections, the retired registration-desk role and self-paced per-team shuffling,
// against the real migrations in PGlite. Organizer calls pick their section with
// the x-brainfreze-section header exactly as the browser does.
import { beforeAll, describe, expect, it } from 'vitest';
import { asRole, attachTeam, createDb, errCode, joinQuiz, ORG, STAFF, STRANGER, selectTeams } from './helpers/db.js';

let db;
let n = 0;
const rid = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ph = (args) => args.map((_, i) => `$${i + 1}`).join(', ');
const call = async (sub, fn, args = [], section = null) =>
  (await asRole(db, 'authenticated', sub, `select public.${fn}(${ph(args)}) as r`, args, section ? { 'x-brainfreze-section': section } : null)).rows[0].r;
const org = (fn, args, section) => call(ORG, fn, args, section);
const staff = (fn, args) => call(STAFF, fn, args);
const anon = async (fn, args = [], ip = '10.1.0.1') =>
  (await asRole(db, 'anon', null, `select public.${fn}(${ph(args)}) as r`, args, { 'x-forwarded-for': ip })).rows[0].r;
const team = (team_number, extra = {}) => ({ team_number, team_name: `Team ${team_number}${extra.section || ''}`, participant_1: 'P1', participant_2: 'P2', college_name: 'MCA College', ...extra });
const teamRow = async (section, num) => (await db.query('select * from public.teams where section = $1 and team_number = $2', [section, num])).rows[0];

const QUESTIONS = Array.from({ length: 30 }, (_, i) => ({
  question_text: `Question ${i + 1}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`,
  correct_option: 'ABCD'[i % 4], explanation: `SECRET-${i}`,
}));

beforeAll(async () => {
  db = await createDb();
  await org('import_questions', [QUESTIONS, false, false]);
}, 60_000);

describe('sections', () => {
  it('starts with one draft set per section; any number of sets may be added', async () => {
    const rows = (await db.query('select section from public.quiz_sessions where is_current order by section')).rows;
    expect(rows.map((r) => r.section)).toEqual(['PG', 'UG']);
    const extra = await org('create_set', [{ name: 'PG Set B', section: 'PG' }]);
    expect((await db.query(`select count(*)::int c from public.quiz_sessions where is_current and section = 'PG'`)).rows[0].c).toBe(2);
    await org('delete_set', [extra]);
  });

  it('organizer calls act on the section named by the request header (UG when absent)', async () => {
    await org('save_team', [team(1)]);
    await org('save_team', [team(1, { section: 'PG' })], 'PG');
    await org('save_team', [team(2)], 'PG'); // section from the header
    expect((await teamRow('PG', 2)).section).toBe('PG');
    expect((await teamRow('UG', 1)).section).toBe('UG');
    expect(await errCode(org('save_team', [team(1)], 'XX'))).toBe('VALIDATION');
  });

  it('team numbers are unique within a section only', async () => {
    expect(await errCode(org('save_team', [team(1, { team_name: 'Dup' })]))).toBe('DUPLICATE_TEAM_NUMBER');
    expect(await errCode(db.query(`insert into public.teams (section, team_number, team_name, participant_1, participant_2) values ('UG', 1, 'x', 'a', 'b')`))).toMatch(/duplicate key/);
  });

  it('college name is required for new and edited teams', async () => {
    expect(await errCode(org('save_team', [team(9, { college_name: ' ' })]))).toBe('VALIDATION');
  });

  it('standings, readiness and start are per section', async () => {
    await selectTeams(db, 'UG'); // standings cover each set's selected participants
    await selectTeams(db, 'PG');
    const ug = (await asRole(db, 'authenticated', ORG, 'select team_number from public.get_standings()', [], { 'x-brainfreze-section': 'UG' })).rows;
    const pg = (await asRole(db, 'authenticated', ORG, 'select team_number from public.get_standings()', [], { 'x-brainfreze-section': 'PG' })).rows;
    expect(ug.map((r) => r.team_number)).toEqual([1]);
    expect(pg.map((r) => r.team_number).sort()).toEqual([1, 2]);
  });

  it('import goes into the selected section and rejects rows for the other one', async () => {
    expect(await errCode(org('import_teams', [[team(5, { section: 'PG' })], false, false], 'UG'))).toBe('VALIDATION');
    await org('import_teams', [[team(5), team(6)], false, false], 'UG');
    expect((await teamRow('UG', 5)).section).toBe('UG');
  });

  it('no fixed team capacity: a section can register more than 50 teams; team numbers go up to 99999', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => team(100 + i));
    try {
      expect(await org('import_teams', [rows, false, false], 'UG')).toEqual({ imported: 60 });
      expect((await org('save_team', [team(99)], 'UG')).id).toBeTruthy();
      expect((await org('save_team', [team(12345)], 'UG')).id).toBeTruthy();
      expect(await errCode(org('save_team', [team(100000)], 'UG'))).toBe('VALIDATION');
      expect((await db.query(`select count(*)::int c from public.teams where section = 'UG'`)).rows[0].c).toBeGreaterThan(50);
    } finally {
      await db.query(`delete from public.teams where team_number >= 99`);
    }
  });
});

describe('registration desk (retired, migration 17)', () => {
  let createdId;

  it('the registration desk functions can no longer be called by anyone', async () => {
    for (const [fn, args] of [['registration_access', []], ['is_registration_staff', []], ['reg_overview', []], ['reg_save_team', [team(20, { section: 'UG' })]]]) {
      for (const sub of [STAFF, ORG, STRANGER]) expect(await errCode(call(sub, fn, args)), `${fn} as ${sub}`).toMatch(/permission denied/);
      expect(await errCode(asRole(db, 'anon', null, `select public.${fn}(${ph(args)})`, args))).toMatch(/permission denied/);
    }
    createdId = (await org('save_team', [team(20, { section: 'UG', team_name: 'Desk Team' })])).id;
  });

  it('former registration staff cannot read any table directly', async () => {
    for (const t of ['teams', 'questions', 'question_keys', 'team_credentials', 'team_answers', 'score_events', 'quiz_sessions', 'quiz_settings', 'participant_sessions', 'registration_events', 'organizers']) {
      expect((await asRole(db, 'authenticated', STAFF, `select count(*)::int c from public.${t}`)).rows[0].c, t).toBe(0);
    }
  });

  it('former registration staff cannot manage questions, scoring, timers, sessions or answer keys', async () => {
    const calls = [
      ['save_question', [QUESTIONS[0]]], ['delete_question', [rid(), true]], ['import_questions', [QUESTIONS, false, false]],
      ['update_settings', [{ duration_seconds: 60 }]], ['start_quiz', []], ['pause_quiz', []], ['end_quiz', []], ['reset_timer', []],
      ['publish_quiz', []], ['new_session', []], ['update_quiz_details', [{ name: 'x' }]], ['set_projector_view', ['standby']],
      ['record_answer', [rid(), createdId, rid(), 'A', false, null]], ['save_team', [team(30)]], ['delete_team', [createdId, true]],
      ['rotate_team_pin', [createdId]], ['restore_backup', [{}]], ['confirm_qualifiers', [[], null]],
      ['save_set_question', [QUESTIONS[0]]], ['import_set_questions', [[]]], ['previous_set_questions', []],
    ];
    for (const [fn, args] of calls) expect(await errCode(staff(fn, args)), fn).toBe('NOT_AUTHORIZED');
    expect(await errCode(asRole(db, 'authenticated', STAFF, 'select * from public.get_standings()'))).toBe('NOT_AUTHORIZED');
  });

  it('registration history is append-only', async () => {
    expect(await errCode(db.query('update public.registration_events set actor_role = $1', ['registration']))).toBe('AUDIT_IMMUTABLE');
    expect(await errCode(db.query('delete from public.registration_events'))).toBe('AUDIT_IMMUTABLE');
  });

  it('organizer saves are logged as organizer', async () => {
    const id = (await org('save_team', [team(7)])).id;
    expect((await db.query('select actor_role from public.registration_events where team_id = $1', [id])).rows[0].actor_role).toBe('organizer');
  });
});

describe('join codes per section and team identity', () => {
  let ugCode;
  let pgCode;

  it('each section has its own six-digit code', async () => {
    ugCode = (await org('publish_quiz', [], 'UG')).join_code;
    pgCode = (await org('publish_quiz', [], 'PG')).join_code;
    await selectTeams(db, 'UG');
    await selectTeams(db, 'PG');
    expect(ugCode).toMatch(/^\d{6}$/);
    expect(pgCode).toMatch(/^\d{6}$/);
    expect(ugCode).not.toBe(pgCode);
    expect((await anon('join_lookup', [pgCode])).quiz.section).toBe('PG');
  });

  it('the code decides the section: a self-joined participant lands in the code’s section and cannot claim the other one', async () => {
    const pg = await joinQuiz(db, pgCode, 'Walk PG', 'Walk College', { ip: '10.1.0.3' });
    expect(pg).toMatchObject({ ok: true, section: 'PG', team: { section: 'PG', participant_1: 'Walk PG', college_name: 'Walk College' } });
    expect((await db.query(`select section, college_name from public.teams where team_name = 'Walk PG'`)).rows[0]).toEqual({ section: 'PG', college_name: 'Walk College' });
    expect(await joinQuiz(db, ugCode, 'Other', 'Walk College', { ip: '10.1.0.3', section: 'PG' })).toMatchObject({ ok: false, error: 'SECTION_MISMATCH', section: 'UG' });
    // a registered PG team attached to the PG code
    expect(await attachTeam(db, pgCode, 'PG', 1, '10.1.0.2')).toMatchObject({ ok: true, section: 'PG', team: { team_number: 1, team_name: 'Team 1PG' } });
    expect(await attachTeam(db, ugCode, 'PG', 1, '10.1.0.2')).toMatchObject({ ok: false, error: 'SECTION_MISMATCH' });
  });

  it('one section can be live while the other is still in setup', async () => {
    await org('start_quiz', [], 'UG');
    const s = (await db.query('select section, status from public.quiz_sessions where is_current order by section')).rows;
    expect(s).toEqual([{ section: 'PG', status: 'setup' }, { section: 'UG', status: 'running' }]);
    const tok = (await attachTeam(db, ugCode, 'UG', 1, '10.1.0.4')).token;
    expect((await anon('participant_start', [tok])).ok).toBe(true);
    await org('end_quiz', [], 'UG');
  });
});

describe('backups cover both sections', () => {
  it('format 2 round-trips both sections; format 1 restores into UG with a fresh PG session', async () => {
    const sessions = (await db.query('select * from public.quiz_sessions where is_current order by section')).rows;
    const settings = (await db.query('select * from public.quiz_settings')).rows;
    const teams = (await db.query('select * from public.teams')).rows;
    const questions = (await db.query('select q.*, k.correct_option, k.explanation from public.questions q join public.question_keys k on k.question_id = q.id')).rows;
    const answers = (await db.query('select * from public.team_answers')).rows.map((a) => ({ ...a, points: Number(a.points) }));
    const backup = {
      app: 'brainfreze-cold-start', format_version: 2, exported_at: new Date().toISOString(),
      teams, questions, answers, events: [], tiebreaks: [],
      sessions: sessions.map((s) => ({ session: s, settings: settings.find((x) => x.session_id === s.id) })),
    };
    await org('restore_backup', [backup]);
    const after = (await db.query('select section, status from public.quiz_sessions where is_current order by section')).rows;
    expect(after).toEqual([{ section: 'PG', status: 'setup' }, { section: 'UG', status: 'ended' }]);
    expect((await db.query('select count(*)::int c from public.teams')).rows[0].c).toBe(teams.length);
    expect((await db.query(`select count(*)::int c from public.teams where section = 'PG'`)).rows[0].c).toBe(teams.filter((t) => t.section === 'PG').length);
    expect((await db.query('select count(*)::int c from public.team_answers')).rows[0].c).toBe(answers.length);

    const v1 = { app: 'brainfreze-cold-start', format_version: 1, teams: teams.filter((t) => t.section === 'UG').map(({ section: _s, ...t }) => t), questions, session: sessions[1], settings: {}, answers: [], events: [], tiebreaks: [] };
    await org('restore_backup', [v1]);
    expect((await db.query('select section from public.quiz_sessions where is_current order by section')).rows.map((r) => r.section)).toEqual(['PG', 'UG']);
    expect((await db.query(`select count(*)::int c from public.teams where section <> 'UG'`)).rows[0].c).toBe(0);
  });
});
