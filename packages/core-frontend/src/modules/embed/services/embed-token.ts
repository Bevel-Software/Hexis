/**
 * The outside account the token names, read from its payload for DISPLAY
 * only — the server verifies the signature when the link is posted, and
 * nothing here trusts what it decodes. Null when the token is not a JWT this
 * page can read.
 */
export function outsideAccountOf(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // The payload is UTF-8: `atob` alone would hand an account name with a
    // non-ASCII character to the page as mojibake.
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: unknown; sub?: unknown; accountId?: unknown };
    if (claims.kind === 'atlassian' && typeof claims.sub === 'string') return claims.sub;
    // A token from the release before the subject was generalised names the
    // account as `accountId`; the server still accepts it for its lifetime.
    return typeof claims.accountId === 'string' && claims.accountId ? claims.accountId : null;
  } catch {
    return null;
  }
}
