import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Archive, ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, Copy, Eye, EyeOff, Pencil, Plus, Rocket, Save, Trash2 } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useR3Data, useRound3 } from '../context/Round3Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, ErrorState, Field, Loading, Modal } from '../components/Common.jsx';
import { BidTimerField } from '../components/Round3Bits.jsx';
import { formatJoinCode } from '../lib/joinCodes.js';
import { formatStamp } from '../lib/sets.js';
import {
  R3_DEFAULTS, R3_MODES, R3_MODE_LABELS, R3_SECTIONS, R3_SECTION_LABELS, questionLabel, bidTimerValid, r3PublishIssues, timerLabel, validateR3Question, validateR3SetFields, validateR3Topic, versionOrder,
} from '../lib/round3.js';

function useCopy() {
  const { toast } = useUI();
  return async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast('success', `${what} copied`); } catch { toast('warn', 'Copy failed', 'Select and copy it manually.'); }
  };
}

const statusOf = (s) => (s.archived_at ? ['Archived', 'badge-muted'] : s.published_version ? [`Published v${s.published_version}`, 'badge-ok'] : ['Draft', 'badge-amber']);

/** Every auction set (draft, published, archived) and "New auction set". */
export function AuctionSets() {
  const { act } = useRound3();
  const navigate = useNavigate();
  const copy = useCopy();
  const { data, error, reload } = useR3Data(() => backend.round3.overview(), 'overview');
  const [creating, setCreating] = useState(false);
  if (error && !data) return <ErrorState title="Auction sets could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading auction sets…" />;

  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r3-sets-title">
        <div className="panel-head">
          <h2 id="r3-sets-title">Auction sets</h2>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New auction set</button>
        </div>
        <p className="muted small">Each set is a draft until you publish it. Publishing freezes an unchangeable version and gives the set a six-digit code that you enter on <Link to="/host/rounds/3/join">Join Round 3</Link> to start a live auction.</p>
        {data.sets.length === 0 ? <EmptyState title="No auction sets yet"><p className="muted">Create one, add topics and Normal or Blind questions, then publish it.</p></EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Auction set</th><th scope="col">Section</th><th scope="col">Content</th><th scope="col">Status</th><th scope="col">Code</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.sets.map((s) => {
                  const [label, cls] = statusOf(s);
                  return (
                    <tr key={s.id} className={s.archived_at ? 'row-dim' : ''}>
                      <td><b>{s.title}</b>{s.unpublished_changes && !s.archived_at && <> <span className="badge badge-amber badge-xs">unpublished changes</span></>}{s.live_sessions > 0 && <> <span className="badge badge-ice badge-xs">live</span></>}</td>
                      <td>{R3_SECTION_LABELS[s.section]}</td>
                      <td className="small">{s.topic_count} topic(s) · {s.question_count} question(s)</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td>{s.join_code && !s.archived_at ? <span className="row gap"><code className="r2-code">{formatJoinCode(s.join_code)}</code><button className="icon-btn" onClick={() => copy(s.join_code, 'Code')} aria-label={`Copy the code of ${s.title}`}><Copy size={14} /></button></span> : <span className="muted">—</span>}</td>
                      <td className="actions"><Link className="btn btn-ghost btn-sm" to={`/host/rounds/3/sets/${s.id}`}>{s.archived_at ? <><Eye size={14} /> View</> : <><Pencil size={14} /> Open</>}</Link></td>
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
          const res = await act('r3sSaveSet', fields, { key: 'r3-set', success: 'Auction set created' });
          if (res.ok) navigate(`/host/rounds/3/sets/${res.result.id}`);
          return res.ok;
        }} />
      )}
    </div>
  );
}

