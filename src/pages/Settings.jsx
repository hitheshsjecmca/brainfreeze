import { useRef, useState } from 'react';
import { Archive, Database, Download, FileUp, RotateCcw, Save, ShieldCheck, ToggleLeft, Trash2 } from 'lucide-react';
import { useAppSettings } from '../context/AppSettingsContext.jsx';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { PageHeader } from '../components/Common.jsx';
import { backend } from '../backend/index.js';
import { buildBackup, validateBackup } from '../lib/backup.js';
import { answersCSV, auditCSV, standingsCSV } from '../lib/exports.js';
import { downloadText, readFileText, stamp } from '../lib/download.js';
import { toQuizError } from '../lib/errors.js';
import { EVENT_TIMEZONE, formatStamp } from '../lib/sets.js';

export default function SettingsPage() {
  const { snap, standings, qualification, act, refresh, isDemo, mode, loadBackupData, quizQuestions, selectSet } = useQuiz();
  const { confirm, toast } = useUI();
  const fileRef = useRef(null);
  const { session } = snap;

  /** Downloads a backup of EVERY quiz set. Returns false (and says why) if it could not be built. */
  async function exportBackup(silent = false) {
    try {
      const data = await loadBackupData();
      downloadText(`brainfreze-backup-${stamp()}.json`, JSON.stringify(buildBackup(data, mode), null, 2), 'application/json');
      if (!silent) toast('success', 'Backup downloaded', 'Every quiz set (UG and PG, archived included). It contains answer keys and team PINs — keep it private.');
      return true;
    } catch (e) {
      toast('error', 'Backup failed — nothing was changed', toQuizError(e).message);
      return false;
    }
  }

  async function onRestoreFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let backup;
    try {
      backup = JSON.parse(await readFileText(file));
      validateBackup(backup);
    } catch (err) {
      toast('error', 'Cannot restore this file', toQuizError(err).message);
      return;
    }
    const ok = await confirm({
      title: 'Restore backup?', danger: true, confirmLabel: 'Restore', typeToConfirm: 'RESTORE',
      message: (
        <>
          <p><b>{file.name}</b> — exported {backup.exported_at ? new Date(backup.exported_at).toLocaleString() : 'unknown'} from {backup.source_mode || 'unknown'} mode.</p>
          <p>{backup.teams.length} teams · {backup.questions.length} questions · {backup.answers.length} answers · {backup.events.length} audit events.</p>
          <p>ALL current quiz data (every set) will be replaced. A backup of the current data downloads first. A live set is restored as paused (team timers frozen) and restored sets never keep an active join code.</p>
        </>
      ),
    });
    if (!ok) return;
    if (!(await exportBackup(true))) return;
    await act('restoreBackup', { backup }, { success: 'Backup restored' });
  }

  async function removeDemo() {
    const demoTeams = snap.teams.filter((t) => t.is_demo).length;
    const samples = snap.questions.filter((q) => q.is_sample).length;
    if (!demoTeams && !samples) { toast('info', 'No demo data', 'There are no demo teams or sample questions.'); return; }
    const ok = await confirm({
      title: 'Remove demo data?', danger: true, confirmLabel: 'Remove', typeToConfirm: 'REMOVE',
      message: <p>Deletes {demoTeams} demo team(s) and {samples} sample question(s), plus any answers recorded for them. A backup downloads first.</p>,
    });
    if (!ok) return;
    if (!(await exportBackup(true))) return;
    await act('removeDemoData', { teams: true, questions: true, confirm: true }, { success: 'Demo data removed' });
  }

  async function resetDemo() {
    const ok = await confirm({
      title: 'Reset demo to fresh sample data?', danger: true, confirmLabel: 'Reset demo', typeToConfirm: 'RESET',
      message: <p>Replaces everything in this browser with 12 demo teams, 60 sample questions and a new session. A backup of the current data downloads first.</p>,
    });
    if (!ok) return;
    if (!(await exportBackup(true))) return;
    try {
      await backend.resetDemo();
      await refresh();
      toast('success', 'Demo data reset');
    } catch (err) {
      toast('error', 'Reset failed', toQuizError(err).message);
    }
  }

  async function newSession() {
    const ok = await confirm({
      title: 'Archive this set and start a new draft copy?', danger: true, confirmLabel: 'Archive & copy', typeToConfirm: 'NEW SESSION',
      message: <p>“{session.name}” is archived (its join code stops working, devices are signed out; results, answers and the audit log are kept and stay viewable). A new draft with the same questions and settings is created and selected. Other sets are not affected. A backup downloads first.</p>,
    });
    if (!ok) return;
    if (!(await exportBackup(true))) return;
    const res = await act('newSession', {}, { success: 'New draft set created' });
    if (res.ok && res.result?.id) selectSet(res.result.id);
  }

  return (
    <div className="page">
      <PageHeader title="Settings & Backup" subtitle={`${isDemo ? 'Local demo mode' : 'Supabase cloud mode'} · set “${session.name}” (${session.section}) · ${session.id.slice(0, 8)}`} />

      <div className="two-col">
        <section className="panel glass" aria-labelledby="app-title">
          <h2 id="app-title">Application settings</h2>
          <dl className="kv">
            <dt>Mode</dt><dd>{isDemo ? 'Local demo (this browser only)' : 'Supabase cloud'}</dd>
            <dt>Event timezone</dt><dd>{EVENT_TIMEZONE} — now {formatStamp(new Date().toISOString())}</dd>
            <dt>Timer & scoring</dt><dd>Per quiz set, in Rounds → Round 1 → Set setup &amp; join (frozen once published)</dd>
          </dl>
          <p className="muted small">Timestamps are stored in UTC and shown in the event timezone. Change it with <code>VITE_EVENT_TIMEZONE</code> at build time.</p>
        </section>

        <section className="panel glass" aria-labelledby="exp-title">
          <h2 id="exp-title"><Download size={18} /> Exports — {session.name}</h2>
          <div className="stack">
            <button className="btn btn-ghost" onClick={() => downloadText(`brainfreze-scores-${stamp()}.csv`, standingsCSV(standings, { set: session, teams: snap.teams, settings: snap.settings, qualification, qualifiers: session.status === 'finalized' ? session.qualifiers : null, provisional: session.status !== 'finalized' }), 'text/csv')}>Scores / standings CSV</button>
            <button className="btn btn-ghost" onClick={() => downloadText(`brainfreze-answers-${stamp()}.csv`, answersCSV({ ...snap, questions: quizQuestions }), 'text/csv')}>All recorded answers CSV</button>
            <button className="btn btn-ghost" onClick={() => downloadText(`brainfreze-audit-${stamp()}.csv`, auditCSV(snap.events), 'text/csv')}>Audit history CSV</button>
          </div>
        </section>
      </div>

      <Round3AvailabilityPanel />

      <div className="two-col">
        <section className="panel glass" aria-labelledby="bk-title">
          <h2 id="bk-title"><Database size={18} /> Backup & restore</h2>
          <p className="muted small">JSON backups include every quiz set (frozen questions, team attempts and their question orders), teams, questions <b>with answer keys</b>, settings, recorded answers, audit history and tie-breaks. Store them privately — never in a public repo.</p>
          <div className="row gap wrap">
            <button className="btn btn-primary" onClick={() => exportBackup()}><Save size={16} /> Download JSON backup</button>
            <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}><FileUp size={16} /> Restore from backup…</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onRestoreFile} />
          </div>
        </section>

        <section className="panel glass" aria-labelledby="dz-title">
          <h2 id="dz-title" className="text-danger"><Trash2 size={18} /> Data management</h2>
          <div className="stack">
            <button className="btn btn-ghost" onClick={removeDemo}><Trash2 size={16} /> Remove demo teams & sample questions</button>
            <button className="btn btn-ghost" onClick={newSession}><Archive size={16} /> Archive this set & start a new draft copy</button>
            {isDemo && <button className="btn btn-danger" onClick={resetDemo}><RotateCcw size={16} /> Reset demo data</button>}
          </div>
        </section>
      </div>

      <section className="panel glass" aria-labelledby="sec-title">
        <h2 id="sec-title"><ShieldCheck size={18} /> Security status</h2>
        {isDemo ? (
          <ul className="issue-list warn">
            <li>Demo mode: no authentication, no server-side validation, data only in this browser's localStorage.</li>
            <li>Anyone with access to this browser can change data. Do not use demo mode for the official event.</li>
          </ul>
        ) : (
          <ul className="issue-list ok">
            <li>Signed in as an organizer; database Row Level Security restricts all data to organizers.</li>
            <li>Scores are computed in the database from the private answer key; the browser only submits the selected option.</li>
            <li>Every score change is written to an append-only audit log with idempotent request IDs.</li>
            <li>The projector loads questions without answer keys and aggregate standings only.</li>
          </ul>
        )}
      </section>
    </div>
  );
}

