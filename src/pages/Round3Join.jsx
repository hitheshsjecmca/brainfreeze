import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Gavel, Loader2, Search } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useRound3 } from '../context/Round3Context.jsx';
import { BidTimerField } from '../components/Round3Bits.jsx';
import TeamPicker from '../components/TeamPicker.jsx';
import { useUI } from '../context/UIContext.jsx';
import { SECTION_LABELS } from '../lib/constants.js';
import { toQuizError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { formatJoinCode, isJoinCode, normalizeJoinCode } from '../lib/joinCodes.js';
import { round3ProjectorUrl } from '../lib/projectorWindow.js';
import { R3_SECTION_LABELS, START_BUDGET, bidTimerValid, parseAnswerTimer, timerLabel } from '../lib/round3.js';
import { formatScore } from '../lib/round2.js';
import { selectionProblem } from '../lib/teamSelection.js';

/**
 * Join Round 3: code of a published auction set → section → the organiser's choice of registered teams (any number,
 * at least one; nothing is carried over from earlier rounds; the pick order sets the seats) → review → confirm →
 * Start Round 3. Nothing is created until then; the server validates the set, the section, the teams and that no other
 * auction of the section is live.
 */
export default function Round3Join() {
  const { act } = useRound3();
  const { toast, confirm } = useUI();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [set, setSet] = useState(null);
  const [section, setSection] = useState(null);
  const [teams, setTeams] = useState(null);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bidTimer, setBidTimer] = useState(null);
  const [answerSecs, setAnswerSecs] = useState('25');
  const startReq = useRef(null);

  const reset = () => { setSet(null); setSection(null); setTeams(null); setPicked([]); startReq.current = null; };

  async function load(e) {
    e.preventDefault();
    const c = normalizeJoinCode(code);
    if (!isJoinCode(c)) { setError('Enter the six-digit code of a published auction set.'); return; }
    setBusy(true); setError(''); reset();
    try {
      const s = await backend.round3.lookup(c);
      setSet(s);
      setBidTimer(s.bid_seconds ?? null);
      setAnswerSecs(String(s.answer_seconds ?? 25));
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
      setTeams(await backend.round3.eligible(s.join_code, sec));
    } catch (err) {
      setError(toQuizError(err).message);
    }
  }

  const pick = (ids) => { startReq.current = null; setPicked(ids); };
  const problem = teams ? selectionProblem(picked, teams, { min: 1 }) : null;
  const chosen = picked.map((id) => (teams || []).find((t) => t.id === id)).filter(Boolean);
  const blind = set ? set.questions.filter((q) => q.mode === 'BLIND').length : 0;
  const answerCheck = parseAnswerTimer(answerSecs);
  const timersOk = bidTimerValid(bidTimer) && !answerCheck.error;

  async function start() {
    if (problem || !timersOk) return;
    const ok = await confirm({
      title: 'Start Round 3 with these teams?', confirmLabel: 'Start Round 3',
      message: <div className="stack"><p><b>{chosen.length}</b> {section} team(s) take part in “{set.title}”, each with a budget of {START_BUDGET} and a private score of 0:</p>
        <p className="small">{chosen.map((t, i) => `Seat ${i + 1}: T${t.team_number} ${t.team_name}`).join(' · ')}</p><p className="small muted">The list is fixed once the auction starts.</p></div>,
    });
    if (!ok) return;
    const proj = window.open('', 'brainfreze-projector-round3', 'popup=yes,width=1280,height=720');
    startReq.current ??= uuid();
    const settings = { bid_timer_seconds: bidTimer, answer_seconds: answerCheck.value };
    const res = await act('r3sStartSession', { request_id: startReq.current, code: set.join_code, section, team_ids: picked, settings }, {
      key: 'r3-start', success: 'Round 3 started', successDetail: `${set.title} · ${section} · ${chosen.length} team(s)`,
    });
    if (!res.ok) { proj?.close(); return; }
    const id = res.result.session_id;
    if (proj) proj.location.href = round3ProjectorUrl(id);
    else toast('warn', 'Projector window blocked', 'Use the Projector button on the auction screen.');
    navigate(`/host/rounds/3/session/${id}`);
  }

  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r3-join-title">
        <h2 id="r3-join-title">Join Round 3</h2>
        <form className="row gap wrap align-end" onSubmit={load} noValidate>
          <label className="field" htmlFor="r3-code">
            <span>Six-digit auction set code</span>
            <input id="r3-code" className="code-input" inputMode="numeric" maxLength={7} placeholder="000 000" value={code} autoComplete="off"
              onChange={(e) => { setError(''); const d = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d); }} />
          </label>
          <button className="btn btn-primary" disabled={busy || normalizeJoinCode(code).length !== 6}>{busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />} Load auction set</button>
        </form>
        {error && <p className="inline-alert alert-danger small" role="alert"><AlertTriangle size={16} /> {error}</p>}
        <p className="muted small">Codes are shown on <Link to="/host/rounds/3/sets">Auction Sets</Link> after publishing. Loading a set does not start anything.</p>
      </section>

      {set && (
        <section className="panel glass" aria-labelledby="r3-set-loaded">
          <h2 id="r3-set-loaded">{set.title} <span className="badge badge-ok">v{set.version}</span></h2>
          {set.description && <p className="small">{set.description}</p>}
          <p className="muted small">Code {formatJoinCode(set.join_code)} · {R3_SECTION_LABELS[set.section]} · {set.questions.length} question(s) ({set.questions.length - blind} normal, {blind} blind) · bidding timer {timerLabel(set.bid_seconds)} · {set.answer_seconds}-second answers</p>
          {set.live_session_id && <p className="warn-text small">An auction of this set is live. <Link to={`/host/rounds/3/session/${set.live_session_id}`}>Open it</Link></p>}
        </section>
      )}

      {set && (
        <section className="panel glass" aria-labelledby="r3-sec-title">
          <h2 id="r3-sec-title">Section and teams</h2>
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
              <p className="muted small">Choose any number of registered {section} teams for this auction — the organisers decide; nothing is carried over from earlier rounds. The order you tick them sets their seats.</p>
              <TeamPicker teams={teams} value={picked} onChange={pick} label={`Registered ${section} teams`}
                extra={(t) => (
                  <>
                    {t.round2 && <span className="badge badge-ice badge-xs">Round 2: {formatScore(t.round2.score)}</span>}
                    {t.in_live_auction && <span className="badge badge-amber badge-xs">in a live auction</span>}
                  </>
                )} />
            </>
          ))}
        </section>
      )}

      {set && section && teams && (
        <section className="panel glass r2-review" aria-labelledby="r3-review-title">
          <h2 id="r3-review-title">Review</h2>
          <dl className="kv small">
            <dt>Auction set</dt><dd>{set.title} (version {set.version}, code {formatJoinCode(set.join_code)})</dd>
            <dt>Section</dt><dd>{SECTION_LABELS[section]}</dd>
            <dt>Teams</dt><dd>{chosen.length ? <><b>{chosen.length}</b>: {chosen.map((t, i) => `Seat ${i + 1}: T${t.team_number} ${t.team_name}`).join(' · ')}</> : <span className="warn-text">Select at least one team.</span>}</dd>
            <dt>Start</dt><dd>Each team: budget {START_BUDGET} (public), score 0 (private)</dd>
            <dt>Timers</dt><dd>Bidding: {timerLabel(bidTimer)} (default for every question; you can change it per question) · Answer: {answerCheck.error ? '—' : `${answerCheck.value} s`}</dd>
          </dl>
          <BidTimerField idPrefix="r3-join-timer" value={bidTimer} onChange={(v) => { startReq.current = null; setBidTimer(v); }} legend="Default bidding timer for this auction" />
          <label className="field r3-secs-field">
            <span>Answer timer (seconds, 5–600)</span>
            <input type="number" min={5} max={600} value={answerSecs} onChange={(e) => { startReq.current = null; setAnswerSecs(e.target.value); }} aria-invalid={!!answerCheck.error} />
          </label>
          {answerCheck.error && <p className="danger-text small" role="alert">{answerCheck.error}</p>}
          {problem && <p className="warn-text small">{problem}</p>}
          <button className="btn btn-primary btn-lg" onClick={start} disabled={!!problem || !timersOk}><Gavel size={18} /> Review &amp; Start Round 3 <ArrowRight size={18} /></button>
        </section>
      )}
    </div>
  );
}
