import { useEffect, useRef, useState } from 'react';
import { remainingMs } from './timer.js';

/** Current time corrected by the measured server clock offset. */
export function useServerNow(offsetMs = 0, intervalMs = 250) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offsetMs), intervalMs);
    return () => clearInterval(id);
  }, [offsetMs, intervalMs]);
  return now;
}

/**
 * Form state autosaved to localStorage. Only differences from `initial` are
 * stored, so an untouched form leaves no draft behind.
 */
export function useDraft(key, initial) {
  const initialJson = useRef(JSON.stringify(initial));
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        const json = JSON.stringify(value);
        if (json === initialJson.current) localStorage.removeItem(key);
        else localStorage.setItem(key, json);
      } catch { /* storage full or disabled */ }
    }, 300);
    return () => clearTimeout(id);
  }, [key, value]);
  const clear = () => { try { localStorage.removeItem(key); } catch { /* ignore */ } };
  return [value, setValue, clear];
}

/** Live remaining time (ms) for the quiz timer. */
export function useRemaining(session, settings, offsetMs) {
  const now = useServerNow(offsetMs);
  return remainingMs(session, settings, now);
}
