import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, Lock, MonitorPlay, Square, X } from 'lucide-react';
import { backend } from '../backend/index.js';
import { useR2Data, useRound2 } from '../context/Round2Context.jsx';
import { R2QuestionActions, R2SelectedActions, R2TeamModal, useR2Gameplay } from '../components/Round2Controls.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, ErrorState, Loading, Modal } from '../components/Common.jsx';
import { R2Countdown, R2Scores, TriviaBoard } from '../components/Round2Bits.jsx';
import { formatJoinCode } from '../lib/joinCodes.js';
import { openRound2Projector } from '../lib/projectorWindow.js';
import { formatStamp } from '../lib/sets.js';
import { R2_RESULT_LABELS, formatScore, scoreDelta } from '../lib/round2.js';

/** Round 2 Dashboard: live and finished games. */
export function Round2Dashboard() {
  const { data, error, reload } = useR2Data(() => backend.round2.overview(), 'overview');
  if (error && !data) return <ErrorState title="Round 2 could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading Round 2…" />;
  const live = data.sessions.filter((g) => g.status === 'live');
  const ended = data.sessions.filter((g) => g.status !== 'live');
  const published = data.sets.filter((s) => s.published_version > 0 && !s.archived_at).length;
  const row = (g) => (
    <tr key={g.id}>
      <td><b>{g.title}</b> <span className="badge badge-muted badge-xs">v{g.version}</span></td>
      <td>{g.section}</td>
      <td className="num">{g.team_count}</td>
      <td className="num">{g.played}/{g.question_count}</td>
      <td className="small">{formatStamp(g.started_at)}</td>
      <td className="actions">
        <Link className="btn btn-primary btn-sm" to={`/host/rounds/2/session/${g.id}`}>{g.status === 'live' ? 'Open game' : 'View'}</Link>
        {g.status === 'live' && <button className="btn btn-ghost btn-sm" onClick={() => openRound2Projector(g.id)}><MonitorPlay size={14} /> Projector</button>}
      </td>
    </tr>
  );
  const table = (rows) => (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th scope="col">Trivia set</th><th scope="col">Section</th><th scope="col">Teams</th><th scope="col">Played</th><th scope="col">Started</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );
  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r2-live-title">
        <div className="panel-head">
          <h2 id="r2-live-title">Live games</h2>
          <Link className="btn btn-primary" to="/host/rounds/2/join">Join Round 2</Link>
        </div>
        {live.length ? table(live) : (
          <EmptyState title="No live Round 2 game">
            <p className="muted">{published ? 'Enter a published trivia set’s code on Join Round 2, choose the section and teams, then press Start Round 2.' : <>First create and publish a trivia set on <Link to="/host/rounds/2/sets">Trivia Sets</Link>.</>}</p>
          </EmptyState>
        )}
      </section>
      {ended.length > 0 && (
        <section className="panel glass" aria-labelledby="r2-ended-title">
          <h2 id="r2-ended-title">Finished games</h2>
          {table(ended)}
        </section>
      )}
    </div>
  );
}

/**
 * One game — the organiser's PRIVATE host screen: board, question controls, leaderboard and score log.
 * Tile → (server) selected, question still hidden → Reveal Question (timer starts) → Right / Wrong
 * open "Which team answered?" → Confirm Score (the server computes the points). Answer only reveals
 * the stored answer. The same controls also work on the projector, which never shows scores.
 */
