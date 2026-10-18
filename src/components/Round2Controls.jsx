import { useEffect, useReducer, useRef } from 'react';
import { CheckCircle2, Lightbulb, Rocket, X, XCircle } from 'lucide-react';
import { useRound2 } from '../context/Round2Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { Modal } from './Common.jsx';
import { uuid } from '../lib/ids.js';
import { R2_RESULT_LABELS, R2_UI_IDLE, canConfirm, canReview, formatScore, r2UiReducer, scoreDelta } from '../lib/round2.js';

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
  const review = () => dispatch({ type: 'review' });
  const back = () => dispatch({ type: 'back' });
  const cancelTeam = () => { scoreReq.current = null; dispatch({ type: 'cancel' }); };

  async function confirmScore() {
    if (!canConfirm(ui) || !sid || !qid) return;
    const team = data.teams?.find((t) => t.team_id === ui.teamId);
    // The server takes the points from the saved question and validates session, question and team; the
    // browser sends only the outcome. The same request id on a retry can never score twice.
    const res = await act('r2sScore', { request_id: scoreReq.current, session_id: sid, question_id: qid, team_id: ui.teamId, result: ui.result }, {
      key: 'r2-score',
      success: 'Score saved',
      successDetail: privateFeedback
        ? (r) => `${team ? `Team ${team.team_number} ${team.team_name}` : 'Team'}: ${formatScore(r.points, { sign: true })} points${r.duplicate_request ? ' (already recorded — not counted twice)' : ''}`
        : 'The question is marked as played.',
    });
    // On success: close every scoring dialog (the board reloads through the context). On failure the summary
    // stays open with the error and the same request id, so Confirm Score can be retried safely.
    if (res.ok) { scoreReq.current = null; dispatch({ type: 'done' }); }
    else if (!res.skipped) dispatch({ type: 'failed', error: res.error?.message });
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

  return { ui, busy, pick, cancelSelection, reveal, revealAnswer, mark, pickTeam, review, back, cancelTeam, confirmScore, closeWithoutPoints };
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
 * Scoring popup, two steps: "Which Team Answered?" (the session's teams; Confirm only once exactly one team is
 * chosen) → a summary (question, team, result, the question's saved points and the score change) → Confirm Score.
 * Cancel on either step changes nothing. `scores` (host screen only) adds each team's current total.
 */
export function R2TeamModal({ data, play, scores = null }) {
  const { game, teams } = data;
  const { ui } = play;
  if (!['team', 'confirm'].includes(ui.modal) || game.phase !== 'revealed') return null;
  const totals = scores ? new Map(scores.map((s) => [s.team_id, s.score])) : null;
  const saving = play.busy('r2-score');
  // A board without the session's team list (a database older than migration 11) cannot be scored: say so here
  // instead of failing to render the page.
  if (!Array.isArray(teams)) {
    return (
      <Modal title="Which Team Answered?" onClose={play.cancelTeam} labelledBy="r2-team-title">
        <div className="inline-alert alert-danger" role="alert">
          The teams of this game could not be loaded, so no score can be recorded. The database is missing a Round 2 update
          (apply the latest Round 2 migration), then reload this page. Nothing was changed.
        </div>
        <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={play.cancelTeam}>Close</button></div>
      </Modal>
    );
  }
  const team = teams.find((t) => t.team_id === ui.teamId);
  const delta = scoreDelta(game.points, ui.result);
  const resultBadge = <b className={ui.result === 'right' ? 'ok-text' : 'danger-text'}>{R2_RESULT_LABELS[ui.result]}</b>;

  if (ui.modal === 'confirm' && team) {
    return (
      <Modal title="Confirm score" onClose={saving ? () => {} : play.cancelTeam} labelledBy="r2-team-title">
        <dl className="kv r2-confirm-sum">
          <dt>Question</dt><dd>{game.question_text || `${game.topic} · ${formatScore(game.points)} points`}</dd>
          <dt>Team</dt><dd>{team.section} T{team.team_number} · <b>{team.team_name}</b></dd>
          <dt>Result</dt><dd>{resultBadge}</dd>
          <dt>Question points</dt><dd>{formatScore(game.points)}</dd>
          <dt>Score change</dt><dd><b>{formatScore(delta, { sign: true })} points</b>{totals && <span className="muted"> (now {formatScore(totals.get(team.team_id) ?? 0)})</span>}</dd>
        </dl>
        {ui.error && <div className="inline-alert alert-danger" role="alert">The score was not saved: {ui.error} Nothing was changed — press Confirm Score to try again.</div>}
        <p className="muted small">No score changes until you press Confirm Score. Cancel leaves every score unchanged and the question open.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={play.cancelTeam} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-ghost" onClick={play.back} disabled={saving}>Back</button>
          <button type="button" className="btn btn-primary" onClick={play.confirmScore} disabled={!canConfirm(ui) || saving}>{saving ? 'Saving…' : 'Confirm Score'}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Which Team Answered?" onClose={play.cancelTeam} labelledBy="r2-team-title">
      <p className="r2-confirm-sum">
        {game.topic} · {formatScore(game.points)} points · Result: {resultBadge}
      </p>
      {teams.length === 0 ? <p className="warn-text" role="alert">This game has no teams to score.</p> : (
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
      )}
      <p className="muted small">Choose exactly one team. No score changes until you confirm on the next step.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={play.cancelTeam}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={play.review} disabled={!canReview(ui)}>Confirm</button>
      </div>
    </Modal>
  );
}
