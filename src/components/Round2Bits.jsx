import { Check } from 'lucide-react';
import { useServerNow } from '../lib/hooks.js';
import { formatScore, r2Remaining } from '../lib/round2.js';

/**
 * Topic columns of point tiles. With `onPick`, available tiles are buttons (host);
 * without it they are static (projector). Used tiles are disabled and marked.
 */
export function TriviaBoard({ topics, onPick, activeId = null, disabled = false, size = 'md' }) {
  if (!topics.length) return <p className="muted r2-empty">No topics yet.</p>;
  return (
    <div className={`r2-board r2-board-${size}`} style={{ '--cols': topics.length }} role="group" aria-label="Trivia board">
      {topics.map((t) => (
        <section key={t.id} className="r2-col" aria-label={`Topic ${t.name}`}>
          <h3 className="r2-topic" title={t.name}>{t.name}</h3>
          {t.questions.length === 0 && <span className="r2-tile r2-tile-empty">—</span>}
          {t.questions.map((q) => {
            const label = `${t.name}, ${formatScore(q.points)} points${q.used ? ', already played' : ''}`;
            const cls = `r2-tile ${q.used ? 'r2-tile-used' : ''} ${activeId === q.id ? 'r2-tile-active' : ''}`;
            return onPick ? (
              <button key={q.id} type="button" className={cls} disabled={q.used || disabled} aria-label={label} onClick={() => onPick(q.id)}>
                {q.used ? <Check size={18} aria-hidden="true" /> : formatScore(q.points)}
              </button>
            ) : (
              <span key={q.id} className={cls} aria-label={label}>{q.used ? <Check size={size === 'xl' ? 30 : 18} aria-hidden="true" /> : formatScore(q.points)}</span>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** The open question's countdown, from the server reveal time. Display only: reaching zero never scores anything. */
export function R2Countdown({ game, settings, offsetMs = 0, size = 'lg' }) {
  const now = useServerNow(offsetMs, 100);
  const rem = r2Remaining(game, settings, now);
  if (rem === null) return null;
  const total = settings.timer_seconds * 1000;
  const secs = Math.ceil(rem / 1000);
  const expired = rem <= 0;
  const urgent = !expired && secs <= 5;
  const pct = Math.max(0, Math.min(1, rem / total));
  return (
    <div className={`timer timer-${size} r2-timer ${expired ? 'timer-expired' : urgent ? 'timer-urgent' : ''}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="52" className="timer-track" />
        <circle cx="60" cy="60" r="52" className="timer-arc" strokeDasharray={`${(pct * 326.7).toFixed(1)} 326.7`} transform="rotate(-90 60 60)" />
      </svg>
      <div className="timer-text" role="timer" aria-live="off" aria-label={expired ? 'Time is up' : `${secs} seconds left`}>
        <strong>{expired ? "TIME'S UP" : secs}</strong>
        <small>{expired ? 'NO AUTO SCORE' : 'SECONDS'}</small>
      </div>
    </div>
  );
}

/** Live Round 2 scores. */
export function R2Scores({ scores, highlight = null, size = 'md' }) {
  if (!scores.length) return <p className="muted small">No teams in the Round 2 roster yet.</p>;
  return (
    <ol className={`r2-scores r2-scores-${size}`}>
      {scores.map((s) => (
        <li key={s.team_id} className={highlight === s.team_id ? 'r2-score-hl' : ''}>
          <span className="r2-score-no">{s.section} T{s.team_number}</span>
          <span className="r2-score-name">{s.team_name}</span>
          <strong className={`r2-score-val ${s.score < 0 ? 'neg' : ''}`}>{formatScore(s.score)}</strong>
        </li>
      ))}
    </ol>
  );
}