export default function Round2Session() {
  const { sessionId } = useParams();
  const { act } = useRound2();
  const { confirm } = useUI();
  const { data, error, reload } = useR2Data(() => backend.round2.board(sessionId, { host: true }), sessionId);
  const play = useR2Gameplay(data, { privateFeedback: true });
  const [peek, setPeek] = useState(false);
  const game = data?.game;
  useEffect(() => { setPeek(false); }, [game?.phase, game?.question_id]);

  if (error && !data) return <ErrorState title="This Round 2 game could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading Round 2 game…" />;

  const { settings, topics, scores, session, results } = data;
  const live = session.status === 'live';
  const last = game.phase === 'idle' && game.last_result_id ? results.find((r) => r.id === game.last_result_id) : null;
  const available = topics.reduce((n, t) => n + t.questions.filter((q) => !q.used).length, 0);
  const sid = session.id;

  async function endGame() {
    const ok = await confirm({
      title: 'End this Round 2 game?', confirmLabel: 'End game', danger: true, typeToConfirm: 'END',
      message: <p>No more questions can be played in this game. Its scores and score log are kept.</p>,
    });
    if (ok) act('r2sEndSession', { session_id: sid }, { key: 'r2-end', success: 'Round 2 game ended' });
  }

  return (
    <div className="stack">
      <div className="row gap wrap r2-session-head">
        <Link to="/host/rounds/2" className="back-link"><ArrowLeft size={16} /> Round 2 Dashboard</Link>
        <span className="r2-session-title"><b>{session.title}</b> v{session.version} · {session.section} · code {session.join_code ? formatJoinCode(session.join_code) : '—'}</span>
        <span className={`badge ${live ? 'badge-ok' : 'badge-muted'}`}>{live ? 'LIVE' : 'Ended'}</span>
        <span className="row gap wrap r2-session-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => openRound2Projector(sid)} title="Interactive board for the audience screen — no scores"><MonitorPlay size={16} /> Projector</button>
          {live && <button className="btn btn-danger btn-sm" onClick={endGame} disabled={game.phase !== 'idle'} title={game.phase !== 'idle' ? 'Finish or cancel the open question first' : undefined}><Square size={14} /> End game</button>}
        </span>
      </div>

      <div className="r2-game">
        <div className="r2-main">
          {game.phase === 'revealed' ? (
            <section className="panel glass r2-control" aria-labelledby="r2-q-title">
              <div className="r2-control-head">
                <div>
                  <p className="r2-kicker">{game.topic} · {formatScore(game.points)} points</p>
                  <h2 id="r2-q-title" className="r2-question">{game.question_text}</h2>
                </div>
                <R2Countdown game={game} settings={settings} offsetMs={data.serverOffsetMs} size="lg" />
              </div>
              <div className="r2-answer-row">
                <span className={`badge ${game.answer_revealed ? 'badge-ok' : 'badge-muted'}`} role="status">
                  {game.answer_revealed ? 'Answer shown on the projector' : 'Answer hidden on the projector'}
                </span>
                {game.answer_revealed || peek
                  ? <span className="r2-answer"><b>Answer:</b> {game.answer_text}</span>
                  : <span className="muted small">Not marked yet. The host decides; the timer never scores.</span>}
                {!game.answer_revealed && (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPeek((v) => !v)} aria-pressed={peek}>
                    {peek ? <EyeOff size={12} /> : <Eye size={12} />} {peek ? 'Hide' : 'Peek'} (this screen only)
                  </button>
                )}
              </div>
              <R2QuestionActions game={game} play={play} />
              <div className="row gap wrap r2-control-foot">
                <span className="muted small">Right: +{formatScore(scoreDelta(game.points, 'right'))} · Wrong: +{formatScore(scoreDelta(game.points, 'wrong'))} (after you confirm the team)</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={play.closeWithoutPoints} disabled={play.busy('r2-close')}><X size={14} /> Close without points</button>
              </div>
            </section>
          ) : (
            <section className="panel glass" aria-labelledby="r2-board-title">
              <div className="panel-head">
                <h2 id="r2-board-title">Trivia board</h2>
                <span className="muted small">{available} question(s) left{live ? ' · choose a tile here or on the projector — the question stays hidden until you reveal it' : ''}</span>
              </div>
              {last && (
                <p className={`r2-last ${last.result}`} role="status">
                  Last question ({last.topic_name} · {formatScore(last.point_value)}): {last.result === 'no_score' ? 'closed — no points' : `${R2_RESULT_LABELS[last.result]} · Team ${last.team_number} ${last.team_name} ${formatScore(last.points, { sign: true })}`}
                </p>
              )}
              <TriviaBoard topics={topics} onPick={live ? play.pick : undefined} activeId={game.question_id} disabled={!live || game.phase !== 'idle' || play.busy('r2-select')} />
            </section>
          )}
        </div>

        <aside className="panel glass r2-side" aria-labelledby="r2-scores-title">
          <h2 id="r2-scores-title">Leaderboard</h2>
          <p className="muted small r2-private"><Lock size={12} /> Private — never shown on the projector.</p>
          <R2Scores scores={scores} />
        </aside>
      </div>

      <section className="panel glass" aria-labelledby="r2-log">
        <h2 id="r2-log">Score log</h2>
        {results.length === 0 ? <p className="muted">No questions played yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Time</th><th scope="col">Topic</th><th scope="col">Value</th><th scope="col">Team</th><th scope="col">Result</th><th scope="col">Points</th><th scope="col">Answer shown</th></tr></thead>
              <tbody>
                {[...results].reverse().map((r) => (
                  <tr key={r.id}>
                    <td className="small">{formatStamp(r.created_at)}</td>
                    <td>{r.topic_name}<br /><small className="muted">{r.question_text}</small></td>
                    <td className="num">{formatScore(r.point_value)}</td>
                    <td>{r.team_name ? `T${r.team_number} ${r.team_name}` : '—'}</td>
                    <td>{R2_RESULT_LABELS[r.result]}</td>
                    <td className="num"><b>{formatScore(r.points, { sign: true })}</b></td>
                    <td>{r.answer_revealed ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {live && game.phase === 'selected' && (
        <Modal title="Question selected" onClose={play.cancelSelection} labelledBy="r2-sel-title">
          <div className="r2-selected">
            <p className="r2-kicker">{game.topic}</p>
            <p className="r2-sel-points">{formatScore(game.points)} <small>points</small></p>
            <p className="muted small">The question is not shown yet — not here and not on the projector. Revealing it starts the {settings.timer_seconds}-second timer.</p>
          </div>
          <R2SelectedActions play={play} />
        </Modal>
      )}

      <R2TeamModal data={data} play={play} scores={scores} />
    </div>
  );
}
