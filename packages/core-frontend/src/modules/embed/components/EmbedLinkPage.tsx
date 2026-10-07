import { useEffect, useState, type ReactNode } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { useAuthState } from '../../auth/hooks/useAuthState';
import { LoginScreen } from '../../auth/components/LoginScreen';
import { getToken } from '../../../lib/api';
import { linkEmbedAccount } from '../services/embed.api';

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-white px-6 text-center text-sm text-ink">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

/**
 * The account-link page, opened in a new tab when an embed viewer whose
 * outside account is not yet linked clicks Edit. It signs them in the ordinary
 * way and then links the account the embed token carries to the user they
 * just authenticated as.
 *
 * THIS PAGE IS NEVER FRAMED, and that is the whole reason it is a page of its
 * own rather than a step inside the embed. It acts under the signed-in
 * session, so a page that could frame it could link a foreign account to
 * whoever happened to be signed in — and from then on read and write the
 * knowledge base as them. The server sends `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` for exactly this route; the embed page, which acts
 * under a token alone, sends no framing restriction at all.
 */
export function EmbedLinkPage() {
  const auth = useAuthState();
  const token = tokenFromUrl();
  const [status, setStatus] = useState<'idle' | 'linking' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.user || !token || status !== 'idle') return;
    setStatus('linking');
    linkEmbedAccount(token, getToken())
      .then(() => setStatus('done'))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Linking failed.');
        setStatus('error');
      });
  }, [auth.user, token, status]);

  return (
    <AuthContext.Provider value={auth}>
      {auth.isLoading ? (
        <Centered>Loading…</Centered>
      ) : !auth.user ? (
        <LoginScreen />
      ) : !token ? (
        <Centered>This link has no token. Open it again from the page in your chat.</Centered>
      ) : status === 'done' ? (
        <Centered>
          <p className="mb-1 text-base font-semibold text-ink">Account linked</p>
          <p>
            Your account is connected. Close this tab, go back to the page and click{' '}
            <strong>Edit</strong> again.
          </p>
        </Centered>
      ) : status === 'error' ? (
        <Centered>
          <p role="alert" className="text-danger">
            Could not link your account: {error}
          </p>
        </Centered>
      ) : (
        <Centered>Linking your account…</Centered>
      )}
    </AuthContext.Provider>
  );
}
