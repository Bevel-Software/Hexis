import type { Response } from 'express';
import { ACCOUNT_DEACTIVATED_MESSAGE } from '../auth/account-admission.js';

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

/**
 * A live key whose account an admin switched off: still a plain
 * `invalid_token` (no sign-in invitation, see above), but told the real
 * reason — telling them to mint a new key would send them to something
 * they cannot do.
 */
export const SWITCHED_OFF_CONNECTION_KEY_CHALLENGE =
  'Bearer error="invalid_token", error_description="The account of this connection key is switched off"';

export function rejectConnectionKey(res: Response, opts: { switchedOff?: boolean } = {}): void {
  res.setHeader('WWW-Authenticate', opts.switchedOff ? SWITCHED_OFF_CONNECTION_KEY_CHALLENGE : INVALID_CONNECTION_KEY_CHALLENGE);
  res.status(401).json({ error: opts.switchedOff ? ACCOUNT_DEACTIVATED_MESSAGE : INVALID_CONNECTION_KEY_MESSAGE });
}
