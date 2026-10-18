import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, Download, Eye, EyeOff, FileUp, Library, ListChecks,
  MonitorPlay, Pencil, Plus, RotateCcw, Rocket, Save, Search, Settings2, ArrowUp, Trash2, X,
} from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { Field, Modal } from './Common.jsx';
import { OptionGrid } from './QuizBits.jsx';
import { QuestionEditor } from '../pages/Questions.jsx';
import { OPTIONS, OPTION_FIELDS, SECTIONS, SECTION_LABELS } from '../lib/constants.js';
import { questionTemplateCSV } from '../lib/csv.js';
import { downloadText, readFileText } from '../lib/download.js';
import { formatJoinCode, joinUrl } from '../lib/joinCodes.js';
import { formatPoints } from '../lib/scoring.js';
import { minutes, rankingPolicy } from '../lib/sets.js';
import { validateQuestion } from '../lib/validation.js';
import {
  DEFAULT_RULES, WIZARD_STEPS, addToSelection, checkQuestionImport, clearLocalDraft, detailsErrors, draftChanges, formFromSet, goBack, goNext,
  importedQuestionIds, isDirty, maxReachableStep, newSetForm, parseQuestionFile, questionCountIssue, readLocalDraft, resumeStep, reviewIssues,
  reviewWarnings, rulesErrors, rulesToSettings, writeLocalDraft,
} from '../lib/setWizard.js';

const storage = () => { try { return window.localStorage; } catch { return null; } };
const STEP_ICONS = [Settings2, ListChecks, Settings2, Rocket];

