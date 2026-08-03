import { useState, useCallback, useEffect, useMemo } from 'react';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { AuthContextValue } from '../state/auth.context';
import { loginWithPassword, fetchCurrentUser } from '../services/auth.api';
import { getToken, setToken, clearToken } from '../../../lib/api';
import { consumeSsoCallback, OAUTH_ERROR_KEY } from '../services/sso';

export function useAuthState(): AuthContextValue {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setTokenState] = useState<string | null>(getToken());
  const [isLoading, setIsLoading] = useState(true);

  // On mount: first absorb an SSO OAuth callback (if we landed on one),
  // then validate whatever token we have (from the callback or localStorage).
  useEffect(() => {
    const cb = consumeSsoCallback();
    if (cb.error) {
      sessionStorage.setItem(OAUTH_ERROR_KEY, cb.error);
    }
    if (cb.token) {
      setToken(cb.token);
      setTokenState(cb.token);
    }
    const activeToken = cb.token ?? getToken();
    if (!activeToken) {
      setIsLoading(false);
      return;
    }

    fetchCurrentUser()
      .then(setUser)
      .catch(() => {
        clearToken();
        setTokenState(null);
      })
      .finally(() => setIsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginWithPassword(email, password);
    setToken(result.token);
    setTokenState(result.token);
    setUser(result.user);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
  }, []);

  return useMemo(() => ({
    user,
    token,
    isLoading,
    login,
    logout,
  }), [user, token, isLoading, login, logout]);
}
