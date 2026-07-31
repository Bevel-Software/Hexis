import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { secrets } from '../database/schema.js';
import { TokenCrypto } from '../../shared/token-crypto.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import {
  type ISecretsVaultService,
  type SecretSummary,
  type SecretConfigStatus,
  type PutStaticSecretInput,
  type PutSharedStaticSecretInput,
  type CreateOAuthSecretInput,
  type OAuthProviderConfig,
  type VariableScopeResolver,
  InvalidSecretError,
  SecretNotFoundError,
  SecretOAuthError,
} from './secrets-vault.contract.js';

const MAX_KEY_LEN = 200;
const MAX_LABEL_LEN = 200;
const MAX_VALUE_LEN = 100_000;
/** Refresh an OAuth token this many ms before its stated expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Upper bound on a token-endpoint round-trip, so a hung provider can't block callers. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The token material stored (encrypted) for an `oauth` secret. */
interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms; absent when the provider gave no `expires_in`. */
  expires_at?: number;
  token_type?: string;
  /**
   * Space-delimited scopes the provider actually granted (echoed on the token
   * response). The durable record of what this token can do, so a later check can
   * tell whether it still covers a tool whose required scopes have grown. Absent
   * on tokens minted before this was captured (treated as "covers nothing").
   */
  scope?: string;
}

interface OAuthBlob {
  clientSecret?: string;
  tokens?: OAuthTokenSet;
  /**
   * PKCE code_verifier generated at `begin*` time, consumed by the next
   * `completeOAuth` on this row. Stored encrypted with the rest of the blob —
   * it's a one-time secret binding the pending consent to this server.
   */
  pendingVerifier?: string;
}

/**
 * Postgres-backed `ISecretsVaultService`. Secret material is encrypted at rest
 * with `TokenCrypto` (AES-256-GCM); a DB leak alone yields only ciphertext. Per-
 * user isolation is enforced by including `userId` in every WHERE clause — a
 * `get`/`remove` for another user's row matches zero rows and reads as "not
 * found", exactly like a row that doesn't exist.
 *
 * Two provisioning tiers share the `secrets` table (see the schema): per-user
 * rows (`user_id` set) and shared/admin rows (`user_id NULL`). At `resolve` time
 * the injected `scopeOf` decides which tier a variable reads — an `admin` var
 * reads the one shared row; a `user` var reads only the caller's row.
 */
export class DbSecretsVaultService implements ISecretsVaultService {
  private cryptoInstance: TokenCrypto | null = null;

  constructor(
    private readonly db: Database,
    /** 32-byte AES key (hex/base64); empty disables secret read/write with a clear error. */
    private readonly encKey: string,
    private readonly now: () => number = Date.now,
    /**
     * The provisioning scope of a UTCP-namespaced key (`<manual>_<VAR>`). Bound
     * to the tool-manuals catalog at composition. Absent ⇒ everything is `admin`
     * (shared) — the safe default (never falls through to a per-user row for an
     * unclassified var).
     */
    private readonly scopeOf?: VariableScopeResolver,
  ) {}

  /** Lazily build the cipher — an empty key fails loudly only when a secret is actually touched. */
  private crypto(): TokenCrypto {
    if (!this.cryptoInstance) {
      if (!this.encKey) {
        throw new InvalidSecretError(
          'Secrets require an encryption key — set CONNECTOR_CONFIG_ENC_KEY (or SHAREPOINT_TOKEN_ENC_KEY).',
        );
      }
      this.cryptoInstance = new TokenCrypto(this.encKey);
    }
    return this.cryptoInstance;
  }

  async list(userId: string): Promise<SecretSummary[]> {
    const rows = await this.db
      .select()
      .from(secrets)
      .where(eq(secrets.userId, userId))
      .orderBy(desc(secrets.updatedAt));
    return rows.map((r) => this.toSummary(r));
  }

  async getById(userId: string, id: string): Promise<SecretSummary | null> {
    const row = await this.row(userId, id);
    return row ? this.toSummary(row) : null;
  }

  async putStatic(input: PutStaticSecretInput): Promise<SecretSummary> {
    const userId = this.requireUserId(input.userId);
    const key = this.requireKey(input.key);
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new InvalidSecretError('value is required');
    }
    if (input.value.length > MAX_VALUE_LEN) {
      throw new InvalidSecretError(`value exceeds ${MAX_VALUE_LEN} characters`);
    }
    const label = this.normaliseLabel(input.label);
    const valueEncrypted = this.crypto().encrypt(input.value);

