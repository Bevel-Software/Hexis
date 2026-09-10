import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyKindSpec, MintedExternalApiKey } from '../../tool-auth/external-api-key.interface.js';
import { signAuthRequest, type McpAuthRequestState } from '../../mcp/oauth/oauth-state.js';
import type { GitHubFacadeCredentialsService } from './github-facade-credentials.service.js';
import type { GitHubFacadeCodeStore } from './github-facade-codes.store.js';
import { printable } from '../../../shared/printable.js';

/**
 * The KIND stored on a connection key minted through the facade, and how
 * that kind is spelled. `gho_` plus forty letters and digits is what a
 * GitHub OAuth token looks like — the shape a consumer expecting a GitHub
 * Enterprise host accepts, and may well check; the key is otherwise an
 * ordinary connection key — hashed at rest, revocable from the person's
 * external-agent page, accepted by every surface a connection key is. The
 * kind, not the label, is what tells such a key apart: a label is the
 * person's to edit.
 */
export const GITHUB_LINK_KEY_KIND = 'github-link';
export const GITHUB_LINK_KEY_PREFIX = 'gho_';
export const GITHUB_LINK_KEY_SPEC: KeyKindSpec = { prefix: GITHUB_LINK_KEY_PREFIX, shape: 'github-token' };

/**
 * A product that talks to this deployment as if it were a GitHub Enterprise
 * Server. The facade itself is consumer-neutral — GitHub's OAuth pair and
 * REST subset are the contract — and a consumer is the one thing that is not:
 * where its callback lives (the only place a code may be sent), what the
 * consent page calls it, and how the keys it holds are labelled for the
 * person. Claude is the first; another product with a "connect your GitHub
 * Enterprise" flow is one more entry, not one more module.
 */
export interface GitHubFacadeConsumer {
  id: string;
  /** What the consent page says is asking. */
  name: string;
  /** Hostnames a redirect_uri may point at. */
  redirectHosts: readonly string[];
  /** The label on the connection keys minted for this consumer. */
  keyLabel: string;
}

/** claude.ai and Cowork: the consumer this facade was built against. */
export const CLAUDE_CONSUMER: GitHubFacadeConsumer = {
  id: 'claude',
  name: 'Claude',
  redirectHosts: ['claude.ai'],
  keyLabel: 'Claude (claude.ai and Cowork)',
};

const CODE_TTL_MS = 10 * 60_000;
const CODE_BYTES = 10;

export interface GitHubFacadeKeyMinter {
  mint(userId: string, label: string, options?: { kind?: string }): Promise<MintedExternalApiKey>;
}

export interface GitHubFacadeDeps {
  credentials: GitHubFacadeCredentialsService;
  codes: GitHubFacadeCodeStore;
  keys: GitHubFacadeKeyMinter;
  /** Who may connect through the facade. */
  consumers: readonly GitHubFacadeConsumer[];
  /** HMAC secret for the signed authorize state — the same one the MCP flow uses. */
  stateSecret: string;
  /** SPA base URL — where the browser is sent to sign in and approve. */
  publicFrontendUrl: string;
}

/**
 * A refusal the caller is answered with in GitHub's terms — and, for the
 * server log only, WHY: `detail` names the check that failed (a client
 * secret that is not the registered one, a code nobody issued) where the
 * response deliberately says no more than GitHub would. A consumer's
 * backend never shows its user what we answered; the log is the only place
 * an operator can see which hop of the connect flow went wrong. It never
 * carries a secret or a code.
 */
export class GitHubFacadeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: string = message,
  ) {
    super(message);
    this.name = 'GitHubFacadeRequestError';
  }
}

