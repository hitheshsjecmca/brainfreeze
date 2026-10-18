import { useState } from 'react';
import { Lock, Save } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { Field } from './Common.jsx';
import { validateSettings } from '../lib/validation.js';

/** The selected set's timer & scoring (frozen once the set is published). */
export default function ScoringForm({ locked }) {
  const { snap, act } = useQuiz();
  const s = snap.settings;
  const [form, setForm] = useState({ ...s, duration_minutes: s.duration_seconds / 60 });
  const durationSeconds = Math.round(Number(form.duration_minutes) * 60);
  const check = validateSettings({ ...form, duration_seconds: durationSeconds });
  const ok = check.ok;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save(e) {
    e.preventDefault();
    if (!ok || locked) return;
    const { accuracy_tiebreak: _unused, ...value } = check.value;
    await act('updateSettings', value, { success: 'Timer & scoring saved' });
  }

  return (
    <section className="panel glass" aria-labelledby="sc-title">
      <h2 id="sc-title">Timer & scoring {locked && <span className="badge badge-muted"><Lock size={12} /> frozen after publishing</span>}</h2>
      <form onSubmit={save} className="form-grid" noValidate>
        <Field label="Time limit per team (minutes)" error={check.errors.duration_seconds} hint="Any positive number of minutes.">
          <input type="number" min={0} step="any" value={form.duration_minutes} onChange={set('duration_minutes')} disabled={locked} />
        </Field>
        <Field label="Teams that qualify" error={check.errors.qualify_count}><input type="number" min={1} max={50} value={form.qualify_count} onChange={set('qualify_count')} disabled={locked} /></Field>
        <Field label="Correct answer" error={check.errors.marks_correct}><input type="number" step="0.25" value={form.marks_correct} onChange={set('marks_correct')} disabled={locked} /></Field>
        <Field label="Incorrect answer" error={check.errors.marks_incorrect}><input type="number" step="0.25" value={form.marks_incorrect} onChange={set('marks_incorrect')} disabled={locked} /></Field>
        <Field label="Unanswered" error={check.errors.marks_unanswered}><input type="number" step="0.25" value={form.marks_unanswered} onChange={set('marks_unanswered')} disabled={locked} /></Field>
        <p className="muted small span-2">Questions with their own marks in the bank keep them. Equal scores are separated by elapsed completion time (see the ranking rules).</p>
        <div className="span-2 row gap">
          <button className="btn btn-primary" disabled={locked || !ok}><Save size={16} /> Save timer & scoring</button>
        </div>
      </form>
    </section>
  );
}
