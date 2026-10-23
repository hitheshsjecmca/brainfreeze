import { useState } from 'react';
import {
  AlertTriangle, Ban, Copy, DoorClosed, DoorOpen, Globe, KeyRound, Lock, RefreshCw, Save, Undo2,
} from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { Field, Modal, PageHeader, StatusBadge } from '../components/Common.jsx';
import ParticipantMonitor from '../components/ParticipantMonitor.jsx';
import ScoringForm from '../components/ScoringForm.jsx';
import SetWizard from '../components/SetWizard.jsx';
import { formatJoinCode, joinUrl } from '../lib/joinCodes.js';
import { OPTION_FIELDS, SECTIONS, SET_STAGE_LABELS } from '../lib/constants.js';
import { optionLetters } from '../lib/options.js';
import { setStage } from '../lib/engine.js';
import { formatStamp, minutes, rankingPolicy } from '../lib/sets.js';
import { setupView } from '../lib/setWizard.js';
import { formatPoints } from '../lib/scoring.js';

/**
 * The selected quiz set. A draft is built with the four-step wizard; a published
 * (or archived) set shows its join code, registration, frozen questions and devices.
 */
export default function QuizSetup() {
  const { snap } = useQuiz();
  const s = snap.session;
  const stage = setStage(s);
  const frozen = !!s.published_at;
  // Right after publishing, the wizard stays on screen to show the new join code.
  const [justPublished, setJustPublished] = useState(null);
  if (setupView(s) === 'wizard' || justPublished === s.id) {
    return (
      <div className="page">
        <PageHeader title={s.name} subtitle={`${s.section} quiz set · ${frozen ? 'Published' : 'Draft — set it up step by step'}`}>
          <span className={`badge ${frozen ? 'badge-ice' : 'badge-muted'}`}>{SET_STAGE_LABELS[stage].toUpperCase()}</span>
        </PageHeader>
        <SetWizard key={s.id} onPublished={setJustPublished} onManage={() => setJustPublished(null)} />
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader title={s.name} subtitle={`${s.section} quiz set · ${SET_STAGE_LABELS[stage]}. Build it as a draft, review it, then publish to freeze it and get its six-digit join code.`}>
        <span className={`badge ${stage === 'draft' ? 'badge-muted' : 'badge-ice'}`}>{SET_STAGE_LABELS[stage].toUpperCase()}</span>
        {stage === 'live' && <StatusBadge status={s.status} />}
      </PageHeader>
      {frozen && (
        <div className="inline-alert alert-info"><Lock size={16} /> Published {formatStamp(s.published_at)}: questions, answer keys, option mapping, timer and scoring are frozen. A wrong key can only be changed with the audited “Correct key” action below.</div>
      )}
      <div className="two-col">
        <DetailsForm key={`${s.id}:${s.updated_at}`} />
        <PublishPanel />
      </div>
      {frozen && <FrozenQuestions />}
      <div className="two-col">
        <ScoringForm key={JSON.stringify(snap.settings) + s.id + frozen} locked={frozen || s.status !== 'setup'} />
        <PolicyPanel />
      </div>
      <ParticipantMonitor />
    </div>
  );
}

function DetailsForm() {
  const { snap, act } = useQuiz();
  const s = snap.session;
  const frozen = !!s.published_at;
  const [name, setName] = useState(s.name || '');
  const [description, setDescription] = useState(s.description || '');
  const [section, setSection] = useState(s.section);

  async function save(e) {
    e.preventDefault();
    const payload = { name, description };
    if (!frozen) payload.section = section;
    await act('updateQuizDetails', payload, { key: 'details', success: 'Set details saved' });
  }

  return (
    <section className="panel glass" aria-labelledby="qd-title">
      <h2 id="qd-title">Set details</h2>
      <form onSubmit={save} className="stack">
        <Field label="Set name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
        <Field label="Section" hint={frozen ? 'Frozen after publishing.' : 'Only teams of this section can join the set.'}>
          <select value={section} onChange={(e) => setSection(e.target.value)} disabled={frozen}>{SECTIONS.map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        <Field label="Instructions (optional, shown to teams before they start)"><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        <button className="btn btn-primary"><Save size={16} /> Save details</button>
      </form>
    </section>
  );
}

/** Published: the frozen snapshot, with the audited key-correction workflow. */
function FrozenQuestions() {
  const { quizQuestions, snap } = useQuiz();
  const [fixing, setFixing] = useState(null);
  const finalized = snap.session.status === 'finalized';
  return (
    <section className="panel glass" aria-labelledby="fq-title">
      <h2 id="fq-title"><Lock size={18} /> Frozen questions ({quizQuestions.length})</h2>
      <p className="muted small">Each team sees these in its own random order with shuffled options; scoring always uses the original key below. Keys are never sent to team devices.</p>
      <ol className="q-pick-list">
        {quizQuestions.map((q) => (
          <li key={q.id}>
            <span>{q.question_text} <span className="badge badge-ok badge-xs">Key {q.correct_option}</span> <span className="muted small">{formatPoints(q.marks_correct)} / {formatPoints(q.marks_incorrect)}</span></span>
            {!finalized && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFixing(q)}><KeyRound size={14} /> Correct key</button>}
          </li>
        ))}
      </ol>
      {fixing && <KeyCorrection q={fixing} onClose={() => setFixing(null)} />}
    </section>
  );
}

function KeyCorrection({ q, onClose }) {
  const { act } = useQuiz();
  const [key, setKey] = useState(q.correct_option);
  const [mc, setMc] = useState(q.marks_correct);
  const [mi, setMi] = useState(q.marks_incorrect);
  const [reason, setReason] = useState('');
  async function submit(e) {
    e.preventDefault();
    const res = await act('correctSetQuestion', { question_id: q.id, correct_option: key, marks_correct: Number(mc), marks_incorrect: Number(mi), reason },
      { key: `fix:${q.id}`, success: 'Key corrected', successDetail: (r) => `${r.rescored} recorded answer(s) re-scored (audited).` });
    if (res.ok) onClose();
  }
  return (
    <Modal title="Correct a published key" onClose={onClose} labelledBy="kc-title">
      <form className="stack" onSubmit={submit}>
        <p>{q.question_text}</p>
        <ul className="muted small">{optionLetters(q).map((l) => <li key={l}><b>{l}</b> {q[OPTION_FIELDS[l]]}</li>)}</ul>
        <div className="form-grid">
          <Field label="Correct option"><select value={key} onChange={(e) => setKey(e.target.value)}>{optionLetters(q).map((l) => <option key={l}>{l}</option>)}</select></Field>
          <Field label="Marks correct"><input type="number" step="0.25" value={mc} onChange={(e) => setMc(e.target.value)} /></Field>
          <Field label="Marks incorrect"><input type="number" step="0.25" value={mi} onChange={(e) => setMi(e.target.value)} /></Field>
        </div>
        <Field label="Reason (required, recorded in the audit log)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required /></Field>
        <p className="warn-text small"><AlertTriangle size={14} /> Every answer already recorded for this question in this set is re-scored; each change is logged. Other sets are not affected.</p>
        <button className="btn btn-danger" disabled={!reason.trim()}>Apply correction</button>
      </form>
    </Modal>
  );
}

function PolicyPanel() {
  const { snap } = useQuiz();
  return (
    <section className="panel glass" aria-labelledby="rp-title">
      <h2 id="rp-title">Ranking & timing rules</h2>
      <ol className="small">{rankingPolicy(snap.settings).map((t) => <li key={t}>{t}</li>)}</ol>
      <p className="muted small">Each team's timer starts when it presses Start (after you put the set live) and runs for {minutes(snap.settings.duration_seconds)} minutes on the server clock. Refreshing or reconnecting never restarts it; answers after the deadline are refused and the attempt is finalized automatically. Pausing the set freezes every running team timer.</p>
    </section>
  );
}

function PublishPanel() {
  const { snap, act } = useQuiz();
  const { confirm, toast } = useUI();
  const s = snap.session;
  const ended = ['ended', 'finalized'].includes(s.status);
  const archived = s.is_current === false;
  const joined = (snap.attempts || []).filter((a) => a.status !== 'reset').length;

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast('success', `${what} copied`); } catch { toast('warn', 'Copy failed', 'Select and copy it manually.'); }
  }
  async function regenerate() {
    const ok = await confirm({ title: 'Generate a new join code?', danger: true, confirmLabel: 'New code', message: <p>The old code stops working immediately and is never reused. Teams already joined stay connected.</p> });
    if (ok) act('regenerateJoinCode', {}, { success: 'New join code generated' });
  }
  async function revoke() {
    const ok = await confirm({ title: 'Revoke the join code?', danger: true, confirmLabel: 'Revoke code', message: <p>The code stops working immediately and is never reused or given to another set. Teams that already joined keep their access. Issue a new code later if needed.</p> });
    if (ok) act('revokeJoinCode', {}, { success: 'Join code revoked' });
  }
  async function unpublish() {
    const ok = await confirm({ title: 'Return the set to draft?', danger: true, confirmLabel: 'Unpublish', message: <p>Only possible before any team joins. The code is retired and the frozen copy is discarded.</p> });
    if (ok) act('unpublishQuiz', {}, { success: 'Set returned to draft' });
  }

  return (
    <section className="panel glass publish-panel" aria-labelledby="pub-title">
      <h2 id="pub-title"><Globe size={18} /> Join code & registration</h2>
      {archived && <p className="muted">This set is archived. Its code no longer works; its results stay viewable. Duplicate it on the Quiz sets tab to reuse it.</p>}
      {!archived && !s.published_at && <p className="muted">This set is a draft. Open it from Quiz sets to finish setting it up.</p>}
      {!archived && s.join_code_active && (
        <>
          <div className="join-code-big" aria-label={`Join code ${s.join_code.split('').join(' ')}`}>{formatJoinCode(s.join_code)}</div>
          <div className="row gap wrap center-row">
            <button className="btn btn-ghost btn-sm" onClick={() => copy(s.join_code, 'Join code')}><Copy size={14} /> Copy code</button>
            <button className="btn btn-ghost btn-sm" onClick={() => copy(joinUrl(), 'Join link')}><Copy size={14} /> Copy join link</button>
          </div>
          <p className="center muted small">Participants join at <b>{joinUrl()}</b> with the code, their name and college · {joined} joined</p>
          <div className="row gap wrap">
            <span className={`badge ${s.registration_open ? 'badge-ok' : 'badge-amber'}`}>{s.registration_open ? 'Registration OPEN' : 'Registration CLOSED'}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => act('setRegistration', { open: !s.registration_open }, { key: 'reg', success: s.registration_open ? 'Registration closed' : 'Registration opened' })}>
              {s.registration_open ? <><DoorClosed size={14} /> Close registration</> : <><DoorOpen size={14} /> Open registration</>}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={revoke}><Ban size={14} /> Revoke code</button>
            <button className="btn btn-ghost btn-sm" onClick={regenerate}><RefreshCw size={14} /> New code</button>
            {s.status === 'setup' && joined === 0 && <button className="btn btn-ghost btn-sm" onClick={unpublish}><Undo2 size={14} /> Unpublish</button>}
          </div>
          <p className="muted small">Closed registration stops new teams; joined teams can still reconnect. The code expires when the set ends.</p>
        </>
      )}
      {!archived && s.published_at && !s.join_code_active && !ended && (
        <div className="stack">
          <p className="warn-text"><AlertTriangle size={16} /> The join code is revoked. Joined participants keep access; new participants cannot join.</p>
          <button className="btn btn-ghost btn-sm" onClick={regenerate}><RefreshCw size={14} /> Issue a new code</button>
        </div>
      )}
      {!archived && ended && <p className="muted">The set has {s.status === 'ended' ? 'ended' : 'been finalized'}; its join code has expired.</p>}
    </section>
  );
}

