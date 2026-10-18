import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Eye, EyeOff, Gavel, Lightbulb, Lock, RotateCcw, SkipForward, Timer, X, XCircle } from 'lucide-react';
import { Modal } from './Common.jsx';
import { BidTimerField } from './Round3Bits.jsx';
import { useServerNow } from '../lib/hooks.js';
import { uuid } from '../lib/ids.js';
import {
  BID_PANEL_LABELS, R3_OUTCOME_LABELS, bidPanel, bidTimerValid, describeDeltas, outcomeDeltas, parseAnswerTimer, remainingMs, tieOrderProblem, timerLabel,
} from '../lib/round3.js';

/**
 * Live-auction controls shared by the private host control panel and the organiser-controlled projector.
 * `ctx` = { data, sid, act, busy, confirm, reload }. `data` is either the private host board or the PUBLIC projector
 * board: every control here needs only public fields (phase, labels, bids, budgets, timers). Private values (scores)
 * are used only when the board carries them (host board); the projector never loads them for these controls.
 * Every action is an organizer-only server function that re-checks the phase; the client never sends a score.
 */

const teamName = (t) => (t ? `T${t.team_number} ${t.team_name}` : '');

/** The auction's commands for the open question. */
// eslint-disable-next-line react-refresh/only-export-components
export function r3Commands({ data, sid, act, confirm }) {
  const qid = data.current.question_id;
  const at = { session_id: sid, question_id: qid };
  return {
    select: (question_id) => act('r3sSelectQuestion', { session_id: sid, question_id }, { key: 'r3-select' }),
    startBidding: (timer) => act('r3sStartBidding', { ...at, timer: timer === 'default' ? null : { bid_timer_seconds: timer } }, { key: 'r3-bidstart', success: 'Bidding open' }),
    closeBidding: () => act('r3sCloseBidding', at, { key: 'r3-close', success: 'Bidding closed' }),
    revealTopic: () => act('r3sRevealTopic', at, { key: 'r3-topic', success: 'Topic revealed on the projector' }),
    revealQuestion: () => act('r3sRevealQuestion', at, { key: 'r3-revealq', success: 'Question revealed — answer timer running' }),
    revealAnswer: () => act('r3sRevealAnswer', at, { key: 'r3-answer', success: 'Answer shown on the projector' }),
    nextBidder: () => act('r3sNextBidder', at, { key: 'r3-next' }),
    finish: () => act('r3sFinishQuestion', at, { key: 'r3-finish', success: 'Question completed' }),
    revealResults: (reveal) => act('r3sRevealResults', { session_id: sid, reveal }, { key: 'r3-reveal', success: reveal ? 'Final results shown on the projector' : 'Results hidden from the projector' }),
    async cancel() {
      const ok = await confirm({ title: 'Cancel this question?', confirmLabel: 'Cancel question', danger: true, message: <p>Its bids are discarded and it goes back to the list unused. No budget or score changes.</p> });
      if (ok) act('r3sCancelQuestion', at, { key: 'r3-cancel', success: 'Question returned unused' });
    },
    async endAuction() {
      const ok = await confirm({
        title: 'End this auction?', confirmLabel: 'End Auction', danger: true, typeToConfirm: 'END',
        message: <p>No more questions can be played. Final rankings are calculated from the private scores. The projector shows them only when you press Reveal Final Results.</p>,
      });
      if (ok) act('r3sEndAuction', { session_id: sid }, { key: 'r3-end', success: 'Auction ended', successDetail: 'Reveal the final results when you are ready.' });
    },
  };
}

/**
 * One team's +10 / −10 / Pass controls while bidding is open. The buttons send ABSOLUTE amounts computed from the
 * server-confirmed bid (see bidPanel), so a double-click or a retry never adds 10 twice; the server validates every bid.
 * `compact` (projector team card) shows only the status and the buttons — the card already shows the budget and bid.
 */