    // Upsert on (user_id, key): re-saving a key replaces its value in place.
    const [row] = await this.db
      .insert(secrets)
      .values({ userId, key, kind: 'static', label, valueEncrypted, oauthMeta: null })
      .onConflictDoUpdate({
        target: [secrets.userId, secrets.key],
        set: { kind: 'static', label, valueEncrypted, oauthMeta: null, updatedAt: new Date() },
      })
      .returning();
    return this.toSummary(row);
  }

  async createOAuth(input: CreateOAuthSecretInput): Promise<SecretSummary> {
    const userId = this.requireUserId(input.userId);
    const key = this.requireKey(input.key);
    const provider = this.requireProvider(input.provider);
    const label = this.normaliseLabel(input.label);

    const blob: OAuthBlob = { clientSecret: provider.clientSecret };
    const valueEncrypted = this.crypto().encrypt(JSON.stringify(blob));
    const oauthMeta = this.publicProviderMeta(provider);

    const [row] = await this.db
      .insert(secrets)
      .values({ userId, key, kind: 'oauth', label, valueEncrypted, oauthMeta })
      .onConflictDoUpdate({
        target: [secrets.userId, secrets.key],
        // Replacing an oauth secret's provider config drops any existing tokens
        // (they belonged to the old client) — the user must re-authorize.
        set: { kind: 'oauth', label, valueEncrypted, oauthMeta, updatedAt: new Date() },
      })
      .returning();
    return this.toSummary(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(id);
  }

  async putSharedStatic(input: PutSharedStaticSecretInput): Promise<SecretSummary> {
    const key = this.requireKey(input.key);
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new InvalidSecretError('value is required');
    }
    if (input.value.length > MAX_VALUE_LEN) {
      throw new InvalidSecretError(`value exceeds ${MAX_VALUE_LEN} characters`);
    }
    const label = this.normaliseLabel(input.label);
    const valueEncrypted = this.crypto().encrypt(input.value);

    // Upsert the ONE shared row for this key (user_id NULL). The conflict target
    // is the partial unique index `secrets_shared_key_unq` — hence `targetWhere`.
    const [row] = await this.db
      .insert(secrets)
      .values({ userId: null, key, kind: 'static', label, valueEncrypted, oauthMeta: null })
      .onConflictDoUpdate({
        target: secrets.key,
        targetWhere: isNull(secrets.userId),
        set: { kind: 'static', label, valueEncrypted, oauthMeta: null, updatedAt: new Date() },
      })
      .returning();
    return this.toSummary(row);
  }

  async removeShared(key: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(isNull(secrets.userId), eq(secrets.key, key)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(key);
  }

  async removeUserByKey(userId: string, key: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.key, key)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(key);
  }

  async statusFor(userId: string, keys: string[]): Promise<SecretConfigStatus[]> {
    if (keys.length === 0) return [];
    const rows = await this.db
      .select({
        key: secrets.key,
        userId: secrets.userId,
        kind: secrets.kind,
        valueEncrypted: secrets.valueEncrypted,
      })
      .from(secrets)
      .where(and(inArray(secrets.key, keys), or(isNull(secrets.userId), eq(secrets.userId, userId))));
    return keys.map((key) => {
      const userRow = rows.find((r) => r.key === key && r.userId === userId);
      // Decrypt+parse the oauth row's token set once, then derive both fields from it.
      const tokens = userRow?.kind === 'oauth' ? this.readTokensSafe(userRow.valueEncrypted) : undefined;
      return {
        key,
        adminConfigured: rows.some((r) => r.key === key && r.userId === null),
        userConfigured: !!userRow,
        // Only meaningful for an oauth row: has the caller completed sign-in?
        userAuthorized: userRow?.kind === 'oauth' ? Boolean(tokens?.access_token) : undefined,
        // Only meaningful for an oauth row: the scopes the caller's token was granted,
        // so a coverage check can tell whether it still covers the tool's live scopes.
        grantedScopes: userRow?.kind === 'oauth' ? tokens?.scope : undefined,
      };
    });
  }

  /**
   * Decrypt+parse an oauth row's token set once, or undefined if the blob can't be
   * read — a corrupted row or rotated encKey must degrade to "not authorized", not throw.
   * Callers derive `authorized` / `grantedScopes` from this so decrypt happens once per row.
   */
  private readTokensSafe(valueEncrypted: string): OAuthTokenSet | undefined {
    try {
      return this.readBlob(valueEncrypted).tokens;
    } catch {
      return undefined;
    }
  }

  async beginOAuth(userId: string, id: string, redirectUri: string, state: string): Promise<string> {
    const row = await this.requireRow(userId, id);
    if (row.kind !== 'oauth') throw new SecretOAuthError('Secret is not an OAuth secret');
    const meta = this.readMeta(row.oauthMeta);

    // PKCE (S256): same as the tool path — mint the verifier, stash it on the
    // row (so `completeOAuth` echoes it at the token exchange), and put only
    // the derived challenge in the consent URL. A provider registered pkce
    // would otherwise fail the exchange from this standalone flow.
    let pendingVerifier: string | undefined;
    if (meta.pkce) {
      pendingVerifier = randomBytes(32).toString('base64url');
      const blob = this.readBlob(row.valueEncrypted);
      const next: OAuthBlob = { ...blob, pendingVerifier };
      await this.db
        .update(secrets)
        .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
        .where(and(eq(secrets.id, id), eq(secrets.userId, userId)));
    }

    const url = new URL(meta.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', meta.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    if (meta.scopes && meta.scopes.length) url.searchParams.set('scope', meta.scopes.join(' '));
    if (pendingVerifier) {
      url.searchParams.set('code_challenge', sha256base64url(pendingVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (meta.resource) url.searchParams.set('resource', meta.resource);
    // Extra provider params must not clobber the control params we just set — most
    // importantly the signed `state` and `redirect_uri` (CSRF / code-interception).
    const reserved = new Set([
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'resource',
    ]);
    for (const [k, v] of Object.entries(meta.authParams ?? {})) {
      if (!reserved.has(k)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async completeOAuth(userId: string, id: string, code: string, redirectUri: string): Promise<void> {
    const row = await this.requireRow(userId, id);
    if (row.kind !== 'oauth') throw new SecretOAuthError('Secret is not an OAuth secret');
    const meta = this.readMeta(row.oauthMeta);
    const blob = this.readBlob(row.valueEncrypted);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: meta.clientId,
    });
    if (blob.clientSecret) body.set('client_secret', blob.clientSecret);
    // PKCE: echo the verifier generated at begin time; audience-bind per RFC 8707.
    if (blob.pendingVerifier) body.set('code_verifier', blob.pendingVerifier);
    if (meta.resource) body.set('resource', meta.resource);

    const tokens = await this.tokenRequest(meta.tokenUrl, body);
    // The verifier is one-time — never carried past the exchange it was minted for.
    const next: OAuthBlob = { clientSecret: blob.clientSecret, tokens };
    await this.db
      .update(secrets)
      .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)));
  }

  async putSharedOAuthClientSecret(input: {
    key: string;
    clientSecret: string;
    provider: OAuthProviderConfig;
  }): Promise<void> {
    const key = this.requireKey(input.key);
    if (typeof input.clientSecret !== 'string' || !input.clientSecret) {
      throw new InvalidSecretError('clientSecret is required');
    }
    // Validate the provider config the same way createOAuth does (SSRF-safe https
    // URLs). Store the client secret AND the provider meta together on the shared
    // row so a later `.tool` edit can't redirect the secret to another endpoint.
    const provider = this.requireProvider({ ...input.provider, clientSecret: input.clientSecret });
    const blob: OAuthBlob = { clientSecret: provider.clientSecret };
    const valueEncrypted = this.crypto().encrypt(JSON.stringify(blob));
    const oauthMeta = this.publicProviderMeta(provider);
    await this.db
      .insert(secrets)
      .values({ userId: null, key, kind: 'oauth', label: null, valueEncrypted, oauthMeta })
      .onConflictDoUpdate({
        target: secrets.key,
        targetWhere: isNull(secrets.userId),
        set: { kind: 'oauth', valueEncrypted, oauthMeta, updatedAt: new Date() },
      });
  }

  async beginToolOAuthByKey(input: {
    userId: string;
    key: string;
    redirectUri: string;
    state: string;
    scopes?: string[];
  }): Promise<{ id: string; url: string }> {
    const userId = this.requireUserId(input.userId);
    const key = this.requireKey(input.key);
    // The shared row holds the owner-set client secret + the provider meta it was
    // set for. Both are read from HERE, never from the live `.tool`.
    const [shared] = await this.db
      .select()
      .from(secrets)
      .where(and(isNull(secrets.userId), eq(secrets.key, key)))
      .limit(1);
    if (!shared || shared.kind !== 'oauth') {
      throw new SecretOAuthError("This tool's owner hasn't finished setting this up");
    }
    const sharedBlob = this.readBlob(shared.valueEncrypted);
    const meta = this.readMeta(shared.oauthMeta);
    // A missing secret is "not set up yet" ONLY for confidential clients — a
    // dynamically-registered PUBLIC client (PKCE-only) never has one.
    if (!sharedBlob.clientSecret && !meta.publicClient) {
      throw new SecretOAuthError("This tool's owner hasn't finished setting this up");
    }

    // Carry forward any tokens the caller already holds so re-entering the flow
    // (or abandoning it) can't de-authorize a still-valid prior grant — only
    // `completeOAuth` replaces tokens, after a successful callback.
    const [existingUserRow] = await this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.key, key)))
      .limit(1);
    // Only reuse tokens if (a) they decrypt cleanly — a corrupted row or rotated
    // encKey must degrade to "start fresh", not crash the recovery flow — and (b)
    // they were minted under the SAME provider config we're about to (re)write, or
    // a refresh_token for a stale client id/secret would silently fail once carried
    // into this row after an owner rotates the shared secret.
    let existingTokens: OAuthTokenSet | undefined;
    if (
      existingUserRow?.kind === 'oauth' &&
      JSON.stringify(existingUserRow.oauthMeta) === JSON.stringify(shared.oauthMeta)
    ) {
      try {
        existingTokens = this.readBlob(existingUserRow.valueEncrypted).tokens;
      } catch {
        existingTokens = undefined;
      }
    }

    // PKCE (S256): mint the verifier now, stash it on the caller's row, and put
    // only the derived challenge in the consent URL. `completeOAuth` echoes the
    // verifier at the token exchange and drops it.
    const pendingVerifier = meta.pkce ? randomBytes(32).toString('base64url') : undefined;

    // Provision (or reset) the caller's own oauth row for this key from the shared
    // provider meta + secret, preserving any existing tokens. Keyed `<manual>_<VAR>`
    // so `resolve` (scope 'user') returns the token once sign-in completes.
    const blob: OAuthBlob = { clientSecret: sharedBlob.clientSecret, tokens: existingTokens, pendingVerifier };
    const valueEncrypted = this.crypto().encrypt(JSON.stringify(blob));
    const [row] = await this.db
      .insert(secrets)
      .values({ userId, key, kind: 'oauth', label: shared.label, valueEncrypted, oauthMeta: shared.oauthMeta })
      .onConflictDoUpdate({
        target: [secrets.userId, secrets.key],
        set: { kind: 'oauth', valueEncrypted, oauthMeta: shared.oauthMeta, updatedAt: new Date() },
      })
      .returning();

    // Build the consent URL exactly as beginOAuth does, from the stored meta —
    // EXCEPT the requested scopes, which the caller may override from the live tool
    // file (`input.scopes`) so an owner adding a permission takes effect without
    // re-setting the secret. Client id, addresses, and secret stay owner-pinned.
    const requestedScopes = input.scopes && input.scopes.length ? input.scopes : meta.scopes;
    const url = new URL(meta.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', meta.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    if (requestedScopes && requestedScopes.length) url.searchParams.set('scope', requestedScopes.join(' '));
    if (pendingVerifier) {
      url.searchParams.set('code_challenge', sha256base64url(pendingVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (meta.resource) url.searchParams.set('resource', meta.resource);
    const reserved = new Set([
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'resource',
    ]);
    for (const [k, v] of Object.entries(meta.authParams ?? {})) {
      if (!reserved.has(k)) url.searchParams.set(k, v);
    }
    return { id: row.id, url: url.toString() };
  }

  async resolve(userId: string, key: string): Promise<string | null> {
    // Scope-driven: an `admin` var reads the ONE shared row (user_id NULL) and
    // ignores the caller; a `user` var reads only the caller's row. Default is
    // `admin` so an unclassified var never falls through to a per-user row.
    const scope = (await this.scopeOf?.(key)) ?? 'admin';
    const scopeFilter = scope === 'user' ? eq(secrets.userId, userId) : isNull(secrets.userId);
    const [row] = await this.db
      .select()
      .from(secrets)
      .where(and(scopeFilter, eq(secrets.key, key)))
      .limit(1);
    if (!row) return null;

    if (row.kind === 'static') {
      try {
        return this.crypto().decrypt(row.valueEncrypted);
      } catch {
        return null;
      }
    }

    // oauth: return a valid access token, refreshing on demand.
    let blob: OAuthBlob;
    try {
      blob = this.readBlob(row.valueEncrypted);
    } catch {
      return null;
    }
    const tokens = blob.tokens;
    if (!tokens?.access_token) return null; // not authorized yet

    const expired = typeof tokens.expires_at === 'number' && tokens.expires_at - REFRESH_SKEW_MS <= this.now();
    if (!expired) return tokens.access_token;
    if (!tokens.refresh_token) return tokens.access_token; // best-effort; may be stale

    const meta = this.readMeta(row.oauthMeta);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: meta.clientId,
    });
    if (blob.clientSecret) body.set('client_secret', blob.clientSecret);
    if (meta.resource) body.set('resource', meta.resource);

    let refreshed: OAuthTokenSet;
    try {
      refreshed = await this.tokenRequest(meta.tokenUrl, body);
    } catch (err) {
      // A DEFINITIVE provider rejection (400/401 — invalid_grant and friends)
      // means the grant is dead: no future refresh will revive it. Wipe the
      // token set (keeping the client secret) so `statusFor` reports
      // not-authorized and every fail-closed surface — the pre-call check,
      // /connect, the listing filter — routes the user to re-authorize instead
      // of letting calls fail opaquely at the provider forever.
      if (
        err instanceof SecretOAuthError &&
        (err.providerStatus === 400 || err.providerStatus === 401)
      ) {
        const next: OAuthBlob = { clientSecret: blob.clientSecret };
        // Guarded on the ciphertext we read, so a concurrent refresh that
        // already persisted ROTATED tokens can't be wiped by our stale
        // failure. When that guard trips (0 rows), the failure was against a
        // dead pre-rotation refresh token — re-read and serve the fresh grant
        // instead of reporting not-authorized.
        const wiped = await this.db
          .update(secrets)
          .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
          .where(and(eq(secrets.id, row.id), eq(secrets.valueEncrypted, row.valueEncrypted)))
          .returning({ id: secrets.id });
        if (Array.isArray(wiped) && wiped.length === 0) {
          const [current] = await this.db
            .select({ valueEncrypted: secrets.valueEncrypted })
            .from(secrets)
            .where(eq(secrets.id, row.id))
            .limit(1);
          try {
            const fresh = current ? this.readBlob(current.valueEncrypted) : null;
            return fresh?.tokens?.access_token ?? null;
          } catch {
            return null;
          }
        }
        return null;
      }
      // Transient failure (timeout, network, 5xx) — return the stale token so
      // the caller gets a clear 401 from the provider rather than a silent
      // missing var, and the next call retries the refresh.
      return tokens.access_token;
    }
    // Some providers omit the refresh_token on refresh — keep the old one.
    if (!refreshed.refresh_token) refreshed.refresh_token = tokens.refresh_token;
    // Likewise, a refresh response often omits `scope` — keep the granted scopes
    // recorded at sign-in so coverage checks don't regress to "unknown".
    if (!refreshed.scope) refreshed.scope = tokens.scope;
    const next: OAuthBlob = { clientSecret: blob.clientSecret, tokens: refreshed };

    // Optimistic concurrency: only persist if the stored ciphertext is unchanged,
    // so a concurrent refresh on the same row doesn't clobber (Microsoft pattern).
    await this.db
      .update(secrets)
      .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
      .where(and(eq(secrets.id, row.id), eq(secrets.valueEncrypted, row.valueEncrypted)));
    return refreshed.access_token;
  }

  async putSharedOAuthProvider(input: {
    key: string;
    label?: string | null;
    provider: OAuthProviderConfig;
  }): Promise<void> {
    const key = this.requireKey(input.key);
    // Same validation as the owner-typed path, but the secret is OPTIONAL —
    // auto-discovery registers PUBLIC (PKCE-only) clients that never get one.
    const provider = this.requireProvider(input.provider);
    const label = this.normaliseLabel(input.label);
    const blob: OAuthBlob = { clientSecret: provider.clientSecret };
    const valueEncrypted = this.crypto().encrypt(JSON.stringify(blob));
    const oauthMeta = this.publicProviderMeta(provider);
    await this.db
      .insert(secrets)
      .values({ userId: null, key, kind: 'oauth', label, valueEncrypted, oauthMeta })
      // Preserve an existing row's label on re-upsert (matches
      // `putSharedOAuthClientSecret`): the optional input label is only for the
      // FIRST write, so a later re-registration can't null out an owner label.
      .onConflictDoUpdate({
        target: secrets.key,
        targetWhere: isNull(secrets.userId),
        set: { kind: 'oauth', valueEncrypted, oauthMeta, updatedAt: new Date() },
      });
  }

  async getSharedOAuthProvider(key: string): Promise<OAuthProviderConfig | null> {
    const [shared] = await this.db
      .select()
      .from(secrets)
      .where(and(isNull(secrets.userId), eq(secrets.key, key)))
      .limit(1);
    if (!shared || shared.kind !== 'oauth') return null;
    try {
      return this.readMeta(shared.oauthMeta);
    } catch {
      return null;
    }
  }

  // ---- helpers --------------------------------------------------------------

  private async tokenRequest(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenSet> {
    // Re-validate at fetch time (defense-in-depth): the URL was checked on input,
    // but this also guards the refresh path and any future caller that skipped it.
    try {
      assertSafeFetchUrl(tokenUrl, { requireHttps: true, label: 'tokenUrl' });
    } catch (err) {
      throw new SecretOAuthError(err instanceof Error ? err.message : 'tokenUrl is not allowed');
    }
    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        // Don't follow redirects: a validated host could 302 to an internal target,
        // which would post the code/secret past the SSRF check (redirect-based SSRF).
        redirect: 'error',
        // Bound the call so a slow/hung provider can't block completeOAuth/resolve.
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'TimeoutError'
          ? `Token endpoint timed out after ${TOKEN_REQUEST_TIMEOUT_MS}ms`
          : `Token endpoint request failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new SecretOAuthError(msg);
    }
    if (!res.ok) {
      throw new SecretOAuthError(`Token endpoint returned HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
    if (!accessToken) throw new SecretOAuthError('Token endpoint response had no access_token');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined;
    return {
      access_token: accessToken,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expires_at: expiresIn !== undefined ? this.now() + expiresIn * 1000 : undefined,
      token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
      scope: typeof json.scope === 'string' ? json.scope : undefined,
    };
  }

  private async row(userId: string, id: string): Promise<typeof secrets.$inferSelect | undefined> {
    const [row] = await this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .limit(1);
    return row;
  }

  private async requireRow(userId: string, id: string): Promise<typeof secrets.$inferSelect> {
    const row = await this.row(userId, id);
    if (!row) throw new SecretNotFoundError(id);
    return row;
  }

  private readBlob(valueEncrypted: string): OAuthBlob {
    const parsed = JSON.parse(this.crypto().decrypt(valueEncrypted));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as OAuthBlob;
  }

  private readMeta(raw: unknown): Required<Pick<OAuthProviderConfig, 'authorizationUrl' | 'tokenUrl' | 'clientId'>> &
    Pick<OAuthProviderConfig, 'scopes' | 'authParams' | 'pkce' | 'publicClient' | 'resource'> {
    const meta = (raw ?? {}) as Record<string, unknown>;
    const authorizationUrl = typeof meta.authorizationUrl === 'string' ? meta.authorizationUrl : '';
    const tokenUrl = typeof meta.tokenUrl === 'string' ? meta.tokenUrl : '';
    const clientId = typeof meta.clientId === 'string' ? meta.clientId : '';
    if (!authorizationUrl || !tokenUrl || !clientId) {
      throw new SecretOAuthError('OAuth secret is missing provider configuration');
    }
    return {
      authorizationUrl,
      tokenUrl,
      clientId,
      scopes: Array.isArray(meta.scopes) ? meta.scopes.map(String) : undefined,
      authParams:
        meta.authParams && typeof meta.authParams === 'object'
          ? (meta.authParams as Record<string, string>)
          : undefined,
      pkce: meta.pkce === true,
      publicClient: meta.publicClient === true,
      resource: typeof meta.resource === 'string' && meta.resource ? meta.resource : undefined,
    };
  }

  private publicProviderMeta(p: OAuthProviderConfig): Record<string, unknown> {
    return {
      authorizationUrl: p.authorizationUrl,
      tokenUrl: p.tokenUrl,
      clientId: p.clientId,
      scopes: p.scopes ?? [],
      authParams: p.authParams ?? {},
      ...(p.pkce ? { pkce: true } : {}),
      ...(p.publicClient ? { publicClient: true } : {}),
      ...(p.resource ? { resource: p.resource } : {}),
    };
  }

  private requireProvider(p: unknown): OAuthProviderConfig {
    if (!p || typeof p !== 'object') throw new InvalidSecretError('provider is required');
    const cfg = p as Record<string, unknown>;
    const authorizationUrl = this.requireUrl(cfg.authorizationUrl, 'authorizationUrl');
    const tokenUrl = this.requireUrl(cfg.tokenUrl, 'tokenUrl');
    const clientId = typeof cfg.clientId === 'string' ? cfg.clientId.trim() : '';
    if (!clientId) throw new InvalidSecretError('clientId is required');
    const scopes = Array.isArray(cfg.scopes) ? cfg.scopes.map(String) : undefined;
    const authParams =
      cfg.authParams && typeof cfg.authParams === 'object'
        ? (cfg.authParams as Record<string, string>)
        : undefined;
    return {
      authorizationUrl,
      tokenUrl,
      clientId,
      clientSecret: typeof cfg.clientSecret === 'string' ? cfg.clientSecret : undefined,
      scopes,
      authParams,
      pkce: cfg.pkce === true,
      publicClient: cfg.publicClient === true,
      // Never fetched (it rides as a request param), but validate it like the
      // endpoints anyway — it names the remote server and must be a sane https URL.
      resource:
        typeof cfg.resource === 'string' && cfg.resource.trim()
          ? this.requireUrl(cfg.resource, 'resource')
          : undefined,
    };
  }

  private requireUrl(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidSecretError(`${field} is required`);
    const trimmed = value.trim();
    // OAuth endpoints must be https (client secret + tokens travel here) and
    // must not point at internal/loopback/metadata hosts (SSRF): `tokenUrl` is
    // fetched server-side, and blocking `authorizationUrl` too costs nothing.
    try {
      assertSafeFetchUrl(trimmed, { requireHttps: true, label: field });
    } catch (err) {
      throw new InvalidSecretError(err instanceof Error ? err.message : `${field} must be a valid https URL`);
    }
    return trimmed;
  }

  private requireUserId(userId: unknown): string {
    const trimmed = (typeof userId === 'string' ? userId : '').trim();
    if (!trimmed) throw new InvalidSecretError('userId is required');
    return trimmed;
  }

  private requireKey(key: unknown): string {
    if (typeof key !== 'string') throw new InvalidSecretError('key must be a string');
    const trimmed = key.trim();
    if (!trimmed) throw new InvalidSecretError('key is required');
    if (trimmed.length > MAX_KEY_LEN) throw new InvalidSecretError(`key exceeds ${MAX_KEY_LEN} characters`);
    // Keys are UTCP variable names — restrict to what the substitutor accepts
    // (`${[a-zA-Z0-9_]+}`) so a saved secret can actually be referenced.
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      throw new InvalidSecretError('key may only contain letters, digits, and underscores');
    }
    return trimmed;
  }

  private normaliseLabel(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new InvalidSecretError('label must be a string');
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_LABEL_LEN) throw new InvalidSecretError(`label exceeds ${MAX_LABEL_LEN} characters`);
    return trimmed;
  }

  private toSummary(row: typeof secrets.$inferSelect): SecretSummary {
    const kind = (row.kind === 'oauth' ? 'oauth' : 'static') as 'static' | 'oauth';
    const summary: SecretSummary = {
      id: row.id,
      key: row.key,
      kind,
      label: row.label,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (kind === 'oauth') {
      summary.authorized = Boolean(this.readTokensSafe(row.valueEncrypted)?.access_token);
    }
    return summary;
  }
}

/** PKCE S256: base64url(sha256(verifier)). */
function sha256base64url(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
