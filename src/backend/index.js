import { localBackend } from './localBackend.js';
import { supabaseBackend } from './supabaseBackend.js';
import { keyProblem, supabaseConfigured } from './supabaseClient.js';
import { resolveMode } from '../lib/mode.js';

const resolved = resolveMode({
  isDev: import.meta.env.DEV,
  allowDemoFlag: import.meta.env.VITE_ALLOW_DEMO_MODE === 'true',
  supabaseConfigured,
  keyProblem,
});

// When resolved.mode === 'error', App renders a configuration error screen and
// never touches this backend; the local backend is only a harmless placeholder.
export const backend = resolved.mode === 'supabase' ? supabaseBackend : localBackend;
export const isDemoMode = resolved.mode === 'demo';
export const configProblem = resolved.error;
export const participantApi = backend.participant;
export const registrationApi = backend.registration;
