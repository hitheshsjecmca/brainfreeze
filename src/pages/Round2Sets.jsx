import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Archive, ArrowLeft, CheckCircle2, Copy, Eye, Pencil, Plus, Rocket, Save, Trash2 } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useR2Data, useRound2 } from '../context/Round2Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, ErrorState, Field, Loading, Modal } from '../components/Common.jsx';
import { TriviaBoard } from '../components/Round2Bits.jsx';
import { formatJoinCode } from '../lib/joinCodes.js';
import { formatStamp } from '../lib/sets.js';
import {
  R2_DEFAULTS, R2_SECTIONS, R2_SECTION_LABELS, boardTopics, formatScore, publishIssues, validateR2Question, validateR2SetFields, validateTopicName,
} from '../lib/round2.js';

function useCopy() {
  const { toast } = useUI();
  return async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast('success', `${what} copied`); } catch { toast('warn', 'Copy failed', 'Select and copy it manually.'); }
  };
}

const statusOf = (s) => (s.archived_at ? ['Archived', 'badge-muted'] : s.published_version ? [`Published v${s.published_version}`, 'badge-ok'] : ['Draft', 'badge-amber']);

/** Every trivia set (draft, published, archived) and "New trivia set". */
export function TriviaSets() {
  const { act } = useRound2();
  const navigate = useNavigate();
  const copy = useCopy();
  const { data, error, reload } = useR2Data(() => backend.round2.overview(), 'overview');
  const [creating, setCreating] = useState(false);
  if (error && !data) return <ErrorState title="Trivia sets could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading trivia sets…" />;

  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r2-sets-title">
        <div className="panel-head">
          <h2 id="r2-sets-title">Trivia sets</h2>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New trivia set</button>
        </div>
        <p className="muted small">Build any number of independent trivia boards. Each set is a draft until you publish it; publishing freezes a version and gives the set a six-digit code that you enter on <Link to="/host/rounds/2/join">Join Round 2</Link> to start a live game.</p>
        {data.sets.length === 0 ? <EmptyState title="No trivia sets yet"><p className="muted">Create one, add topics and point-valued questions, then publish it.</p></EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Trivia set</th><th scope="col">Section</th><th scope="col">Board</th><th scope="col">Status</th><th scope="col">Code</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.sets.map((s) => {
                  const [label, cls] = statusOf(s);
                  return (
                    <tr key={s.id} className={s.archived_at ? 'row-dim' : ''}>
                      <td><b>{s.title}</b>{s.unpublished_changes && !s.archived_at && <> <span className="badge badge-amber badge-xs">unpublished changes</span></>}{s.live_sessions > 0 && <> <span className="badge badge-ice badge-xs">{s.live_sessions} live</span></>}</td>
                      <td>{R2_SECTION_LABELS[s.section]}</td>
                      <td className="small">{s.topic_count} topic(s) · {s.question_count} question(s)</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td>{s.join_code && !s.archived_at ? <span className="row gap"><code className="r2-code">{formatJoinCode(s.join_code)}</code><button className="icon-btn" onClick={() => copy(s.join_code, 'Code')} aria-label={`Copy the code of ${s.title}`}><Copy size={14} /></button></span> : <span className="muted">—</span>}</td>
                      <td className="actions"><Link className="btn btn-ghost btn-sm" to={`/host/rounds/2/sets/${s.id}`}>{s.archived_at ? <><Eye size={14} /> View</> : <><Pencil size={14} /> Open</>}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && (
        <SetForm onClose={() => setCreating(false)} onSaved={async (fields) => {
          const res = await act('r2sSaveSet', fields, { key: 'r2-set', success: 'Trivia set created' });
          if (res.ok) navigate(`/host/rounds/2/sets/${res.result.id}`);
          return res.ok;
        }} />
      )}
    </div>
  );
}

/** Title, section compatibility and timer (new set or edit). */
function SetForm({ set = null, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: set?.title ?? '', section: set?.section ?? 'BOTH',
    timer_seconds: String(set?.timer_seconds ?? R2_DEFAULTS.timer_seconds),
  });
  const [touched, setTouched] = useState(false);
  const check = validateR2SetFields(form);
  const err = (k) => (touched ? check.errors[k] : undefined);
  const set_ = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    if (await onSaved({ id: set?.id, ...form })) onClose();
  }
  return (
    <Modal title={set ? 'Trivia set settings' : 'New trivia set'} onClose={onClose} labelledBy="r2-setf">
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Trivia set title" error={err('title')}><input value={form.title} onChange={set_('title')} maxLength={80} autoFocus placeholder="e.g. UG Round 2 board" /></Field>
        <Field label="Section" error={err('section')} hint="Which sections may play this set.">
          <select value={form.section} onChange={set_('section')}>{R2_SECTIONS.map((s) => <option key={s} value={s}>{R2_SECTION_LABELS[s]}</option>)}</select>
        </Field>
        <div className="form-grid">
          <Field label="Question timer (seconds)" error={err('timer_seconds')} hint={`Default ${R2_DEFAULTS.timer_seconds}. Display only — it never scores.`}>
            <input type="number" min={5} max={120} value={form.timer_seconds} onChange={set_('timer_seconds')} />
          </Field>
        </div>
        <p className="muted small">Scoring: Right adds the question&rsquo;s points to the team that answered (a 20-point question: +20); Wrong and closing a question without a result give 0. Nothing is deducted.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"><Save size={16} /> {set ? 'Save settings' : 'Create set'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** One trivia set: its draft (topics, questions, answers), a board preview, Publish and its code. */
export function TriviaSetEditor() {
  const { setId } = useParams();
  const { act, pendingKeys } = useRound2();
  const { confirm } = useUI();
  const navigate = useNavigate();
  const copy = useCopy();
  const { data, error, reload } = useR2Data(() => backend.round2.setDetail(setId), setId);
  const [newTopic, setNewTopic] = useState('');
  const [editing, setEditing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [settings, setSettings] = useState(false);
  if (error && !data) return <ErrorState title="Trivia set could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading trivia set…" />;

  const { set: s, topics, questions } = data;
  const archived = !!s.archived_at;
  const issues = publishIssues(topics, questions);
  const topicErr = newTopic.trim() ? validateTopicName(newTopic, topics).error : null;
  const [label, cls] = statusOf(s);

  async function addTopic(e) {
    e.preventDefault();
    const res = await act('r2sSaveTopic', { set_id: s.id, name: newTopic }, { key: 'r2-topic', success: 'Topic added' });
    if (res.ok) setNewTopic('');
  }
  async function removeTopic(t) {
    const n = questions.filter((q) => q.topic_id === t.id).length;
    const ok = await confirm({ title: `Delete topic “${t.name}”?`, danger: true, confirmLabel: 'Delete topic', message: <p>Its {n} question(s) are deleted from this draft. Published versions and live games keep their own copy.</p> });
    if (ok) act('r2sDeleteTopic', { id: t.id }, { key: `r2-del-${t.id}`, success: 'Topic deleted' });
  }
  async function removeQuestion(q) {
    const ok = await confirm({ title: `Delete this ${formatScore(q.points)}-point question?`, danger: true, confirmLabel: 'Delete question', message: <p>“{q.question_text}”</p> });
    if (ok) act('r2sDeleteQuestion', { id: q.id }, { key: `r2-delq-${q.id}`, success: 'Question deleted' });
  }
  async function publish() {
    const ok = await confirm({
      title: s.published_version ? `Publish version ${s.published_version + 1} of “${s.title}”?` : `Publish “${s.title}”?`,
      confirmLabel: 'Publish Trivia Set',
      message: (
        <>
          <p>{topics.length} topic(s) and {questions.length} question(s) are frozen as version {s.published_version + 1}.</p>
          <p>{s.join_code ? <>The set keeps its code <b>{formatJoinCode(s.join_code)}</b>; new games use this version. Games already running keep the version they started with.</> : 'A unique six-digit code is generated for this set.'}</p>
        </>
      ),
    });
    if (!ok) return;
    await act('r2sPublishSet', { id: s.id }, { key: 'r2-publish', success: 'Trivia set published', successDetail: (r) => `Version ${r.version} · code ${formatJoinCode(r.join_code)}` });
  }
  async function archive() {
    const ok = await confirm({ title: `Archive “${s.title}”?`, danger: true, confirmLabel: 'Archive', message: <p>Its code stops working for new games. Finished games and their scores are kept.</p> });
    if (ok) act('r2sArchiveSet', { id: s.id }, { key: 'r2-archive', success: 'Trivia set archived' });
  }
  async function remove() {
    const ok = await confirm({ title: `Delete draft “${s.title}”?`, danger: true, confirmLabel: 'Delete draft', message: <p>The draft and all its topics and questions are deleted. This cannot be undone.</p> });
    if (!ok) return;
    const res = await act('r2sDeleteSet', { id: s.id }, { key: 'r2-delset', success: 'Draft deleted' });
    if (res.ok) navigate('/host/rounds/2/sets');
  }

  return (
    <div className="stack">
      <Link to="/host/rounds/2/sets" className="back-link"><ArrowLeft size={16} /> All trivia sets</Link>
      <section className="panel glass" aria-labelledby="r2-set-title">
        <div className="panel-head">
          <div>
            <h2 id="r2-set-title">{s.title} <span className={`badge ${cls}`}>{label}</span></h2>
            <p className="muted small">{R2_SECTION_LABELS[s.section]} · {s.timer_seconds}-second timer · Right + points, Wrong 0{s.published_at && <> · last published {formatStamp(s.published_at)}</>}</p>
          </div>
          {!archived && (
            <div className="row gap wrap">
              <button className="btn btn-ghost btn-sm" onClick={() => setSettings(true)}><Pencil size={14} /> Settings</button>
              {s.published_version > 0
                ? <button className="btn btn-ghost btn-sm" onClick={archive} disabled={data.live_sessions > 0} title={data.live_sessions ? 'End its live game first' : undefined}><Archive size={14} /> Archive</button>
                : <button className="btn btn-ghost btn-sm" onClick={remove}><Trash2 size={14} /> Delete draft</button>}
            </div>
          )}
        </div>
        {s.join_code && !archived && (
          <div className="r2-code-box">
            <span className="muted small">Six-digit code (enter it on Join Round 2)</span>
            <strong className="join-code-big" aria-label={`Code ${s.join_code.split('').join(' ')}`}>{formatJoinCode(s.join_code)}</strong>
            <button className="btn btn-primary btn-sm" onClick={() => copy(s.join_code, 'Code')}><Copy size={14} /> Copy code</button>
          </div>
        )}
        {!archived && (
          <div className="r2-publish">
            {issues.length ? (
              <div className="inline-alert alert-warn small" role="status"><AlertTriangle size={16} /><div><b>Before publishing:</b><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div></div>
            ) : (
              <p className="ok-text small" role="status"><CheckCircle2 size={16} /> {s.published_version === 0 ? 'Ready to publish.' : s.unpublished_changes ? `The draft has changes that are not in version ${s.published_version}.` : `Version ${s.published_version} matches this draft.`}</p>
            )}
            <button className="btn btn-primary" onClick={publish} disabled={issues.length > 0 || pendingKeys.has('r2-publish')}><Rocket size={16} /> Publish Trivia Set</button>
          </div>
        )}
        {archived && <p className="muted">This set is archived. Its code no longer starts games.</p>}
      </section>

      <section className="panel glass" aria-labelledby="r2-preview">
        <h2 id="r2-preview">Board preview <small className="muted">(draft — what the projector shows before any question is opened)</small></h2>
        <TriviaBoard topics={boardTopics(topics, questions.map((q) => ({ ...q, used: false })))} size="md" />
      </section>

      {!archived && (
        <section className="panel glass" aria-labelledby="r2-nt">
          <h2 id="r2-nt">Topics</h2>
          <form className="row gap wrap align-end" onSubmit={addTopic}>
            <Field label="New topic" error={topicErr}><input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} maxLength={60} placeholder="e.g. Networks" /></Field>
            <button className="btn btn-primary" disabled={!newTopic.trim() || !!topicErr}><Plus size={16} /> Add topic</button>
          </form>
          <p className="muted small">Any number of topics, and any number of questions per topic with any point values. Answers are hidden on the projector until you press Answer during the game.</p>
        </section>
      )}
      {topics.length === 0 ? <EmptyState title="No topics yet" /> : topics.map((t) => {
        const qs = questions.filter((q) => q.topic_id === t.id);
        return (
          <section key={t.id} className="panel glass" aria-label={`Topic ${t.name}`}>
            <div className="panel-head">
              <h2>{t.name} <span className="badge badge-muted">{qs.length} question(s)</span></h2>
              {!archived && (
                <div className="row gap">
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing({ topic_id: t.id, points: '', question_text: '', answer_text: '' })}><Plus size={14} /> Add question</button>
                  <button className="icon-btn" onClick={() => setRenaming(t)} aria-label={`Rename topic ${t.name}`}><Pencil size={16} /></button>
                  <button className="icon-btn danger" onClick={() => removeTopic(t)} aria-label={`Delete topic ${t.name}`}><Trash2 size={16} /></button>
                </div>
              )}
            </div>
            {qs.length === 0 ? <p className="muted small">No questions in this topic yet.</p> : (
              <ul className="r2-qlist">
                {qs.map((q) => (
                  <li key={q.id}>
                    <span className="r2-qpts">{formatScore(q.points)}</span>
                    <span className="r2-qtext">{q.question_text}<small className="muted"> Answer: {q.answer_text}</small></span>
                    {!archived && (
                      <span className="actions">
                        <button className="icon-btn" onClick={() => setEditing(q)} aria-label={`Edit ${formatScore(q.points)}-point question in ${t.name}`}><Pencil size={15} /></button>
                        <button className="icon-btn danger" onClick={() => removeQuestion(q)} aria-label={`Delete ${formatScore(q.points)}-point question in ${t.name}`}><Trash2 size={15} /></button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {editing && <QuestionForm question={editing} topics={topics} onClose={() => setEditing(null)} />}
      {renaming && <RenameTopic topic={renaming} topics={topics} onClose={() => setRenaming(null)} />}
      {settings && <SetForm set={s} onClose={() => setSettings(false)} onSaved={async (fields) => (await act('r2sSaveSet', fields, { key: 'r2-set', success: 'Settings saved' })).ok} />}
    </div>
  );
}

function QuestionForm({ question, topics, onClose }) {
  const { act } = useRound2();
  const [form, setForm] = useState({ ...question, points: String(question.points ?? '') });
  const [touched, setTouched] = useState(false);
  const check = validateR2Question(form, topics);
  const err = (k) => (touched ? check.errors[k] : undefined);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    const res = await act('r2sSaveQuestion', { id: question.id, topic_id: form.topic_id, points: form.points.trim(), question_text: form.question_text, answer_text: form.answer_text },
      { key: 'r2-saveq', success: question.id ? 'Question saved' : 'Question added' });
    if (res.ok) onClose();
  }
  return (
    <Modal title={question.id ? 'Edit question' : 'New question'} onClose={onClose} labelledBy="r2-qf">
      <form className="stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Topic" error={err('topic_id')}>
            <select value={form.topic_id || ''} onChange={set('topic_id')}>{topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </Field>
          <Field label="Points" error={err('points')} hint="Any value, e.g. 10, 20, 25.5"><input inputMode="decimal" value={form.points} onChange={set('points')} /></Field>
        </div>
        <Field label="Question" error={err('question_text')}><textarea rows={3} value={form.question_text} onChange={set('question_text')} maxLength={1000} /></Field>
        <Field label="Correct answer (hidden until you press Answer in the game)" error={err('answer_text')}><input value={form.answer_text} onChange={set('answer_text')} maxLength={500} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"><Save size={16} /> Save question</button>
        </div>
      </form>
    </Modal>
  );
}

function RenameTopic({ topic, topics, onClose }) {
  const { act } = useRound2();
  const [name, setName] = useState(topic.name);
  const { error } = validateTopicName(name, topics, topic.id);
  async function submit(e) {
    e.preventDefault();
    if (error) return;
    const res = await act('r2sSaveTopic', { id: topic.id, name }, { key: 'r2-topic', success: 'Topic renamed' });
    if (res.ok) onClose();
  }
  return (
    <Modal title="Rename topic" onClose={onClose} labelledBy="r2-rt">
      <form className="stack" onSubmit={submit}>
        <Field label="Topic name" error={error}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!!error}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
