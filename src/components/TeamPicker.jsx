import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { SECTION_LABELS } from '../lib/constants.js';
import { filterTeams, participantNames } from '../lib/teamSelection.js';

/**
 * Organiser team selection for a round (Round 1 sets, Round 2 games): a searchable list of
 * registered teams with checkboxes, an optional UG / PG filter, Select all (the teams shown), Clear, and a count.
 * Any number of teams; the value is an ordered list of team ids without duplicates (the pick order is kept).
 * `locked(team)` → a reason string keeps a selected team checked (e.g. it has already started);
 * `unavailable(team)` → a reason string makes an unselected team unpickable (e.g. it plays in another set).
 * `extra(team)` renders badges after the team name.
 */
export default function TeamPicker({ teams, value, onChange, label = 'Registered teams', sectionFilter = false, locked = () => null, unavailable = () => null, extra = null, disabled = false }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [section, setSection] = useState('ALL');
  const chosen = useMemo(() => new Set(value), [value]);
  const shown = filterTeams(teams, { query, section });
  const pickable = (t) => !disabled && !unavailable(t);
  const toggle = (t) => {
    if (disabled) return;
    if (chosen.has(t.id)) { if (!locked(t)) onChange(value.filter((x) => x !== t.id)); } else if (pickable(t)) onChange([...value, t.id]);
  };
  const selectShown = () => onChange([...value, ...shown.filter((t) => !chosen.has(t.id) && pickable(t)).map((t) => t.id)]);
  const clear = () => onChange(value.filter((x) => { const t = teams.find((y) => y.id === x); return t && locked(t); }));
  const sections = [...new Set(teams.map((t) => t.section))].sort();
  return (
    <div className="team-picker">
      <div className="row gap wrap align-end team-picker-tools">
        <label className="field team-picker-search" htmlFor={`${id}-q`}>
          <span>Search teams</span>
          <span className="input-icon"><Search size={15} aria-hidden="true" />
            <input id={`${id}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Team number, team, participant or college" autoComplete="off" />
          </span>
        </label>
        {sectionFilter && sections.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="Show section">
            {['ALL', ...sections].map((s) => (
              <button key={s} type="button" role="radio" aria-checked={section === s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>{s === 'ALL' ? 'All' : SECTION_LABELS[s] || s}</button>
            ))}
          </div>
        )}
      </div>
      <div className="row gap wrap align-center team-picker-actions">
        <span className="badge badge-ice" role="status" aria-live="polite">{value.length} selected</span>
        <span className="muted small">of {teams.length} registered{shown.length !== teams.length ? ` · ${shown.length} shown` : ''}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={selectShown} disabled={disabled || !shown.some((t) => !chosen.has(t.id) && pickable(t))}>
          Select all{shown.length !== teams.length ? ' shown' : ''}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={clear} disabled={disabled || !value.some((x) => { const t = teams.find((y) => y.id === x); return t && !locked(t); })}>Clear selection</button>
      </div>
      {shown.length === 0 ? <p className="muted small">{teams.length ? 'No team matches the search.' : 'No registered teams.'}</p> : (
        <ul className="q-pick-list team-picker-list" aria-label={label}>
          {shown.map((t) => {
            const on = chosen.has(t.id);
            const lock = on ? locked(t) : null;
            const why = on ? null : unavailable(t);
            return (
              <li key={t.id} className={why ? 'team-picker-unavailable' : ''}>
                <label className="check">
                  <input type="checkbox" checked={on} disabled={disabled || !!lock || !!why} onChange={() => toggle(t)} />
                  <span>
                    <b>{sectionFilter ? `${t.section} ` : ''}T{t.team_number}</b> {t.team_name} <small className="muted">{t.team_name === t.participant_1 && !t.participant_2 ? '' : participantNames(t)}{t.college_name ? ` · ${t.college_name}` : ''}</small>
                    {on && value.length > 1 && <span className="badge badge-muted badge-xs">#{value.indexOf(t.id) + 1}</span>}
                    {extra?.(t)}
                    {lock && <small className="muted"> — {lock}</small>}
                    {why && <small className="warn-text"> — {why}</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
