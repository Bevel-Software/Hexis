import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../state/auth.context';
import {
  startSsoLogin,
  fetchLoginProviders,
  OAUTH_ERROR_KEY,
  type SsoProvider,
} from '../services/sso';

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state: 'Sign-in could not be verified. Please try again.',
  auth: 'Sign-in failed. Please try again.',
  start: 'Could not start sign-in. Please try again.',
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
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([]);

  // Surface an error returned by an SSO callback (stored by useAuthState),
  // and probe which login methods this deployment offers.
  useEffect(() => {
    let mounted = true;
    const oauthError = sessionStorage.getItem(OAUTH_ERROR_KEY);
    if (oauthError) {
      sessionStorage.removeItem(OAUTH_ERROR_KEY);
      setError(OAUTH_ERROR_MESSAGES[oauthError] ?? 'Sign-in failed.');
    }
    // Capability probe: never set state after unmount.
    fetchLoginProviders()
      .then((providers) => {
        if (!mounted) return;
        setPasswordEnabled(providers.password);
        setSsoProviders(providers.sso);
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
        className="bg-white p-8 rounded-xl border border-slate-200 w-full max-w-sm space-y-5"
      >
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900">Bevel</h1>
          <p className="text-sm text-slate-600">Sign in to continue</p>
        </div>

        {passwordEnabled && (
          <>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Password</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400"
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

        {passwordEnabled && ssoProviders.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            or
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        )}

        {ssoProviders.map((provider) => (
          <button
            key={provider.key}
            type="button"
            onClick={() => startSsoLogin(provider)}
            className="w-full rounded-md border border-slate-300 bg-white text-slate-700 text-sm font-medium py-2 hover:bg-slate-50"
          >
            {provider.label}
          </button>
        ))}
      </form>
    </div>
  );
}
