import { computeStandings } from '../lib/scoring.js';
import { sessionQuestions } from '../lib/engine.js';

// The ONLY question shape the projector ever receives: no answer key, no
// explanation. Supabase mode reads the `questions` table, which has no key
// columns at all; demo mode strips them here.
export function publicQuestion(q) {
  return {
    id: q.id,
    position: q.position,
    question_text: q.question_text,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d ?? null,
    option_e: q.option_e ?? null,
    option_f: q.option_f ?? null,
    image_url: q.image_url || null,
  };
}

export function publicTeam(t) {
  return { id: t.id, team_number: t.team_number, team_name: t.team_name };
}

/**
 * `view` = one quiz set (engine setView): its session, settings, teams, answers.
 * `results` = the set's standings (engine setResults); computed from the view when omitted.
 */
export function buildPublicSnapshot(view, results = null) {
  const answers = view.answers.filter((a) => a.session_id === view.session.id);
  const tiebreaks = view.tiebreaks.filter((t) => t.session_id === view.session.id);
  const questions = sessionQuestions(view);
  const state = view;
  const standings = (results || computeStandings({ teams: state.teams, questions, answers, tiebreaks, settings: state.settings, attempts: view.attempts || [] }))
    .map(({ team_id, team_number, team_name, points, correct, incorrect, unanswered, rank, tiebreak }) => ({ team_id, team_number, team_name, points, correct, incorrect, unanswered, rank, tiebreak }));
  return {
    setId: state.session.id,
    section: state.session.section,
    session: state.session,
    settings: state.settings,
    questions: questions.map(publicQuestion),
    teams: state.teams.map(publicTeam),
    standings,
    // Self-paced progress for the projector: how many answers are in, never which.
    submitted: answers.length,
  };
}