export function BidControls({ ctx, team, compact = false }) {
  const { sid, act, busy, confirm, data } = ctx;
  const key = `r3-bid-${team.team_id}`;
  const panel = bidPanel(team, true);
  const locked = busy(key);
  const name = teamName(team);
  const save = (p) => act('r3sRecordBid', { session_id: sid, question_id: data.current.question_id, team_id: team.team_id, ...p }, { key });
  const undoPass = async () => {
    const ok = await confirm({ title: `Undo ${name}'s pass?`, confirmLabel: 'Undo pass',
      message: <p>Use this only to correct an accidental pass. The team goes back to <b>Ready</b> with a bid of 0; the correction is recorded in the auction log. No budget or score changes.</p> });
    if (ok) save({ amount: null });
  };
  const status = <span className={`r3-bidstatus r3-bidstatus-${panel.status}`}>{BID_PANEL_LABELS[panel.status]}</span>;
  const buttons = (
    <div className="r3-bidbuttons">
      <button type="button" className="btn btn-ghost" onClick={() => save({ amount: panel.minus })} disabled={panel.minus === undefined || locked} aria-label={`−10 for ${name}`}>−10</button>
      <button type="button" className="btn btn-primary" onClick={() => save({ amount: panel.plus })} disabled={panel.plus === undefined || locked} aria-label={`+10 for ${name}`}>+10</button>
      {panel.canPass
        ? <button type="button" className="btn btn-ghost" onClick={() => save({ pass: true })} disabled={locked} aria-label={`Pass for ${name}`}>Pass</button>
        : <button type="button" className="btn btn-ghost btn-sm" onClick={undoPass} disabled={!panel.canUndoPass || locked} aria-label={`Undo pass for ${name}`}>Undo pass</button>}
    </div>
  );
  if (compact) {
    return (
      <div className={`r3-bidform r3-bidpanel r3-bidpanel-compact r3-bidpanel-${panel.status}`} aria-label={`Bid for ${name}`} role="group">
        <div className="row gap align-center">{status}{panel.status === 'ineligible' && <span className="warn-text small">Below 10 — must pass</span>}</div>
        {buttons}
      </div>
    );
  }
  return (
    <section className={`r3-bidform r3-bidpanel r3-bidpanel-${panel.status} glass`} aria-label={`Bid for ${name}`}>
      <div className="row space-between align-center gap"><b>{name}</b>{status}</div>
      <small className="muted">Budget <b>{team.budget}</b></small>
      <p className="r3-bidvalue" aria-label={`Current bid for ${name}`}>{panel.status === 'passed' ? '—' : panel.current}</p>
      {panel.status === 'ineligible' && <p className="warn-text small">Budget below 10 — this team cannot bid and must pass.</p>}
      {buttons}
    </section>
  );
}

/** Bidding timer for the selected question (auction default, No timer, or any 1–3600 s) and Start Bidding. */
export function StartBidding({ ctx, cancelLabel = 'Cancel', idPrefix = 'r3-q-timer' }) {
  const { data, busy } = ctx;
  const cmd = r3Commands(ctx);
  const [timer, setTimer] = useState('default');
  const secs = timer === 'default' ? data.settings.bid_timer_default : timer;
  return (
    <>
      <BidTimerField idPrefix={idPrefix} value={timer} onChange={setTimer} legend="Bidding timer for this question" extraChoice={`Auction default (${timerLabel(data.settings.bid_timer_default)})`} />
      <div className="row gap wrap">
        <button className="btn btn-primary btn-lg" onClick={() => cmd.startBidding(timer)} disabled={!bidTimerValid(timer) || busy('r3-bidstart')}><Gavel size={18} /> Start Bidding ({timerLabel(secs)})</button>
        <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> {cancelLabel}</button>
      </div>
    </>
  );
}

/** Audited correction before the question is revealed: reopen bidding. */
export function ReopenBidding({ ctx, open = false }) {
  const { data, sid, act, busy } = ctx;
  const [reason, setReason] = useState('');
  return (
    <details className="r3-reopen" open={open || undefined}>
      <summary>Correct the bids (reopen bidding)</summary>
      <div className="row gap wrap align-end">
        <label className="field"><span>Reason (recorded in the log)</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Team 2's bid was recorded wrongly" /></label>
        <button className="btn btn-ghost" disabled={!reason.trim() || busy('r3-reopen')} onClick={() => act('r3sReopenBidding', { session_id: sid, question_id: data.current.question_id, reason }, { key: 'r3-reopen', success: 'Bidding reopened' })}><RotateCcw size={16} /> Reopen bidding</button>
      </div>
    </details>
  );
}

