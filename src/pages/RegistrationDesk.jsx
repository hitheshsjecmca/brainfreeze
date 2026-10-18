import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Download, Lock, LogOut, Pencil, Plus, RefreshCw, Search, Users } from 'lucide-react';
import { BrandLockup } from '../components/Brand.jsx';
import { EmptyState, ErrorState, Field, Loading, Modal, ModeBadge } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { isDemoMode, registrationApi } from '../backend/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { SECTION_LABELS, SECTIONS } from '../lib/constants.js';
import { toCSV } from '../lib/csv.js';
import { downloadText, stamp } from '../lib/download.js';
import { toQuizError } from '../lib/errors.js';
import { validateTeam } from '../lib/validation.js';

const POLL_MS = 10_000;

// The registration desk sees teams and whether each section's quiz has
// started — nothing about questions, answers, scores or timers. Every save is
// re-validated (and locked once that team has started a quiz) by the database.
export default function RegistrationDesk() {
  const { user, signOut } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [section, setSection] = useState('ALL');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await registrationApi.overview());
      setError(null);
    } catch (e) {
      setError(toQuizError(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const status = useMemo(() => new Map((data?.sections || []).map((s) => [s.section, s])), [data]);
  const teams = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.teams || []).filter((t) => (section === 'ALL' || t.section === section)
      && (!q || String(t.team_number) === q.replace(/^t/, '')
        || [t.team_name, t.participant_1, t.participant_2, t.college_name || ''].some((v) => v.toLowerCase().includes(q))));
  }, [data, section, query]);

  const nextNumber = (sec) => {
    const used = new Set((data?.teams || []).filter((t) => t.section === sec).map((t) => t.team_number));
    for (let i = 1; i <= 999; i++) if (!used.has(i)) return i;
    return '';
  };
  const addSection = section === 'ALL' ? 'UG' : section;
  const exportCsv = () => downloadText(`brainfreze-registrations-${stamp()}.csv`, toCSV(
    ['section', 'team_number', 'team_name', 'participant_1', 'participant_2', 'college_name'],
    teams.map((t) => [t.section, t.team_number, t.team_name, t.participant_1, t.participant_2, t.college_name || '']),
  ), 'text/csv');

  return (
    <div className="reg-shell">
      <FrostBackdrop snow={false} />
      <header className="topbar glass reg-top">
        <BrandLockup size="sm" />
        <h1 className="reg-title"><ClipboardCheck size={20} /> Registration desk</h1>
        <ModeBadge isDemo={isDemoMode} />
        <span className="muted small hide-mobile" title={user?.email}>{user?.email}</span>
        <button className="btn btn-ghost btn-sm" onClick={signOut}><LogOut size={16} /> Sign out</button>
      </header>
      {isDemoMode && <div className="demo-banner" role="note">DEMO MODE — data is stored only in this browser. No login, no cloud sync.</div>}

      <main className="page reg-main" id="main">
        {!data && !error && <Loading label="Loading registrations…" />}
        {!data && error && <ErrorState title="Could not load registrations" error={error} onRetry={load} />}
        {data && (
          <>
            {error && <div className="inline-alert alert-warn" role="alert">Showing the last loaded data — refresh failed: {error.message}</div>}
            <div className="reg-sections">
              {SECTIONS.map((sec) => {
                const s = status.get(sec);
                return (
                  <article key={sec} className="panel glass reg-section-card">
                    <h2>{SECTION_LABELS[sec]}</h2>
                    <p><b>{s?.team_count ?? 0}</b>{data.capacity ? ` / ${data.capacity}` : ''} teams</p>
                    <p className="ok-text">Open for new registrations</p>
                    {s?.live_sets > 0 && <p className="warn-text small"><Lock size={14} /> {s.live_sets} quiz set(s) live — teams that have started are locked</p>}
                  </article>
                );
              })}
            </div>

            <div className="toolbar">
              <div className="segmented" role="radiogroup" aria-label="Section filter">
                {['ALL', ...SECTIONS].map((s) => (
                  <button key={s} role="radio" aria-checked={section === s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>{s === 'ALL' ? 'All' : s}</button>
                ))}
              </div>
              <label className="search">
                <Search size={16} aria-hidden="true" />
                <input type="search" placeholder="Search number, team, participant or college…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search registrations" />
              </label>
              <button className="btn btn-ghost btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
              <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!teams.length}><Download size={14} /> CSV (keep private)</button>
              <button className="btn btn-primary"
                onClick={() => setEditing({ section: addSection, team_number: nextNumber(addSection), team_name: '', participant_1: '', participant_2: '', college_name: '' })}>
                <Plus size={16} /> Register team
              </button>
            </div>

            {teams.length === 0 ? (
              <EmptyState icon={Users} title={data.teams.length ? 'No teams match' : 'No teams registered yet'}><p className="muted">Use “Register team” to add one.</p></EmptyState>
            ) : (
              <div className="table-wrap glass">
                <table className="table">
                  <thead>
                    <tr><th scope="col">Section</th><th scope="col">No.</th><th scope="col">Team</th><th scope="col">Participant 1</th><th scope="col">Participant 2</th><th scope="col">College</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {teams.map((t) => (
                      <tr key={t.id}>
                        <td><span className="badge badge-section">{t.section}</span></td>
                        <td className="num">{t.team_number}</td>
                        <td>{t.team_name} {t.is_demo && <span className="badge badge-amber badge-xs">DEMO</span>} {t.self_registered && <span className="badge badge-purple badge-xs">walk-in</span>}</td>
                        <td>{t.participant_1}</td>
                        <td>{t.participant_2}</td>
                        <td>{t.college_name || <span className="badge badge-amber badge-xs">missing</span>}</td>
                        <td className="actions">
                          {t.locked && <span className="badge badge-muted badge-xs" title="This team has started a quiz"><Lock size={11} /> locked</span>}
                          <button className="icon-btn" onClick={() => setEditing(t)} disabled={t.locked}
                            aria-label={`Edit ${t.section} team ${t.team_number}`} title={t.locked ? 'Locked: this team has started a quiz. Ask an organizer.' : 'Edit'}><Pencil size={16} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
      {editing && <RegistrationForm team={editing} all={data?.teams || []} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function RegistrationForm({ team, all, onClose, onSaved }) {
  const { toast } = useUI();
  const [form, setForm] = useState({ ...team, college_name: team.college_name || '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const check = validateTeam(form, all, team.id || null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const err = (k) => (touched ? check.errors[k] : undefined);
  const sectionLocked = !!team.locked;

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok || busy) return;
    setBusy(true);
    setServerError('');
    try {
      const { section, team_number, team_name, participant_1, participant_2, college_name } = check.value;
      await registrationApi.saveTeam({ id: team.id, section, team_number, team_name, participant_1, participant_2, college_name });
      toast('success', team.id ? 'Registration updated' : 'Team registered', `${section} team ${team_number} can now join a ${section} quiz by choosing its name.`, 10000);
      onSaved();
      onClose();
    } catch (e2) {
      setServerError(toQuizError(e2).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={team.id ? `Edit ${team.section} team ${team.team_number}` : 'Register a team'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" noValidate>
        <Field label="Section" error={err('section')}>
          <select value={form.section} onChange={set('section')}>
            {SECTIONS.map((s) => <option key={s} value={s}>{SECTION_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="Team number" error={err('team_number')}>
          <input type="number" min={1} max={999} value={form.team_number} onChange={set('team_number')} required />
        </Field>
        <Field label="Team name" error={err('team_name')}>
          <input value={form.team_name} onChange={set('team_name')} maxLength={80} required />
        </Field>
        <Field label="College name" error={err('college_name')}>
          <input value={form.college_name} onChange={set('college_name')} maxLength={120} required />
        </Field>
        <Field label="Participant 1" error={err('participant_1')}>
          <input value={form.participant_1} onChange={set('participant_1')} maxLength={80} required />
        </Field>
        <Field label="Participant 2" error={err('participant_2')}>
          <input value={form.participant_2} onChange={set('participant_2')} maxLength={80} required />
        </Field>
        {sectionLocked && <p className="inline-alert alert-warn small span-2" role="alert">This team has started a quiz, so its registration is locked. Ask an organizer.</p>}
        {serverError && <p className="inline-alert alert-danger small span-2" role="alert">{serverError}</p>}
        <p className="muted small span-2">Team numbers are unique within a section. Teams join a quiz by choosing their registered name, so check the names carefully.</p>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || sectionLocked}>{busy ? 'Saving…' : 'Save registration'}</button>
        </div>
      </form>
    </Modal>
  );
}
