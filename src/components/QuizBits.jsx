import { OPTIONS, OPTION_FIELDS } from '../lib/constants.js';
import { formatClock } from '../lib/timer.js';
import { useRemaining } from '../lib/hooks.js';
import { OPTION_STYLE } from './optionStyle.js';


export function OptionTile({ letter, text, size = 'md', state, onClick, disabled, pressed }) {
  const { cls, Icon } = OPTION_STYLE[letter];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`option-tile ${cls} option-${size} ${state ? `option-${state}` : ''}`}
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      aria-pressed={onClick ? !!pressed : undefined}
      type={onClick ? 'button' : undefined}
    >
      <span className="option-letter"><Icon size={size === 'xl' ? 30 : 18} aria-hidden="true" /> {letter}</span>
      <span className="option-text">{text}</span>
    </Tag>
  );
}

export function OptionGrid({ question, size = 'md', keyLetter = null }) {
  return (
    <div className={`option-grid option-grid-${size}`}>
      {OPTIONS.map((l) => (
        <OptionTile key={l} letter={l} text={question[OPTION_FIELDS[l]]} size={size} state={keyLetter ? (keyLetter === l ? 'key' : 'dim') : null} />
      ))}
    </div>
  );
}

export function TimerDisplay({ session, settings, offsetMs = 0, size = 'md' }) {
  const rem = useRemaining(session, settings, offsetMs);
  const total = (settings?.duration_seconds || 1) * 1000;
  const pct = Math.max(0, Math.min(1, rem / total));
  const notStarted = session.status === 'setup';
  const expired = !notStarted && rem <= 0;
  const urgent = !expired && rem <= 5 * 60 * 1000 && !notStarted;
  const label = notStarted ? formatClock(total) : formatClock(rem);
  return (
    <div className={`timer timer-${size} ${expired ? 'timer-expired' : urgent ? 'timer-urgent' : ''} ${session.status === 'paused' ? 'timer-paused' : ''}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="52" className="timer-track" />
        <circle cx="60" cy="60" r="52" className="timer-arc" strokeDasharray={`${(pct * 326.7).toFixed(1)} 326.7`} transform="rotate(-90 60 60)" />
      </svg>
      <div className="timer-text" role="timer" aria-live="off" aria-label={`Time remaining ${label}`}>
        <strong>{expired ? "TIME'S UP" : label}</strong>
        <small>{notStarted ? 'READY' : session.status === 'paused' ? 'PAUSED' : session.status === 'running' ? 'REMAINING' : 'STOPPED'}</small>
      </div>
    </div>
  );
}
