import { useMemo, useRef, useState } from 'react';
import { Download, FileUp, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, Field, Modal, PageHeader } from '../components/Common.jsx';
import { ATTEMPT_STATUS_LABELS, SECTIONS } from '../lib/constants.js';
import { round1TeamStatus } from '../lib/rounds.js';
import { parseCSVObjects, teamTemplateCSV, toCSV, TEAM_CSV_HEADERS, TEAM_EXPORT_HEADERS } from '../lib/csv.js';
import { downloadText, readFileText, stamp } from '../lib/download.js';
import { validateTeam } from '../lib/validation.js';
import { DEMO_TEAMS } from '../data/demoTeams.js';

function nextFreeNumber(teams) {
  const used = new Set(teams.map((t) => t.team_number));
  for (let i = 1; i <= 999; i++) if (!used.has(i)) return i;
  return '';
}

const STATUS_CLASS = { qualified: 'badge-ok', eliminated: 'badge-muted', in_progress: 'badge-ice', submitted: 'badge-ice', timed_out: 'badge-amber', organizer_finalized: 'badge-purple', ready: 'badge-muted' };

/** Every registered team (UG and PG) with its Round 1 status; add, edit, import, export and delete. */
export default function Teams() {
  const { snap, act, section: setSection, sets } = useQuiz();
  const { confirm, toast } = useUI();
  const [query, setQuery] = useState('');
  const [view, setView] = useState('ALL');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(null);
  const fileRef = useRef(null);
  const all = snap.allTeams || snap.teams;
  // Add/import need a concrete section: the filter's, else the selected quiz set's.
  const section = view === 'ALL' ? setSection : view;
  const sectionTeams = all.filter((t) => t.section === section);

  const status = useMemo(() => new Map(all.map((t) => [t.id, round1TeamStatus(t.id, sets)])), [all, sets]);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    return all.filter((t) => (view === 'ALL' || t.section === view)
      && (!s || String(t.team_number) === s.replace(/^t/, '')
        || [t.team_name, t.participant_1, t.participant_2, t.college_name || ''].some((v) => v.toLowerCase().includes(s))));
  }, [all, query, view]);

  async function remove(team) {
    const first = await confirm({
      title: `Delete ${team.section} team ${team.team_number}?`, danger: true, confirmLabel: 'Delete team',
      message: <p>Delete <strong>{team.team_name}</strong>? This cannot be undone.</p>,
    });
    if (!first) return;
    const res = await act('deleteTeam', { id: team.id }, { key: `del:${team.id}`, success: `Team ${team.team_number} deleted`, quietCodes: ['TEAM_HAS_ANSWERS'] });
    if (res.ok || res.error?.code !== 'TEAM_HAS_ANSWERS') return;
    // The database found recorded answers (in any set): ask again, explicitly.
    const ok = await confirm({
      title: `Team ${team.team_number} has recorded answers`, danger: true, confirmLabel: 'Delete team and answers',
      message: <p>{res.error.message} Deleting the team permanently removes those answers and their points. The deletion is recorded in the audit log.</p>,
      typeToConfirm: `DELETE ${team.team_number}`,
    });
    if (ok) await act('deleteTeam', { id: team.id, confirm: true }, { key: `del:${team.id}`, success: `Team ${team.team_number} deleted` });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const rows = parseCSVObjects(await readFileText(file));
      if (!rows.length) { toast('error', 'Empty CSV', 'No data rows found.'); return; }
      const missing = TEAM_CSV_HEADERS.filter((h) => !(h in rows[0]));
      if (missing.length) { toast('error', 'Missing CSV columns', missing.join(', ')); return; }
      setImporting({ fileName: file.name, rows });
    } catch (err) {
      toast('error', 'Could not read file', err.message);
    }
  }

  const exportTeams = () => downloadText(`brainfreze-teams-${view}-${stamp()}.csv`,
    toCSV(TEAM_EXPORT_HEADERS, filtered.map((t) => TEAM_EXPORT_HEADERS.map((h) => t[h]))), 'text/csv');
  const missingCollege = all.filter((t) => !t.college_name).length;

  return (
    <div className="page">
      <PageHeader title="Teams" subtitle={`${all.length} registered · ${SECTIONS.map((sec) => `${sec} ${all.filter((t) => t.section === sec).length}`).join(' · ')} · two participants per team · team numbers are unique within a section`}>
        <button className="btn btn-ghost" onClick={exportTeams} disabled={!filtered.length}><Download size={16} /> Export</button>
        <button className="btn btn-primary" onClick={() => setEditing({ section, team_number: nextFreeNumber(sectionTeams), team_name: '', participant_1: '', participant_2: '', college_name: '' })}>
          <Plus size={16} /> Add {section} team
        </button>
      </PageHeader>

      {missingCollege > 0 && (
        <p className="inline-alert alert-warn small" role="note">{missingCollege} team(s) have no college name (registered before colleges were recorded). Edit them to add it.</p>
      )}
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label="Section filter">
          {['ALL', ...SECTIONS].map((x) => (
            <button key={x} role="radio" aria-checked={view === x} className={view === x ? 'active' : ''} onClick={() => setView(x)}>{x === 'ALL' ? 'All' : x}</button>
          ))}
        </div>
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder="Search by number, team, participant or college…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search teams" />
        </label>
        <details className="menu">
          <summary className="btn btn-ghost btn-sm">More…</summary>
          <div className="menu-body glass">
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><FileUp size={14} /> Import CSV into {section}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => downloadText('brainfreze-teams-template.csv', teamTemplateCSV(), 'text/csv')}><Download size={14} /> CSV template</button>
            {sectionTeams.length === 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => act('importTeams', { rows: DEMO_TEAMS }, { success: 'Demo teams loaded', target: { section } })}>Load 12 demo teams into {section}</button>
            )}
          </div>
        </details>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onFile} />
      </div>

      {all.length === 0 ? (
        <EmptyState icon={Users} title="No teams yet"><p className="muted">Add teams one by one, import the CSV template, or use the registration desk.</p></EmptyState>
      ) : (
        <div className="table-wrap glass">
          <table className="table">
            <thead>
              <tr><th scope="col">Section</th><th scope="col">No.</th><th scope="col">Team</th><th scope="col">Participants</th><th scope="col">College</th><th scope="col">Round 1</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const st = status.get(t.id);
                return (
                  <tr key={t.id}>
                    <td><span className="badge badge-section">{t.section}</span></td>
                    <td className="num">{t.team_number}</td>
                    <td>{t.team_name} {t.is_demo && <span className="badge badge-amber badge-xs">DEMO</span>}</td>
                    <td className="small">{t.participant_1} &amp; {t.participant_2}</td>
                    <td>{t.college_name || <span className="badge badge-amber badge-xs">missing</span>}</td>
                    <td>
                      {st.key === 'none' ? <span className="muted small">{st.label}</span>
                        : <span className={`badge badge-xs ${STATUS_CLASS[st.key] || ''}`}>{st.label || ATTEMPT_STATUS_LABELS[st.key]}</span>}
                      {st.set && <small className="muted"> · {st.set}</small>}
                    </td>
                    <td className="actions">
                      <button className="icon-btn" onClick={() => setEditing(t)} aria-label={`Edit ${t.section} team ${t.team_number}`}><Pencil size={16} /></button>
                      <button className="icon-btn danger" onClick={() => remove(t)} aria-label={`Delete ${t.section} team ${t.team_number}`}><Trash2 size={16} /></button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && <tr><td colSpan={7} className="muted center">No teams match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Round 1 status comes from team-device attempts and confirmed qualifiers in active quiz sets. Teams scored only on paper show “No device attempt”.</p>

      {editing && <TeamForm team={{ college_name: '', ...editing }} teams={all} onClose={() => setEditing(null)} />}
      {importing && <ImportTeams data={importing} section={section} teams={sectionTeams} hasAnswers={snap.section === section && snap.answers.length > 0} onClose={() => setImporting(null)} />}
    </div>
  );
}

function TeamForm({ team, teams, onClose }) {
  const { act } = useQuiz();
  const [form, setForm] = useState(team);
  const [touched, setTouched] = useState(false);
  const check = validateTeam({ ...form, section: team.section }, teams, team.id || null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    const res = await act('saveTeam', { ...check.value, id: team.id, is_demo: team.is_demo }, { key: 'saveTeam', success: team.id ? 'Team updated' : 'Team added' });
    if (res.ok) onClose();
  }
  const err = (k) => (touched ? check.errors[k] : undefined);

  return (
    <Modal title={team.id ? `Edit team ${team.team_number}` : 'Add team'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" noValidate>
        <Field label="Team number" error={err('team_number')}>
          <input type="number" min={1} max={999} value={form.team_number} onChange={set('team_number')} required />
        </Field>
        <Field label="Team name" error={err('team_name')}>
          <input value={form.team_name} onChange={set('team_name')} maxLength={80} required />
        </Field>
        <Field label="Participant 1" error={err('participant_1')}>
          <input value={form.participant_1} onChange={set('participant_1')} maxLength={80} required />
        </Field>
        <Field label="Participant 2" error={err('participant_2')}>
          <input value={form.participant_2} onChange={set('participant_2')} maxLength={80} required />
        </Field>
        <Field label="College name" error={err('college_name')}>
          <input value={form.college_name || ''} onChange={set('college_name')} maxLength={120} required />
        </Field>
        <p className="muted small span-2">Section: <b>{team.section}</b>. Registration staff can also edit teams that have not started a quiz.</p>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary">Save team</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportTeams({ data, section, teams, hasAnswers, onClose }) {
  const { act } = useQuiz();
  const { confirm } = useUI();
  const [replace, setReplace] = useState(false);
  const base = replace ? [] : teams;
  const checked = [];
  const rows = data.rows.map((r) => {
    const c = validateTeam({ ...r, section: r.section || section }, [...base, ...checked.map((x) => x.value)], null);
    checked.push(c);
    return { r, c };
  });
  const errors = rows.filter((x) => !x.c.ok || x.c.value.section !== section);

  async function run() {
    if (replace) {
      const ok = await confirm({
        title: 'Replace all teams?', danger: true, confirmLabel: 'Replace teams',
        message: <p>All {teams.length} existing {section} teams{hasAnswers ? ' and their recorded answers' : ''} will be deleted and replaced by {rows.length} imported teams. The other section is not affected.</p>,
        typeToConfirm: hasAnswers ? 'REPLACE' : undefined,
      });
      if (!ok) return;
    }
    // Imports run on the section's newest set, so a PG import works while a UG set is selected.
    const res = await act('importTeams', { rows: rows.map(({ r }) => ({ ...r })), replace, confirm: replace }, { success: `${rows.length} team(s) imported`, target: { section } });
    if (res.ok) onClose();
  }

  return (
    <Modal title={`Import teams — ${data.fileName}`} onClose={onClose} wide>
      <p className="muted">{rows.length} row(s) found; they are imported into the <b>{section}</b> section. The import is all-or-nothing: if any row is invalid, nothing is imported.</p>
      <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace all existing {section} teams</label>
      {errors.length > 0 && (
        <div className="inline-alert alert-danger" role="alert">
          <div><strong>{errors.length} invalid row(s):</strong>
            <ul>{errors.slice(0, 8).map(({ r, c }) => <li key={r.__line}>Line {r.__line}: {Object.values(c.errors).join(' ') || `Section ${c.value.section} does not match ${section}.`}</li>)}</ul>
          </div>
        </div>
      )}
      <div className="table-wrap preview">
        <table className="table table-compact">
          <thead><tr><th>Line</th><th>No.</th><th>Team</th><th>P1</th><th>P2</th><th>College</th><th>Status</th></tr></thead>
          <tbody>
            {rows.slice(0, 60).map(({ r, c }) => (
              <tr key={r.__line} className={c.ok ? '' : 'row-error'}>
                <td>{r.__line}</td><td>{r.team_number}</td><td>{r.team_name}</td><td>{r.participant_1}</td><td>{r.participant_2}</td><td>{r.college_name}</td>
                <td>{c.ok ? 'OK' : 'Invalid'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={errors.length > 0} onClick={run}>Import {rows.length} team(s)</button>
      </div>
    </Modal>
  );
}
