/**
 * Decide which backend the app may use. A production build must FAIL SAFE:
 * without valid Supabase configuration it shows a configuration error instead
 * of silently becoming an unauthenticated demo — unless the build explicitly
 * opts in with VITE_ALLOW_DEMO_MODE=true (for a rehearsal/demo deployment).
 */
export function resolveMode({ isDev, allowDemoFlag, supabaseConfigured, keyProblem }) {
  if (keyProblem) return { mode: 'error', error: keyProblem };
  if (supabaseConfigured) return { mode: 'supabase', error: null };
  if (isDev || allowDemoFlag) return { mode: 'demo', error: null };
  return {
    mode: 'error',
    error: 'This build has no valid Supabase configuration (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). '
      + 'Refusing to start in unauthenticated demo mode. Set the variables and rebuild, or build a demo explicitly with VITE_ALLOW_DEMO_MODE=true.',
  };
}
