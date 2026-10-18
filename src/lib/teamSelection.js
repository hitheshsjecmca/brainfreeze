// Organiser team selection for a round — pure helpers shared by the team picker and the round pages.
// There is no fixed number of teams: any number of registered teams may be chosen, each at most once.

const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Teams matching a search (team number "12" / "t12", team name, participant or college) and a section ('ALL' = both). */
export function filterTeams(teams, { query = '', section = 'ALL' } = {}) {
  const q = norm(query).replace(/^t(?=\d)/, '');
  return teams.filter((t) => (section === 'ALL' || t.section === section)
    && (!q || String(t.team_number).startsWith(q)
      || [t.team_name, t.participant_1, t.participant_2, t.college_name].some((x) => norm(x).includes(q))));
}

/** The ids added to and removed from a selection. */
export function selectionDiff(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  return { added: after.filter((id) => !a.has(id)), removed: before.filter((id) => !b.has(id)) };
}

/** A problem with a selection (or null): duplicates, unknown teams, or none at all when one is required. */
export function selectionProblem(ids, teams, { min = 0 } = {}) {
  if (new Set(ids).size !== ids.length) return 'A team is selected more than once.';
  const known = new Set(teams.map((t) => t.id));
  if (ids.some((id) => !known.has(id))) return 'A selected team is no longer registered.';
  if (ids.length < min) return min === 1 ? 'Select at least one team.' : `Select at least ${min} teams.`;
  return null;
}

/** "T3 Frost Byte, T7 Null Pointers" in selection order. */
export const selectionNames = (ids, teams) => ids.map((id) => teams.find((t) => t.id === id)).filter(Boolean).map((t) => `T${t.team_number} ${t.team_name}`).join(', ');
