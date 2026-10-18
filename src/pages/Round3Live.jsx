import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, CheckCircle2, Eye, Gavel, Lightbulb, Lock, MonitorPlay, Play, Settings2, Square, Timer, Trophy, Tv, X,
} from 'lucide-react';
import { backend } from '../backend/index.js';
import { useR3Data, useRound3 } from '../context/Round3Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { EmptyState, ErrorState, Loading, Modal } from '../components/Common.jsx';
import { R3TeamCards, R3Timer } from '../components/Round3Bits.jsx';
import { BidControls, OutcomeControls, ReopenBidding, StartBidding, TieResolver, TimerSettings, r3Commands } from '../components/Round3Controls.jsx';
import { formatJoinCode } from '../lib/joinCodes.js';
import { openRound3Projector } from '../lib/projectorWindow.js';
import { R3_OUTCOME_LABELS, R3_PHASE_LABELS, R3_RESULT_LABELS, describeDeltas, timerLabel, timerModeText } from '../lib/round3.js';
import { formatStamp } from '../lib/sets.js';

/** Live Auction tab: live auctions (open the private control panel) and finished ones. */
export function LiveAuctions() {
  const { data, error, reload } = useR3Data(() => backend.round3.overview(), 'overview');
  if (error && !data) return <ErrorState title="Round 3 could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading Round 3…" />;
  const live = data.sessions.filter((g) => g.status === 'live');
  const ended = data.sessions.filter((g) => g.status !== 'live');
  const published = data.sets.some((s) => s.published_version > 0 && !s.archived_at);
  const names = (g) => (g.teams || []).map((t) => `T${t.team_number} ${t.team_name}`).join(' · ');
  return (
    <div className="stack">
      <section className="panel glass" aria-labelledby="r3-live-title">
        <div className="panel-head">
          <h2 id="r3-live-title">Live auctions</h2>
          <Link className="btn btn-primary" to="/host/rounds/3/join">Join Round 3</Link>
        </div>
        {live.length === 0 ? (
          <EmptyState title="No live auction">
            <p className="muted">{published ? 'Enter a published auction set’s code on Join Round 3, choose the section and the three finalists, then press Start Round 3.' : <>First create and publish an auction set on <Link to="/host/rounds/3/sets">Auction Sets</Link>.</>}</p>
          </EmptyState>
        ) : (
          <ul className="r3-live-list">
            {live.map((g) => (
              <li key={g.id} className="glass">
                <div><b>{g.title}</b> <span className="badge badge-ok">LIVE · {g.section}</span> <span className="badge badge-muted badge-xs">{R3_PHASE_LABELS[g.phase]}</span>
                  <p className="muted small">{names(g)} · {g.played}/{g.question_count} questions played · started {formatStamp(g.started_at)}</p></div>
                <div className="row gap wrap">
                  <Link className="btn btn-primary" to={`/host/rounds/3/session/${g.id}`}><Gavel size={16} /> Open control panel</Link>
                  <button className="btn btn-ghost btn-sm" onClick={() => openRound3Projector(g.id)}><MonitorPlay size={14} /> Projector</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {ended.length > 0 && (
        <section className="panel glass" aria-labelledby="r3-ended-title">
          <h2 id="r3-ended-title">Finished auctions</h2>
          <ul className="r3-live-list">
            {ended.map((g) => (
              <li key={g.id} className="glass">
                <div><b>{g.title}</b> <span className="badge badge-muted">{g.section} · ended</span><p className="muted small">{names(g)} · {g.played} question(s) played</p></div>
                <Link className="btn btn-ghost btn-sm" to={`/host/rounds/3/results/${g.id}`}><Trophy size={14} /> Results</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The PRIVATE organiser control panel of one auction. Scores, the question, the answer and the log are shown only
 * here; the projector gets its own board without them. Every button is one organizer-only server function that
 * re-checks the phase; scores and budgets are computed in the database.
 */
export default function Round3Session() {
  const { sessionId } = useParams();
  const { act, pendingKeys } = useRound3();
  const { confirm } = useUI();
  const { data, error, reload } = useR3Data(() => backend.round3.board(sessionId, { host: true }), sessionId);
  const [timerSettings, setTimerSettings] = useState(false);
  if (error && !data) return <ErrorState title="This auction could not load" error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading auction…" />;

  const { session, current: cur, teams, ranking, settings } = data;
  const live = session.status === 'live';
  const sid = session.id;
  const busy = (k) => pendingKeys.has(k);
  const ctx = { data, sid, act, busy, confirm, reload };

  const cmd = r3Commands(ctx);

  return (
    <div className="stack">
      <div className="row gap wrap r2-session-head">
        <Link to="/host/rounds/3" className="back-link"><ArrowLeft size={16} /> Live Auction</Link>
        <span className="r2-session-title"><b>{session.title}</b> v{session.version} · {session.section} · code {session.join_code ? formatJoinCode(session.join_code) : '—'}</span>
        <span className={`badge ${live ? 'badge-ok' : 'badge-muted'}`}>{live ? 'LIVE' : 'Ended'}</span>
        {live && <span className="badge badge-ice" role="status">{R3_PHASE_LABELS[cur.phase]}{cur.seq ? ` · question ${cur.seq} of ${data.question_list.length}` : ''}</span>}
        <span className="row gap wrap r2-session-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => openRound3Projector(sid)} title="The projector screen with every auction control (no private scores)"><MonitorPlay size={16} /> Projector</button>
          <button className="btn btn-ghost btn-sm" onClick={() => openRound3Projector(sid, { display: true })} title="Audience-only display with no controls, for a second screen"><Tv size={16} /> Audience display</button>
          {live && <button className="btn btn-ghost btn-sm" onClick={() => setTimerSettings(true)}><Settings2 size={16} /> Timers</button>}
          {live && <button className="btn btn-danger btn-sm" onClick={cmd.endAuction} disabled={!['idle', 'done'].includes(cur.phase) || busy('r3-end')} title={!['idle', 'done'].includes(cur.phase) ? 'Finish or cancel the open question first' : undefined}><Square size={14} /> End Auction</button>}
        </span>
      </div>

      {live && <p className="muted small r3-timer-line"><Timer size={13} /> Bidding timer default: <b>{timerLabel(settings.bid_timer_default)}</b> · answer timer <b>{settings.answer_seconds} s</b></p>}
      {timerSettings && <TimerSettings ctx={ctx} onClose={() => setTimerSettings(false)} />}
      <div className="r3-game">
        <div className="r3-main">
          {live ? <PhasePanel {...ctx} /> : <EndedPanel {...ctx} />}
        </div>
        <aside className="r3-side stack">
          <section className="panel glass" aria-labelledby="r3-teams-title">
            <h2 id="r3-teams-title">Teams</h2>
            <R3TeamCards teams={teams} currentTeamId={cur.current_team_id} order={cur.bid_order} showBids={!!cur.question_id} showScores />
            <p className="muted small">Budget is public (projector). <Lock size={11} /> Scores are private to this screen.</p>
          </section>
          <section className="panel glass" aria-labelledby="r3-lb-title">
            <h2 id="r3-lb-title"><Lock size={16} /> Private leaderboard</h2>
            <ol className="r3-ranking">
              {ranking.map((r) => (
                <li key={r.team_id}><span className="r3-rank">{r.rank}{r.tied ? '=' : ''}</span><span>T{r.team_number} {r.team_name}</span><b>{r.score}</b><small className="muted">budget {r.budget}</small></li>
              ))}
            </ol>
            <p className="muted small">Bids: min {settings.min_bid}, steps of {settings.bid_step}. Highest bidder: correct +½ bid (score), wrong −½ bid (budget). Lower bidder correct +10. Pass/timeout: no change.</p>
          </section>
        </aside>
      </div>

      <section className="panel glass" aria-labelledby="r3-log-title">
        <h2 id="r3-log-title">Auction log <small className="muted">(private)</small></h2>
        {data.log.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="r3-log">
            {data.log.map((e) => <li key={e.id}><small className="muted">{formatStamp(e.created_at)}</small> {logText(e)}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

function logText(e) {
  const t = e.team_name ? `T${e.team_number} ${e.team_name}` : '';
  const q = e.seq ? `Q${e.seq}` : '';
  switch (e.kind) {
    case 'bid': return `${q} bid — ${t}: ${e.detail?.pass ? 'pass' : e.detail?.amount ?? '0 (no bid / pass undone)'}`;
    case 'bidding_started': return `${q} bidding opened (${e.detail?.restart ? 'timer restarted' : timerLabel(e.detail?.timer_seconds ?? null)})`;
    case 'bidding_closed': return `${q} bidding closed ${e.detail?.auto ? 'automatically when the timer ended' : 'by the organiser'}${e.detail?.tie ? ' — tie' : ''}`;
    case 'settings_changed': return `Timer defaults changed: bidding ${timerLabel(e.detail?.bid_timer_seconds ?? null)}, answer ${e.detail?.answer_seconds} s`;
    case 'tie_resolved': return `${q} tie resolved (${e.detail?.reason}) — ${t} answers first`;
    case 'bidding_reopened': return `${q} bidding reopened (${e.detail?.reason})`;
    case 'topic_revealed': return `${q} topic revealed`;
    case 'question_revealed': return `${q} question revealed`;
    case 'outcome': return `${q} ${t}: ${R3_OUTCOME_LABELS[e.outcome]}${e.was_top ? ' (highest bidder)' : ''} — ${describeDeltas(e)}`;
    case 'next_bidder': return `${q} next bidder: ${t}`;
    case 'answer_revealed': return `${q} answer revealed`;
    case 'question_completed': return `${q} completed — ${R3_RESULT_LABELS[e.detail?.result] || e.detail?.result}${t ? ` (${t})` : ''}`;
    case 'question_cancelled': return `${q} cancelled (returned unused)`;
    case 'auction_ended': return 'Auction ended';
    case 'results_revealed': return e.detail?.revealed ? 'Final results shown on the projector' : 'Final results hidden from the projector';
    default: return e.kind;
  }
}

function QuestionHead({ data }) {
  const c = data.current;
  return (
    <div className="r3-qhead">
      <p className="r2-kicker">Question {c.seq} · <span className={`badge ${c.mode === 'BLIND' ? 'badge-purple' : 'badge-ice'} badge-xs`}>{c.mode}</span> · projector shows: <b>{c.mode === 'BLIND' && c.topic_revealed ? c.topic : c.label}</b></p>
      <p className="small"><Lock size={12} /> Topic <b>{c.topic}</b>{c.mode === 'BLIND' && !c.topic_revealed && <span className="muted"> (hidden on the projector)</span>}</p>
      <h2 className="r2-question">{c.question_text} {!c.question_revealed && <small className="badge badge-muted badge-xs">hidden on the projector</small>}</h2>
      <p className="r2-answer small"><Lock size={12} /> <b>Answer:</b> {c.answer_text}{c.explanation ? <span className="muted"> — {c.explanation}</span> : null} {c.answer_revealed ? <span className="badge badge-ok badge-xs">shown on the projector</span> : null}</p>
    </div>
  );
}

function PhasePanel(ctx) {
  const { data } = ctx;
  const p = data.current.phase;
  if (p === 'idle') return <QuestionPicker {...ctx} />;
  return (
    <section className="panel glass r3-phase" aria-label={R3_PHASE_LABELS[p]}>
      <QuestionHead data={data} />
      {p === 'selected' && <SelectedStep {...ctx} />}
      {p === 'bidding' && <BiddingStep {...ctx} />}
      {p === 'tie' && <TieResolver ctx={ctx} />}
      {p === 'closed' && <ClosedStep {...ctx} />}
      {p === 'answering' && <AnsweringStep {...ctx} />}
      {p === 'between' && <BetweenStep {...ctx} />}
      {p === 'done' && <DoneStep {...ctx} />}
    </section>
  );
}

function QuestionPicker(ctx) {
  const { data, busy } = ctx;
  const cmd = r3Commands(ctx);
  const left = data.question_list.filter((q) => !q.used).length;
  return (
    <section className="panel glass" aria-labelledby="r3-qpick">
      <div className="panel-head">
        <h2 id="r3-qpick">Select Question</h2>
        <span className="muted small">{left} of {data.question_list.length} left</span>
      </div>
      {left === 0 && <p className="ok-text">Every question has been played. End the auction to finalise the rankings.</p>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">#</th><th scope="col">Mode</th><th scope="col">Topic <Lock size={11} /></th><th scope="col">Question <Lock size={11} /></th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {data.question_list.map((q) => (
              <tr key={q.id} className={q.used ? 'row-dim' : ''}>
                <td className="num">{q.seq}</td>
                <td><span className={`badge ${q.mode === 'BLIND' ? 'badge-purple' : 'badge-ice'} badge-xs`}>{q.mode === 'BLIND' ? `MYSTERY #${q.mystery_no}` : 'NORMAL'}</span></td>
                <td>{q.topic_name}</td>
                <td className="small">{q.question_text}</td>
                <td className="actions">{q.used ? <span className="badge badge-muted">Used</span> : (
                  <button className="btn btn-primary btn-sm" disabled={busy('r3-select')} onClick={() => cmd.select(q.id)} aria-label={`Select question ${q.seq}`}>Select</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SelectedStep(ctx) {
  const { data } = ctx;
  return (
    <>
      <p className="muted small">The projector shows <b>{data.current.label}</b>{data.current.mode === 'BLIND' ? ' — the topic stays hidden until you reveal it after bidding.' : ' (the topic). The question stays hidden.'}</p>
      <StartBidding ctx={ctx} />
    </>
  );
}

function BiddingStep(ctx) {
  const { data, busy } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  return (
    <>
      <div className="row gap wrap align-center">
        {c.bid_seconds !== null && <R3Timer startedAt={c.bid_started_at} seconds={c.bid_seconds} offsetMs={data.serverOffsetMs} size="md" expiredHint="CLOSING" onExpire={ctx.reload} />}
        <div>
          <p className="r3-mode-line" role="status"><b>{timerModeText(c.bid_seconds)}</b></p>
          <p className="muted small">Every bid starts at 0. Press <b>+10</b> for each raise a team calls, <b>&minus;10</b> to correct a mistake and <b>Pass</b> when a team drops out. Bidding never changes a budget or score.</p>
        </div>
      </div>
      <div className="r3-bidforms">
        {data.teams.map((t) => <BidControls key={t.team_id} ctx={ctx} team={t} />)}
      </div>
      <div className="row gap wrap">
        <button className="btn btn-primary btn-lg" onClick={cmd.closeBidding} disabled={busy('r3-close')}><CheckCircle2 size={18} /> Close Bidding</button>
        <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> Cancel question</button>
      </div>
    </>
  );
}

function bidderList(data) {
  const byId = new Map(data.teams.map((t) => [t.team_id, t]));
  return data.current.bid_order.map((id) => byId.get(id)).filter(Boolean);
}

function OrderList({ data }) {
  const pos = data.current.order_pos;
  return (
    <ol className="r3-order">
      {bidderList(data).map((t, i) => (
        <li key={t.team_id} className={i + 1 === pos ? 'r3-order-current' : i + 1 < pos ? 'row-dim' : ''}>
          <span><b>#{i + 1}</b> T{t.team_number} {t.team_name} — bid {t.bid}{i === 0 ? ' (highest bidder)' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

function ClosedStep(ctx) {
  const { data, busy } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  const blindHidden = c.mode === 'BLIND' && !c.topic_revealed;
  return (
    <>
      <p className="small">Bidding is closed. Answering order:</p>
      <OrderList data={data} />
      <div className="row gap wrap">
        {blindHidden && <button className="btn btn-primary" onClick={cmd.revealTopic} disabled={busy('r3-topic')}><Eye size={16} /> Reveal Topic</button>}
        <button className="btn btn-primary btn-lg" onClick={cmd.revealQuestion} disabled={blindHidden || busy('r3-revealq')} title={blindHidden ? 'Reveal the topic first' : undefined}><Play size={18} /> Reveal Question ({data.settings.answer_seconds} s)</button>
        <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> Cancel question</button>
      </div>
      <ReopenBidding ctx={ctx} />
    </>
  );
}

function AnsweringStep(ctx) {
  const { data } = ctx;
  const c = data.current;
  const team = data.teams.find((t) => t.team_id === c.current_team_id);
  return (
    <>
      <div className="row gap wrap align-center">
        <R3Timer startedAt={c.answer_started_at} seconds={data.settings.answer_seconds} offsetMs={data.serverOffsetMs} size="md" />
        <div>
          <p className="r3-turn">Answering: <b>T{team?.team_number} {team?.team_name}</b></p>
          <p className="muted small">{c.order_pos === 1 ? `Highest bidder · bid ${team?.bid}` : `Lower-ranked bidder (#${c.order_pos}) · bid ${team?.bid}`}</p>
        </div>
      </div>
      <OutcomeControls key={`${c.question_id}:${c.order_pos}`} ctx={ctx} />
    </>
  );
}

function LastOutcome({ data }) {
  const o = data.last_outcome;
  if (!o) return null;
  return <p className={`r2-last ${o.outcome === 'correct' ? 'right' : 'wrong'}`} role="status">T{o.team_number} {o.team_name}: {R3_OUTCOME_LABELS[o.outcome]}{o.was_top ? ' (highest bidder)' : ''} — {describeDeltas(o)}</p>;
}

function BetweenStep(ctx) {
  const { data, busy } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  const next = data.teams.find((t) => t.team_id === c.bid_order[c.order_pos]);
  return (
    <>
      <LastOutcome data={data} />
      <OrderList data={data} />
      <div className="row gap wrap">
        <button className="btn btn-primary btn-lg" onClick={cmd.nextBidder} disabled={busy('r3-next')}><ArrowRight size={18} /> Move to Next Eligible Bidder{next ? `: T${next.team_number} ${next.team_name}` : ''}</button>
        <button className="btn btn-ghost" onClick={cmd.revealAnswer} disabled={c.answer_revealed || busy('r3-answer')}><Lightbulb size={16} /> Reveal Answer</button>
      </div>
      <p className="muted small">The answer timer restarts for the next team.</p>
    </>
  );
}

function DoneStep(ctx) {
  const { data, busy } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  const noBids = !c.bid_order.length;
  return (
    <>
      {noBids ? <p className="r2-last no_score" role="status">No team bid — the question is completed with no points.</p> : <LastOutcome data={data} />}
      {!noBids && data.last_outcome?.outcome !== 'correct' && <p className="small">No bidder answered correctly — no further points.</p>}
      <div className="row gap wrap">
        {c.question_revealed && <button className="btn btn-ghost" onClick={cmd.revealAnswer} disabled={c.answer_revealed || busy('r3-answer')}><Lightbulb size={16} /> {c.answer_revealed ? 'Answer revealed' : 'Reveal Answer'}</button>}
        <button className="btn btn-primary btn-lg" onClick={cmd.finish} disabled={busy('r3-finish')}><ArrowRight size={18} /> Complete Question — next question</button>
      </div>
    </>
  );
}

function EndedPanel(ctx) {
  const { data, sid, busy } = ctx;
  const s = data.session;
  const cmd = r3Commands(ctx);
  return (
    <section className="panel glass" aria-labelledby="r3-final-title">
      <h2 id="r3-final-title"><Trophy size={18} /> Auction ended — final ranking</h2>
      <ol className="r3-ranking r3-ranking-lg">
        {data.ranking.map((r) => <li key={r.team_id}><span className="r3-rank">{r.rank}{r.tied ? '=' : ''}</span><span>T{r.team_number} {r.team_name}</span><b>{r.score}</b><small className="muted">budget {r.budget}</small></li>)}
      </ol>
      {data.ranking.some((r) => r.tied) && <p className="warn-text small">Equal final scores share a rank. Decide any tie-break openly (for example a sudden-death question) — the system never breaks it on its own.</p>}
      <div className="row gap wrap">
        <button className="btn btn-primary" onClick={() => cmd.revealResults(!s.results_revealed)} disabled={busy('r3-reveal')}>
          <Eye size={16} /> {s.results_revealed ? 'Hide results on the projector' : 'Reveal final rankings on the projector'}
        </button>
        <Link className="btn btn-ghost" to={`/host/rounds/3/results/${sid}`}><Trophy size={16} /> Session summary &amp; export</Link>
      </div>
    </section>
  );
}
