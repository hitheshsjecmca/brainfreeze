// The timer is derived from timestamps, never decremented:
//   elapsed = elapsed_ms (accumulated before the last pause)
//           + (now − timer_started_at)   while running
// Supabase mode uses the database clock (now()) for all transitions, and the
// client corrects for its own clock skew with a measured server offset.

export function elapsedMs(session, nowMs) {
  if (!session) return 0;
  let e = Number(session.elapsed_ms || 0);
  if (session.status === 'running' && session.timer_started_at) {
    e += Math.max(0, nowMs - Date.parse(session.timer_started_at));
  }
  return e;
}

export function remainingMs(session, settings, nowMs) {
  const total = Number(settings?.duration_seconds || 0) * 1000;
  return Math.max(0, total - elapsedMs(session, nowMs));
}

export function isTimeExpired(session, settings, nowMs) {
  if (!session || session.status === 'setup') return false;
  return remainingMs(session, settings, nowMs) <= 0;
}

export function formatClock(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
