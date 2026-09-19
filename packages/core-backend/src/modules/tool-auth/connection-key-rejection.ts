import type { Response } from 'express';

/**
 * How every key-authenticated endpoint answers a bearer that LOOKS like a
 * connection key but does not verify (unknown, revoked, mistyped).
 *
 * Deliberately no `resource_metadata`: that parameter (RFC 9728) invites an
 * OAuth-capable client to discover our authorization server and start a
 * browser sign-in, which is the wrong answer to someone who configured a key —
 * signing in does not repair the key, and the invitation buries the one thing
 * they need to hear. A missing bearer or a bad OAuth token keeps the discovery
 * challenge; only this shape gets the plain sentence.
 *
 * The submitted key is never echoed, in the header, the body, or a log line.
 */
export const INVALID_CONNECTION_KEY_CHALLENGE =
  'Bearer error="invalid_token", error_description="Invalid or revoked connection key"';

export const INVALID_CONNECTION_KEY_MESSAGE =
  'Invalid or revoked connection key. Mint a new one in External agent access.';

export function rejectConnectionKey(res: Response): void {
  res.setHeader('WWW-Authenticate', INVALID_CONNECTION_KEY_CHALLENGE);
  res.status(401).json({ error: INVALID_CONNECTION_KEY_MESSAGE });
}
