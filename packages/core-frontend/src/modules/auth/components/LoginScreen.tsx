import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../state/auth.context';
import {
  startMicrosoftLogin,
  fetchLoginProviders,
  OAUTH_ERROR_KEY,
} from '../services/microsoft-oauth';

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state: 'Microsoft sign-in could not be verified. Please try again.',
  auth: 'Microsoft sign-in failed. Please try again.',
  start: 'Could not start Microsoft sign-in. Please try again.',
};

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Default to password-only until the probe resolves, matching fetchLoginProviders'
  // failure fallback so we never flash a button the backend can't service.
  const [passwordEnabled, setPasswordEnabled] = useState(true);
  const [microsoftEnabled, setMicrosoftEnabled] = useState(false);

  // Surface an error returned by the OAuth callback (stored by useAuthState),
  // and probe which login methods this deployment offers.
  useEffect(() => {
    let mounted = true;
    const oauthError = sessionStorage.getItem(OAUTH_ERROR_KEY);
    if (oauthError) {
      sessionStorage.removeItem(OAUTH_ERROR_KEY);
      setError(OAUTH_ERROR_MESSAGES[oauthError] ?? 'Microsoft sign-in failed.');
    }
    // Capability probe: never set state after unmount.
    fetchLoginProviders()
      .then((providers) => {
        if (!mounted) return;
        setPasswordEnabled(providers.password);
        setMicrosoftEnabled(providers.microsoft);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-full bg-white">
      <form
        onSubmit={handleSubmit}
        className="bg-white p-8 rounded-xl border border-line w-full max-w-sm space-y-5"
      >
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold text-ink">Bevel</h1>
          <p className="text-sm text-ink-muted">Sign in to continue</p>
        </div>

        {passwordEnabled && (
          <>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-ink-muted">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-ink-muted">Password</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-bevel text-white text-sm font-medium py-2 hover:bg-bevel-deep disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}

        {error && (
          <div className="text-sm text-red-600" role="alert">
            {error}
          </div>
        )}

        {passwordEnabled && microsoftEnabled && (
          <div className="flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {microsoftEnabled && (
          <button
            type="button"
            onClick={startMicrosoftLogin}
            className="w-full rounded-md border border-line-strong bg-white text-ink text-sm font-medium py-2 hover:bg-hover"
          >
            Sign in with Microsoft
          </button>
        )}
      </form>
    </div>
  );
}
