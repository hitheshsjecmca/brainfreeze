/** Open one quiz set's clean projector display in its own window (drag it to the projector screen). */
export function openProjector(setId) {
  const url = `/projector${setId ? `?set=${encodeURIComponent(setId)}` : ''}`;
  const w = window.open(url, `brainfreze-projector-${setId || 'default'}`, 'popup=yes,width=1280,height=720');
  if (!w) window.location.assign(url);
  else w.focus();
}

/** The Round 2 projector for one game (session); without an id it shows the newest live game. */
export const round2ProjectorUrl = (sessionId = null) => (sessionId ? `/projector/round2?session=${encodeURIComponent(sessionId)}` : '/projector/round2');

export function openRound2Projector(sessionId = null) {
  const url = round2ProjectorUrl(sessionId);
  const w = window.open(url, 'brainfreze-projector-round2', 'popup=yes,width=1280,height=720');
  if (!w) window.location.assign(url);
  else w.focus();
}

/**
 * The Round 3 auction projector for one auction; without an id it shows the newest live auction. It is the
 * organiser-controlled screen (every auction control on the projector); `display` gives the audience-only view
 * with no controls, for a second screen.
 */
export const round3ProjectorUrl = (sessionId = null, { display = false } = {}) => {
  const q = new URLSearchParams();
  if (sessionId) q.set('session', sessionId);
  if (display) q.set('view', 'display');
  const s = q.toString();
  return `/projector/round3${s ? `?${s}` : ''}`;
};

export function openRound3Projector(sessionId = null, { display = false } = {}) {
  const url = round3ProjectorUrl(sessionId, { display });
  const w = window.open(url, display ? 'brainfreze-display-round3' : 'brainfreze-projector-round3', 'popup=yes,width=1280,height=720');
  if (!w) window.location.assign(url);
  else w.focus();
}
