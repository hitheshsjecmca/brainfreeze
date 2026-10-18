import { useEffect } from 'react';
import { Flag, RotateCcw, Smartphone, Unplug } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { ago, useParticipantStatus } from '../lib/participantStatus.js';
import { ATTEMPT_STATUS_LABELS } from '../lib/constants.js';
import { formatClock } from '../lib/timer.js';
import { formatTime } from '../lib/sets.js';

const ATTEMPT_CLASS = { in_progress: 'badge-ice', submitted: 'badge-ok', timed_out: 'badge-amber', organizer_finalized: 'badge-purple', ready: 'badge-muted', none: '' };

/** Team devices and attempts for the selected set: presence, attempt status, team timer, progress. */
export default function ParticipantMonitor({ compact = false }) {
  const { snap, act, refreshParticipants, refresh } = useQuiz();
  const { confirm } = useUI();
  const status = useParticipantStatus();
  const live = !!snap.session.published_at;
  const running = ['running', 'paused'].includes(snap.session.status);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(refreshParticipants, 5000);
    return () => clearInterval(id);
  }, [live, refreshParticipants]);

  // Attempt timers expire on the server; reload results when a visible team timer reaches zero.
  const nextExpiry = status.rows.filter((r) => r.remainingMs !== null).reduce((m, r) => Math.min(m, r.remainingMs), Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry) || snap.session.status !== 'running') return undefined;
    const id = setTimeout(refresh, Math.max(500, nextExpiry + 800));
    return () => clearTimeout(id);
  }, [nextExpiry, snap.session.status, refresh]);

  async function release(t) {
    const ok = await confirm({
      title: `Release Team ${t.team_number}?`, confirmLabel: 'Release device', danger: true,
      message: <p>The team's current device is signed out immediately. The team can then join again on any device with the join code by choosing its name, and resumes the same attempt; its timer keeps running and saved answers are kept. A team stays bound to one device until you release it.</p>,
    });
    if (ok) act('revokeParticipant', { team_id: t.id }, { key: `revoke:${t.id}`, success: `Team ${t.team_number} released — it can join again on another device` });
  }
  async function finalize(t) {
    const ok = await confirm({
      title: `Finalize Team ${t.team_number}'s attempt now?`, confirmLabel: 'Finalize attempt', danger: true, requireReason: true,
      message: <p>The team can no longer answer. Its status becomes “organizer-finalized” and it is ranked at the full time limit. Recorded answers count.</p>,
    });
    if (ok) act('finalizeAttempt', { team_id: t.id, reason: ok.reason }, { key: `fin:${t.id}`, success: `Team ${t.team_number}'s attempt finalized` });
  }
  async function reset(t) {
    const ok = await confirm({
      title: `Reset Team ${t.team_number}'s attempt?`, confirmLabel: 'Reset attempt', danger: true, requireReason: true, typeToConfirm: 'RESET',
      message: <p>Organizer-authorized retake: the team's answers in this set are removed (the reset, its reason and the removed points are kept in the audit log). On its next check-in the team gets a fresh attempt with a new order and must press Start again. Use only for genuine technical failures.</p>,
    });
    if (ok) act('resetAttempt', { team_id: t.id, reason: ok.reason }, { key: `reset:${t.id}`, success: `Team ${t.team_number}'s attempt reset` });
  }

  const label = {
    connected: <span className="dev dev-on">● Connected</span>,
    stale: null,
    'signed-out': <span className="dev dev-off">Signed out</span>,
    'not-joined': <span className="dev dev-none">Not joined</span>,
  };

  return (
    <section className="panel glass" aria-labelledby="pm-title">
      <div className="panel-head">
        <h2 id="pm-title"><Smartphone size={18} /> Team devices & attempts</h2>
        <div className="row gap wrap">
          <span className="badge badge-muted">{status.joined}/{snap.teams.length} signed in</span>
          <span className="badge badge-ok">{status.connected} connected</span>
          {snap.session.status !== 'setup' && <span className="badge badge-ice">{status.started} answering · {status.finished} finished</span>}
        </div>
      </div>
      {!live && <p className="muted small">Publish the set to let team devices join. Presence is based on each device checking in every few seconds; a device that is quiet for a while is shown as “last seen”, never as withdrawn.</p>}
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Device</th>
              <th scope="col">Attempt</th>
              <th scope="col">Team timer</th>
              <th scope="col">Progress</th>
              {!compact && <th scope="col"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {status.rows.map((r) => (
              <tr key={r.team.id} className={r.otherSet ? 'row-dim' : ''}>
                <td><b>T{r.team.team_number}</b> {r.team.team_name} {r.team.self_registered && <span className="badge badge-purple badge-xs">self-registered</span>}</td>
                <td>
                  {r.otherSet ? <span className="muted small">In another set</span> : r.device === 'stale' ? <span className="dev dev-stale">Last seen {ago(r.seenMs)}</span> : label[r.device]}
                  {r.device === 'signed-out' && r.lastRevoked?.revoked_reason && <small className="muted"> · {r.lastRevoked.revoked_reason}</small>}
                </td>
                <td>{r.attemptStatus !== 'none' ? <span className={`badge badge-xs ${ATTEMPT_CLASS[r.attemptStatus] || ''}`}>{ATTEMPT_STATUS_LABELS[r.attemptStatus]}</span> : <span className="muted">—</span>}</td>
                <td className="num">
                  {r.remainingMs !== null ? <span className={r.remainingMs < 5 * 60000 ? 'warn-text' : ''}>{formatClock(r.remainingMs)} left{snap.session.status === 'paused' ? ' (paused)' : ''}</span>
                    : r.attempt?.finished_at || r.attemptStatus === 'timed_out' ? <small className="muted">ended {formatTime(r.attempt.finished_at || r.attempt.deadline_at)}</small>
                    : <span className="muted">—</span>}
                </td>
                <td><span className={r.answered >= status.total && status.total ? 'ok-text' : ''}>{r.answered}/{status.total}</span></td>
                {!compact && (
                  <td className="actions">
                    {r.active && <button className="icon-btn" onClick={() => release(r.team)} aria-label={`Release Team ${r.team.team_number} device`} title="Release device (team can join on another device)"><Unplug size={15} /></button>}
                    {running && r.attemptStatus === 'in_progress' && <button className="icon-btn" onClick={() => finalize(r.team)} aria-label={`Finalize Team ${r.team.team_number} attempt`} title="Finalize attempt now"><Flag size={15} /></button>}
                    {r.attempt && snap.session.status !== 'finalized' && <button className="icon-btn" onClick={() => reset(r.team)} aria-label={`Reset Team ${r.team.team_number} attempt`} title="Reset attempt (retake)"><RotateCcw size={15} /></button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
