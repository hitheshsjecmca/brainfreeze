import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Loader2, Play, Search } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useRound2 } from '../context/Round2Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { TriviaBoard } from '../components/Round2Bits.jsx';
import TeamPicker from '../components/TeamPicker.jsx';
import { SECTION_LABELS } from '../lib/constants.js';
import { toQuizError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { formatJoinCode, isJoinCode, normalizeJoinCode } from '../lib/joinCodes.js';
import { round2ProjectorUrl } from '../lib/projectorWindow.js';
import { R2_SECTION_LABELS, formatScore } from '../lib/round2.js';
import { selectionNames, selectionProblem } from '../lib/teamSelection.js';

/**
 * Join Round 2: code of a published trivia set → section → the organiser's choice of registered teams (any number;
 * nothing is carried over from Round 1) → review → confirm → Start Round 2. Nothing is created on the server until then;
 * the server validates the set, section and every team again.
 */
export default function Round2Join() {
  const { act } = useRound2();
  const { toast, confirm } = useUI();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [set, setSet] = useState(null);
  const [section, setSection] = useState(null);
  const [teams, setTeams] = useState(null);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const startReq = useRef(null); // one request id per configuration: a retried Start never creates two games

  const reset = () => { setSet(null); setSection(null); setTeams(null); setPicked([]); startReq.current = null; };

  async function load(e) {
    e.preventDefault();
    const c = normalizeJoinCode(code);
    if (!isJoinCode(c)) { setError('Enter the six-digit code of a published trivia set.'); return; }
    setBusy(true); setError(''); reset();
    try {
      const s = await backend.round2.lookup(c);
      setSet(s);
      if (s.section !== 'BOTH') chooseSection(s.section, s);
    } catch (err) {
      setError(toQuizError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseSection(sec, s = set) {
    setSection(sec); setTeams(null); setPicked([]); setError(''); startReq.current = null;
    try {
      setTeams(await backend.round2.eligible(s.join_code, sec));
    } catch (err) {
      setError(toQuizError(err).message);
    }
  }

  const pick = (ids) => { startReq.current = null; setPicked(ids); };
  const chosen = picked.map((id) => (teams || []).find((t) => t.id === id)).filter(Boolean);
  const problem = teams ? selectionProblem(picked, teams, { min: 1 }) : null;

  async function start() {
    if (problem) return;
    const ok = await confirm({
      title: 'Start Round 2 with these teams?', confirmLabel: 'Start Round 2',
      message: <div className="stack"><p><b>{chosen.length}</b> {section} team(s) take part in “{set.title}”:</p><p className="small">{selectionNames(picked, teams)}</p><p className="small muted">The list is fixed once the game starts.</p></div>,
    });
    if (!ok) return;
    // Open the projector window now (inside the confirming click), then point it at the new game.
    const proj = window.open('', 'brainfreze-projector-round2', 'popup=yes,width=1280,height=720');
    startReq.current ??= uuid();
    const res = await act('r2sStartSession', { request_id: startReq.current, code: set.join_code, section, team_ids: chosen.map((t) => t.id) }, {
      key: 'r2-start', success: 'Round 2 started', successDetail: `${set.title} · ${section} · ${chosen.length} team(s)`,
    });
    if (!res.ok) { proj?.close(); return; }
    const id = res.result.session_id;
    if (proj) proj.location.href = round2ProjectorUrl(id);
    else toast('warn', 'Projector window blocked', 'Use the Projector button on the game screen.');
    navigate(`/host/rounds/2/session/${id}`);
  }

  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r2-join-title">
        <h2 id="r2-join-title">Join Round 2</h2>
        <form className="row gap wrap align-end" onSubmit={load} noValidate>
          <label className="field" htmlFor="r2-code">
            <span>Six-digit trivia set code</span>
            <input id="r2-code" className="code-input" inputMode="numeric" maxLength={7} placeholder="000 000" value={code} autoComplete="off"
              onChange={(e) => { setError(''); const d = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d); }} />
          </label>
          <button className="btn btn-primary" disabled={busy || normalizeJoinCode(code).length !== 6}>{busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />} Load trivia set</button>
        </form>
        {error && <p className="inline-alert alert-danger small" role="alert"><AlertTriangle size={16} /> {error}</p>}
        <p className="muted small">Codes are shown on the Trivia Sets tab after publishing. Loading a set does not start anything.</p>
      </section>

      {set && (
        <section className="panel glass" aria-labelledby="r2-set-loaded">
          <h2 id="r2-set-loaded">{set.title} <span className="badge badge-ok">v{set.version}</span></h2>
          <p className="muted small">Code {formatJoinCode(set.join_code)} · {R2_SECTION_LABELS[set.section]} · {set.topics.length} topic(s) · {set.question_count} question(s) · {set.timer_seconds}-second timer · wrong −{formatScore(set.wrong_penalty_percent)} %</p>
          <TriviaBoard topics={set.topics} size="md" />
        </section>
      )}

      {set && (
        <section className="panel glass" aria-labelledby="r2-sec-title">
          <h2 id="r2-sec-title">Section and teams</h2>
          <fieldset className="wz-fieldset">
            <legend>Section</legend>
            <div className="segmented" role="radiogroup" aria-label="Section">
              {['UG', 'PG'].map((s) => (
                <button key={s} type="button" role="radio" aria-checked={section === s} className={section === s ? 'active' : ''}
                  disabled={!['BOTH', s].includes(set.section)} onClick={() => chooseSection(s)}>{SECTION_LABELS[s]}</button>
              ))}
            </div>
          </fieldset>
          {section && !teams && !error && <p className="muted small"><Loader2 size={14} className="spin" /> Loading registered {section} teams…</p>}
          {teams && (teams.length === 0 ? <p className="warn-text">No registered {section} teams.</p> : (
            <>
              <p className="muted small">Choose any number of registered {section} teams for this game. Nothing is carried over from Round 1 — the organisers decide.</p>
              <TeamPicker teams={teams} value={picked} onChange={pick} label={`Registered ${section} teams`} />
            </>
          ))}
        </section>
      )}

      {set && section && teams && (
        <section className="panel glass r2-review" aria-labelledby="r2-review-title">
          <h2 id="r2-review-title">Review</h2>
          <dl className="kv small">
            <dt>Trivia set</dt><dd>{set.title} (version {set.version}, code {formatJoinCode(set.join_code)})</dd>
            <dt>Section</dt><dd>{SECTION_LABELS[section]}</dd>
            <dt>Teams</dt><dd>{chosen.length ? <><b>{chosen.length}</b>: {selectionNames(picked, teams)}</> : <span className="warn-text">Select at least one team.</span>}</dd>
            <dt>Rules</dt><dd>{set.timer_seconds}-second question timer · Right + the question&rsquo;s points · Wrong 0</dd>
          </dl>
          <p className="muted small">The game starts only when you press Start Round 2. Other Round 2 games — even of this set — are not affected.</p>
          {problem && chosen.length > 0 && <p className="danger-text small" role="alert">{problem}</p>}
          <button className="btn btn-primary btn-lg" onClick={start} disabled={!!problem}><Play size={18} /> Review &amp; Start Round 2 <ArrowRight size={18} /></button>
        </section>
      )}
    </div>
  );
}
