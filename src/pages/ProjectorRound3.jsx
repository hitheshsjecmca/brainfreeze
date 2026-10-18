import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Eye, EyeOff, Lightbulb, Lock, Maximize, Minimize, MonitorOff, MousePointerClick, Play, RotateCcw, Scale, Settings2, Square, Tv, WifiOff, X } from 'lucide-react';
import { backend } from '../backend/index.js';
import { BrandMark } from '../components/Brand.jsx';
import { Modal } from '../components/Common.jsx';
import { FrostBackdrop } from '../components/Snowfall.jsx';
import { R3TeamCards, R3Timer } from '../components/Round3Bits.jsx';
import { BidControls, OutcomeControls, ReopenBidding, StartBidding, TieResolver, TimerSettings, r3Commands } from '../components/Round3Controls.jsx';
import { Round3Provider, useR3Data, useRound3 } from '../context/Round3Context.jsx';
import { useUI } from '../context/UIContext.jsx';
import { toQuizError } from '../lib/errors.js';
import { openRound3Projector } from '../lib/projectorWindow.js';
import { R3_OUTCOME_LABELS, timerLabel, timerModeText, topicCards } from '../lib/round3.js';

/**
 * Round 3 projector (?session=…; without it, the newest live auction) — the organiser-controlled auction screen.
 *
 * It loads only the PUBLIC projector board (r3s_board with p_host = false): budgets, bids, the label / topic /
 * question / answer exactly as far as the organiser has revealed them, and the final ranking only after the auction
 * has ended AND the organiser revealed it. Private scores and unrevealed content are not in its data at all.
 *
 * The whole auction can be run from this screen: click a topic card → choose an unused question → set the bidding
 * timer → Start Bidding → +10 / −10 / Pass on each team card → Close Bidding → (tie) → Reveal Topic (blind) →
 * Reveal Question → Correct / Wrong / Pass → Confirm Outcome → Next Eligible Bidder → Complete Question → … →
 * End Auction → Reveal Final Results. Every control is an organizer-only, server-validated function shared with the
 * private host control panel (the page itself requires an organiser login). "Private notes" loads the private
 * board on demand only (answer, scores) and closes by itself. `?view=display` (or "Display only") hides every
 * control for an audience-only second screen.
 */
export default function ProjectorRound3() {
  return (
    <Round3Provider projector>
      <ProjectorScreen />
    </Round3Provider>
  );
}

async function loadProjector(wanted) {
  let id = wanted;
  if (!id) id = (await backend.round3.overview()).sessions.find((g) => g.status === 'live')?.id ?? null;
  return { sessionId: id, board: id ? await backend.round3.board(id, { host: false }) : null };
}

function ProjectorScreen() {
  const [params] = useSearchParams();
  const wanted = params.get('session');
  const [controls, setControls] = useState(params.get('view') !== 'display');
  const [peek, setPeek] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const { data, error, reload } = useR3Data(() => loadProjector(wanted), wanted ?? '');
  const board = data?.board ?? null;
  const sessionId = data?.sessionId ?? wanted;
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return (
    <div className={`projector r3-projector ${controls && board ? 'r3-proj-interactive' : ''}`}>
      <FrostBackdrop />
      <Chrome sessionId={sessionId} controls={controls} setControls={setControls} onPeek={board && controls ? () => setPeek(true) : null} />
      {(!online || error?.code === 'NETWORK') && <div className="proj-conn" role="status"><WifiOff size={16} /> Reconnecting…</div>}
      {!data && !error && <div className="proj-center"><BrandMark size={140} className="pulse" /></div>}
      {data && !board && <Waiting />}
      {!board && error && <div className="proj-center"><p className="proj-error">Projector cannot load Round 3: {error.message}</p></div>}
      {board && <AuctionScreen data={board} reload={reload} controls={controls} />}
      {peek && board && <PrivatePeek sessionId={board.session.id} onClose={() => setPeek(false)} />}
    </div>
  );
}

function Waiting() {
  return (
    <div className="proj-center r3-proj-wait">
      <div>
        <BrandMark size={120} className="pulse" />
        <h1 className="r3-proj-title">THE KNOWLEDGE AUCTION</h1>
        <p className="r3-tagline">THINK. BID. RISK. WIN.</p>
        <p className="proj-msg">Waiting for the host to start Round 3…</p>
      </div>
    </div>
  );
}

const nameOf = (data, id) => { const t = data.teams.find((x) => x.team_id === id); return t ? `T${t.team_number} ${t.team_name}` : ''; };

