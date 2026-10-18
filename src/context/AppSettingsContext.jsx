import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { backend } from '../backend/index.js';
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '../lib/appSettings.js';
import { toQuizError } from '../lib/errors.js';
import { useAuth } from './AuthContext.jsx';

const AppSettingsContext = createContext(null);

/**
 * Event-wide settings (Round 3 Availability), loaded for signed-in organizers. Fails closed: until the settings
 * load — or if they cannot be loaded — Round 3 counts as disabled. The database enforces the same rule on every
 * Round 3 call, so this only decides what the interface shows.
 */
export function AppSettingsProvider({ children }) {
  const { loading: authLoading, user, organizer } = useAuth();
  const [state, setState] = useState({ loading: true, settings: DEFAULT_APP_SETTINGS, error: null });
  const userId = user?.id ?? null;

  const refresh = useCallback(async () => {
    if (!organizer) { setState({ loading: false, settings: DEFAULT_APP_SETTINGS, error: null }); return; }
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ loading: false, settings: normalizeAppSettings(await backend.appSettings.get()), error: null });
    } catch (e) {
      setState({ loading: false, settings: DEFAULT_APP_SETTINGS, error: toQuizError(e) });
    }
  }, [organizer]);

  // Reload on every sign-in (and sign-out), so a new login always sees the stored value.
  useEffect(() => {
    if (authLoading) return;
    refresh();
  }, [authLoading, userId, refresh]);

  const value = useMemo(() => ({
    ...state,
    loading: authLoading || state.loading,
    round3Enabled: state.settings.round3_enabled,
    refresh,
    async setRound3Enabled(enabled) {
      const settings = normalizeAppSettings(await backend.appSettings.setRound3Enabled(enabled));
      setState({ loading: false, settings, error: null });
      return settings;
    },
  }), [state, authLoading, refresh]);

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAppSettings = () => useContext(AppSettingsContext);
