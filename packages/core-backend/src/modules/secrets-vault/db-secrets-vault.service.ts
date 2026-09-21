import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('vault');
import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { secrets } from '../database/schema.js';
import { TokenCrypto } from '../../shared/token-crypto.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import {
  type ISecretsVaultService,
  type SecretSummary,
  type SecretConfigStatus,
  type SecretKind,
  type PutStaticSecretInput,
  type PutSharedStaticSecretInput,
  type CreateOAuthSecretInput,
  type OAuthProviderConfig,
  type VariableScopeResolver,
  type NamespaceSecretCount,
  isKeyInNamespace,
  type ForcedRefreshOutcome,
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

/**
 * How a row is stored, or `null` when there is no row — the column is a plain
 * string, and anything that is not `oauth` is a stored value (`toSummary` reads
 * it the same way).
 */
function kindOf(row: { kind: string } | undefined): SecretKind | null {
  if (!row) return null;
  return row.kind === 'oauth' ? 'oauth' : 'static';
}

/** The token material stored (encrypted) for an `oauth` secret. */
interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms; absent when the provider gave no `expires_in`. */
  expires_at?: number;
  token_type?: string;
  /**
   * Space-delimited scopes the provider actually granted. The durable record of
   * what this token can do, so a later check can tell whether it still covers a
   * tool whose required scopes have grown. Taken from the token response's
   * `scope` when echoed; when the provider stays silent, RFC 6749 §5.1 says the
   * grant is identical to the request, so the scopes asked for at `begin*` time
   * are recorded instead. Absent only on tokens minted before this was captured
   * (treated as "covers nothing").
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
  /**
   * The space-delimited `scope` the pending consent asked for — what the
   * token is deemed granted when the provider's token response echoes none
   * (RFC 6749 §5.1: `scope` is optional when identical to the request). One-time
   * like the verifier: consumed by the exchange it was minted for.
   */
  pendingScopes?: string;
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
          'Secrets require an encryption key — set SECRETS_ENC_KEY.',
        );
      }
      this.cryptoInstance = new TokenCrypto(this.encKey);
    }
    return this.cryptoInstance;
  }

  // ── Mutation listeners ─────────────────────────────────────────────────────
  // Notified after any secret mutation: `userId` for a per-user secret, null
  // for a SHARED one (affects every user). Lets caches keyed on credential
  // validity (e.g. the MCP proxy's manual-failure memo) invalidate the moment
  // a credential changes instead of waiting out a TTL.
  private readonly mutationListeners: Array<(userId: string | null) => void> = [];

  onMutation(listener: (userId: string | null) => void): void {
    this.mutationListeners.push(listener);
  }

  private notifyMutation(userId: string | null): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(userId);
      } catch (err) {
        log.warn('mutation listener failed:', { err });
      }
    }
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
    this.notifyMutation(userId);
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
    this.notifyMutation(userId);
    return this.toSummary(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(id);
    this.notifyMutation(userId);
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
    this.notifyMutation(null);
    return this.toSummary(row);
  }

  async removeShared(key: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(isNull(secrets.userId), eq(secrets.key, key)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(key);
    this.notifyMutation(null);
  }

  async removeUserByKey(userId: string, key: string): Promise<void> {
    const res = await this.db
      .delete(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.key, key)))
      .returning({ id: secrets.id });
    if (res.length === 0) throw new SecretNotFoundError(key);
    this.notifyMutation(userId);
  }

  async countNamespace(prefix: string): Promise<NamespaceSecretCount> {
    return tally(await this.namespaceRows(prefix));
  }

  async removeNamespace(prefix: string): Promise<NamespaceSecretCount> {
    // Scanned and deleted until a pass finds NOTHING. The membership rule
    // (`isKeyInNamespace`) cannot be said in SQL, so the ids have to be read
    // before they are deleted — and a row written in that window would
    // otherwise outlive the namespace it belongs to, which is precisely the
    // orphan this method exists to prevent. Bounded, so a writer looping
    // against us cannot hold the request open.
    //
    // What it reports and notifies is what the DELETE itself returned, row by
    // row — never the scan's copy, which a same-key upsert may have changed
    // the `kind` of in between.
    const gone: { userId: string | null; kind: string }[] = [];
    try {
      for (let pass = 0; pass < 5; pass++) {
        const rows = await this.namespaceRows(prefix);
        if (rows.length === 0) break;
        const deleted = await this.db
          .delete(secrets)
          .where(inArray(secrets.id, rows.map((r) => r.id)))
          .returning({ userId: secrets.userId, kind: secrets.kind });
        gone.push(...deleted);
      }
    } finally {
      // In `finally`, because a pass that throws does not un-delete the passes
      // before it: those rows are gone, and a listener that never heard would
      // serve a cached connection for a credential that no longer exists.
      this.notifyNamespaceGone(gone);
    }
    return tally(gone);
  }

  /**
   * Tell the tiers a namespace deletion actually touched. The `null` sentinel
   * means "everyone's pooled connection" — earned only by a SHARED row going,
   * never by one user's secret.
   */
  private notifyNamespaceGone(gone: readonly { userId: string | null }[]): void {
    if (gone.length === 0) return;
    if (gone.some((r) => r.userId === null)) this.notifyMutation(null);
    for (const userId of new Set(gone.map((r) => r.userId).filter((u): u is string => u !== null))) {
      this.notifyMutation(userId);
    }
  }

  /**
   * The rows under a namespace, across every user. `LIKE` narrows in the
   * database (its `_` and `%` escaped — `_` is in nearly every prefix); the
   * exact membership rule, which `LIKE` cannot say, is applied here.
   */
  private async namespaceRows(
    prefix: string,
  ): Promise<{ id: string; key: string; userId: string | null; kind: string }[]> {
    if (!prefix) return [];
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db
      .select({ id: secrets.id, key: secrets.key, userId: secrets.userId, kind: secrets.kind })
      .from(secrets)
      .where(like(secrets.key, pattern));
    return rows.filter((r) => isKeyInNamespace(r.key, prefix));
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
      const adminRow = rows.find((r) => r.key === key && r.userId === null);
      // Decrypt+parse the oauth row's token set once, then derive both fields from it.
      const tokens = userRow?.kind === 'oauth' ? this.readTokensSafe(userRow.valueEncrypted) : undefined;
      return {
        key,
        adminConfigured: !!adminRow,
        userConfigured: !!userRow,
        // How each row is stored, so a caller can tell a row that backs the kind
        // the manual NOW declares from one left behind by an earlier edit.
        adminKind: kindOf(adminRow),
        userKind: kindOf(userRow),
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
    // would otherwise fail the exchange from this standalone flow. The
    // requested scopes ride along for the same exchange (see `pendingScopes`).
    const pendingVerifier = meta.pkce ? randomBytes(32).toString('base64url') : undefined;
    const pendingScopes = meta.scopes && meta.scopes.length ? meta.scopes.join(' ') : undefined;
    if (pendingVerifier || pendingScopes) {
      // Read-modify-write on the blob, guarded on the ciphertext we read: a
      // refresh running concurrently (the row is a live credential) may have
      // persisted ROTATED tokens in between, and writing our copy over them
      // would leave the row holding a dead refresh token if this consent is
      // then abandoned. On a miss (0 rows), re-read and merge onto the fresh
      // blob; bounded so a row that keeps changing fails loudly, not forever.
      let current = row;
      for (let attempt = 0; ; attempt++) {
        const blob = this.readBlob(current.valueEncrypted);
        const next: OAuthBlob = { ...blob, pendingVerifier, pendingScopes };
        const written = await this.db
          .update(secrets)
          .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
          .where(
            and(eq(secrets.id, id), eq(secrets.userId, userId), eq(secrets.valueEncrypted, current.valueEncrypted)),
          )
          .returning({ id: secrets.id });
        if (!Array.isArray(written) || written.length > 0) break;
        if (attempt >= 2) throw new SecretOAuthError('The sign-in changed while starting — try again');
        current = await this.requireRow(userId, id);
        // Only a token rotation is merge-able. A row that is no longer this
        // OAuth secret — re-registered against another provider, or replaced by
        // a static value — would have the consent URL built above pointing at
        // one provider and the pending fields stashed for another.
        if (current.kind !== 'oauth' || JSON.stringify(current.oauthMeta) !== JSON.stringify(row.oauthMeta)) {
          throw new SecretOAuthError('The sign-in changed while starting — try again');
        }
      }
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
    // A silent token response granted what was asked (RFC 6749 §5.1) — record
    // the request as the grant, or every declared scope would read as missing
    // and the sign-in would be flagged "again" forever. An echoed `scope` is
    // the provider's own word and wins — narrower grants included, and so does
    // an explicit empty one: only an ABSENT field means "as requested".
    if (tokens.scope === undefined && blob.pendingScopes) tokens.scope = blob.pendingScopes;
    // The verifier and the requested scopes are one-time — never carried past
    // the exchange they were minted for.
    const next: OAuthBlob = { clientSecret: blob.clientSecret, tokens };
    await this.db
      .update(secrets)
      .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)));
    // Fresh tokens just landed — let credential-validity caches retry NOW.
    this.notifyMutation(userId);
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
    this.notifyMutation(null);
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
    // The scopes this consent asks for: the caller may override from the live
    // tool file (`input.scopes`) so an owner adding a permission takes effect
    // without re-setting the secret. Remembered on the row so a token response
    // that echoes no `scope` is read as granting exactly this (RFC 6749 §5.1).
    const requestedScopes = input.scopes && input.scopes.length ? input.scopes : meta.scopes;
    const pendingScopes = requestedScopes && requestedScopes.length ? requestedScopes.join(' ') : undefined;

    // Provision (or reset) the caller's own oauth row for this key from the shared
    // provider meta + secret, preserving any existing tokens. Keyed `<manual>_<VAR>`
    // so `resolve` (scope 'user') returns the token once sign-in completes.
    const blob: OAuthBlob = {
      clientSecret: sharedBlob.clientSecret,
      tokens: existingTokens,
      pendingVerifier,
      pendingScopes,
    };
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
    // EXCEPT the requested scopes (above). Client id, addresses, and secret
    // stay owner-pinned.
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

    const result = await this.refreshRow(row, blob, tokens);
    // Transient failure (timeout, network, 5xx) — return the stale token so
    // the caller gets a clear 401 from the provider rather than a silent
    // missing var, and the next call retries the refresh.
    if (result.outcome === 'transient') return tokens.access_token;
    return result.accessToken;
  }

  async forceRefresh(userId: string, key: string): Promise<ForcedRefreshOutcome> {
    const [row] = await this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.key, key)))
      .limit(1);
    if (!row || row.kind !== 'oauth') return 'skipped';
    let blob: OAuthBlob;
    try {
      blob = this.readBlob(row.valueEncrypted);
    } catch {
      return 'skipped';
    }
    const tokens = blob.tokens;
    if (!tokens?.access_token) return 'skipped'; // already not connected
    // The stored expiry is deliberately NOT consulted: the provider just
    // refused this token, which outranks whatever lifetime it was issued with.
    const result = await this.refreshRow(row, blob, tokens);
    return result.outcome;
  }

  /**
   * Trade `tokens.refresh_token` for a fresh token set and persist it — the ONE
   * refresh path, shared by the expiry-driven `resolve` and the rejection-driven
   * `forceRefresh`. Three outcomes, each already persisted:
   *
   *   - `refreshed` — fresh tokens stored (or a concurrent refresh already
   *     stored some); `accessToken` is the one to use.
   *   - `rejected` — the grant is dead: the provider refused it (400/401) or
   *     there is no refresh token to try. The token set is wiped, the client
   *     secret kept, so `statusFor` reports not-authorized and /connect routes
   *     the user to re-authorize.
   *   - `transient` — timeout, network, 5xx: nothing is changed, so a later
   *     call tries again.
   */
  private async refreshRow(
    row: typeof secrets.$inferSelect,
    blob: OAuthBlob,
    tokens: OAuthTokenSet,
  ): Promise<
    | { outcome: 'refreshed'; accessToken: string }
    | { outcome: 'rejected'; accessToken: null }
    | { outcome: 'transient' }
  > {
    if (!tokens.refresh_token) {
      // Only the rejection-driven path reaches here without one (`resolve`
      // serves a refresh-less token as is): the provider refused the only
      // credential there is, and nothing can renew it.
      return this.wipeTokens(row, blob);
    }
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
        return this.wipeTokens(row, blob);
      }
      return { outcome: 'transient' };
    }
    // Some providers omit the refresh_token on refresh — keep the old one.
    if (!refreshed.refresh_token) refreshed.refresh_token = tokens.refresh_token;
    // Likewise, a refresh response often omits `scope` — keep the granted scopes
    // recorded at sign-in so coverage checks don't regress to "unknown". Same
    // rule as the exchange: only an ABSENT field means "unchanged"; an echoed
    // value, empty included, is the provider's word.
    if (refreshed.scope === undefined) refreshed.scope = tokens.scope;
    const next: OAuthBlob = { clientSecret: blob.clientSecret, tokens: refreshed };

    // Optimistic concurrency: only persist if the stored ciphertext is unchanged,
    // so a concurrent refresh on the same row doesn't clobber (Microsoft pattern).
    const stored = await this.db
      .update(secrets)
      .set({ valueEncrypted: this.crypto().encrypt(JSON.stringify(next)), updatedAt: new Date() })
      .where(and(eq(secrets.id, row.id), eq(secrets.valueEncrypted, row.valueEncrypted)))
      .returning({ id: secrets.id });
    if (Array.isArray(stored) && stored.length === 0) {
      // Nothing was written: the row changed under us, so our fresh token is
      // not what the vault holds and handing it out would be a lie about
      // stored state. Same resolution as the guarded wipe — re-read and serve
      // whatever the winner persisted, or report the grant not-connected when
      // the winner was a wipe.
      const current = await this.currentAccessToken(row.id);
      return current
        ? { outcome: 'refreshed', accessToken: current }
        : { outcome: 'rejected', accessToken: null };
    }
    // A successful refresh is a credential repair — notify so dependent caches
    // (the MCP proxy's manual-failure memo) retry immediately. `row.userId` is
    // null for a shared (admin-scope) row, which maps to "affects everyone".
    this.notifyMutation(row.userId);
    return { outcome: 'refreshed', accessToken: refreshed.access_token };
  }

  /**
   * The access token currently stored on `id`, or undefined if there is none to
   * read — including when the row is no longer an OAuth row at all: a concurrent
   * edit can turn a sign-in into a static value, and a static value that happens
   * to parse as a token blob must not be handed out as a refreshed grant.
   */
  private async currentAccessToken(id: string): Promise<string | undefined> {
    const [current] = await this.db
      .select({ kind: secrets.kind, valueEncrypted: secrets.valueEncrypted })
      .from(secrets)
      .where(eq(secrets.id, id))
      .limit(1);
    if (!current || current.kind !== 'oauth') return undefined;
    try {
      return this.readBlob(current.valueEncrypted).tokens?.access_token;
    } catch {
      return undefined;
    }
  }

  /** Drop a dead grant's token set, keeping the client secret. See {@link refreshRow}. */
  private async wipeTokens(
    row: typeof secrets.$inferSelect,
    blob: OAuthBlob,
  ): Promise<{ outcome: 'refreshed'; accessToken: string } | { outcome: 'rejected'; accessToken: null }> {
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
      const fresh = await this.currentAccessToken(row.id);
      return fresh ? { outcome: 'refreshed', accessToken: fresh } : { outcome: 'rejected', accessToken: null };
    }
    // The sign-in just became not-connected — let credential-validity caches
    // (pooled downstream connections dialed with the dead token) drop it now.
    this.notifyMutation(row.userId);
    return { outcome: 'rejected', accessToken: null };
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
    this.notifyMutation(null);
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

/** A namespace's rows, counted by what a person would call them. */
function tally(rows: { userId: string | null; kind: string }[]): NamespaceSecretCount {
  const signIns = rows.filter((r) => r.userId !== null && r.kind === 'oauth').length;
  return { keys: rows.length - signIns, signIns };
}
