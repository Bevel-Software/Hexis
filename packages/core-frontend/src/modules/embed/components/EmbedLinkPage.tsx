import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '../../../shared/components';
import { AuthContext } from '../../auth/state/auth.context';
import { useAuthState } from '../../auth/hooks/useAuthState';
import { LoginScreen } from '../../auth/components/LoginScreen';
import { getToken } from '../../../lib/api';
import { linkEmbedAccount } from '../services/embed.api';
import { outsideAccountOf } from '../services/embed-token';

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
 * way and then — once they CONFIRM it, naming both accounts — links the
 * account the embed token carries to the user they just authenticated as.
 *
 * The confirmation is not a courtesy. A link to this page can be crafted by
 * anybody holding a token for their own outside account; followed silently by
 * a signed-in victim, it would bind the attacker's account to the victim's,
 * and hand the attacker the victim's knowledge-base access from then on.
 * Refusing to be framed does nothing against a top-level link, so nothing is
 * linked until the person who is signed in says so.
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
  const [status, setStatus] = useState<'idle' | 'linking' | 'done' | 'declined' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const outside = outsideAccountOf(token);

  const onLink = useCallback(() => {
    setStatus('linking');
    linkEmbedAccount(token, getToken())
      .then(() => setStatus('done'))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Linking failed.');
        setStatus('error');
      });
  }, [token]);

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
            {/* Not "click Edit": whether the page offers Edit or Propose
                changes depends on this person's access, which this page
                does not know. */}
            Your account is connected. Close this tab and reload the page you came from.
          </p>
        </Centered>
      ) : status === 'error' ? (
        <Centered>
          <p role="alert" className="text-danger">
            Could not link your account: {error}
          </p>
        </Centered>
      ) : status === 'declined' ? (
        <Centered>Nothing was linked. You can close this tab.</Centered>
      ) : status === 'linking' ? (
        <Centered>Linking your account…</Centered>
      ) : (
        <Centered>
          <p className="mb-1 text-base font-semibold text-ink">Link your Atlassian account?</p>
          <p className="mb-3">
            The Atlassian account{' '}
            {outside ? <code className="break-all">{outside}</code> : 'in this link'} will read and edit
            this knowledge base as <strong>{auth.user.email}</strong>. Only continue if you opened this
            link yourself, from a page in Jira or Confluence.
          </p>
          <span className="flex justify-center gap-2">
            <Button variant="quiet" size="sm" onClick={() => setStatus('declined')}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={onLink}>
              Link accounts
            </Button>
          </span>
        </Centered>
      )}
    </AuthContext.Provider>
  );
}
