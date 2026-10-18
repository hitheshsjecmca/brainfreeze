// Event-wide settings shared by every round (Supabase: public.app_settings via get_app_settings /
// set_round3_enabled; demo: state.app_settings). Round 3 is disabled unless an organizer enables it.
import { fail } from './errors.js';

export const DEFAULT_APP_SETTINGS = Object.freeze({ round3_enabled: false, updated_at: null });

export const normalizeAppSettings = (raw) => ({
  round3_enabled: raw?.round3_enabled === true,
  updated_at: raw?.updated_at ?? null,
});

/** Demo backend guard (the database does the same in every r3s_* function). Returns the state for chaining. */
export function requireRound3(state) {
  if (!normalizeAppSettings(state?.app_settings).round3_enabled) fail('ROUND3_DISABLED');
  return state;
}
