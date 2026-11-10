import { getToken } from '../../../lib/api';

/**
 * The account the stored session token belongs to: its `userId` claim, or
 * null when there is no token or it cannot be read.
 *
 * The stored token is the one every request of this browser carries, and
 * every tab shares it: a sign-in in another tab replaces it, while this tab's
 * auth state still names the account it signed in as. Something decided for
 * that account (a page's remembered Allow) compares the two before it acts,
 * so nothing decided for one account is sent with another's token. The claim
 * is read, not verified: the server verifies the token on every request, and
 * this only asks whose it is. A token renewed for the same account (a
 * password change) keeps its account.
 */
export function tokenAccountId(): string | null {
  try {
    const token = getToken();
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
