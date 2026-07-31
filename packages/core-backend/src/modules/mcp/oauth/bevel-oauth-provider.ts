import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Database } from '../../database/connection.js';
import { oauthAuthCodes, oauthClients, oauthTokens, users } from '../../database/schema.js';
import type { TokenCrypto } from '../../../shared/token-crypto.js';
import { signAuthRequest, type McpAuthRequestState } from './oauth-state.js';

// Same entropy as connection keys: 32 random bytes, base64url. The prefix
// (`<tenant>-mcp_`) routes the bearer in the MCP auth middleware without
// colliding with connection keys (`<tenant>_`) or internal tokens
// (`<tenant>-int_`).
const TOKEN_BYTES = 32;

const ACCESS_TTL_MS = 60 * 60_000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days, rotated on use
const CODE_TTL_MS = 60_000; // exchanged within seconds of Finish

export interface BevelOAuthProviderDeps {
  db: Database;
  /**
   * Encrypts confidential-client secrets at rest (tokens/codes are hashed).
   * Null when no encryption key is configured — public (PKCE-only) clients,
   * which is what MCP clients register as, work regardless; only registering
   * a CONFIDENTIAL client then fails, with a clear error.
   */
  crypto: TokenCrypto | null;
  /** HMAC secret for the authorize→/connect→finish signed state. */
  stateSecret: string;
  /** SPA base URL — where `authorize` sends the browser (the /connect page). */
  publicFrontendUrl: string;
  /** Access-token plaintext prefix, e.g. `bevel-mcp_`. */
  tokenPrefix: string;
}

/**
 * Our own OAuth 2.1 authorization server for the MCP endpoint, backed by the
 * `oauth_*` tables. Mounted through the MCP SDK's `mcpAuthRouter`, which owns
 * request validation (client lookup, redirect_uri matching, PKCE S256
 * enforcement) and calls into this provider for the actual decisions.
 *
 * The deliberate twist: `authorize` does NOT authenticate the user — the SDK
 * hands it no request, so there is no cookie to read. It packs the validated
 * request into a signed state and sends the browser to the SPA's `/connect`
 * page; the JWT/cookie-authed Finish endpoint (oauth-consent.routes.ts) is
 * where a Bevel user attaches to the flow, via `issueAuthCode`.
 */
export class BevelOAuthProvider implements OAuthServerProvider {
  private readonly store: OAuthRegisteredClientsStore;

  constructor(private readonly deps: BevelOAuthProviderDeps) {
    this.store = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.store;
  }

  private get refreshPrefix(): string {
    return `${this.deps.tokenPrefix}r_`;
  }

  /**
   * True if a bearer string carries this tenant's MCP OAuth access-token
   * prefix — the routing predicate for the middleware's OAuth branch (a
   * refresh token shares the prefix but fails verification by hash miss).
   */
  looksLikeAccessToken(token: string): boolean {
    return typeof token === 'string' && token.startsWith(this.deps.tokenPrefix);
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (!row) return undefined;
    // `metadata` snapshots the full registration object minus the secret, so
    // rebuilding is a spread; only the secret needs decrypting back in (the
    // SDK's token-endpoint client auth compares it in plaintext).
    return {
      ...(row.metadata as OAuthClientInformationFull),
      client_id: row.clientId,
      client_secret:
        row.clientSecretEncrypted && this.deps.crypto
          ? this.deps.crypto.decrypt(row.clientSecretEncrypted)
          : undefined,
    };
  }