/**
 * The "connect your GitHub Enterprise account" flow, as a consumer such as claude.ai drives it
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
export class GitHubFacade {
  constructor(private readonly deps: GitHubFacadeDeps) {}

  /** Where to send the browser for an authorize request, or a 4xx to answer with. */
  async authorizeRedirect(query: Record<string, unknown>): Promise<string> {
    const clientId = str(query.client_id);
    const redirectUri = str(query.redirect_uri);
    const state = str(query.state);
    const creds = await this.deps.credentials.ensure();
    if (!clientId || !safeEqual(clientId, creds.clientId)) {
      throw new GitHubFacadeRequestError(
        400,
        'unknown_client',
        'Unknown client_id.',
        clientId ? 'client_id is not the registered one (rotated since, or mistyped)' : 'no client_id in the request',
      );
    }
    if (!this.consumerFor(redirectUri)) {
      throw new GitHubFacadeRequestError(
        400,
        'invalid_redirect',
        'redirect_uri does not belong to a known consumer.',
        `redirect_uri host is ${hostOf(redirectUri)}, not a consumer's`,
      );
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

  /** True when a verified state is one of ours (a GitHub-shaped link, not an MCP client). */
  isFacadeRequest(st: McpAuthRequestState): boolean {
    return st.gh === true;
  }

  /** What the consent page should say is asking, for one of our states. */
  clientNameFor(st: McpAuthRequestState): string {
    return this.consumerFor(st.r)?.name ?? 'an external product';
  }

  /**
   * The person approved on `/connect`: a one-time code for them, and the
   * claude.ai callback to send the browser to. Supersedes any live code the
   * same person already had for this client.
   */
  async completeConsent(userId: string, st: McpAuthRequestState): Promise<{ redirectTo: string }> {
    const creds = await this.deps.credentials.ensure();
    if (!safeEqual(st.c, creds.clientId) || !this.consumerFor(st.r)) {
      throw new GitHubFacadeRequestError(400, 'invalid_request', 'The authorization request is not one of ours.');
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
    // One answer for every credential failure, as GitHub gives; the log
    // alone says which half was wrong.
    const credentialsWrong = (detail: string) =>
      new GitHubFacadeRequestError(
        401,
        'incorrect_client_credentials',
        'The client_id and/or client_secret passed are incorrect.',
        detail,
      );
    if (!clientId || !safeEqual(clientId, creds.clientId)) {
      throw credentialsWrong(clientId ? 'client_id is not the registered one (rotated since, or mistyped)' : 'no client_id in the request');
    }
    if (!clientSecret || !safeEqual(clientSecret, creds.clientSecret)) {
      throw credentialsWrong(clientSecret ? 'client_secret is not the registered one (rotated since, or mistyped)' : 'no client_secret in the request');
    }
    const codeWrong = (detail: string) =>
      new GitHubFacadeRequestError(400, 'bad_verification_code', 'The code passed is incorrect or expired.', detail);
    if (!code) throw codeWrong('no code in the request');
    const pending = await this.deps.codes.peek(hashCode(code));
    if (!pending) throw codeWrong('no live code with that value: never issued, already spent, or older than 10 minutes');
    if (pending.clientId !== clientId) throw codeWrong('the code was issued under a different client id');
    const redirectUri = str(body.redirect_uri);
    if (redirectUri && redirectUri !== pending.redirectUri) {
      throw new GitHubFacadeRequestError(
        400,
        'redirect_uri_mismatch',
        'The redirect_uri does not match the authorization.',
        `redirect_uri host is ${hostOf(redirectUri)}, the code was issued for ${hostOf(pending.redirectUri)}`,
      );
    }
    const spent = await this.deps.codes.consume(pending.codeHash);
    if (!spent) throw codeWrong('the code was spent by a concurrent exchange');
    // The consumer is the one the code was issued for — the redirect the
    // person approved names it — so the key is labelled for that product.
    const consumer = this.consumerFor(spent.redirectUri);
    const minted = await this.deps.keys.mint(spent.userId, consumer?.keyLabel ?? 'GitHub-compatible link', {
      kind: GITHUB_LINK_KEY_KIND,
    });
    console.info(
      `[github-facade] ${printable(consumer?.name ?? 'a consumer')} connected user ${printable(spent.userId)}: link key ${printable(minted.summary.id)} minted`,
    );
    return { access_token: minted.plaintext, token_type: 'bearer', scope: '' };
  }

  /** The consumer whose callback a redirect_uri is, or null — https only, host exactly. */
  private consumerFor(redirectUri: string): GitHubFacadeConsumer | null {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    return this.deps.consumers.find((c) => c.redirectHosts.includes(parsed.hostname)) ?? null;
  }
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * The host of a URL for a log line, or what was sent when it is not one.
 * The caller chose the URL, so the host is rendered printable even though a
 * parsed host is ASCII: the log's one-line rule holds by construction, not
 * by an argument about URL parsing.
 */
function hostOf(url: string): string {
  try {
    const host = new URL(url).host;
    return host ? printable(host) : '(empty)';
  } catch {
    return url ? '(not a URL)' : '(empty)';
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
