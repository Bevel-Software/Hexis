import { authFetch, getToken } from '../../../lib/api';

/**
 * The account a session token belongs to: its `userId` claim, or null when
 * there is no token or it cannot be read. The claim is read, not verified:
 * the server verifies the token on every request, and this only asks whose it
 * is. A token renewed for the same account (a password change) keeps its
 * account.
 */
function accountOf(token: string | null): string | null {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { userId?: unknown };
    return typeof claims.userId === 'string' && claims.userId ? claims.userId : null;
  } catch {
    return null;
  }
}

/** What `accountFetch` throws, sending nothing, when the session is not the expected account's. */
export class AccountChangedError extends Error {
  constructor() {
    super('You signed in as another account in another tab. Reload this page to use its tools as that account.');
    this.name = 'AccountChangedError';
  }
}

/**
 * A fetch that sends only as `accountId`. The stored session token is shared
 * by every tab: a sign-in in another tab replaces it, while this tab's auth
 * state still names the account it signed in as. Something decided for that
 * account (a page's remembered Allow) must not reach the server with another
 * account's token. Each request reads the token ONCE, throws
 * `AccountChangedError` without sending anything unless it is `accountId`'s
 * (no token, or one that cannot be read, included), and sends exactly that
 * token, so a token swapped in after the check is never the one sent.
 */
export function accountFetch(accountId: string): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let token: string | null;
    try {
      token = getToken();
    } catch {
      token = null;
    }
    if (accountOf(token) !== accountId) throw new AccountChangedError();
    return authFetch(input, init, { token });
  };
}