/** Equal bids: the organiser sets the order (only equal bids may swap) and records how the tie was decided. */
export function TieResolver({ ctx }) {
  const { data, sid, act, busy } = ctx;
  const [order, setOrder] = useState(() => data.current.bid_order);
  const [reason, setReason] = useState('');
  const amountOf = (id) => data.teams.find((t) => t.team_id === id)?.bid ?? -1;
  const nameOf = (id) => teamName(data.teams.find((x) => x.team_id === id)) || id;
  const problem = tieOrderProblem(order, data.current.bid_order, amountOf);
  const swap = (i, j) => setOrder((o) => { const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <>
      <div className="inline-alert alert-warn small" role="status">Two or more teams bid the same amount. Settle it (e.g. a coin toss or a quick re-bid), set the order below — only equal bids can swap — and record how it was decided. The first team is the highest bidder.</div>
      <ol className="r3-order">
        {order.map((id, i) => (
          <li key={id}>
            <span><b>#{i + 1}</b> {nameOf(id)} — bid {amountOf(id)}</span>
            <span className="row gap">
              <button className="icon-btn" disabled={i === 0 || amountOf(order[i - 1]) !== amountOf(id)} onClick={() => swap(i, i - 1)} aria-label={`Move ${nameOf(id)} up`}><ArrowUp size={15} /></button>
              <button className="icon-btn" disabled={i === order.length - 1 || amountOf(order[i + 1]) !== amountOf(id)} onClick={() => swap(i, i + 1)} aria-label={`Move ${nameOf(id)} down`}><ArrowDown size={15} /></button>
            </span>
          </li>
        ))}
      </ol>
      <div className="row gap wrap align-end">
        <label className="field"><span>How was the tie resolved?</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Coin toss won by Team 2" /></label>
        <button className="btn btn-primary" disabled={!!problem || !reason.trim() || busy('r3-tie')} onClick={() => act('r3sResolveTie', { session_id: sid, question_id: data.current.question_id, order, reason }, { key: 'r3-tie', success: 'Tie resolved' })}>Confirm order</button>
      </div>
      {problem && <p className="danger-text small">{problem}</p>}
      <ReopenBidding ctx={ctx} />
    </>
  );
}

/**
 * Correct / Wrong / Pass / Time out → Confirm Outcome (with the budget and score changes previewed) and Reveal Answer.
 * The database applies an outcome once per request id, so a double click or a retry never scores twice.
 * On the projector board there are no scores: the dialog shows the budget figures and keeps the private score
 * change behind a "Show" toggle, and the success message never names points.
 */
export function OutcomeControls({ ctx }) {
  const { data, sid, act, busy } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  const now = useServerNow(data.serverOffsetMs, 500);
  const expired = (remainingMs(c.answer_started_at, data.settings.answer_seconds, now) ?? 1) <= 0;
  const team = data.teams.find((t) => t.team_id === c.current_team_id);
  const hasScores = team?.score !== undefined;
  const wasTop = c.order_pos === 1;
  const [pick, setPick] = useState(null);
  const [peek, setPeek] = useState(false);
  const req = useRef(null);
  const choose = (o) => { req.current = uuid(); setPeek(false); setPick(o); };
  const close = () => { req.current = null; setPick(null); };
  const deltas = pick ? outcomeDeltas(wasTop, pick, team?.bid) : null;
  const more = c.order_pos < c.bid_order.length;
  async function confirmOutcome() {
    const res = await act('r3sRecordOutcome', { request_id: req.current, session_id: sid, question_id: c.question_id, team_id: team.team_id, outcome: pick }, {
      key: 'r3-outcome', success: 'Outcome confirmed',
      successDetail: (r) => `T${team.team_number}: ${hasScores ? describeDeltas(r) : `budget ${r.budget_delta ? r.budget_delta : 'unchanged'}`}${r.duplicate_request ? ' (already recorded — not applied twice)' : ''}`,
    });
    if (res.ok) close();
  }
  const hidden = (v) => (peek ? v : <span className="muted">hidden</span>);
  return (
    <>
      <div className="r3-outcomes">
        <button className="btn btn-lg r2-right" onClick={() => choose('correct')} disabled={!team}><CheckCircle2 size={20} /> Correct</button>
        <button className="btn btn-lg r2-wrong" onClick={() => choose('wrong')} disabled={!team}><XCircle size={20} /> Wrong</button>
        <button className="btn btn-lg btn-ghost" onClick={() => choose('pass')} disabled={!team}><SkipForward size={20} /> Pass</button>
        <button className="btn btn-lg btn-ghost" onClick={() => choose('timeout')} disabled={!team || !expired} title={expired ? undefined : 'Available when the answer timer runs out'}><Timer size={20} /> Time out</button>
        <button className="btn btn-lg btn-ghost" onClick={cmd.revealAnswer} disabled={c.answer_revealed || busy('r3-answer')}><Lightbulb size={20} /> {c.answer_revealed ? 'Answer revealed' : 'Reveal Answer'}</button>
      </div>
      {expired && <p className="muted small">Time is up. Nothing happens automatically: record Wrong (highest bidder loses ½ bid), Time out (no change) or Pass.</p>}
      {pick && team && (
        <Modal title="Confirm Outcome" onClose={close} labelledBy="r3-outcome-title">
          <dl className="kv small r3-preview-deltas">
            <dt>Team</dt><dd>{teamName(team)} ({wasTop ? 'highest bidder' : `lower-ranked bidder #${c.order_pos}`})</dd>
            <dt>Bid</dt><dd>{team.bid}</dd>
            <dt>Outcome</dt><dd><b>{R3_OUTCOME_LABELS[pick]}</b></dd>
            <dt>Current budget</dt><dd>{team.budget}</dd>
            {hasScores && <><dt><Lock size={11} /> Current private score</dt><dd>{team.score}</dd></>}
            <dt>Budget change</dt><dd>{deltas.budget_delta ? deltas.budget_delta : '0 (unchanged)'}</dd>
            <dt><Lock size={11} /> {hasScores ? 'Score change' : 'Private score change'}</dt><dd>{hasScores ? (deltas.score_delta ? `+${deltas.score_delta}` : '0 (unchanged)') : hidden(deltas.score_delta ? `+${deltas.score_delta}` : '0 (unchanged)')}</dd>
            <dt>Resulting budget</dt><dd><b>{team.budget + deltas.budget_delta}</b></dd>
            {hasScores && <><dt><Lock size={11} /> Resulting private score</dt><dd><b>{team.score + deltas.score_delta}</b></dd></>}
            <dt>Next</dt><dd>{pick === 'correct' ? 'The question is completed.' : more ? 'The question moves to the next bidder.' : 'No bidders remain — the question is completed with no further points.'}</dd>
          </dl>
          {!hasScores && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPeek((x) => !x)} aria-pressed={peek}>
              {peek ? <><EyeOff size={14} /> Hide private change</> : <><Eye size={14} /> Show private change</>}
            </button>
          )}
          <p className="muted small">The database applies the change once, even if this is clicked twice or retried.</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={close} disabled={busy('r3-outcome')}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={confirmOutcome} disabled={busy('r3-outcome')}>Confirm Outcome</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Change the auction's timer defaults (audited). The answer timer cannot change while a team is answering. */
export function TimerSettings({ ctx, onClose }) {
  const { data, act, busy } = ctx;
  const [bid, setBid] = useState(data.settings.bid_timer_default);
  const [ans, setAns] = useState(String(data.settings.answer_seconds));
  const ansCheck = parseAnswerTimer(ans, data.settings.answer_seconds);
  const answering = ['answering', 'between'].includes(data.current.phase);
  async function save(e) {
    e.preventDefault();
    if (!bidTimerValid(bid) || ansCheck.error) return;
    const res = await act('r3sUpdateSessionSettings', { session_id: data.session.id, settings: { bid_timer_seconds: bid, answer_seconds: ansCheck.value } }, { key: 'r3-settings', success: 'Timer defaults saved' });
    if (res.ok) onClose();
  }
  return (
    <Modal title="Auction timers" onClose={onClose} labelledBy="r3-timers-title">
      <form className="stack" onSubmit={save} noValidate>
        <BidTimerField idPrefix="r3-default-timer" value={bid} onChange={setBid} legend="Default bidding timer (next questions)" />
        <label className="field">
          <span>Answer timer (seconds, 5–600)</span>
          <input type="number" min={5} max={600} value={ans} onChange={(e) => setAns(e.target.value)} disabled={answering} aria-invalid={!!ansCheck.error} />
        </label>
        {answering && <p className="muted small">The answer timer can be changed when no team is answering.</p>}
        {ansCheck.error && <p className="danger-text small" role="alert">{ansCheck.error}</p>}
        <p className="muted small">A running bidding timer is never changed or extended.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!bidTimerValid(bid) || !!ansCheck.error || busy('r3-settings')}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