/** Round 3 Availability: an event-wide switch, stored in the database (demo: this browser) and enforced there. */
function Round3AvailabilityPanel() {
  const { round3Enabled, loading, error, refresh, setRound3Enabled, settings } = useAppSettings();
  const { confirm, toast } = useUI();
  const [saving, setSaving] = useState(false);

  async function change(enabled) {
    if (saving || loading || enabled === round3Enabled) return;
    const ok = await confirm({
      title: enabled ? 'Enable Round 3?' : 'Disable Round 3?',
      confirmLabel: enabled ? 'Enable Round 3' : 'Disable Round 3',
      danger: !enabled,
      message: enabled
        ? <p>Round 3 — THE KNOWLEDGE AUCTION becomes available again for every organizer: its pages, auction sets, projector and results return with all their existing data.</p>
        : <p>Round 3 is hidden everywhere on the website and every Round 3 action is refused. Nothing is deleted: auction sets, auctions and results are kept, and enabling Round 3 again restores them. Rounds 1 and 2 are not affected.</p>,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await setRound3Enabled(enabled);
      toast('success', enabled ? 'Round 3 enabled' : 'Round 3 disabled');
    } catch (e) {
      toast('error', 'Round 3 Availability was not changed', toQuizError(e).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel glass" aria-labelledby="r3a-title">
      <h2 id="r3a-title"><ToggleLeft size={18} /> Round 3 Availability</h2>
      <div className="segmented" role="radiogroup" aria-labelledby="r3a-title">
        {[[false, 'Disabled'], [true, 'Enabled']].map(([value, label]) => (
          <button key={label} type="button" role="radio" aria-checked={!loading && round3Enabled === value} className={!loading && round3Enabled === value ? 'active' : ''}
            disabled={loading || saving || !!error} onClick={() => change(value)}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {loading ? 'Loading…' : round3Enabled
          ? 'Round 3 — THE KNOWLEDGE AUCTION is available to organizers.'
          : 'Round 3 is hidden from the website and its pages, projector and actions are blocked. Its data is kept.'}
        {!loading && settings.updated_at && <> Last changed {formatStamp(settings.updated_at)}.</>}
      </p>
      {error && (
        <div className="inline-alert alert-warn" role="alert">
          Could not load Round 3 Availability (Round 3 stays hidden): {error.message} <button className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button>
        </div>
      )}
    </section>
  );
}