function AuctionScreen({ data, reload, controls }) {
  const { session, current: c, teams, settings } = data;
  const { act, pendingKeys } = useRound3();
  const { confirm } = useUI();
  const ctx = { data, sid: session.id, act, busy: (k) => pendingKeys.has(k), confirm, reload, working: pendingKeys.size > 0 };
  const interactive = controls;
  const live = session.status === 'live';
  const [card, setCard] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const heading = c.question_id ? (c.topic ?? c.label) : null;
  const bidding = interactive && live && c.phase === 'bidding';
  const toggleTeam = (id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="r3-proj">
      <header className="r2-proj-head">
        <div className="proj-brand">
          <BrandMark size={44} />
          <div><b>BRAIN<span>FREZE</span> IT</b><small>ROUND 3</small></div>
        </div>
        <h1 className="r3-proj-title">THE KNOWLEDGE AUCTION</h1>
        <span className="r2-proj-tag">{live ? `${session.title} · ${session.section}` : 'AUCTION COMPLETE'}</span>
      </header>

      {!live ? (
        <>
          <FinalScreen data={data} />
          {interactive && <ResultsBar ctx={ctx} />}
        </>
      ) : (
        <div className="r3-proj-body">
          <div className={`r3-proj-stage ${c.question_text ? 'r3-stage-q' : ''}`}>
            {c.phase === 'idle' && <Board data={data} onPick={interactive ? setCard : null} />}
            {c.question_id && (
              <>
                <p className="r3-proj-kicker">QUESTION {c.seq}{c.mode === 'BLIND' ? ' · BLIND TOPIC' : ''}</p>
                <h2 className={`r3-proj-label ${c.mode === 'BLIND' && !c.topic_revealed ? 'r3-mystery' : ''}`}>{heading}</h2>
                {c.mode === 'BLIND' && c.topic_revealed && <p className="r3-proj-sub">{c.label}</p>}
                {c.phase === 'selected' && <p className="proj-msg">Bidding opens soon…</p>}
                {c.phase === 'bidding' && (
                  <div className="r3-proj-bidding">
                    <span className="r3-status r3-status-open">BIDDING OPEN</span>
                    {c.bid_seconds !== null
                      ? <R3Timer startedAt={c.bid_started_at} seconds={c.bid_seconds} offsetMs={data.serverOffsetMs} size="xl" expiredHint="BIDDING CLOSED" onExpire={reload} />
                      : <p className="r3-proj-rules">No timer — the host closes bidding</p>}
                    <p className="r3-proj-rules">Minimum {settings.min_bid} · steps of {settings.bid_step} · never above your budget</p>
                  </div>
                )}
                {['tie', 'closed'].includes(c.phase) && <span className="r3-status">BIDDING CLOSED{c.phase === 'tie' ? ' — RESOLVING A TIE' : ''}</span>}
                {['closed', 'answering', 'between', 'done'].includes(c.phase) && c.bid_order.length > 0 && (
                  <ol className="r3-proj-order">
                    {c.bid_order.map((id, i) => <li key={id} className={c.current_team_id === id ? 'current' : i + 1 < c.order_pos ? 'past' : ''}>{i + 1}. {nameOf(data, id)}</li>)}
                  </ol>
                )}
                {c.question_text && <p className={`proj-q-text ${c.question_text.length > 160 ? 'long' : ''}`}>{c.question_text}</p>}
                {c.phase === 'answering' && (
                  <div className="r3-proj-answering">
                    <p className="r3-proj-turn">Answering: <b>{nameOf(data, c.current_team_id)}</b></p>
                    <R3Timer startedAt={c.answer_started_at} seconds={settings.answer_seconds} offsetMs={data.serverOffsetMs} size="xl" />
                  </div>
                )}
                {['between', 'done'].includes(c.phase) && data.last_outcome && (
                  <p className={`r3-feedback r3-feedback-${data.last_outcome.outcome}`} role="status">
                    {data.last_outcome.team_name}: <b>{R3_OUTCOME_LABELS[data.last_outcome.outcome].toUpperCase()}</b>
                    {data.last_outcome.budget_delta ? <> · budget {data.last_outcome.budget_delta}</> : null}
                  </p>
                )}
                {c.phase === 'between' && <p className="proj-msg">Next: {nameOf(data, c.bid_order[c.order_pos])}</p>}
                {c.phase === 'done' && !c.bid_order.length && <p className="r3-feedback">No bids — question closed</p>}
                {c.phase === 'done' && c.bid_order.length > 0 && data.last_outcome?.outcome !== 'correct' && <p className="proj-msg">No correct answer</p>}
                {c.answer_revealed && <p className="r2-ov-answer"><small>ANSWER</small>{c.answer_text}{c.explanation && <span className="r3-expl">{c.explanation}</span>}</p>}
              </>
            )}
          </div>
          <R3TeamCards teams={teams} currentTeamId={c.current_team_id} order={c.bid_order} showBids={!!c.question_id} size="xl"
            onTeamClick={bidding ? toggleTeam : null} expanded={(id) => !collapsed.has(id)}
            renderControls={bidding ? (t) => (collapsed.has(t.team_id) ? null : <BidControls ctx={ctx} team={t} compact />) : null} />
          {interactive && <ControlBar key={`${c.phase}:${c.question_id}`} ctx={ctx} />}
        </div>
      )}
      {card && interactive && <TopicPicker ctx={ctx} card={topicCards(data.questions).find((x) => x.key === card.key) ?? card} onClose={() => setCard(null)} />}
    </div>
  );
}

