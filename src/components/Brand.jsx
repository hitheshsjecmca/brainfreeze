import { useId } from 'react';

/** Original BRAINFREZE mark: a six-armed ice crystal whose core is a circuit node. */
export function BrandMark({ size = 48, className = '' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="BRAINFREZE crystal logo">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9fbff" />
          <stop offset=".45" stopColor="#67e8f9" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
        <radialGradient id={`c${id}`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".6" stopColor="#a5f3fc" />
          <stop offset="1" stopColor="#a78bfa" />
        </radialGradient>
      </defs>
      <polygon points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5" fill="none" stroke={`url(#g${id})`} strokeWidth="2.2" opacity=".55" />
      <g stroke={`url(#g${id})`} strokeWidth="3" strokeLinecap="round" fill="none">
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <g key={a} transform={`rotate(${a} 32 32)`}>
            <path d="M32 32 V10" />
            <path d="M32 17 l-5 -5 M32 17 l5 -5" strokeWidth="2.2" />
          </g>
        ))}
      </g>
      <circle cx="32" cy="32" r="7.5" fill={`url(#c${id})`} />
      <circle cx="32" cy="32" r="3" fill="#061226" />
    </svg>
  );
}

export function BrandLockup({ size = 'md', showRound = true }) {
  return (
    <div className={`brand-lockup brand-${size}`}>
      <BrandMark size={size === 'xl' ? 120 : size === 'lg' ? 72 : 40} />
      <div>
        <div className="brand-word" aria-label="BRAINFREZE">BRAIN<span>FREZE</span></div>
        {showRound && <div className="brand-round">COLD START <em>· ROUND 1</em></div>}
      </div>
    </div>
  );
}
