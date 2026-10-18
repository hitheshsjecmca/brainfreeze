import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Archive, Copy, FolderOpen, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, PageHeader } from '../components/Common.jsx';
import { SECTIONS, SET_STAGE_LABELS } from '../lib/constants.js';
import { formatJoinCode } from '../lib/joinCodes.js';
import { formatStamp, minutes } from '../lib/sets.js';

const STAGE_CLASS = { draft: 'badge-muted', published: 'badge-ice', live: 'badge-ok', completed: 'badge-purple', archived: 'badge-muted' };

/** Every quiz set (UG and PG): create, open, duplicate, delete drafts, archive. */
export default function QuizSets() {
  const { sets, setId, selectSet, act } = useQuiz();
  const { confirm } = useUI();
  const navigate = useNavigate();
  const [section, setSection] = useState('ALL');
  const [showArchived, setShowArchived] = useState(false);

  const shown = sets.filter((x) => (section === 'ALL' || x.section === section) && (showArchived || x.stage !== 'archived'))
    .sort((a, b) => a.section.localeCompare(b.section) || b.created_at.localeCompare(a.created_at));

  const open = (id) => { selectSet(id); navigate('/host/rounds/1/setup'); };

  async function duplicate(x) {
    const res = await act('duplicateSet', { id: x.id }, { key: `dup:${x.id}`, success: `Copied “${x.name}” into a new draft` });
    if (res.ok) open(res.result.id);
  }
  async function remove(x) {
    const ok = await confirm({ title: `Delete draft “${x.name}”?`, danger: true, confirmLabel: 'Delete draft', message: <p>Only the draft is deleted; the question bank and teams are not affected.</p> });
    if (ok) act('deleteSet', { id: x.id }, { key: `del:${x.id}`, success: 'Draft deleted' });
  }
  async function archive(x) {
    const ok = await confirm({
      title: `Archive “${x.name}”?`, danger: true, confirmLabel: 'Archive', requireReason: true,
      message: <p>Its join code stops working (and is never reused) and joined devices are signed out. Results, answers and the audit log are kept and stay viewable. Teams in this set become free to take another set of their section.</p>,
    });
    if (ok) act('archiveSet', { id: x.id, reason: ok.reason }, { key: `arc:${x.id}`, success: 'Set archived' });
  }

  return (
    <div className="page">
      <PageHeader title="Quiz sets" subtitle={`Any number of UG and PG sets. Each set has its own questions, timer, scoring, join code, team attempts and results. A team takes one set of its section.`}>
        <Link className="btn btn-primary" to="/host/rounds/1/new"><Plus size={16} /> New quiz set</Link>
      </PageHeader>

      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label="Filter by section">
          {['ALL', ...SECTIONS].map((s) => (
            <button key={s} role="radio" aria-checked={section === s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>{s === 'ALL' ? 'All' : s}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>

      {shown.length === 0 ? <EmptyState icon={Layers} title="No quiz sets" /> : (
        <div className="table-wrap glass">
          <table className="table">
            <thead>
              <tr><th scope="col">Set</th><th scope="col">Section</th><th scope="col">Stage</th><th scope="col">Questions</th><th scope="col">Timer</th><th scope="col">Join code</th><th scope="col">Teams joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.id} className={x.id === setId ? 'row-selected' : ''}>
                  <td>
                    <b>{x.name}</b>{x.id === setId && <span className="badge badge-ice badge-xs">selected</span>}
                    <br /><small className="muted">{x.published_at ? `Published ${formatStamp(x.published_at)}` : `Created ${formatStamp(x.created_at)}`}</small>
                  </td>
                  <td><span className="badge badge-section">{x.section}</span></td>
                  <td><span className={`badge ${STAGE_CLASS[x.stage]}`}>{SET_STAGE_LABELS[x.stage]}</span></td>
                  <td className={`num ${x.question_count === 0 ? 'warn-text' : ''}`}>{x.question_count}</td>
                  <td className="num">{minutes(x.duration_seconds)} min</td>
                  <td>{x.join_code_active ? <code>{formatJoinCode(x.join_code)}</code> : x.join_code ? <span className="muted">revoked</span> : <span className="muted">—</span>}</td>
                  <td className="num">{x.attempts}</td>
                  <td className="actions">
                    {x.stage === 'draft'
                      ? <button className="btn btn-ghost btn-sm" onClick={() => open(x.id)} aria-label={`Continue setup of ${x.name}`}><Pencil size={14} /> Continue setup</button>
                      : <button className="icon-btn" onClick={() => open(x.id)} aria-label={`Open ${x.name}`} title="Open"><FolderOpen size={16} /></button>}
                    <button className="icon-btn" onClick={() => duplicate(x)} aria-label={`Duplicate ${x.name}`} title="Duplicate as a new draft"><Copy size={16} /></button>
                    {x.stage === 'draft' && !x.join_code && <button className="icon-btn" onClick={() => remove(x)} aria-label={`Delete ${x.name}`} title="Delete draft"><Trash2 size={16} /></button>}
                    {x.stage !== 'archived' && x.stage !== 'live' && <button className="icon-btn" onClick={() => archive(x)} aria-label={`Archive ${x.name}`} title="Archive"><Archive size={16} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
