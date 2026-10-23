import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { backend } from '../backend/index.js';
import { toQuizError } from '../lib/errors.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // organizer: may open the quiz console (re-checked by the database on every call).
  const [state, setState] = useState({ loading: true, user: null, organizer: false, error: '' });

  const evaluate = useCallback(async (user) => {
    if (!user) {
      setState({ loading: false, user: null, organizer: false, error: '' });
      return;
    }
    try {
      const organizer = !!(await backend.isOrganizer());
      setState({ loading: false, user, organizer, error: organizer ? '' : 'This account is signed in but is not listed as an organizer.' });
    } catch (e) {
      setState({ loading: false, user, organizer: false, error: toQuizError(e).message });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    backend.getUser().then((u) => alive && evaluate(u)).catch((e) => alive && setState({ loading: false, user: null, organizer: false, error: toQuizError(e).message }));
    const off = backend.onAuthChange((u) => alive && evaluate(u));
    return () => { alive = false; off(); };
  }, [evaluate]);

  const value = useMemo(() => ({
    ...state,
    async signIn(email, password) {
      const user = await backend.signIn(email, password);
      await evaluate(user);
      return user;
    },
    async signOut() {
      await backend.signOut();
      setState({ loading: false, user: null, organizer: false, error: '' });
    },
  }), [state, evaluate]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