  private async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    // Despite the Omit type, the SDK register handler generates client_id /
    // client_id_issued_at before calling us (register.js), so the runtime
    // object is complete.
    const full = client as OAuthClientInformationFull;
    const { client_secret: secret, ...publicMetadata } = full;
    if (secret && !this.deps.crypto) {
      throw new Error(
        'Cannot register a confidential OAuth client: no encryption key configured (set CONNECTOR_CONFIG_ENC_KEY).',
      );
    }
    await this.deps.db.insert(oauthClients).values({
      clientId: full.client_id,
      clientSecretEncrypted: secret && this.deps.crypto ? this.deps.crypto.encrypt(secret) : null,
      // `0` is the RFC 7591 "never expires" sentinel — store as NULL.
      clientSecretExpiresAt: full.client_secret_expires_at
        ? new Date(full.client_secret_expires_at * 1000)
        : null,
      redirectUris: full.redirect_uris ?? [],
      tokenEndpointAuthMethod: full.token_endpoint_auth_method ?? 'none',
      clientName: full.client_name ?? null,
      metadata: publicMetadata,
    });
    return full;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // The SDK handler has already validated client, redirect_uri, and PKCE
    // method. No user yet (this is a bare browser navigation) — defer
    // identity to the authed Finish endpoint by carrying the request in a
    // signed state through the /connect page.
    const state = signAuthRequest(this.deps.stateSecret, {
      c: client.client_id,
      r: params.redirectUri,
      cc: params.codeChallenge,
      s: params.state,
      sc: params.scopes?.length ? params.scopes.join(' ') : undefined,
      rs: params.resource?.href,
    });
    const url = new URL('/connect', this.deps.publicFrontendUrl);
    url.searchParams.set('oauth', state);
    res.redirect(302, url.toString());
  }

  /**
   * Called by the Finish endpoint once an authenticated user completes the
   * /connect step: bind a one-time code to (user, client, redirect_uri, PKCE
   * challenge) and hand back the client redirect the browser should follow.
   */
  async issueAuthCode(
    userId: string,
    st: McpAuthRequestState,
  ): Promise<{ redirectTo: string }> {
    const code = this.deps.tokenPrefix + randomBytes(TOKEN_BYTES).toString('base64url');
    await this.deps.db.insert(oauthAuthCodes).values({
      codeHash: hashToken(code),
      clientId: st.c,
      userId,
      redirectUri: st.r,
      codeChallenge: st.cc,
      scope: st.sc ?? null,
      resource: st.rs ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    const redirect = new URL(st.r);
    redirect.searchParams.set('code', code);
    if (st.s) redirect.searchParams.set('state', st.s);
    return { redirectTo: redirect.toString() };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const [row] = await this.deps.db
      .select()
      .from(oauthAuthCodes)
      .where(eq(oauthAuthCodes.codeHash, hashToken(authorizationCode)))
      .limit(1);
    if (!row || row.clientId !== client.client_id || row.consumedAt || row.expiresAt <= new Date()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE already verified locally by the SDK token handler
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    // Atomic consume: two concurrent /token calls with the same code race on
    // this UPDATE and exactly one wins — a select-then-update would let both
    // through. `clientId` is IN the predicate so a mismatched client can't burn
    // (consume) a code that isn't theirs — the update matches nothing and the
    // code stays live for its rightful client.
    const [row] = await this.deps.db
      .update(oauthAuthCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(oauthAuthCodes.codeHash, hashToken(authorizationCode)),
          eq(oauthAuthCodes.clientId, client.client_id),
          isNull(oauthAuthCodes.consumedAt),
          gt(oauthAuthCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!row) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.mintTokens(row.userId, row.clientId, row.scope, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const now = new Date();
    // Rotation: atomically revoke the presented refresh token; the winner of
    // a concurrent double-refresh gets the new pair, the loser a clean 400.
    // `clientId` is IN the predicate so a caller presenting a valid refresh
    // token under the WRONG client can't revoke (kill) another client's
    // session — the update matches nothing and their token stays live.
    const [row] = await this.deps.db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthTokens.refreshTokenHash, hashToken(refreshToken)),
          eq(oauthTokens.clientId, client.client_id),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning();
    if (!row) {
      throw new InvalidGrantError('Invalid or revoked refresh token');
    }
    if (row.refreshExpiresAt && row.refreshExpiresAt <= now) {
      throw new InvalidGrantError('Refresh token expired');
    }
    // Scope may only narrow on refresh (RFC 6749 §6).
    let scope = row.scope;
    if (scopes?.length) {
      const granted = new Set((row.scope ?? '').split(' ').filter(Boolean));
      if (!scopes.every((s) => granted.has(s))) {
        throw new InvalidScopeError('Requested scope exceeds the originally granted scope');
      }
      scope = scopes.join(' ');
    }
    return this.mintTokens(row.userId, row.clientId, scope, row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = new Date();
    const [row] = await this.deps.db
      .select({
        id: oauthTokens.id,
        clientId: oauthTokens.clientId,
        scope: oauthTokens.scope,
        resource: oauthTokens.resource,
        expiresAt: oauthTokens.expiresAt,
        userId: users.id,
        userEmail: users.email,
      })
      .from(oauthTokens)
      .innerJoin(users, eq(oauthTokens.userId, users.id))
      .where(
        and(
          eq(oauthTokens.accessTokenHash, hashToken(token)),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (!row) {
      throw new InvalidTokenError('Invalid, expired, or revoked access token');
    }
    // Fire-and-forget like the connection-key path — a stale last_used_at is
    // fine for audit, blocking verification on it is not.
    this.deps.db
      .update(oauthTokens)
      .set({ lastUsedAt: now })
      .where(eq(oauthTokens.id, row.id))
      .then(undefined, (err) => console.warn('[mcp-oauth] touch lastUsedAt failed:', err));
    return {
      token,
      clientId: row.clientId,
      scopes: (row.scope ?? '').split(' ').filter(Boolean),
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.userId, userEmail: row.userEmail },
    };
  }

  /**
   * Internal revoke by the bearer itself (no client binding) — used by the MCP
   * proxy to reset an interactive session whose TOOL sign-in died: revoking the
   * pair makes the client's next request 401, its refresh fail, and its
   * re-authorization run — landing the user on /connect to fix the sign-in.
   * No-op for non-OAuth bearers (connection keys, JWTs) and unknown tokens.
   */
  async revokeByAccessToken(token: string): Promise<void> {
    if (!this.looksLikeAccessToken(token)) return;
    await this.deps.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.accessTokenHash, hashToken(token)), isNull(oauthTokens.revokedAt)));
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // RFC 7009: revoking an unknown/foreign/already-revoked token is a no-op.
    // The token may be either half of a pair — one UPDATE matching either hash.
    const hash = hashToken(request.token);
    await this.deps.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthTokens.clientId, client.client_id),
          isNull(oauthTokens.revokedAt),
          or(eq(oauthTokens.accessTokenHash, hash), eq(oauthTokens.refreshTokenHash, hash)),
        ),
      );
  }

  private async mintTokens(
    userId: string,
    clientId: string,
    scope: string | null,
    resource: string | null,
  ): Promise<OAuthTokens> {
    const accessToken = this.deps.tokenPrefix + randomBytes(TOKEN_BYTES).toString('base64url');
    const refreshToken = this.refreshPrefix + randomBytes(TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    // Opportunistic pruning, piggybacked on mint (one per sign-in / refresh —
    // no scheduler needed) so the oauth tables stay bounded: a token row whose
    // refresh window has closed can never authenticate again (revoked-but-live
    // rows are kept until then, so revocation stays observable), and an auth
    // code past its 60s TTL can never be exchanged. Best-effort — a cleanup
    // hiccup must not fail the token issuance itself.
    try {
      const cutoff = new Date(now);
      await this.deps.db.delete(oauthTokens).where(
        or(
          lt(oauthTokens.refreshExpiresAt, cutoff),
          and(isNull(oauthTokens.refreshExpiresAt), lt(oauthTokens.expiresAt, cutoff)),
        ),
      );
      await this.deps.db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, cutoff));
    } catch (err) {
      console.warn('[mcp-oauth] token-table prune failed (non-fatal):', err instanceof Error ? err.message : err);
    }
    await this.deps.db.insert(oauthTokens).values({
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      clientId,
      userId,
      scope,
      resource,
      expiresAt: new Date(now + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    };
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