/** Four-step progress indicator. Steps after `reachable` stay disabled until the earlier steps are valid. */
function WizardSteps({ step, reachable, onGo, done = false }) {
  return (
    <nav aria-label="Set setup progress">
      <ol className="wizard-steps">
        {WIZARD_STEPS.map((x, i) => {
          const state = done || i < step ? 'done' : i === step ? 'current' : 'todo';
          return (
            <li key={x.key} className={`wz-${state}`}>
              <button type="button" onClick={() => onGo?.(i)} disabled={done || !onGo || i === step || i > reachable} aria-current={i === step && !done ? 'step' : undefined}>
                <span className="wz-num" aria-hidden="true">{state === 'done' ? <Check size={14} /> : i + 1}</span>
                <span className="wz-label"><small>Step {i + 1}</small>{x.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function IssueList({ issues, title }) {
  if (!issues.length) return null;
  return (
    <div className="inline-alert alert-danger wizard-issues" role="alert">
      <AlertTriangle size={18} />
      <div>
        <strong>{title}</strong>
        <ul>{issues.slice(0, 8).map((i) => <li key={i}>{i}</li>)}</ul>
        {issues.length > 8 && <small>…and {issues.length - 8} more.</small>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- step 1

function DetailsStep({ form, setForm, showErrors, sectionLocked }) {
  const errors = showErrors ? detailsErrors(form) : {};
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <div className="stack">
      <Field label="Quiz title" error={errors.name} hint="Shown to teams and on the projector, e.g. “UG Morning Set A”.">
        <input value={form.name} onChange={set('name')} maxLength={80} autoComplete="off" />
      </Field>
      <fieldset className="wz-fieldset">
        <legend>Section</legend>
        <div className="segmented" role="radiogroup" aria-label="Section">
          {SECTIONS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={form.section === s} className={form.section === s ? 'active' : ''}
              disabled={sectionLocked} onClick={() => setForm((f) => ({ ...f, section: s }))}>{SECTION_LABELS[s]}</button>
          ))}
        </div>
        <small className="hint">Only {form.section} teams can join this set.</small>
        {errors.section && <small className="error-text" role="alert">{errors.section}</small>}
      </fieldset>
      <details className="wz-more">
        <summary>More options (optional)</summary>
        <div className="stack">
          <Field label="Instructions shown to teams before they start" error={errors.description}>
            <textarea rows={2} value={form.description} onChange={set('description')} maxLength={500} />
          </Field>
          <label className="check"><input type="checkbox" checked={!!form.self_registration} onChange={set('self_registration')} /> Allow walk-in teams to self-register with the join code</label>
        </div>
      </details>
    </div>
  );
}

// --------------------------------------------------------------------------- step 2

function CountMeter({ n }) {
  const issue = questionCountIssue(n);
  return (
    <div className={`count-meter ${issue ? 'count-bad' : 'count-ok'}`}>
      <div className="count-line">
        <strong>{n}</strong><span> question{n === 1 ? '' : 's'} in this set</span>
        <span className={`badge ${issue ? 'badge-amber' : 'badge-ok'}`}>{issue ? 'Empty' : 'Ready'}</span>
      </div>
      {issue && <p className="warn-text small" role="status">{issue}</p>}
    </div>
  );
}

function QuestionsStep({ form, setForm }) {
  const { snap, isDemo, act } = useQuiz();
  const { toast, confirm } = useUI();
  const bank = snap.questions;
  const bankById = useMemo(() => new Map(bank.map((q) => [q.id, q])), [bank]);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [showOptions, setShowOptions] = useState(false);
  const fileRef = useRef(null);
  const ids = form.question_ids;

  const setIds = (fn) => setForm((f) => ({ ...f, question_ids: fn(f.question_ids) }));
  const add = (newIds, what) => {
    setIds((cur) => addToSelection(cur, newIds).ids);
    if (what) toast('success', what);
  };
  const move = (i, d) => setIds((a) => { const b = [...a]; const j = i + d; if (j < 0 || j >= b.length) return b; [b[i], b[j]] = [b[j], b[i]]; return b; });

  // After an import, add the new bank questions once the refreshed snapshot contains them.
  useEffect(() => {
    if (!pendingImport) return;
    const created = importedQuestionIds(pendingImport.before, bank, pendingImport.items);
    if (created.length < pendingImport.items.length) return;
    setPendingImport(null);
    add([...pendingImport.reuseIds, ...created], `${pendingImport.reuseIds.length + created.length} imported question(s) added to the set`);
  }, [bank, pendingImport]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = parseQuestionFile(await readFileText(file), file.name);
      setImporting({ fileName: file.name, items });
    } catch (err) {
      toast('error', 'Could not read the file', err.message);
    }
  }

  async function runImport(check) {
    if (check.toImport.length) {
      const before = new Set(bank.map((q) => q.id));
      const res = await act('importQuestions', { items: check.toImport }, { key: 'wizard-import', success: `${check.toImport.length} question(s) added to the bank` });
      if (!res.ok) return;
      setPendingImport({ before, items: check.toImport, reuseIds: check.reuseIds });
    } else {
      add(check.reuseIds, `${check.reuseIds.length} existing bank question(s) added to the set`);
    }
    setImporting(null);
  }

  async function clearAll() {
    const ok = await confirm({ title: 'Remove every question from this set?', confirmLabel: 'Remove all', danger: true, message: <p>The questions stay in the question bank; only this set's selection is cleared. Nothing is saved until you press Save draft or Next.</p> });
    if (ok) setIds(() => []);
  }

  return (
    <div className="stack">
      <CountMeter n={ids.length} />
      <div className="toolbar wz-toolbar">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}><Plus size={16} /> Add question</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(true)}><Library size={16} /> Choose from bank ({bank.length})</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><FileUp size={16} /> Import CSV</button>
        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={onFile} aria-label="Question CSV file" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadText('brainfreze-questions-template.csv', questionTemplateCSV(), 'text/csv')}><Download size={16} /> CSV template</button>
        <span className="wz-toolbar-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowOptions((v) => !v)} aria-pressed={showOptions}>
            {showOptions ? <EyeOff size={16} /> : <Eye size={16} />} {showOptions ? 'Hide' : 'Show'} options & answers
          </button>
          {ids.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}><Trash2 size={16} /> Remove all</button>}
        </span>
      </div>
      {pendingImport && <p className="muted small" role="status">Adding the imported questions…</p>}

      {ids.length === 0 ? (
        <div className="state-box"><ListChecks size={28} /><h3>No questions in this set yet</h3><p className="muted">Add questions one by one, choose them from the question bank, or import a CSV file.</p></div>
      ) : (
        <ol className="wz-qlist">
          {ids.map((id, i) => {
            const q = bankById.get(id);
            const v = q ? validateQuestion(q) : null;
            return (
              <li key={id} className={!q || !v.ok ? 'wz-q-bad' : ''}>
                <span className="wz-qnum">{i + 1}</span>
                <div className="wz-qbody">
                  <p className="wz-qtext">{q ? q.question_text : <i className="danger-text">Question no longer in the bank — remove it</i>}</p>
                  {q && (
                    <span className="wz-qmeta">
                      {OPTIONS.includes(q.correct_option) ? <span className="badge badge-ok badge-xs">Answer {q.correct_option}</span> : <span className="badge badge-danger badge-xs">NO ANSWER</span>}
                      {q.category && <span className="badge badge-muted badge-xs">{q.category}</span>}
                      {q.is_sample && <span className="badge badge-amber badge-xs">SAMPLE</span>}
                      {(q.marks_correct != null || q.marks_incorrect != null) && <span className="badge badge-purple badge-xs">own marks</span>}
                      {!v.ok && <span className="badge badge-danger badge-xs">{Object.values(v.errors)[0]}</span>}
                    </span>
                  )}
                  {q && showOptions && (
                    <ul className="q-options wz-qopts">
                      {OPTIONS.map((l) => <li key={l} className={q.correct_option === l ? 'is-key' : ''}><b>{l}</b> {q[OPTION_FIELDS[l]]}</li>)}
                    </ul>
                  )}
                </div>
                <span className="actions">
                  {q && <button type="button" className="icon-btn" onClick={() => setPreview({ q, n: i + 1 })} aria-label={`Preview question ${i + 1}`} title="Preview"><Eye size={15} /></button>}
                  {q && <button type="button" className="icon-btn" onClick={() => setEditing(q)} aria-label={`Edit question ${i + 1}`} title="Edit"><Pencil size={15} /></button>}
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`}><ArrowUp size={15} /></button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === ids.length - 1} aria-label={`Move question ${i + 1} down`}><ArrowDown size={15} /></button>
                  <button type="button" className="icon-btn" onClick={() => setIds((a) => a.filter((x) => x !== id))} aria-label={`Remove question ${i + 1}`} title="Remove from this set"><X size={15} /></button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted small">Each team gets these questions in its own random order with shuffled options; answers are never sent to team devices. Questions live in the shared question bank — editing one here also changes it for other drafts that use it. Published sets keep their own frozen copy.</p>

      {editing && (
        <QuestionEditor question={editing} isDemo={isDemo} hasAnswers={false} onClose={() => setEditing(null)}
          onSaved={(id) => { if (!editing.id && id) add([id], null); }} />
      )}
      {preview && <PreviewModal {...preview} onClose={() => setPreview(null)} />}
      {picking && <BankPicker bank={bank} selected={ids} onChange={(next) => setIds(() => next)} onClose={() => setPicking(false)} />}
      {importing && <ImportDialog data={importing} bank={bank} onImport={runImport} onClose={() => setImporting(null)} />}
    </div>
  );
}

function PreviewModal({ q, n, onClose }) {
  return (
    <Modal title={`Preview — question ${n}`} onClose={onClose} labelledBy="wz-preview" wide>
      <div className="preview-frame">
        <p className="preview-q">{q.question_text}</p>
        {q.image_url && <img src={q.image_url} alt="" className="preview-img" />}
        <OptionGrid question={q} size="sm" keyLetter={OPTIONS.includes(q.correct_option) ? q.correct_option : null} />
      </div>
      <p className="muted small">Organizer preview: the correct answer ({q.correct_option || 'none'}) is highlighted here only. Teams see the options in their own shuffled order without any answer.</p>
    </Modal>
  );
}

function BankPicker({ bank, selected, onChange, onClose }) {
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const chosen = new Set(selected);
  const categories = [...new Set(bank.map((q) => q.category).filter(Boolean))].sort();
  const f = filter.trim().toLowerCase();
  const visible = bank.filter((q) => (!category || q.category === category) && (!onlyFree || !chosen.has(q.id)) && (!f || q.question_text.toLowerCase().includes(f)));
  const toggle = (id) => onChange(chosen.has(id) ? selected.filter((x) => x !== id) : addToSelection(selected, [id]).ids);
  return (
    <Modal title="Choose from the question bank" onClose={onClose} labelledBy="wz-bank" wide>
      <div className="toolbar">
        <label className="search"><Search size={14} aria-hidden="true" /><input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter bank questions" /></label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"><option value="">All categories</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="check"><input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> Not in this set</label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!visible.length} onClick={() => onChange(addToSelection(selected, visible.map((q) => q.id)).ids)}><Plus size={14} /> Add all shown</button>
      </div>
      <CountMeter n={selected.length} />
      {bank.length === 0 ? <p className="muted">The question bank is empty. Add or import questions first.</p> : (
        <ul className="q-pick-list wz-bank">
          {visible.map((q) => {
            const ok = validateQuestion(q).ok;
            return (
              <li key={q.id}>
                <label className="check">
                  <input type="checkbox" checked={chosen.has(q.id)} onChange={() => toggle(q.id)} />
                  <span><b>Q{q.position}</b> {q.question_text} {q.category && <span className="badge badge-muted badge-xs">{q.category}</span>}
                    {q.is_sample && <span className="badge badge-amber badge-xs">SAMPLE</span>} {!ok && <span className="badge badge-danger badge-xs">needs fixing</span>}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function ImportDialog({ data, bank, onImport, onClose }) {
  const check = useMemo(() => checkQuestionImport(data.items, { bank }), [data.items, bank]);
  const adding = check.toImport.length + check.reuseIds.length;
  return (
    <Modal title={`Import questions — ${data.fileName}`} onClose={onClose} labelledBy="wz-import" wide>
      <p>{check.rows.length} row(s) found: <b>{check.rows.length - check.invalid.length} valid</b>{check.invalid.length > 0 && <>, <b className="danger-text">{check.invalid.length} invalid</b></>}.</p>
      {check.invalid.length > 0 && (
        <div className="inline-alert alert-danger" role="alert">
          <div><strong>Fix these rows and import again (nothing is imported while any row is invalid):</strong>
            <ul>{check.invalid.slice(0, 10).map((r) => <li key={r.line}>Line {r.line}: {r.errors.join(' ')}</li>)}</ul>
            {check.invalid.length > 10 && <small>…and {check.invalid.length - 10} more.</small>}
          </div>
        </div>
      )}
      {check.ok && (
        <ul className="small">
          <li>{check.toImport.length} new question(s) will be added to the question bank.</li>
          {check.duplicates.length > 0 && <li>{check.duplicates.length} row(s) are duplicates ({[...new Set(check.duplicates.map((r) => r.duplicate.replace(/\d+$/, 'n')))].join(', ')}) and are not imported again{check.reuseIds.length ? '; the matching bank questions are added to the set instead' : ''}.</li>}
          <li>{adding} question(s) will be added to this set.</li>
        </ul>
      )}
      <ol className="import-preview">
        {check.rows.slice(0, 60).map((r) => (
          <li key={r.line} className={r.ok ? '' : 'row-error'}>{r.text || '(no text)'} — <b>{r.key || '?'}</b>{r.duplicate && <span className="muted small"> ({r.duplicate})</span>}</li>
        ))}
      </ol>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!check.ok || adding === 0} onClick={() => onImport(check)}>Import {adding} question(s)</button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------- step 3

function RulesStep({ form, setForm, showErrors }) {
  const errors = showErrors ? rulesErrors(form.rules) : {};
  const set = (k) => (e) => setForm((f) => ({ ...f, rules: { ...f.rules, [k]: e.target.value } }));
  const isDefault = JSON.stringify(rulesToSettings(form.rules)) === JSON.stringify(rulesToSettings(DEFAULT_RULES));
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Time limit per team (minutes)" error={errors.duration_minutes} hint="Any positive number of minutes. Each team's timer starts when it presses Start.">
          <input type="number" min={0} step="any" inputMode="decimal" value={form.rules.duration_minutes} onChange={set('duration_minutes')} />
        </Field>
        <Field label="Teams that qualify" error={errors.qualify_count} hint="Top teams confirmed after the round. Default 5.">
          <input type="number" min={1} max={50} value={form.rules.qualify_count} onChange={set('qualify_count')} />
        </Field>
        <Field label="Marks for a correct answer" error={errors.marks_correct} hint="Default +1"><input type="number" step="0.25" value={form.rules.marks_correct} onChange={set('marks_correct')} /></Field>
        <Field label="Marks for an incorrect answer" error={errors.marks_incorrect} hint="Default −0.25 (0 or negative)"><input type="number" step="0.25" value={form.rules.marks_incorrect} onChange={set('marks_incorrect')} /></Field>
        <Field label="Marks for an unanswered question" error={errors.marks_unanswered} hint="Default 0"><input type="number" step="0.25" value={form.rules.marks_unanswered} onChange={set('marks_unanswered')} /></Field>
        <div className="field">
          <span>Questions in this set</span>
          <p className="wz-static">{form.question_ids.length}</p>
        </div>
      </div>
      <div className="row gap wrap">
        <button type="button" className="btn btn-ghost btn-sm" disabled={isDefault} onClick={() => setForm((f) => ({ ...f, rules: { ...DEFAULT_RULES } }))}><RotateCcw size={14} /> Restore defaults</button>
        {isDefault && <span className="muted small">Using the default rules.</span>}
      </div>
      <details className="wz-more">
        <summary>How timing and ranking work</summary>
        <ol className="small">{rankingPolicy(rulesToSettings(form.rules)).map((t) => <li key={t}>{t}</li>)}</ol>
      </details>
    </div>
  );
}

// --------------------------------------------------------------------------- step 4

function ReviewStep({ form, bankById, issues, warnings, dirty, onEdit }) {
  const r = rulesToSettings(form.rules);
  const n = form.question_ids.length;
  return (
    <div className="stack">
      <div className="wz-review">
        <section>
          <h3>Basic details <button type="button" className="btn btn-ghost btn-xs" onClick={() => onEdit(0)}>Edit</button></h3>
          <dl className="kv small">
            <dt>Quiz title</dt><dd>{form.name || '—'}</dd>
            <dt>Section</dt><dd>{SECTION_LABELS[form.section]}</dd>
            <dt>Instructions</dt><dd>{form.description || <span className="muted">none</span>}</dd>
            <dt>Walk-in teams</dt><dd>{form.self_registration ? 'May self-register' : 'Registered teams only'}</dd>
          </dl>
        </section>
        <section>
          <h3>Questions <button type="button" className="btn btn-ghost btn-xs" onClick={() => onEdit(1)}>Edit</button></h3>
          <dl className="kv small">
            <dt>Selected</dt><dd className={questionCountIssue(n) ? 'warn-text' : ''}>{n}</dd>
            <dt>With an answer</dt><dd>{form.question_ids.filter((id) => OPTIONS.includes(bankById.get(id)?.correct_option)).length} of {n}</dd>
            <dt>Order</dt><dd>Shuffled per team (questions and options)</dd>
          </dl>
        </section>
        <section>
          <h3>Rules <button type="button" className="btn btn-ghost btn-xs" onClick={() => onEdit(2)}>Edit</button></h3>
          <dl className="kv small">
            <dt>Time limit</dt><dd>{minutes(r.duration_seconds)} minutes per team</dd>
            <dt>Scoring</dt><dd>Correct {formatPoints(r.marks_correct)} · incorrect {formatPoints(r.marks_incorrect)} · unanswered {formatPoints(r.marks_unanswered)}</dd>
            <dt>Qualifiers</dt><dd>Top {r.qualify_count} (confirmed by an organizer)</dd>
          </dl>
        </section>
      </div>
      {issues.length ? <IssueList issues={issues} title="Fix these before publishing:" /> : (
        <p className="ok-text" role="status"><CheckCircle2 size={16} /> Ready to publish: {n} question{n === 1 ? '' : 's'} with answers, {minutes(r.duration_seconds)}-minute timer, valid scoring.</p>
      )}
      {warnings.map((w) => <p key={w} className="warn-text small"><AlertTriangle size={14} /> {w}</p>)}
      {dirty && !issues.length && <p className="muted small">Your unsaved changes are saved automatically before publishing.</p>}
      <p className="muted small">Publishing freezes the questions, answers, timer and scoring and generates a unique six-digit join code. Teams can join and read the instructions, but cannot start until you press <b>Go live</b> on the Live host tab.</p>
    </div>
  );
}

function PublishedStep({ onManage }) {
  const { snap } = useQuiz();
  const { toast } = useUI();
  const s = snap.session;
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast('success', `${what} copied`); } catch { toast('warn', 'Copy failed', 'Select and copy it manually.'); }
  }
  return (
    <div className="stack wz-published">
      <p className="ok-text" role="status"><CheckCircle2 size={18} /> “{s.name}” is published. Its questions, answers, timer and scoring are now frozen.</p>
      {s.join_code_active ? (
        <>
          <p className="center muted">Six-digit join code for {s.section} teams</p>
          <div className="join-code-big" aria-label={`Join code ${s.join_code.split('').join(' ')}`}>{formatJoinCode(s.join_code)}</div>
          <div className="row gap wrap center-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(s.join_code, 'Join code')}><Copy size={14} /> Copy code</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(joinUrl(), 'Join link')}><Copy size={14} /> Copy join link</button>
          </div>
          <p className="center muted small">Teams join at <b>{joinUrl()}</b> with this code, then choose their section and their registered team.</p>
        </>
      ) : <p className="warn-text"><AlertTriangle size={16} /> This set has no active join code. Manage the set to issue one.</p>}
      <div className="row gap wrap center-row">
        <button type="button" className="btn btn-ghost" onClick={onManage}>Manage set (join slips, registration, devices)</button>
        <Link className="btn btn-ghost" to="/host/rounds/1/live"><MonitorPlay size={16} /> Open Live host</Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- wizard shell

function WizardFooter({ step, busy, dirty, onCancel, onBack, onSave, onNext, onPublish, canPublish }) {
  const last = step === WIZARD_STEPS.length - 1;
  return (
    <div className="wizard-footer">
      <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      <span className="wz-save-state muted small" role="status">{onSave ? (dirty ? 'Unsaved changes' : 'All changes saved') : ''}</span>
      <div className="row gap wrap">
        {step > 0 && <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Back</button>}
        {onSave && <button type="button" className="btn btn-ghost" onClick={onSave} disabled={busy || !dirty}><Save size={16} /> Save draft</button>}
        {last
          ? <button type="button" className="btn btn-primary" onClick={onPublish} disabled={busy || !canPublish}><Rocket size={16} /> Publish set</button>
          : <button type="button" className="btn btn-primary" onClick={onNext} disabled={busy}>Next <ArrowRight size={16} /></button>}
      </div>
    </div>
  );
}

/** "New quiz set": step 1 only — Next creates the draft, then the wizard continues on the Set setup tab. */
export function NewSetWizard() {
  const { act, selectSet, section } = useQuiz();
  const navigate = useNavigate();
  const [form, setForm] = useState(() => newSetForm(section));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const issues = Object.values(detailsErrors(form));

  async function next() {
    setShowErrors(true);
    if (issues.length) return;
    setBusy(true);
    try {
      const res = await act('createSet', { name: form.name.trim(), section: form.section, description: form.description }, { key: 'createSet', success: 'Draft quiz set created' });
      if (!res.ok) return;
      const id = res.result.id;
      selectSet(id);
      if (form.self_registration) await act('updateQuizDetails', { self_registration: true }, { key: 'wizard-details' });
      writeLocalDraft(storage(), id, { step: 1 });
      navigate('/host/rounds/1/setup');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header"><div><h1>New quiz set</h1><p className="muted">Four short steps: details, questions, rules, then review and publish.</p></div></header>
      <section className="panel glass wizard" aria-labelledby="wz-title">
        <WizardSteps step={0} reachable={0} />
        <h2 id="wz-title" className="wz-step-title">Step 1 · Basic details</h2>
        {showErrors && <IssueList issues={issues} title="Complete the details:" />}
        <DetailsStep form={form} setForm={setForm} showErrors={showErrors} />
        <WizardFooter step={0} busy={busy} onCancel={() => navigate('/host/rounds/1/sets')} onNext={next} />
      </section>
    </div>
  );
}

/** The selected DRAFT set, edited step by step. Once published, shows the join code (`onManage` returns to the set view). */
export default function SetWizard({ onPublished, onManage }) {
  const { snap, act, quizQuestions } = useQuiz();
  const { confirm, toast } = useUI();
  const navigate = useNavigate();
  const s = snap.session;
  const bankById = useMemo(() => new Map(snap.questions.map((q) => [q.id, q])), [snap.questions]);
  const server = useMemo(() => formFromSet(s, snap.settings, quizQuestions.map((q) => q.id)), [s, snap.settings, quizQuestions]);
  const [init] = useState(() => {
    const local = readLocalDraft(storage(), s.id);
    const form = local?.form && isDirty(local.form, server) ? local.form : server;
    return { form, restored: form !== server, step: resumeStep(form, bankById, local?.step ?? null) };
  });
  const [form, setForm] = useState(init.form);
  const [restored, setRestored] = useState(init.restored);
  const [step, setStep] = useState(init.step);
  const [shown, setShown] = useState([]);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null);
  const prevServer = useRef(server);
  const dirty = isDirty(form, server);
  const published = !!s.published_at;

  // Follow saved changes (this tab or another organizer) while there are no unsaved edits here.
  useEffect(() => {
    const prev = prevServer.current;
    if (prev === server) return;
    prevServer.current = server;
    setForm((f) => (isDirty(f, prev) ? f : server));
  }, [server]);

  // Keep unsaved edits and the current step in this browser (per set) so a refresh resumes here.
  useEffect(() => {
    if (!published) writeLocalDraft(storage(), s.id, { form, server, step });
  }, [form, server, step, s.id, published]);

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const reachable = maxReachableStep(form, bankById);
  const issues = reviewIssues(form, bankById);

  async function save({ quiet = false } = {}) {
    const c = draftChanges(form, server);
    if (c.emptySelection) toast('warn', 'Question selection not saved', 'A draft must keep at least one question. Add questions, then save again.');
    if (!c.details && !c.settings) return !c.emptySelection || quiet;
    setBusy(true);
    try {
      if (c.details && !(await act('updateQuizDetails', c.details, { key: 'wizard-details', errorTitle: 'Draft not saved' })).ok) return false;
      if (c.settings && !(await act('updateSettings', c.settings, { key: 'wizard-settings', errorTitle: 'Rules not saved' })).ok) return false;
      if (!quiet) toast('success', 'Draft saved', 'You can leave and continue later from Quiz sets.');
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function go(target) {
    if (target <= step) { setShown([]); setStep(target); return; }
    if (target > reachable) return;
    if (!(await save({ quiet: true }))) return;
    setShown([]);
    setStep(target);
  }

  async function next() {
    const r = goNext(step, form, bankById);
    if (r.issues.length) { setShown(r.issues); return; }
    if (!(await save({ quiet: true }))) return;
    setShown([]);
    setStep(r.step);
  }

  async function cancel() {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?', danger: true, confirmLabel: 'Discard changes',
        message: <p>The draft keeps everything you last saved (with Save draft or Next). Changes made since then are discarded.</p>,
      });
      if (!ok) return;
      setForm(server);
    }
    clearLocalDraft(storage(), s.id);
    navigate('/host/rounds/1/sets');
  }

  async function publish() {
    if (issues.length) { setShown(issues); return; }
    if (!(await save({ quiet: true }))) return;
    const r = rulesToSettings(form.rules);
    const ok = await confirm({
      title: `Publish “${form.name}”?`, confirmLabel: 'Publish & generate code',
      message: (
        <>
          <ul>
            <li>{form.section} section · {form.question_ids.length} question{form.question_ids.length === 1 ? '' : 's'} · {minutes(r.duration_seconds)}-minute timer per team</li>
            <li>Scoring: correct {formatPoints(r.marks_correct)}, incorrect {formatPoints(r.marks_incorrect)}, unanswered {formatPoints(r.marks_unanswered)} (per-question marks where set)</li>
          </ul>
          <p>Publishing <b>freezes</b> the questions, answers, timer and scoring, and generates a unique six-digit join code. Teams cannot start until you press <b>Go live</b>.</p>
        </>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await act('publishQuiz', {}, { key: 'publish', success: 'Set published', successDetail: (x) => `Join code ${formatJoinCode(x.join_code)}` });
      if (res.ok) { clearLocalDraft(storage(), s.id); onPublished?.(s.id); }
    } finally {
      setBusy(false);
    }
  }

  if (published) {
    return (
      <section className="panel glass wizard" aria-labelledby="wz-title">
        <WizardSteps step={3} reachable={3} done />
        <h2 id="wz-title" className="wz-step-title">Published</h2>
        <PublishedStep onManage={onManage} />
      </section>
    );
  }

  const StepIcon = STEP_ICONS[step];
  return (
    <section className="panel glass wizard" aria-labelledby="wz-title">
      <WizardSteps step={step} reachable={reachable} onGo={go} />
      {restored && (
        <div className="inline-alert alert-info small">
          Unsaved changes from this browser were restored.
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setForm(server); setRestored(false); }}>Discard them</button>
        </div>
      )}
      <h2 id="wz-title" className="wz-step-title" tabIndex={-1} ref={headingRef}><StepIcon size={18} aria-hidden="true" /> Step {step + 1} · {WIZARD_STEPS[step].label}</h2>
      {step < 3 && <IssueList issues={shown} title="Before you continue:" />}
      {step === 0 && <DetailsStep form={form} setForm={setForm} showErrors={shown.length > 0} />}
      {step === 1 && <QuestionsStep form={form} setForm={setForm} />}
      {step === 2 && <RulesStep form={form} setForm={setForm} showErrors={shown.length > 0 || Object.keys(rulesErrors(form.rules)).length > 0} />}
      {step === 3 && <ReviewStep form={form} bankById={bankById} issues={issues} warnings={reviewWarnings(form, bankById)} dirty={dirty} onEdit={go} />}
      <WizardFooter step={step} busy={busy} dirty={dirty} onCancel={cancel} onBack={() => { setShown([]); setStep(goBack(step)); }}
        onSave={() => save()} onNext={next} onPublish={publish} canPublish={issues.length === 0} />
    </section>
  );
}
