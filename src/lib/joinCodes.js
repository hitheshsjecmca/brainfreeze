// Cryptographically secure random identifiers (Web Crypto). Same formats as
// the SQL generators in supabase/migrations/20261014000100_participants.sql.
export const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

const bytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Uniform six-digit code (rejection sampling, no modulo bias). */
export function randomJoinCode() {
  for (;;) {
    const [v] = globalThis.crypto.getRandomValues(new Uint32Array(1));
    if (v < 4294000000) return String(v % 1000000).padStart(6, '0');
  }
}

export function randomPin() {
  let pin = '';
  while (pin.length < 6) {
    for (const b of bytes(6)) if (b < 248 && pin.length < 6) pin += PIN_ALPHABET[b % 31];
  }
  return pin;
}

/** 256-bit device token as 64 hex characters. */
export function randomToken() {
  return [...bytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const normalizeJoinCode = (v) => String(v ?? '').replace(/[\s-]/g, '');
export const isJoinCode = (v) => /^\d{6}$/.test(normalizeJoinCode(v));
export const formatJoinCode = (c) => (c ? `${c.slice(0, 3)} ${c.slice(3)}` : '');

export const joinUrl = () => `${globalThis.location?.origin ?? ''}/join`;