function SetForm({ set = null, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: set?.title ?? '', description: set?.description ?? '', section: set?.section ?? 'BOTH',
    answer_seconds: String(set?.answer_seconds ?? R3_DEFAULTS.answer_seconds),
  });
  const [bidTimer, setBidTimer] = useState(set ? set.bid_seconds ?? null : R3_DEFAULTS.bid_seconds);
  const [touched, setTouched] = useState(false);
  const check = validateR3SetFields({ ...form, bid_seconds: bidTimer === null ? null : String(bidTimer) });
  const err = (k) => (touched ? check.errors[k] : undefined);
  const set_ = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok || !bidTimerValid(bidTimer)) return;
    if (await onSaved({ id: set?.id, ...form, bid_seconds: bidTimer })) onClose();
  }
  return (
    <Modal title={set ? 'Auction set settings' : 'New auction set'} onClose={onClose} labelledBy="r3-setf">
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Auction set title" error={err('title')}><input value={form.title} onChange={set_('title')} maxLength={80} autoFocus placeholder="e.g. UG Grand Finale" /></Field>
        <Field label="Description (optional)" error={err('description')}><textarea rows={2} value={form.description} onChange={set_('description')} maxLength={500} /></Field>
        <Field label="Section" error={err('section')} hint="Which sections may play this set.">
          <select value={form.section} onChange={set_('section')}>{R3_SECTIONS.map((s) => <option key={s} value={s}>{R3_SECTION_LABELS[s]}</option>)}</select>
        </Field>
        <BidTimerField idPrefix="r3-set-timer" value={bidTimer} onChange={setBidTimer} legend="Default bidding timer" />
        <p className="muted small">Timed bidding closes automatically when the countdown ends; with no timer you close bidding yourself. You can change this when you start the auction and for each question.</p>
        <Field label="Answer timer (seconds)" error={err('answer_seconds')} hint={`5–600. Default ${R3_DEFAULTS.answer_seconds}.`}><input type="number" min={5} max={600} value={form.answer_seconds} onChange={set_('answer_seconds')} /></Field>
        <p className="muted small">Every team starts with a public budget of 100 and a private score of 0. Bids: minimum 10, steps of 10, never above the budget.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"><Save size={16} /> {set ? 'Save settings' : 'Create set'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** One auction set: draft topics and questions (reorderable), a preview, Publish and its code. */
export function AuctionSetEditor() {
  const { setId } = useParams();
  const { act, pendingKeys } = useRound3();
  const { confirm } = useUI();
  const navigate = useNavigate();
  const copy = useCopy();
  const { data, error, reload } = useR3Data(() => backend.round3.setDetail(setId), setId);
  const [newTopic, setNewTopic] = useState('');
  const [editing, setEditing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [settings, setSettings] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  if (error && !data) return <ErrorState title="Auction set could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading auction set…" />;

  const { set: s, topics, questions } = data;
  const archived = !!s.archived_at;
  const issues = r3PublishIssues(topics, questions);
  const topicErr = newTopic.trim() ? validateR3Topic(newTopic, topics).error : null;
  const [label, cls] = statusOf(s);
  const ordered = versionOrder(topics, questions);
  const move = (kind, id, dir) => act('r3sMove', { kind, id, dir }, { key: `r3-move-${id}` });

  async function addTopic(e) {
    e.preventDefault();
    const res = await act('r3sSaveTopic', { set_id: s.id, name: newTopic }, { key: 'r3-topic', success: 'Topic added' });
    if (res.ok) setNewTopic('');
  }
  async function removeTopic(t) {
    const n = questions.filter((q) => q.topic_id === t.id).length;
    const ok = await confirm({ title: `Delete topic “${t.name}”?`, danger: true, confirmLabel: 'Delete topic', message: <p>Its {n} question(s) are deleted from this draft. Published versions keep their own copy.</p> });
    if (ok) act('r3sDeleteTopic', { id: t.id }, { key: `r3-del-${t.id}`, success: 'Topic deleted' });
  }
  async function removeQuestion(q) {
    const ok = await confirm({ title: 'Delete this question?', danger: true, confirmLabel: 'Delete question', message: <p>“{q.question_text}”</p> });
    if (ok) act('r3sDeleteQuestion', { id: q.id }, { key: `r3-delq-${q.id}`, success: 'Question deleted' });
  }
  async function publish() {
    const ok = await confirm({
      title: s.published_version ? `Publish version ${s.published_version + 1} of “${s.title}”?` : `Publish “${s.title}”?`,
      confirmLabel: 'Publish Auction Set',
      message: (
        <>
          <p>{topics.length} topic(s) and {questions.length} question(s) are frozen as version {s.published_version + 1}. A published version can never be edited.</p>
          <p>{s.join_code ? <>The set keeps its code <b>{formatJoinCode(s.join_code)}</b>; new auctions use this version. Auctions already started keep their version.</> : 'A unique six-digit code is generated for this set.'}</p>
        </>
      ),
    });
    if (!ok) return;
    await act('r3sPublishSet', { id: s.id }, { key: 'r3-publish', success: 'Auction set published', successDetail: (r) => `Version ${r.version} · code ${formatJoinCode(r.join_code)}` });
  }
  async function archive() {
    const ok = await confirm({ title: `Archive “${s.title}”?`, danger: true, confirmLabel: 'Archive', message: <p>Its code stops working for new auctions. Finished auctions and their results are kept.</p> });
    if (ok) act('r3sArchiveSet', { id: s.id }, { key: 'r3-archive', success: 'Auction set archived' });
  }
  async function remove() {
    const ok = await confirm({ title: `Delete draft “${s.title}”?`, danger: true, confirmLabel: 'Delete draft', message: <p>The draft and all its topics and questions are deleted. This cannot be undone.</p> });
    if (!ok) return;
    const res = await act('r3sDeleteSet', { id: s.id }, { key: 'r3-delset', success: 'Draft deleted' });
    if (res.ok) navigate('/host/rounds/3/sets');
  }

  return (
    <div className="stack">
      <Link to="/host/rounds/3/sets" className="back-link"><ArrowLeft size={16} /> All auction sets</Link>
      <section className="panel glass" aria-labelledby="r3-set-title">
        <div className="panel-head">
          <div>
            <h2 id="r3-set-title">{s.title} <span className={`badge ${cls}`}>{label}</span></h2>
            {s.description && <p className="small">{s.description}</p>}
            <p className="muted small">{R3_SECTION_LABELS[s.section]} · bidding timer: {timerLabel(s.bid_seconds)} · {s.answer_seconds}-second answer timer{s.published_at && <> · last published {formatStamp(s.published_at)}</>}</p>
          </div>
          {!archived && (
            <div className="row gap wrap">
              <button className="btn btn-ghost btn-sm" onClick={() => setSettings(true)}><Pencil size={14} /> Settings</button>
              {s.published_version > 0
                ? <button className="btn btn-ghost btn-sm" onClick={archive} disabled={data.live_sessions > 0} title={data.live_sessions ? 'End its live auction first' : undefined}><Archive size={14} /> Archive</button>
                : <button className="btn btn-ghost btn-sm" onClick={remove}><Trash2 size={14} /> Delete draft</button>}
            </div>
          )}
        </div>
        {s.join_code && !archived && (
          <div className="r2-code-box">
            <span className="muted small">Six-digit code (enter it on Join Round 3)</span>
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
            <button className="btn btn-primary" onClick={publish} disabled={issues.length > 0 || pendingKeys.has('r3-publish')}><Rocket size={16} /> Publish Auction Set</button>
          </div>
        )}
        {archived && <p className="muted">This set is archived. Its code no longer starts auctions.</p>}
      </section>

      <section className="panel glass" aria-labelledby="r3-preview">
        <div className="panel-head">
          <h2 id="r3-preview">Preview <small className="muted">(the order in a live auction)</small></h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAnswers((v) => !v)} aria-pressed={showAnswers}>{showAnswers ? <EyeOff size={14} /> : <Eye size={14} />} {showAnswers ? 'Hide answers' : 'Show answers'}</button>
        </div>
        {ordered.length === 0 ? <p className="muted">No questions yet.</p> : (
          <ol className="r3-preview">
            {ordered.map((q) => (
              <li key={q.id}>
                <span className={`badge ${q.mode === 'BLIND' ? 'badge-purple' : 'badge-ice'} badge-xs`}>{q.mode}</span>
                <b>Projector before bidding: {questionLabel(q)}</b>
                <span className="small">{q.mode === 'BLIND' && <>Topic {q.topic_name} · </>}{q.question_text}</span>
                {showAnswers && <small className="muted">Answer: {q.answer_text}{q.explanation ? ` — ${q.explanation}` : ''}</small>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {!archived && (
        <section className="panel glass" aria-labelledby="r3-nt">
          <h2 id="r3-nt">Topics</h2>
          <form className="row gap wrap align-end" onSubmit={addTopic}>
            <Field label="New topic" error={topicErr}><input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} maxLength={60} placeholder="e.g. Cyber Security" /></Field>
            <button className="btn btn-primary" disabled={!newTopic.trim() || !!topicErr}><Plus size={16} /> Add topic</button>
          </form>
          <p className="muted small">Any number of topics and questions. <b>Normal</b>: the projector shows the topic before bidding. <b>Blind</b>: it shows “MYSTERY QUESTION #n” until you reveal the topic after bidding closes.</p>
        </section>
      )}
      {topics.length === 0 ? <EmptyState title="No topics yet" /> : topics.map((t, ti) => {
        const qs = questions.filter((q) => q.topic_id === t.id);
        return (
          <section key={t.id} className="panel glass" aria-label={`Topic ${t.name}`}>
            <div className="panel-head">
              <h2>{t.name} <span className="badge badge-muted">{qs.length} question(s)</span></h2>
              {!archived && (
                <div className="row gap">
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing({ topic_id: t.id, mode: 'NORMAL', question_text: '', answer_text: '', explanation: '' })}><Plus size={14} /> Add question</button>
                  <button className="icon-btn" onClick={() => move('topic', t.id, -1)} disabled={ti === 0} aria-label={`Move topic ${t.name} up`}><ArrowUp size={16} /></button>
                  <button className="icon-btn" onClick={() => move('topic', t.id, 1)} disabled={ti === topics.length - 1} aria-label={`Move topic ${t.name} down`}><ArrowDown size={16} /></button>
                  <button className="icon-btn" onClick={() => setRenaming(t)} aria-label={`Rename topic ${t.name}`}><Pencil size={16} /></button>
                  <button className="icon-btn danger" onClick={() => removeTopic(t)} aria-label={`Delete topic ${t.name}`}><Trash2 size={16} /></button>
                </div>
              )}
            </div>
            {qs.length === 0 ? <p className="muted small">No questions in this topic yet.</p> : (
              <ul className="r2-qlist">
                {qs.map((q, qi) => (
                  <li key={q.id}>
                    <span className={`badge ${q.mode === 'BLIND' ? 'badge-purple' : 'badge-ice'} badge-xs`}>{q.mode}</span>
                    <span className="r2-qtext">{q.question_text}<small className="muted"> Answer: {q.answer_text}</small></span>
                    {!archived && (
                      <span className="actions">
                        <button className="icon-btn" onClick={() => move('question', q.id, -1)} disabled={qi === 0} aria-label={`Move question ${qi + 1} of ${t.name} up`}><ArrowUp size={15} /></button>
                        <button className="icon-btn" onClick={() => move('question', q.id, 1)} disabled={qi === qs.length - 1} aria-label={`Move question ${qi + 1} of ${t.name} down`}><ArrowDown size={15} /></button>
                        <button className="icon-btn" onClick={() => setEditing(q)} aria-label={`Edit question ${qi + 1} of ${t.name}`}><Pencil size={15} /></button>
                        <button className="icon-btn danger" onClick={() => removeQuestion(q)} aria-label={`Delete question ${qi + 1} of ${t.name}`}><Trash2 size={15} /></button>
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
      {settings && <SetForm set={s} onClose={() => setSettings(false)} onSaved={async (fields) => (await act('r3sSaveSet', fields, { key: 'r3-set', success: 'Settings saved' })).ok} />}
    </div>
  );
}

function QuestionForm({ question, topics, onClose }) {
  const { act } = useRound3();
  const [form, setForm] = useState({ ...question, explanation: question.explanation ?? '' });
  const [touched, setTouched] = useState(false);
  const check = validateR3Question(form, topics);
  const err = (k) => (touched ? check.errors[k] : undefined);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    const res = await act('r3sSaveQuestion', { id: question.id, topic_id: form.topic_id, mode: form.mode, question_text: form.question_text, answer_text: form.answer_text, explanation: form.explanation },
      { key: 'r3-saveq', success: question.id ? 'Question saved' : 'Question added' });
    if (res.ok) onClose();
  }
  return (
    <Modal title={question.id ? 'Edit question' : 'New question'} onClose={onClose} labelledBy="r3-qf">
      <form className="stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Topic" error={err('topic_id')}>
            <select value={form.topic_id || ''} onChange={set('topic_id')}>{topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </Field>
          <Field label="Topic mode" error={err('mode')} hint={form.mode === 'BLIND' ? 'Topic hidden until you reveal it after bidding.' : 'Topic shown before bidding.'}>
            <select value={form.mode} onChange={set('mode')}>{R3_MODES.map((m) => <option key={m} value={m}>{R3_MODE_LABELS[m]}</option>)}</select>
          </Field>
        </div>
        <Field label="Question" error={err('question_text')}><textarea rows={3} value={form.question_text} onChange={set('question_text')} maxLength={1000} /></Field>
        <Field label="Correct answer (hidden until you reveal it)" error={err('answer_text')}><input value={form.answer_text} onChange={set('answer_text')} maxLength={500} /></Field>
        <Field label="Explanation (optional)" error={err('explanation')}><textarea rows={2} value={form.explanation} onChange={set('explanation')} maxLength={1000} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"><Save size={16} /> Save question</button>
        </div>
      </form>
    </Modal>
  );
}

function RenameTopic({ topic, topics, onClose }) {
  const { act } = useRound3();
  const [name, setName] = useState(topic.name);
  const { error } = validateR3Topic(name, topics, topic.id);
  async function submit(e) {
    e.preventDefault();
    if (error) return;
    const res = await act('r3sSaveTopic', { id: topic.id, name }, { key: 'r3-topic', success: 'Topic renamed' });
    if (res.ok) onClose();
  }
  return (
    <Modal title="Rename topic" onClose={onClose} labelledBy="r3-rt">
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
