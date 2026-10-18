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
