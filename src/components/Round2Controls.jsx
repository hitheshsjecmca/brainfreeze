import { useEffect, useReducer, useRef } from 'react';
import { CheckCircle2, Lightbulb, Rocket, X, XCircle } from 'lucide-react';
import { useRound2 } from '../context/Round2Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { Modal } from './Common.jsx';
import { uuid } from '../lib/ids.js';
import { R2_RESULT_LABELS, R2_UI_IDLE, canConfirm, formatScore, r2UiReducer, scoreDelta } from '../lib/round2.js';

/**
 * Gameplay actions of one live Round 2 session, shared by the private host screen and the
 * interactive projector. Every action is an organizer-only server function that re-validates the
 * session state; the client never sends a score. `privateFeedback` adds the team and points to the
 * success toast — the host screen only, never the projector.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useR2Gameplay(data, { privateFeedback = false } = {}) {
  const { act, pendingKeys } = useRound2();
  const { confirm } = useUI();
  const [ui, dispatch] = useReducer(r2UiReducer, R2_UI_IDLE);
  const scoreReq = useRef(null); // one request id per confirmation → retries can never score twice
  const closeReq = useRef(null);
  const game = data?.game;
  const sid = data?.session.id;
  const qid = game?.question_id;
  const activeKey = `${game?.phase}:${qid}`;

  // If the question stops being open (scored on the other screen, cancelled…), close the local team popup.
  useEffect(() => {
    if (game?.phase !== 'revealed') { dispatch({ type: 'cancel' }); scoreReq.current = null; }
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = (k) => pendingKeys.has(k);
  const pick = (question_id) => act('r2sSelect', { session_id: sid, question_id }, { key: 'r2-select' });
  const cancelSelection = () => act('r2sCancel', { session_id: sid }, { key: 'r2-cancel' });
  const reveal = () => act('r2sRevealQuestion', { session_id: sid, question_id: qid }, { key: 'r2-reveal' });
  const revealAnswer = () => act('r2sRevealAnswer', { session_id: sid, question_id: qid }, {
    key: 'r2-answer', success: 'Answer shown on the projector', successDetail: 'No score was changed.',
  });
  const mark = (result) => { scoreReq.current = uuid(); dispatch({ type: 'mark', result }); };
  const pickTeam = (teamId) => dispatch({ type: 'pick', teamId });
  const cancelTeam = () => { scoreReq.current = null; dispatch({ type: 'cancel' }); };

  async function confirmScore() {
    if (!canConfirm(ui)) return;
    const team = data.teams.find((t) => t.team_id === ui.teamId);
    const res = await act('r2sScore', { request_id: scoreReq.current, session_id: sid, question_id: qid, team_id: ui.teamId, result: ui.result }, {
      key: 'r2-score',
      success: 'Score saved',
      successDetail: privateFeedback
        ? (r) => `${team ? `Team ${team.team_number} ${team.team_name}` : 'Team'}: ${formatScore(r.points, { sign: true })} points${r.duplicate_request ? ' (already recorded — not counted twice)' : ''}`
        : 'The question is marked as played.',
    });
    // On a network error the popup stays open with the same request id, so trying again is safe.
    if (res.ok) { scoreReq.current = null; dispatch({ type: 'done' }); }
  }

  async function closeWithoutPoints() {
    const ok = await confirm({
      title: 'Close this question without points?', confirmLabel: 'Close without points', danger: true,
      message: <p>The question is marked as played and no team's score changes. Use this when nobody answered.</p>,
    });
    if (!ok) return;
    closeReq.current ??= uuid();
    const res = await act('r2sCloseQuestion', { request_id: closeReq.current, session_id: sid, question_id: qid }, { key: 'r2-close', success: 'Question closed — no points' });
    if (res.ok || res.error?.code !== 'NETWORK') closeReq.current = null;
  }

  return { ui, busy, pick, cancelSelection, reveal, revealAnswer, mark, pickTeam, cancelTeam, confirmScore, closeWithoutPoints };
}

/** Reveal Question / Cancel for a selected tile. The question itself is still hidden everywhere. */
export function R2SelectedActions({ play, className = 'modal-actions' }) {
  return (
    <div className={className}>
      <button type="button" className="btn btn-ghost btn-lg" onClick={play.cancelSelection} disabled={play.busy('r2-cancel')}>Cancel</button>
      <button type="button" className="btn btn-primary btn-lg" onClick={play.reveal} disabled={play.busy('r2-reveal')}><Rocket size={18} /> Reveal Question</button>
    </div>
  );
}

/** Right / Wrong (→ team popup) and Answer (shows the stored answer; never scores). */
export function R2QuestionActions({ game, play, closeButton = false }) {
  return (
    <div className="r2-actions">
      <button type="button" className="btn btn-lg r2-right" onClick={() => play.mark('right')}><CheckCircle2 size={20} /> Right</button>
      <button type="button" className="btn btn-lg r2-wrong" onClick={() => play.mark('wrong')}><XCircle size={20} /> Wrong</button>
      <button type="button" className="btn btn-lg btn-ghost" onClick={play.revealAnswer} disabled={game.answer_revealed || play.busy('r2-answer')}>
        <Lightbulb size={20} /> {game.answer_revealed ? 'Answer revealed' : 'Answer'}
      </button>
      {closeButton && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={play.closeWithoutPoints} disabled={play.busy('r2-close')}><X size={14} /> Close without points</button>
      )}
    </div>
  );
}

/**
 * "Which team answered?" popup. Lists the session's teams; `scores` (host screen only) adds each
 * team's current total. Nothing changes until Confirm Score.
 */
export function R2TeamModal({ data, play, scores = null }) {
  const { game, settings, teams } = data;
  const { ui } = play;
  if (ui.modal !== 'team' || game.phase !== 'revealed') return null;
  const totals = scores ? new Map(scores.map((s) => [s.team_id, s.score])) : null;
  return (
    <Modal title="Which team answered this question?" onClose={play.cancelTeam} labelledBy="r2-team-title">
      <p className="r2-confirm-sum">
        {game.topic} · {formatScore(game.points)} points · Result: <b className={ui.result === 'right' ? 'ok-text' : 'danger-text'}>{R2_RESULT_LABELS[ui.result]}</b>
        {totals && <> → <b>{formatScore(scoreDelta(game.points, ui.result, settings.wrong_penalty_percent), { sign: true })}</b> for the selected team</>}
      </p>
      <fieldset className="r2-team-pick">
        <legend className="sr-only">Team</legend>
        {teams.map((t) => (
          <label key={t.team_id} className={`r2-team-opt ${ui.teamId === t.team_id ? 'checked' : ''}`}>
            <input type="radio" name="r2-team" checked={ui.teamId === t.team_id} onChange={() => play.pickTeam(t.team_id)} />
            <span>{t.section} T{t.team_number}</span>
            <b>{t.team_name}</b>
            {totals && <small className="muted">{formatScore(totals.get(t.team_id) ?? 0)} pts</small>}
          </label>
        ))}
      </fieldset>
      <p className="muted small">No score changes until you press Confirm Score. Cancel leaves every score unchanged.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={play.cancelTeam} disabled={play.busy('r2-score')}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={play.confirmScore} disabled={!canConfirm(ui) || play.busy('r2-score')}>Confirm Score</button>
      </div>
    </Modal>
  );
}
