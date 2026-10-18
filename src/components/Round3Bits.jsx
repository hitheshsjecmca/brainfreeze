import { useEffect, useRef } from 'react';
import { Lock } from 'lucide-react';
import { useServerNow } from '../lib/hooks.js';
import { R3_LIMITS, remainingMs } from '../lib/round3.js';

/**
 * Countdown from a SERVER timestamp (bidding or answer timer): a refresh shows the same remaining time.
 * It never decides anything itself. `onExpire` (once, at zero) only asks the server for fresh state — for a timed
 * bidding the server has then closed bidding at its deadline.
 */
export function R3Timer({ startedAt, seconds, offsetMs = 0, size = 'lg', label = 'SECONDS', expiredHint = 'HOST DECIDES', onExpire }) {
  const now = useServerNow(offsetMs, 200);
  const rem = remainingMs(startedAt, seconds, now);
  const fired = useRef(null);
  useEffect(() => {
    if (rem !== null && rem <= 0 && fired.current !== startedAt) { fired.current = startedAt; onExpire?.(); }
  }, [rem, startedAt, onExpire]);
  if (rem === null) return null;
  const secs = Math.max(0, Math.ceil(rem / 1000));
  const expired = rem <= 0;
  const pct = Math.max(0, Math.min(1, rem / (seconds * 1000)));
  return (
    <div className={`timer timer-${size} r3-timer ${expired ? 'timer-expired' : secs <= 5 ? 'timer-urgent' : ''}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="52" className="timer-track" />
        <circle cx="60" cy="60" r="52" className="timer-arc" strokeDasharray={`${(pct * 326.7).toFixed(1)} 326.7`} transform="rotate(-90 60 60)" />
      </svg>
      <div className="timer-text" role="timer" aria-live="off" aria-label={expired ? 'Time is up' : `${secs} seconds left`}>
        <strong>{expired ? "TIME'S UP" : secs}</strong>
        <small>{expired ? expiredHint : label}</small>
      </div>
    </div>
  );
}

/**
 * Bidding-timer choice: No timer, or Timed with any whole number of seconds (1–3600). `value` is null (no timer)
 * or a number; `draft` keeps what is typed. Reports the parsed value through onChange(value, error).
 */
export function BidTimerField({ idPrefix, value, onChange, legend = 'Bidding timer', extraChoice = null }) {
  const timed = value !== null && value !== undefined && value !== 'default';
  const isDefault = value === 'default';
  const name = `${idPrefix}-mode`;
  return (
    <fieldset className="wz-fieldset r3-timer-field">
      <legend>{legend}</legend>
      <div className="row gap wrap align-center">
        {extraChoice && (
          <label className="check"><input type="radio" name={name} checked={isDefault} onChange={() => onChange('default')} /> {extraChoice}</label>
        )}
        <label className="check"><input type="radio" name={name} checked={!timed && !isDefault} onChange={() => onChange(null)} /> No timer <small className="muted">(close manually)</small></label>
        <label className="check"><input type="radio" name={name} checked={timed} onChange={() => onChange(typeof value === 'number' ? value : 30)} /> Timed</label>
        {timed && (
          <label className="field r3-secs">
            <span className="sr-only">Bidding seconds</span>
            <input type="number" min={R3_LIMITS.minBidTimer} max={R3_LIMITS.maxBidTimer} step={1} value={Number.isFinite(value) ? value : ''} aria-label="Bidding seconds"
              onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
            <span className="muted small">seconds (1–3600)</span>
          </label>
        )}
      </div>
      {timed && (!Number.isInteger(value) || value < R3_LIMITS.minBidTimer || value > R3_LIMITS.maxBidTimer) && <p className="danger-text small" role="alert">Enter 1–3600 whole seconds.</p>}
    </fieldset>
  );
}

const BID_TEXT = { none: 'Ready · bid 0', bid: null, pass: 'Passed', no_bid: 'No bid' };
const bidText = (t) => (t.bid_status === 'none' && t.budget < 10 ? 'Ineligible · must pass' : BID_TEXT[t.bid_status]);

/**
 * The three teams: public budget and the open question's bid. `showScores` (private host screen only)
 * adds each team's private score; the projector never passes it and its data has no scores at all.
 * On the organiser-controlled projector, `onTeamClick` makes each card's header a button (expand / collapse that
 * team's bidding controls) and `renderControls(team)` renders the controls inside the card.
 */
export function R3TeamCards({ teams, currentTeamId = null, order = [], showScores = false, showBids = true, size = 'md', onTeamClick = null, expanded = null, renderControls = null }) {
  return (
    <ul className={`r3-teams r3-teams-${size}`} aria-label="Teams">
      {teams.map((t) => {
        const pos = order.indexOf(t.team_id);
        const head = (
          <>
            <span className="r3-team-no">{t.section} T{t.team_number}{pos >= 0 && <b className="r3-team-rank" title="Bidding order"> #{pos + 1}</b>}</span>
            <strong className="r3-team-name">{t.team_name}</strong>
          </>
        );
        const controls = renderControls?.(t);
        return (
          <li key={t.team_id} className={`r3-team glass ${currentTeamId === t.team_id ? 'r3-team-current' : ''} ${controls ? 'r3-team-open' : ''}`}>
            {onTeamClick
              ? <button type="button" className="r3-team-head r3-team-toggle" onClick={() => onTeamClick(t.team_id)} aria-expanded={!!expanded?.(t.team_id)} aria-label={`T${t.team_number} ${t.team_name} — bidding controls`}>{head}</button>
              : <span className="r3-team-head">{head}</span>}
            <span className="r3-budget"><small>BUDGET</small> {t.budget}</span>
            {showBids && <span className={`r3-bid r3-bid-${t.bid_status}`}>{t.bid_status === 'bid' ? <>BID <b>{t.bid}</b></> : bidText(t)}</span>}
            {showScores && <span className="r3-score" title="Private — never shown on the projector"><Lock size={12} /> Score <b>{t.score}</b></span>}
            {controls && <div className="r3-team-controls">{controls}</div>}
          </li>
        );
      })}
    </ul>
  );
}
