// Organizer redesign: navigation structure and the Round 1 statuses shown on the
// dashboard, derived only from real set data (demo engine ↔ same summaries as Supabase).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyState, setSummaries, setView, sessionQuestions } from '../src/lib/engine.js';
import {
  HOST_NAV, LEGACY_ROUTES, ROUND1_TABS, ROUNDS, resultsStatus, round1NextAction, round1Summary, round1TeamStatus, setProgress,
} from '../src/lib/rounds.js';
import { selectTeams } from './helpers/engine.js';

const T0 = Date.parse('2026-10-17T09:00:00Z');
const call = (s, name, p = {}, setId = null, now = T0) => applyAction(s, name, p, setId ? { now, setId } : { now, section: 'UG' });
const run = (...a) => call(...a).state;

function world() {
  let s = createEmptyState(T0);
  s = run(s, 'importQuestions', { items: Array.from({ length: 30 }, (_, i) => ({ question_text: `Q${i}?`, option_a: `a${i}`, option_b: `b${i}`, option_c: `c${i}`, option_d: `d${i}`, correct_option: 'A' })) });
  s = run(s, 'importTeams', { rows: [1, 2].map((n) => ({ team_number: n, team_name: `T${n}`, participant_1: 'a', participant_2: 'b', college_name: 'C' })) });
  return s;
}
const ugSet = (s) => setSummaries(s).find((x) => x.section === 'UG').id;

describe('organizer navigation', () => {
  const app = readFileSync(join(import.meta.dirname, '../src/App.jsx'), 'utf8');
  it('has exactly five sections', () => {
    expect(HOST_NAV.map((n) => n.label)).toEqual(['Dashboard', 'Rounds', 'Teams', 'Results', 'Settings & Backup']);
  });
  it('every Round 1 tab and every old URL has a route; old URLs redirect', () => {
    for (const t of ROUND1_TABS) {
      const sub = t.to.replace('/host/rounds/1', '').replace(/^\//, '');
      expect(sub === '' ? app.includes('path="rounds/1"') : app.includes(`path="${sub}"`), t.to).toBe(true);
    }
    expect(app).toMatch(/LEGACY_ROUTES\).map/);
    for (const to of Object.values(LEGACY_ROUTES)) expect(ROUND1_TABS.map((t) => t.to)).toContain(to);
    expect(app).toContain('path="rounds/2" element={<Round2Layout />}');
    expect(app).toContain('path="/projector/round2"');
    // Round 3 (THE KNOWLEDGE AUCTION) was removed: no routes; old URLs fall through to the catch-all redirect.
    expect(app).not.toMatch(/rounds\/3|projector\/round3|Round3/);
    expect(app).toContain('<Route path="*" element={<Navigate to="/" replace />} />');
  });
  it('Rounds 1 and 2 are the event rounds', () => {
    expect(ROUNDS.map((r) => [r.id, r.implemented])).toEqual([[1, true], [2, true]]);
  });
});

