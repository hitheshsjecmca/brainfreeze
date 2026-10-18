import { useMemo } from 'react';

// Lightweight CSS-only snow. Disabled automatically for prefers-reduced-motion.
export function Snowfall({ count = 36 }) {
  const flakes = useMemo(() => {
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      left: `${(rnd() * 100).toFixed(2)}%`,
      size: `${(rnd() * 3 + 1.5).toFixed(1)}px`,
      duration: `${(rnd() * 14 + 12).toFixed(1)}s`,
      delay: `${(-rnd() * 26).toFixed(1)}s`,
      drift: `${(rnd() * 60 - 30).toFixed(0)}px`,
      opacity: (rnd() * 0.5 + 0.25).toFixed(2),
    }));
  }, [count]);
  return (
    <div className="snowfall" aria-hidden="true">
      {flakes.map((f) => (
        <span
          key={f.id}
          style={{ left: f.left, width: f.size, height: f.size, animationDuration: f.duration, animationDelay: f.delay, opacity: f.opacity, '--drift': f.drift }}
        />
      ))}
    </div>
  );
}

export function FrostBackdrop({ snow = true }) {
  return (
    <div className="frost-backdrop" aria-hidden="true">
      <div className="aurora aurora-1" />
      <div className="aurora aurora-2" />
      <div className="grid-floor" />
      {snow && <Snowfall />}
    </div>
  );
}
