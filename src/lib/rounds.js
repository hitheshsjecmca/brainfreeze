// Event structure (JOSHIANA 15.0 · WINTER ARC) and Round 1 status derived ONLY
// from existing data (quiz-set summaries). Round 2 (trivia board) has its own area.

export const ROUNDS = [
  { id: 1, name: 'COLD START', subtitle: 'MCQ Round', implemented: true, advance: 'The organisers choose the participating teams for each set' },
  { id: 2, name: 'MIND MELTDOWN', subtitle: 'Trivia Round', implemented: true, advance: 'The organisers choose the participating teams for each game' },
];

/** Organizer navigation: five sections. Round pages live under /host/rounds. */
export const HOST_NAV = [
  { to: '/host', end: true, label: 'Dashboard', key: 'dashboard' },
  { to: '/host/rounds', label: 'Rounds', key: 'rounds' },
  { to: '/host/teams', label: 'Teams', key: 'teams' },
  { to: '/host/results', label: 'Results', key: 'results' },
  { to: '/host/settings', label: 'Settings & Backup', key: 'settings' },
];

/** Round 1 management area tabs (existing pages, reused). */
export const ROUND1_TABS = [
  { to: '/host/rounds/1', end: true, label: 'Overview' },
  { to: '/host/rounds/1/sets', label: 'Quiz sets' },
  { to: '/host/rounds/1/setup', label: 'Set setup & join' },
  { to: '/host/rounds/1/participants', label: 'Participants' },
  { to: '/host/rounds/1/live', label: 'Live host' },
  { to: '/host/rounds/1/questions', label: 'Question bank' },
  { to: '/host/rounds/1/leaderboard', label: 'Leaderboard' },
];

/** Round 2 area tabs: live games, trivia set management, and starting a game. */
export const ROUND2_TABS = [
  { to: '/host/rounds/2', end: true, label: 'Round 2 Dashboard' },
  { to: '/host/rounds/2/sets', label: 'Trivia Sets' },
  { to: '/host/rounds/2/join', label: 'Join Round 2' },
];

/** Old organizer URLs → their new place (bookmarks keep working). */
export const LEGACY_ROUTES = {
  sets: '/host/rounds/1/sets',
  quiz: '/host/rounds/1/setup',
  live: '/host/rounds/1/live',
  questions: '/host/rounds/1/questions',
  leaderboard: '/host/rounds/1/leaderboard',
};

const FINISHED = new Set(['submitted', 'timed_out', 'organizer_finalized']);
const byNewest = (a, b) => b.created_at.localeCompare(a.created_at);

/**
 * Round 1 at event level, from the set summaries (archived sets ignored).
 * status: 'not_started' | 'setup' | 'ready' | 'live' | 'review' | 'qualified'
 */
export function round1Summary(sets) {
  const active = sets.filter((x) => x.stage !== 'archived');
  const count = (stage) => active.filter((x) => x.stage === stage).length;
  const live = active.filter((x) => x.stage === 'live');
  const completed = active.filter((x) => x.stage === 'completed');
  const finalized = completed.filter((x) => x.status === 'finalized');
  const participants = active.flatMap((x) => x.participants || []);
  let status = 'not_started';
  if (live.length) status = 'live';
  else if (completed.length && finalized.length === completed.length && !count('published')) status = 'qualified';
  else if (completed.length) status = 'review';
  else if (count('published')) status = 'ready';
  else if (active.length) status = 'setup';
  return {
    status,
    sets: active.length,
    drafts: count('draft'),
    published: count('published'),
    live: live.length,
    completed: completed.length,
    finalized: finalized.length,
    teamsJoined: participants.length,
    teamsFinished: participants.filter((p) => FINISHED.has(p.status)).length,
    teamsAnswering: participants.filter((p) => p.status === 'in_progress').length,
    qualifiers: finalized.reduce((n, x) => n + (x.qualifiers?.length || 0), 0),
  };
}

export const ROUND1_STATUS_LABELS = {
  not_started: 'Not started',
  setup: 'Setting up',
  ready: 'Published — ready to go live',
  live: 'Live',
  review: 'Results to review',
  qualified: 'Results confirmed',
};

