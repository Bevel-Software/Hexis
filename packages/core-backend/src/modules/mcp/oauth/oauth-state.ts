import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed carrier for a validated MCP OAuth authorization request across the
 * browser round-trip: `/authorize` packs the request into this state and
 * redirects to the SPA's `/connect?oauth=<state>`; the Finish endpoint
 * verifies it and issues the auth code. Same HMAC-base64url-JSON shape as the
 * secrets-vault OAuth state (see secrets-vault.routes.ts) — kept separate
 * because the payload differs and the two flows must not accept each other's
 * tokens (different field sets make cross-verification fail structurally).
 *
 * The state carries NO user identity: the user is whoever the Finish
 * endpoint authenticates (JWT or the bevel_token cookie). It only pins the
 * client's request so the issued code binds to exactly what was validated.
 */
export interface McpAuthRequestState {
  /** client_id of the registered OAuth client. */
  c: string;
  /** redirect_uri (already validated against the client's registration). */
  r: string;
  /** PKCE code_challenge (S256 — the SDK authorize handler enforces it). */
  cc: string;
  /** The client's own `state` parameter, echoed back on the code redirect. */
  s?: string;
  /** Requested scope (space-joined). */
  sc?: string;
  /** RFC 8707 resource indicator, if the client sent one. */
  rs?: string;
  /** Issued-at (epoch ms). */
  iat: number;
}

// Generous enough for the user to configure several tools on /connect, short
// enough that a leaked link goes stale the same session.
const STATE_MAX_AGE_MS = 30 * 60_000;
const STATE_SKEW_MS = 60_000;

export function signAuthRequest(secret: string, state: Omit<McpAuthRequestState, 'iat'>): string {
  const full: McpAuthRequestState = { ...state, iat: Date.now() };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAuthRequest(secret: string, token: string): McpAuthRequestState | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as McpAuthRequestState;
    if (typeof parsed.iat !== 'number' || !parsed.c || !parsed.r || !parsed.cc) return null;
    const age = Date.now() - parsed.iat;
    if (age > STATE_MAX_AGE_MS || age < -STATE_SKEW_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
