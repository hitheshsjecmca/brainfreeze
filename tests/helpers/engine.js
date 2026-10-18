// Demo-engine test helpers.
import { applyAction, resolveSetId } from '../../src/lib/engine.js';

/**
 * Round 1 (manual selection, migration 15): select a set's participants as the organiser — every team of the set's
 * section, or only the given team numbers. Without a set id: the newest active UG set.
 */
export function selectTeams(state, setId = null, numbers = null, now = Date.now(), { free = false } = {}) {
  const id = setId ?? resolveSetId(state, null);
  const set = state.sets.find((x) => x.session.id === id);
  // free: skip teams already chosen for another active set of the section (a team takes part in one set at a time)
  const taken = new Set(free ? state.sets.filter((x) => x.session.id !== id && x.session.is_current !== false && x.session.section === set.session.section)
    .flatMap((x) => x.session.team_ids || []) : []);
  const ids = state.teams.filter((t) => t.section === set.session.section && (!numbers || numbers.includes(t.team_number)) && !taken.has(t.id)).map((t) => t.id);
  return applyAction(state, 'setSetTeams', { set_id: id, team_ids: ids }, { now }).state;
}
