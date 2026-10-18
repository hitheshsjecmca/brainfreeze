import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ClipboardList, Copy, Download, Eye, EyeOff, FileUp, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, Field, Modal, PageHeader } from '../components/Common.jsx';
import { OptionGrid } from '../components/QuizBits.jsx';
import { OPTIONS, OPTION_FIELDS } from '../lib/constants.js';
import { questionsToCSV, QUESTION_CSV_HEADERS } from '../lib/csv.js';
import { downloadText, readFileDataURL, readFileText, stamp } from '../lib/download.js';
import { useDraft } from '../lib/hooks.js';
import { validateQuestion } from '../lib/validation.js';
import { parseQuestionFile } from '../lib/setWizard.js';
import { SAMPLE_QUESTIONS } from '../data/sampleQuestions.js';

const EMPTY = { question_text: '', option_a: '', option_b: '', option_c: '', option_d: '', correct_option: '', explanation: '', image_url: '', category: '', marks_correct: '', marks_incorrect: '', is_sample: false };
const exportable = (q) => Object.fromEntries([...QUESTION_CSV_HEADERS, 'is_sample'].map((h) => [h, q[h] ?? null]));

export default function Questions() {
  const { snap, act, isDemo } = useQuiz();
  const { confirm, toast } = useUI();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [onlySamples, setOnlySamples] = useState(false);
  const [showKeys, setShowKeys] = useState(true);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(null);
  const fileRef = useRef(null);
  const { questions, answers, session } = snap;
  const live = session.status === 'running' || session.status === 'paused';

  const categories = useMemo(() => [...new Set(questions.map((q) => q.category).filter(Boolean))].sort(), [questions]);
  const answerCount = useMemo(() => {
    const m = new Map();
    for (const a of answers) m.set(a.question_id, (m.get(a.question_id) || 0) + 1);
    return m;
  }, [answers]);
  const invalidCount = useMemo(() => questions.filter((q) => !validateQuestion(q).ok).length, [questions]);

  const filtered = questions.filter((q) => {
    if (category && q.category !== category) return false;
    if (onlySamples && !q.is_sample) return false;
    const s = query.trim().toLowerCase();
    return !s || [q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.category].some((v) => (v || '').toLowerCase().includes(s));
  });

  async function move(q, dir) {
    const ids = questions.map((x) => x.id);
    const i = ids.indexOf(q.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await act('reorderQuestions', { ids }, { key: 'reorder' });
  }

  async function duplicate(q) {
    const { id: _id, position, created_at: _c, updated_at: _u, ...rest } = q;
    // While live, append at the end so the numbering of the running quiz never shifts.
    const pos = live ? questions.length + 1 : position + 1;
    await act('saveQuestion', { ...rest, question_text: `${q.question_text} (copy)`, position: pos }, { success: `Duplicated as Q${pos}` });
  }

  async function remove(q) {
    const n = answerCount.get(q.id) || 0;
    const ok = await confirm({
      title: `Delete Q${q.position}?`, danger: true, confirmLabel: 'Delete question',
      message: n > 0
        ? <p>This question has <strong>{n} recorded answer(s)</strong>. Deleting it removes those answers and changes team scores. This is recorded in the audit log.</p>
        : <p>“{q.question_text}” will be permanently deleted.</p>,
      typeToConfirm: n > 0 ? `DELETE Q${q.position}` : undefined,
    });
    if (!ok) return;
    await act('deleteQuestion', { id: q.id, confirm: n > 0 }, { success: `Q${q.position} deleted` });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = parseQuestionFile(await readFileText(file), file.name);
      setImporting({ fileName: file.name, items });
    } catch (err) {
      toast('error', 'Could not import file', err.message);
    }
  }

  async function loadSamples() {
    const ok = await confirm({
      title: `Add ${SAMPLE_QUESTIONS.length} sample questions?`, confirmLabel: 'Add samples',
      message: <p>Sample IT questions will be appended and marked <strong>SAMPLE</strong>. Review or replace them before the event.</p>,
    });
    if (!ok) return;
    await act('importQuestions', { items: SAMPLE_QUESTIONS.map(({ sample_ref: _r, ...q }) => q) }, { success: 'Sample questions added' });
  }

  return (
    <div className="page">
      <PageHeader title="Question bank" subtitle={`${questions.length} questions · ${questions.filter((q) => q.is_sample).length} sample · ${invalidCount} need attention`}>
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}><FileUp size={16} /> Import CSV/JSON</button>
        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={onFile} />
        <button className="btn btn-ghost" disabled={!questions.length} onClick={() => downloadText(`brainfreze-questions-${stamp()}.csv`, questionsToCSV(questions), 'text/csv')}><Download size={16} /> CSV</button>
        <button className="btn btn-ghost" disabled={!questions.length} onClick={() => downloadText(`brainfreze-questions-${stamp()}.json`, JSON.stringify({ questions: questions.map(exportable) }, null, 2), 'application/json')}><Download size={16} /> JSON</button>
        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> New question</button>
      </PageHeader>

      {live && <div className="inline-alert alert-info">The quiz is live: reordering and deleting are locked. Editing an answer key re-scores recorded answers (audited).</div>}
      {invalidCount > 0 && <div className="inline-alert alert-warn"><AlertTriangle size={18} /> {invalidCount} question(s) fail validation — the quiz cannot start until they are fixed.</div>}

      <div className="toolbar">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder="Search questions and options…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search questions" />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={onlySamples} onChange={(e) => setOnlySamples(e.target.checked)} /> Samples only</label>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowKeys((v) => !v)} aria-pressed={!showKeys}>
          {showKeys ? <EyeOff size={16} /> : <Eye size={16} />} {showKeys ? 'Hide' : 'Show'} answer keys
        </button>
        <button className="btn btn-ghost btn-sm" onClick={loadSamples}><Sparkles size={16} /> Add sample set</button>
      </div>

      {questions.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No questions yet"><p className="muted">Create questions, import a CSV/JSON file, or add the sample set.</p></EmptyState>
      ) : (
        <ol className="question-list">
          {filtered.map((q) => {
            const v = validateQuestion(q);
            return (
              <li key={q.id} className={`question-row glass ${v.ok ? '' : 'invalid'}`}>
                <div className="q-pos">Q{q.position}</div>
                <div className="q-body">
                  <div className="q-meta">
                    {q.category && <span className="badge badge-muted badge-xs">{q.category}</span>}
                    {q.is_sample && <span className="badge badge-amber badge-xs">SAMPLE · review</span>}
                    {q.image_url && <span className="badge badge-muted badge-xs">image</span>}
                    {(q.marks_correct != null || q.marks_incorrect != null) && <span className="badge badge-purple badge-xs">custom marks</span>}
                    {answerCount.get(q.id) ? <span className="badge badge-muted badge-xs">{answerCount.get(q.id)} answers</span> : null}
                    {!v.ok && <span className="badge badge-danger badge-xs">{Object.values(v.errors)[0]}</span>}
                  </div>
                  <p className="q-text">{q.question_text}</p>
                  <ul className="q-options">
                    {OPTIONS.map((l) => (
                      <li key={l} className={showKeys && q.correct_option === l ? 'is-key' : ''}>
                        <b>{l}</b> {q[OPTION_FIELDS[l]]}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="q-actions">
                  <button className="icon-btn" onClick={() => move(q, -1)} disabled={live || q.position === 1} aria-label={`Move Q${q.position} up`}><ArrowUp size={16} /></button>
                  <button className="icon-btn" onClick={() => move(q, 1)} disabled={live || q.position === questions.length} aria-label={`Move Q${q.position} down`}><ArrowDown size={16} /></button>
                  <button className="icon-btn" onClick={() => setEditing(q)} aria-label={`Edit Q${q.position}`}><Pencil size={16} /></button>
                  <button className="icon-btn" onClick={() => duplicate(q)} aria-label={`Duplicate Q${q.position}`}><Copy size={16} /></button>
                  <button className="icon-btn danger" onClick={() => remove(q)} disabled={live} aria-label={`Delete Q${q.position}`}><Trash2 size={16} /></button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {editing && <QuestionEditor question={editing} isDemo={isDemo} hasAnswers={!!answerCount.get(editing.id)} onClose={() => setEditing(null)} />}
      {importing && <ImportQuestions data={importing} hasQuestions={questions.length > 0} hasAnswers={answers.length > 0} live={live} onClose={() => setImporting(null)} />}
    </div>
  );
}

/** Add/edit a bank question (also used by the set wizard; `onSaved(id)` gets the saved question's id). */
export function QuestionEditor({ question, isDemo, hasAnswers, onClose, onSaved }) {
  const { act } = useQuiz();
  const { confirm, toast } = useUI();
  const draftKey = `brainfreze-cold-start:question-draft:${question.id || 'new'}`;
  const initial = { ...EMPTY, ...question, marks_correct: question.marks_correct ?? '', marks_incorrect: question.marks_incorrect ?? '', explanation: question.explanation ?? '', image_url: question.image_url ?? '', category: question.category ?? '' };
  const [restoredDraft, setRestoredDraft] = useState(() => { try { return !!localStorage.getItem(draftKey); } catch { return false; } });
  const [form, setForm, clearDraft] = useDraft(draftKey, initial);
  const [touched, setTouched] = useState(false);
  const check = validateQuestion(form);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const err = (k) => (touched ? check.errors[k] : undefined);

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    if (question.id && hasAnswers && question.correct_option !== check.value.correct_option) {
      const ok = await confirm({
        title: 'Change the answer key?', danger: true, confirmLabel: 'Change key & re-score',
        message: <p>This question already has recorded answers. Changing the key from <strong>{question.correct_option}</strong> to <strong>{check.value.correct_option}</strong> re-scores them. Every change is written to the audit log.</p>,
      });
      if (!ok) return;
    }
    const res = await act('saveQuestion', { ...check.value, id: question.id }, {
      key: 'saveQuestion', success: question.id ? `Q${question.position} saved` : 'Question added',
      successDetail: (r) => (r?.rescored ? `${r.rescored} recorded answer(s) re-scored` : undefined),
    });
    if (res.ok) { clearDraft(); onSaved?.(res.result?.id); onClose(); }
  }

  async function onImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 500 * 1024) { toast('error', 'Image too large', 'Use an image under 500 KB, or host it and paste an https:// URL.'); return; }
    setForm((f) => ({ ...f, image_url: '' }));
    const url = await readFileDataURL(file);
    setForm((f) => ({ ...f, image_url: url }));
  }

  return (
    <Modal title={question.id ? `Edit Q${question.position}` : 'New question'} onClose={onClose} wide>
      {restoredDraft && <div className="inline-alert alert-info small">Unsaved draft restored (autosaved locally). <button className="btn btn-ghost btn-sm" onClick={() => { clearDraft(); setForm(initial); setRestoredDraft(false); }}>Discard draft</button></div>}
      <form onSubmit={submit} className="editor" noValidate>
        <div className="editor-fields">
          <Field label="Question text" error={err('question_text')}>
            <textarea rows={3} value={form.question_text} onChange={set('question_text')} maxLength={1000} />
          </Field>
          {OPTIONS.map((l) => (
            <div key={l} className={`option-edit opt-${l.toLowerCase()}`}>
              <label className="radio-key" title={`Mark ${l} as correct`}>
                <input type="radio" name="correct" value={l} checked={form.correct_option === l} onChange={set('correct_option')} aria-label={`Option ${l} is correct`} />
                <span>{l}</span>
              </label>
              <Field label={`Option ${l}`} error={err(OPTION_FIELDS[l])}>
                <input value={form[OPTION_FIELDS[l]]} onChange={set(OPTION_FIELDS[l])} maxLength={300} />
              </Field>
            </div>
          ))}
          {err('correct_option') && <p className="error-text" role="alert">{err('correct_option')}</p>}
          <div className="form-grid">
            <Field label="Category"><input value={form.category} onChange={set('category')} maxLength={80} list="cat-list" /></Field>
            <Field label="Image (optional)" error={err('image_url')} hint={isDemo ? 'https:// URL or upload (demo stores it in the browser)' : 'Public https:// URL — never put answer hints in file names'}>
              <div className="row gap">
                <input value={form.image_url.startsWith('data:') ? '(uploaded image)' : form.image_url} onChange={set('image_url')} placeholder="https://…" readOnly={form.image_url.startsWith('data:')} />
                {isDemo && <label className="btn btn-ghost btn-sm">Upload<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={onImage} /></label>}
                {form.image_url && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, image_url: '' }))}>Remove</button>}
              </div>
            </Field>
            <Field label="Marks if correct (blank = default)" error={err('marks_correct')}>
              <input type="number" step="0.25" value={form.marks_correct} onChange={set('marks_correct')} />
            </Field>
            <Field label="Marks if incorrect (blank = default)" error={err('marks_incorrect')}>
              <input type="number" step="0.25" value={form.marks_incorrect} onChange={set('marks_incorrect')} />
            </Field>
          </div>
          <Field label="Explanation (host only, optional)" error={err('explanation')}>
            <textarea rows={2} value={form.explanation} onChange={set('explanation')} maxLength={2000} />
          </Field>
          <label className="check"><input type="checkbox" checked={!!form.is_sample} onChange={(e) => setForm((f) => ({ ...f, is_sample: e.target.checked }))} /> Mark as SAMPLE (needs review)</label>
        </div>
        <aside className="editor-preview" aria-label="Projector preview">
          <h3 className="muted small">Projector preview (key never shown on projector)</h3>
          <div className="preview-frame">
            <p className="preview-q">{form.question_text || 'Question text…'}</p>
            {form.image_url && <img src={form.image_url} alt="" className="preview-img" />}
            <OptionGrid question={{ option_a: form.option_a || '…', option_b: form.option_b || '…', option_c: form.option_c || '…', option_d: form.option_d || '…' }} size="sm" />
          </div>
        </aside>
        <div className="modal-actions span-all">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close (draft kept)</button>
          <button className="btn btn-primary">Save question</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportQuestions({ data, hasQuestions, hasAnswers, live, onClose }) {
  const { act } = useQuiz();
  const { confirm } = useUI();
  const [replace, setReplace] = useState(false);
  const checked = data.items.map((it, i) => ({ it, i, c: validateQuestion(it) }));
  const bad = checked.filter((x) => !x.c.ok);

  async function run() {
    if (replace && hasQuestions) {
      const ok = await confirm({
        title: 'Replace the whole question bank?', danger: true, confirmLabel: 'Replace questions',
        message: <p>All current questions{hasAnswers ? ' and every recorded answer to them' : ''} will be deleted.</p>,
        typeToConfirm: hasAnswers ? 'REPLACE' : undefined,
      });
      if (!ok) return;
    }
    const items = data.items.map(({ id: _id, position: _p, ...rest }) => rest);
    const res = await act('importQuestions', { items, replace, confirm: replace }, { success: `${items.length} question(s) imported` });
    if (res.ok) onClose();
  }

  return (
    <Modal title={`Import questions — ${data.fileName}`} onClose={onClose} wide>
      <p className="muted">{data.items.length} question(s) found. Import is all-or-nothing.</p>
      <label className="check"><input type="checkbox" checked={replace} disabled={live} onChange={(e) => setReplace(e.target.checked)} /> Replace all existing questions {live && '(locked while live)'}</label>
      {bad.length > 0 && (
        <div className="inline-alert alert-danger" role="alert">
          <div><strong>{bad.length} invalid question(s):</strong>
            <ul>{bad.slice(0, 8).map(({ it, i, c }) => <li key={i}>{it.__line ? `Line ${it.__line}` : `#${i + 1}`}: {Object.values(c.errors).join(' ')}</li>)}</ul>
          </div>
        </div>
      )}
      <ol className="import-preview">
        {checked.slice(0, 40).map(({ it, i, c }) => (
          <li key={i} className={c.ok ? '' : 'row-error'}>{it.question_text || '(no text)'} — <b>{String(it.correct_option || '?').toUpperCase()}</b></li>
        ))}
      </ol>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={bad.length > 0} onClick={run}>Import {data.items.length}</button>
      </div>
    </Modal>
  );
}
