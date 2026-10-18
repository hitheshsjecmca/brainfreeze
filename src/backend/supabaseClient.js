import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();

function decodeJwtRole(token) {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).role || null;
  } catch {
    return null;
  }
}

// Refuse to run with a privileged key in the browser bundle.
export const keyProblem = (() => {
  if (!key) return null;
  if (key.startsWith('sb_secret_') || decodeJwtRole(key) === 'service_role') {
    return 'A SERVICE-ROLE / SECRET key was supplied to the browser. Remove it from your environment immediately, rotate it in Supabase, and use the anon/publishable key instead.';
  }
  return null;
})();

const placeholder = !url || !key || url.includes('YOUR_PROJECT') || key.includes('YOUR_');

export const supabaseConfigured = !placeholder && !keyProblem;

export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;