/**
 * The single next step for Round 1: { label, to, setId } — the set to select
 * before navigating. Nothing here changes data; the target page asks for confirmation.
 */
export function round1NextAction(sets) {
  const active = sets.filter((x) => x.stage !== 'archived');
  const pick = (stage, pred = () => true) => active.filter((x) => x.stage === stage && pred(x)).sort(byNewest)[0];
  const live = pick('live');
  if (live) return { label: 'Open Live Host', to: '/host/rounds/1/live', setId: live.id, hint: `“${live.name}” is live.` };
  const review = pick('completed', (x) => x.status !== 'finalized');
  if (review) return { label: 'Review results', to: '/host/results', setId: review.id, hint: `“${review.name}” has ended — review and confirm its results.` };
  const unpicked = pick('published', (x) => !(x.team_ids || []).length);
  if (unpicked) return { label: 'Choose participants', to: '/host/rounds/1/participants', setId: unpicked.id, hint: `“${unpicked.name}” is published — choose the teams that take part before going live.` };
  const ready = pick('published');
  if (ready) return { label: 'Go live', to: '/host/rounds/1/live', setId: ready.id, hint: `“${ready.name}” is published (code ${ready.join_code || 'revoked'}).` };
  const draft = pick('draft');
  if (draft) return { label: 'Continue setup', to: '/host/rounds/1/setup', setId: draft.id, hint: `“${draft.name}” is a draft.` };
  const done = pick('completed');
  if (done) return { label: 'View results', to: '/host/results', setId: done.id, hint: 'Every Round 1 set has confirmed results.' };
  return { label: 'Create a quiz set', to: '/host/rounds/1/new', setId: null, hint: 'No quiz sets yet. Create one in four short steps.' };
}

/**
 * Compact setup progress for ONE set: ordered steps with done flags.
 * `questionCount` = the set's questions (selection or frozen copy).
 */
export function setProgress(session, questionCount) {
  const countOk = questionCount > 0;
  const published = !!session.published_at;
  const wentLive = session.status !== 'setup';
  const ended = ['ended', 'finalized'].includes(session.status);
  const finalized = session.status === 'finalized';
  const chosen = (session.team_ids || []).length;
  return [
    { key: 'questions', label: `Questions (${questionCount})`, done: countOk || published },
    { key: 'participants', label: `Participants (${chosen})`, done: chosen > 0 },
    { key: 'published', label: 'Published', done: published },
    { key: 'live', label: 'Went live', done: wentLive },
    { key: 'ended', label: 'Ended', done: ended },
    { key: 'qualified', label: 'Results confirmed', done: finalized },
    { key: 'revealed', label: 'Revealed', done: finalized && !!session.results_revealed },
  ];
}

/** Results status shown to organizers: only states the data actually supports. */
export function resultsStatus(session, standings) {
  if (session.status === 'finalized') return { key: 'finalized', label: 'Finalized' };
  if (session.status === 'ended') {
    return standings.some((r) => r.tie_review) ? { key: 'review', label: 'Under review — ties flagged' } : { key: 'review', label: 'Under review' };
  }
  if (['running', 'paused'].includes(session.status)) return { key: 'provisional', label: 'Provisional — set is live' };
  return { key: 'none', label: 'No results yet' };
}

/**
 * A team's Round 1 standing across the active sets of its section:
 * highlighted / not highlighted in a finalized set's results, or its attempt status, else no attempt.
 * (Highlighting never selects a team for another round — every round has its own organiser selection.)
 * (Teams scored only on paper have no attempt and show "No device attempt".)
 */
export function round1TeamStatus(teamId, sets) {
  const active = sets.filter((x) => x.stage !== 'archived');
  const won = active.find((x) => x.status === 'finalized' && x.qualifiers?.includes(teamId));
  if (won) return { key: 'qualified', label: 'Highlighted in results', set: won.name };
  for (const x of [...active].sort(byNewest)) {
    const p = (x.participants || []).find((y) => y.team_id === teamId);
    if (!p) continue;
    if (x.status === 'finalized') return { key: 'eliminated', label: 'Round 1 complete', set: x.name };
    return { key: p.status, label: null, set: x.name };
  }
  return { key: 'none', label: 'No device attempt', set: null };
}
