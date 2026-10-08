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
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { kind?: unknown; sub?: unknown };
    return claims.kind === 'atlassian' && typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}