/** Topic cards: NORMAL topics (grouped) and one MYSTERY QUESTION card per blind question. Clickable for the organiser. */
function Board({ data, onPick }) {
  const cards = topicCards(data.questions);
  return (
    <div className="r3-proj-board" role="group" aria-label="Auction topics">
      {cards.map((c) => {
        const cls = `r3-tile ${c.left === 0 ? 'r3-tile-used' : ''} ${c.blind ? 'r3-tile-blind' : ''}`;
        const inner = (
          <>
            <span className="r3-tile-label">{c.label}</span>
            <small>{c.left === 0 ? 'SOLD' : c.blind ? 'BLIND TOPIC' : `${c.left} of ${c.questions.length} left`}</small>
          </>
        );
        return onPick
          ? <button type="button" key={c.key} className={cls} onClick={() => onPick(c)} aria-label={`${c.label}: ${c.left} of ${c.questions.length} question(s) left`}>{inner}</button>
          : <div key={c.key} className={cls}>{inner}</div>;
      })}
    </div>
  );
}

/** The questions of one topic card: used vs unused, Normal or Blind. Choosing one only selects it. */
function TopicPicker({ ctx, card, onClose }) {
  const cmd = r3Commands(ctx);
  async function pick(id) {
    const res = await cmd.select(id);
    if (res.ok) onClose();
  }
  return (
    <Modal title={card.blind ? card.label : `Topic: ${card.label}`} onClose={onClose} labelledBy="r3-pick-title">
      <p className="muted small">
        {card.blind ? 'Blind topic: the projector shows only the mystery label; the topic and question stay hidden until after bidding.' : 'Normal topic: the topic is shown before bidding; the question stays hidden.'}
        {' '}Selecting a question does not start bidding.
      </p>
      <ul className="r3-pick-list">
        {card.questions.map((q) => (
          <li key={q.id} className={q.used ? 'r3-pick-used' : ''}>
            <span><b>Question #{q.seq}</b> <span className={`badge ${q.mode === 'BLIND' ? 'badge-purple' : 'badge-ice'} badge-xs`}>{q.mode === 'BLIND' ? `BLIND · MYSTERY #${q.mystery_no}` : 'NORMAL'}</span></span>
            {q.used
              ? <span className="badge badge-muted">Used</span>
              : <button type="button" className="btn btn-primary" onClick={() => pick(q.id)} disabled={ctx.busy('r3-select')} aria-label={`Select question ${q.seq}`}>Select</button>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** The organiser control strip: only the controls valid for the current phase. */
function ControlBar({ ctx }) {
  const { data, busy, working } = ctx;
  const c = data.current;
  const cmd = r3Commands(ctx);
  const [modal, setModal] = useState(null);
  const blindHidden = c.mode === 'BLIND' && !c.topic_revealed;
  const next = data.teams.find((t) => t.team_id === c.bid_order[c.order_pos]);
  const left = data.questions.filter((q) => !q.used).length;
  let body;
  switch (c.phase) {
    case 'idle':
      body = <p className="r3-ctl-hint">{left ? 'Click a topic card to choose the next question.' : 'Every question has been played — End the auction to finalise the rankings.'}</p>;
      break;
    case 'selected':
      body = <div className="r3-ctl-start"><StartBidding ctx={ctx} idPrefix="r3-proj-timer" cancelLabel="Cancel question" /></div>;
      break;
    case 'bidding':
      body = (
        <>
          <p className="r3-ctl-hint"><b>{timerModeText(c.bid_seconds)}</b> · +10 / −10 / Pass on each team card</p>
          <button className="btn btn-primary btn-lg" onClick={cmd.closeBidding} disabled={busy('r3-close')}><CheckCircle2 size={18} /> Close Bidding</button>
          <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> Cancel question</button>
        </>
      );
      break;
    case 'tie':
      body = (
        <>
          <p className="r3-ctl-hint">Equal bids — the organiser decides the order.</p>
          <button className="btn btn-primary btn-lg" onClick={() => setModal('tie')}><Scale size={18} /> Resolve tie</button>
          <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> Cancel question</button>
        </>
      );
      break;
    case 'closed':
      body = (
        <>
          {blindHidden && <button className="btn btn-primary btn-lg" onClick={cmd.revealTopic} disabled={busy('r3-topic')}><Eye size={18} /> Reveal Topic</button>}
          <button className="btn btn-primary btn-lg" onClick={cmd.revealQuestion} disabled={blindHidden || busy('r3-revealq')} title={blindHidden ? 'Reveal the topic first' : undefined}><Play size={18} /> Reveal Question ({data.settings.answer_seconds} s)</button>
          <button className="btn btn-ghost" onClick={() => setModal('reopen')}><RotateCcw size={16} /> Correct bids</button>
          <button className="btn btn-ghost" onClick={cmd.cancel} disabled={busy('r3-cancel')}><X size={16} /> Cancel question</button>
        </>
      );
      break;
    case 'answering':
      body = <div className="r3-ctl-outcomes"><OutcomeControls key={`${c.question_id}:${c.order_pos}`} ctx={ctx} /></div>;
      break;
    case 'between':
      body = (
        <>
          <button className="btn btn-primary btn-lg" onClick={cmd.nextBidder} disabled={busy('r3-next')}><ArrowRight size={18} /> Next Eligible Bidder{next ? `: T${next.team_number} ${next.team_name}` : ''}</button>
          <button className="btn btn-ghost" onClick={cmd.revealAnswer} disabled={c.answer_revealed || busy('r3-answer')}><Lightbulb size={16} /> Reveal Answer</button>
        </>
      );
      break;
    case 'done':
      body = (
        <>
          {c.question_revealed && <button className="btn btn-ghost" onClick={cmd.revealAnswer} disabled={c.answer_revealed || busy('r3-answer')}><Lightbulb size={16} /> {c.answer_revealed ? 'Answer revealed' : 'Reveal Answer'}</button>}
          <button className="btn btn-primary btn-lg" onClick={cmd.finish} disabled={busy('r3-finish')}><ArrowRight size={18} /> Complete Question → Next Question</button>
        </>
      );
      break;
    default:
      body = null;
  }
  return (
    <section className="r3-ctl glass" aria-label="Organiser controls">
      <span className="r3-ctl-tag"><Lock size={12} /> ORGANISER{working ? ' · working…' : ''}</span>
      <div className="r3-ctl-body">{body}</div>
      <div className="r3-ctl-side">
        <button className="btn btn-ghost btn-sm" onClick={() => setModal('timers')} title={`Bidding default ${timerLabel(data.settings.bid_timer_default)} · answer ${data.settings.answer_seconds} s`}><Settings2 size={14} /> Timers</button>
        <button className="btn btn-danger btn-sm" onClick={cmd.endAuction} disabled={!['idle', 'done'].includes(c.phase) || busy('r3-end')} title={!['idle', 'done'].includes(c.phase) ? 'Finish or cancel the open question first' : undefined}><Square size={13} /> End Auction</button>
      </div>
      {modal === 'timers' && <TimerSettings ctx={ctx} onClose={() => setModal(null)} />}
      {modal === 'tie' && <Modal title="Resolve the tie" onClose={() => setModal(null)} labelledBy="r3-tie-title"><div className="stack"><TieResolver ctx={ctx} /></div></Modal>}
      {modal === 'reopen' && <Modal title="Correct the bids" onClose={() => setModal(null)} labelledBy="r3-reopen-title"><ReopenBidding ctx={ctx} open /></Modal>}
    </section>
  );
}

/** After End Auction: reveal or hide the final rankings on this screen. */
function ResultsBar({ ctx }) {
  const { data, busy, working } = ctx;
  const cmd = r3Commands(ctx);
  const shown = data.session.results_revealed;
  return (
    <section className="r3-ctl glass" aria-label="Organiser controls">
      <span className="r3-ctl-tag"><Lock size={12} /> ORGANISER{working ? ' · working…' : ''}</span>
      <div className="r3-ctl-body">
        <button className="btn btn-primary btn-lg" onClick={() => cmd.revealResults(!shown)} disabled={busy('r3-reveal')}>
          {shown ? <><EyeOff size={18} /> Hide Final Results</> : <><Eye size={18} /> Reveal Final Results</>}
        </button>
        <Link className="btn btn-ghost" to={`/host/rounds/3/results/${data.session.id}`}>Session summary</Link>
      </div>
    </section>
  );
}

function FinalScreen({ data }) {
  if (!data.final) {
    return (
      <div className="proj-center"><div><h2 className="r3-proj-label">AUCTION COMPLETE</h2><p className="proj-msg">Final results coming up…</p></div></div>
    );
  }
  return (
    <div className="r3-final">
      <h2 className="r3-proj-label">FINAL RESULTS</h2>
      <ol className="r3-final-list">
        {data.final.map((r) => (
          <li key={r.team_id} className={`r3-final-${r.rank}`}>
            <span className="r3-rank">{r.rank}{r.tied ? '=' : ''}</span>
            <span className="r3-final-name">T{r.team_number} {r.team_name}</span>
            <strong>{r.score}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Organiser-only private notes, loaded ON DEMAND from the private board (never part of the projector's data):
 * the hidden topic, question and answer of the open question and the private scores. Everyone in the room can see
 * this screen, so it closes by itself after 20 seconds and its data is dropped when it closes.
 */
function PrivatePeek({ sessionId, onClose }) {
  const [state, setState] = useState({ data: null, error: null });
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    let alive = true;
    backend.round3.board(sessionId, { host: true }).then(
      (d) => { if (alive) setState({ data: d, error: null }); },
      (e) => { if (alive) setState({ data: null, error: toQuizError(e) }); },
    );
    const t = setTimeout(() => closeRef.current(), 20000);
    return () => { alive = false; clearTimeout(t); };
  }, [sessionId]);
  const d = state.data;
  return (
    <Modal title="Private notes (organiser)" onClose={onClose} labelledBy="r3-peek-title">
      <p className="warn-text small"><Lock size={13} /> Everyone can see this screen. Closes by itself after 20 seconds.</p>
      {!d && !state.error && <p className="muted">Loading…</p>}
      {state.error && <p className="danger-text">{state.error.message}</p>}
      {d && (
        <div className="stack">
          {d.current.question_id ? (
            <dl className="kv small">
              <dt>Topic</dt><dd>{d.current.topic}</dd>
              <dt>Question</dt><dd>{d.current.question_text}</dd>
              <dt>Answer</dt><dd><b>{d.current.answer_text}</b>{d.current.explanation ? <span className="muted"> — {d.current.explanation}</span> : null}</dd>
            </dl>
          ) : <p className="muted small">No question is open.</p>}
          <ol className="r3-ranking">
            {d.ranking.map((r) => <li key={r.team_id}><span className="r3-rank">{r.rank}{r.tied ? '=' : ''}</span><span>T{r.team_number} {r.team_name}</span><b>{r.score}</b><small className="muted">budget {r.budget}</small></li>)}
          </ol>
        </div>
      )}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

function Chrome({ sessionId, controls, setControls, onPeek }) {
  const [full, setFull] = useState(!!document.fullscreenElement);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    const fs = () => setFull(!!document.fullscreenElement);
    const key = (e) => { if ((e.key === 'f' || e.key === 'F') && !e.target.closest?.('input, textarea, select')) toggle(); };
    wake();
    window.addEventListener('mousemove', wake);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); document.removeEventListener('fullscreenchange', fs); window.removeEventListener('keydown', key); };
  }, []);
  return (
    <div className={`proj-chrome ${idle ? 'idle' : ''}`}>
      <Link to={sessionId ? `/host/rounds/3/session/${sessionId}` : '/host/rounds/3'} className="btn btn-ghost btn-sm">← Control panel</Link>
      <button className="btn btn-ghost btn-sm" onClick={() => setControls((c) => !c)} aria-pressed={!controls}>
        {controls ? <><MonitorOff size={16} /> Display only</> : <><MousePointerClick size={16} /> Show controls</>}
      </button>
      {controls && sessionId && <button className="btn btn-ghost btn-sm" onClick={() => openRound3Projector(sessionId, { display: true })} title="Open an audience-only display (no controls) for a second screen"><Tv size={16} /> Audience window</button>}
      {onPeek && <button className="btn btn-ghost btn-sm" onClick={onPeek}><Lock size={16} /> Private notes</button>}
      <button className="btn btn-ghost btn-sm" onClick={toggle} aria-label="Toggle fullscreen (F)">{full ? <Minimize size={16} /> : <Maximize size={16} />} {full ? 'Exit' : 'Fullscreen'} (F)</button>
    </div>
  );
}

function toggle() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