describe('Round 1 status from set data', () => {
  it('walks draft → published → live → review → qualified, with one next action each', () => {
    let s = world();
    const id = ugSet(s);
    s = run(s, 'deleteSet', { id: setSummaries(s).find((x) => x.section === 'PG').id }); // only the UG set in this test
    const status = () => round1Summary(setSummaries(s)).status;
    const next = () => round1NextAction(setSummaries(s));
    expect(status()).toBe('setup');
    expect(next()).toMatchObject({ label: 'Continue setup', to: '/host/rounds/1/setup' });
    const pub = call(s, 'publishQuiz', {}, id);
    s = pub.state;
    expect(status()).toBe('ready');
    // nothing is selected automatically: the organiser chooses the set's participants first
    expect(next()).toMatchObject({ label: 'Choose participants', to: '/host/rounds/1/participants', setId: id });
    s = selectTeams(s, id, null, T0);
    expect(next()).toMatchObject({ label: 'Go live', setId: id });
    s = run(s, 'startQuiz', {}, id);
    const j = call(s, 'joinTeam', { code: pub.result.join_code, team_number: 1, pin: s.credentials[s.teams.find((t) => t.team_number === 1 && t.section === 'UG').id] });
    s = j.state;
    s = call(s, 'participantStart', { token: j.result.token }).state;
    const att = s.attempts[0];
    const shown = 'ABCD'[att.option_orders[0].indexOf('A')]; // every key is A
    s = call(s, 'participantSubmit', { token: j.result.token, request_id: '11111111-0000-4000-8000-000000000001', question_id: att.question_order[0], option: shown }).state;
    expect(status()).toBe('live');
    expect(round1Summary(setSummaries(s))).toMatchObject({ teamsJoined: 1, teamsAnswering: 1, teamsFinished: 0 });
    expect(next()).toMatchObject({ label: 'Open Live Host', to: '/host/rounds/1/live' });
    s = run(s, 'endQuiz', {}, id, T0 + 1000);
    expect(status()).toBe('review');
    expect(round1Summary(setSummaries(s)).teamsFinished).toBe(1);
    expect(next()).toMatchObject({ label: 'Review results', to: '/host/results' });
    // nothing advances by itself: qualifiers need an explicit confirmation
    const teamIds = (n) => s.teams.filter((t) => t.section === 'UG' && t.team_number <= n).map((t) => t.id);
    s = { ...s, sets: s.sets.map((x) => (x.session.id === id ? { ...x, settings: { ...x.settings, qualify_count: 1 } } : x)) };
    s = run(s, 'confirmQualifiers', { team_ids: teamIds(1) }, id);
    expect(status()).toBe('qualified');
    expect(round1Summary(setSummaries(s))).toMatchObject({ finalized: 1, qualifiers: 1 });
    expect(next().label).toBe('View results');
    // team status: qualified vs not
    const sets = setSummaries(s);
    expect(round1TeamStatus(teamIds(1)[0], sets)).toMatchObject({ key: 'qualified', label: 'Highlighted in results' });
    const t2 = s.teams.find((t) => t.section === 'UG' && t.team_number === 2).id;
    expect(round1TeamStatus(t2, sets)).toMatchObject({ key: 'none', label: 'No device attempt' });
  });

  it('archived sets do not count; no sets → create one', () => {
    let s = world();
    const before = setSummaries(s).map((x) => x.id);
    for (const id of before) s = run(s, 'archiveSet', { id, reason: 'rehearsal' });
    const after = round1Summary(setSummaries(s));
    expect(after).toMatchObject({ status: 'not_started', sets: 0, completed: 0 });
    expect(round1NextAction(setSummaries(s))).toMatchObject({ label: 'Create a quiz set', to: '/host/rounds/1/new' });
    expect(setSummaries(s).filter((x) => before.includes(x.id)).every((x) => x.stage === 'archived')).toBe(true);
    expect(round1Summary([])).toMatchObject({ status: 'not_started', sets: 0 });
    expect(round1NextAction([])).toMatchObject({ label: 'Create a quiz set', setId: null });
  });
});

describe('set progress and results status', () => {
  it('progress shows the current question count (no min/max) and later steps', () => {
    let s = world();
    const id = ugSet(s);
    const steps = (st) => { const v = setView(st, id); return setProgress(v.session, sessionQuestions(v).length); };
    expect(steps(s).map((x) => [x.key, x.done])).toEqual([['questions', true], ['participants', false], ['published', false], ['live', false], ['ended', false], ['qualified', false], ['revealed', false]]);
    const few = run(s, 'updateQuizDetails', { question_ids: s.questions.slice(0, 10).map((q) => q.id) }, id);
    expect(steps(few)[0]).toMatchObject({ done: true, label: 'Questions (10)' });
    expect(setProgress({ status: 'setup', published_at: null }, 0)[0]).toMatchObject({ done: false, label: 'Questions (0)' });
    s = run(selectTeams(run(s, 'publishQuiz', {}, id), id, null, T0), 'startQuiz', {}, id);
    expect(steps(s).filter((x) => x.done).map((x) => x.key)).toEqual(['questions', 'participants', 'published', 'live']);
  });

  it('results status uses only supported states', () => {
    expect(resultsStatus({ status: 'setup' }, []).key).toBe('none');
    expect(resultsStatus({ status: 'running' }, []).key).toBe('provisional');
    expect(resultsStatus({ status: 'ended' }, [{ tie_review: true }]).label).toMatch(/ties flagged/);
    expect(resultsStatus({ status: 'finalized' }, []).key).toBe('finalized');
  });
});
