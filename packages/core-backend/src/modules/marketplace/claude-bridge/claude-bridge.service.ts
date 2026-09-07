import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MintedExternalApiKey } from '../../tool-auth/external-api-key.interface.js';
import { signAuthRequest, type McpAuthRequestState } from '../../mcp/oauth/oauth-state.js';
import type { ClaudeBridgeCredentialsService } from './claude-bridge-credentials.service.js';
import type { ClaudeBridgeCodeStore } from './claude-bridge-codes.store.js';

/**
 * The KIND stored on a connection key minted for a Claude link, and the
 * plaintext prefix that kind is minted with. `gho_` is what a GitHub OAuth
 * token looks like, and the shape claude.ai has been seen to accept from a
 * GitHub Enterprise host; the key is otherwise an ordinary connection key —
 * hashed at rest, revocable from the person's external-agent page, accepted
 * by every surface a connection key is. The kind, not the label, is what
 * tells such a key apart: a label is the person's to edit.
 */
export const CLAUDE_LINK_KEY_KIND = 'claude-link';
export const CLAUDE_LINK_KEY_PREFIX = 'gho_';

/** The label those keys carry, so the person recognises them in their list. */
export const CLAUDE_LINK_KEY_LABEL = 'Claude (claude.ai and Cowork)';

/** What "connect your GitHub Enterprise account" says on the consent page. */
export const CLAUDE_CLIENT_NAME = 'Claude';

/** The only place a code may be sent back to: claude.ai's own callback. */
const ALLOWED_REDIRECT_HOSTS = new Set(['claude.ai']);

const CODE_TTL_MS = 10 * 60_000;
const CODE_BYTES = 10;

export interface ClaudeBridgeKeyMinter {
  mint(userId: string, label: string, options?: { kind?: string }): Promise<MintedExternalApiKey>;
}

export interface ClaudeMarketplaceBridgeDeps {
  credentials: ClaudeBridgeCredentialsService;
  codes: ClaudeBridgeCodeStore;
  keys: ClaudeBridgeKeyMinter;
  /** HMAC secret for the signed authorize state — the same one the MCP flow uses. */
  stateSecret: string;
  /** SPA base URL — where the browser is sent to sign in and approve. */
  publicFrontendUrl: string;
}

export class ClaudeBridgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeBridgeRequestError';
  }
}

/**
 * The "connect your GitHub Enterprise account" flow, as claude.ai drives it
 * against a GitHub Enterprise host — with hexis standing where GitHub would.
 *
 *   1. The browser lands on `/login/oauth/authorize?client_id&redirect_uri&state`.
 *      We check the client id is ours and the redirect goes to claude.ai,
 *      pack the request into the SAME signed state the MCP authorization
 *      flow uses, and send the browser to the SPA's `/connect` page — where a
 *      hexis session (or a sign-in) attaches a person to the request.
 *   2. Finish on that page comes back through the consent routes with the
 *      state; {@link completeConsent} stores a one-time code bound to that
 *      person and returns the callback URL carrying it.
 *   3. Anthropic's backend posts the code with our client id and secret to
 *      `/login/oauth/access_token`; {@link exchangeCode} turns it into a
 *      connection key for that person — the token every later fetch carries.
 *
 * Nothing here is remembered in the process: credentials and codes are read
 * from their stores on every step, so the replica that issued a code and the
 * replica that exchanges it need not be the same one.
 */
export class ClaudeMarketplaceBridge {
  constructor(private readonly deps: ClaudeMarketplaceBridgeDeps) {}

  /** Where to send the browser for an authorize request, or a 4xx to answer with. */
  async authorizeRedirect(query: Record<string, unknown>): Promise<string> {
    const clientId = str(query.client_id);
    const redirectUri = str(query.redirect_uri);
    const state = str(query.state);
    const creds = await this.deps.credentials.ensure();
    if (!clientId || !safeEqual(clientId, creds.clientId)) {
      throw new ClaudeBridgeRequestError(400, 'unknown_client', 'Unknown client_id.');
    }
    if (!isAllowedRedirect(redirectUri)) {
      throw new ClaudeBridgeRequestError(400, 'invalid_redirect', 'redirect_uri is not a Claude callback.');
    }
    const signed = signAuthRequest(this.deps.stateSecret, {
      c: clientId,
      r: redirectUri,
      s: state || undefined,
      gh: true,
    });
    const url = new URL('/connect', this.deps.publicFrontendUrl);
    url.searchParams.set('oauth', signed);
    return url.toString();
  }

  /** True when a verified state is one of ours (a Claude link, not an MCP client). */
  isBridgeRequest(st: McpAuthRequestState): boolean {
    return st.gh === true;
  }

  /**
   * The person approved on `/connect`: a one-time code for them, and the
   * claude.ai callback to send the browser to. Supersedes any live code the
   * same person already had for this client.
   */
  async completeConsent(userId: string, st: McpAuthRequestState): Promise<{ redirectTo: string }> {
    const creds = await this.deps.credentials.ensure();
    if (!safeEqual(st.c, creds.clientId) || !isAllowedRedirect(st.r)) {
      throw new ClaudeBridgeRequestError(400, 'invalid_request', 'The authorization request is not a Claude link.');
    }
    const code = randomBytes(CODE_BYTES).toString('hex');
    await this.deps.codes.put({
      codeHash: hashCode(code),
      userId,
      clientId: st.c,
      redirectUri: st.r,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    const url = new URL(st.r);
    url.searchParams.set('code', code);
    if (st.s) url.searchParams.set('state', st.s);
    return { redirectTo: url.toString() };
  }

  /**
   * The token exchange. Client id and secret must be ours and the code live;
   * every check runs BEFORE the code is spent, so a request that is wrong
   * about something else (its redirect, say) can be corrected and retried.
   * Spending is one conditional update in the store — the first exchange
   * wins, on whichever replica, and only the winner mints.
   */
  async exchangeCode(body: Record<string, unknown>): Promise<{
    access_token: string;
    token_type: 'bearer';
    scope: '';
  }> {
    const creds = await this.deps.credentials.ensure();
    const clientId = str(body.client_id);
    const clientSecret = str(body.client_secret);
    const code = str(body.code);
    if (!clientId || !clientSecret || !safeEqual(clientId, creds.clientId) || !safeEqual(clientSecret, creds.clientSecret)) {
      throw new ClaudeBridgeRequestError(401, 'incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.');
    }
    const pending = code ? await this.deps.codes.peek(hashCode(code)) : null;
    if (!pending || pending.clientId !== clientId) {
      throw new ClaudeBridgeRequestError(400, 'bad_verification_code', 'The code passed is incorrect or expired.');
    }
    const redirectUri = str(body.redirect_uri);
    if (redirectUri && redirectUri !== pending.redirectUri) {
      throw new ClaudeBridgeRequestError(400, 'redirect_uri_mismatch', 'The redirect_uri does not match the authorization.');
    }
    const spent = await this.deps.codes.consume(pending.codeHash);
    if (!spent) {
      throw new ClaudeBridgeRequestError(400, 'bad_verification_code', 'The code passed is incorrect or expired.');
    }
    const minted = await this.deps.keys.mint(spent.userId, CLAUDE_LINK_KEY_LABEL, { kind: CLAUDE_LINK_KEY_KIND });
    return { access_token: minted.plaintext, token_type: 'bearer', scope: '' };
  }
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
