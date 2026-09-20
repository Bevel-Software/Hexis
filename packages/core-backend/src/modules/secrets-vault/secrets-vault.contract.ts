/**
 * Secrets Vault — the per-user credential store that backs UTCP tool variables
 * (`${FOO_API_KEY}`). Distinct from `modules/watchlist` (connector+URL POINTERS, no
 * credentials): this holds the actual secret VALUES, encrypted at rest, and
 * resolves them for the `bevel-secrets` UTCP variable loader at tool-call time.
 *
 * This interface is the swap seam: `DbSecretsVaultService` stores secrets in our
 * own encrypted table today, but a future `ExternalSecretManagerService` (backed
 * by a client's HashiCorp Vault / AWS Secrets Manager / Doppler) can implement
 * the same contract without any change to the loader or the tools.
 */

export type SecretKind = 'static' | 'oauth';

/** A secret as shown in listings — NEVER carries the value or token material. */
export interface SecretSummary {
  id: string;
  /** The UTCP variable name this secret resolves (e.g. `FOO_API_KEY`). */
  key: string;
  kind: SecretKind;
  label: string | null;
  /** For `oauth`: whether a token has been obtained (the user completed the flow). */
  authorized?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PutStaticSecretInput {
  userId: string;
  key: string;
  value: string;
  label?: string | null;
}

/** A shared/admin static secret — one row per key, `user_id NULL`, read by every invoker. */
export interface PutSharedStaticSecretInput {
  key: string;
  value: string;
  label?: string | null;
}

/** Whether a variable's key has a shared (admin) value and/or the caller's own value. */
export interface SecretConfigStatus {
  key: string;
  adminConfigured: boolean;
  userConfigured: boolean;
  /**
   * How the SHARED row is stored, or `null` when there is none. A `.tool` can be
   * edited to turn a plain key into an OAuth variable (or back) while the old row
   * survives, and the two kinds are not interchangeable: an OAuth flow reads the
   * client secret off an `oauth` row and `resolve` reads a value off a `static`
   * one. A caller that asks "is this set up?" has to mean "set up AS THE KIND THE
   * MANUAL NOW DECLARES", or it offers an Authorize the flow will refuse.
   *
   * Required, not optional: "the field was left out" and "there is no row" have
   * to be the same answer, or a caller that trusts it cannot be strict.
   */
  adminKind: SecretKind | null;
  /** How the CALLER's own row is stored, or `null` when they have none. Same reason. */
  userKind: SecretKind | null;
  /**
   * For an OAuth-backed per-user row: whether the caller has completed sign-in (a
   * token exists). `undefined` for static rows / when the caller has no row. Lets
   * the pre-check treat "row present but not authorized" as still-missing.
   */
  userAuthorized?: boolean;
  /**
   * For an OAuth-backed per-user row: the scopes the caller's token was actually
   * granted (space-delimited, as the provider echoed them). `undefined` for static
   * rows, callers with no row, or tokens minted before granted scopes were
   * captured. Lets the pre-check tell whether a token still covers a tool whose
   * required scopes have grown.
   */
  grantedScopes?: string;
}

/**
 * How a secret is provisioned — mirrors `ToolVariableScope` in the tool-manuals
 * contract, redeclared here to keep the vault free of a tool-manuals import.
 */
export type SecretScope = 'admin' | 'user';

/** Resolves a UTCP-namespaced key (`<manual>_<VAR>`) to its provisioning scope. */
export type VariableScopeResolver = (key: string) => Promise<SecretScope>;

/** Non-secret OAuth provider config the user supplies when registering an oauth secret. */
export interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Kept out of listings; stored encrypted alongside the tokens. */
  clientSecret?: string;
  scopes?: string[];
  /** Extra static params appended to the authorization request (e.g. `audience`). */
  authParams?: Record<string, string>;
  /** Use PKCE (S256) on the authorization-code flow. Required by MCP-spec providers. */
  pkce?: boolean;
  /**
   * A PUBLIC client (RFC 6749 §2.1): no client secret exists, by design — token
   * requests authenticate with PKCE only. Distinguishes "no secret needed" from
   * "the owner hasn't set the secret yet" (which stays an error).
   */
  publicClient?: boolean;
  /**
   * RFC 8707 resource indicator, sent on the authorization AND token requests so
   * the issued token is audience-bound. MCP-spec providers require it (the MCP
   * server's canonical URL).
   */
  resource?: string;
}

export interface CreateOAuthSecretInput {
  userId: string;
  key: string;
  label?: string | null;
  provider: OAuthProviderConfig;
}

/** Secrets stored under one manual's name, counted — never a value, never whose. */
export interface NamespaceSecretCount {
  /** Typed values and shared client secrets. */
  keys: number;
  /** Per-user OAuth rows — somebody signed in (or started to). */
  signIns: number;
}

/**
 * Whether a vault key belongs to the namespace `prefix` (`utcpNamespacePrefix`).
 *
 * A bare `startsWith` is not enough: namespacing doubles every underscore, so
 * manual `foo`'s prefix `foo_` is also the start of manual `foo_bar`'s
 * `foo__bar_`. A remainder starting with `_` therefore belongs to a longer
 * name.
 *
 * `_X` IS a legal variable name, so `foo` declaring `_bar_KEY` stores under
 * `foo__bar_KEY` — the very key `foo_bar` declaring `KEY` stores under. The
 * UTCP encoding makes those one row with two honest claimants, and no rule
 * applied to the key can tell them apart. This predicate therefore answers NO
 * for every `_`-leading remainder, with no exception for a declaring manual:
 * the only thing it is used for is counting and WIPING a whole namespace, and
 * an ambiguous row left standing is recoverable where one wrongly deleted is
 * not. (Establishing that no colliding manual exists is not an option either
 * — the tool catalog omits what it could not read, so its silence is not
 * proof.)
 */
export function isKeyInNamespace(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return rest.length > 0 && !rest.startsWith('_');
}

export interface ISecretsVaultService {
  /** Count every user's secrets under one namespace prefix — see {@link isKeyInNamespace}. */
  countNamespace(prefix: string): Promise<NamespaceSecretCount>;
  /**
   * Delete every secret under one namespace prefix — the shared rows and every
   * user's. What deleting a tool wipes; returns what it removed.
   */
  removeNamespace(prefix: string): Promise<NamespaceSecretCount>;
  /** The caller's secrets (values omitted). */
  list(userId: string): Promise<SecretSummary[]>;
  /** One secret's summary, or null if it isn't the caller's. */
  getById(userId: string, id: string): Promise<SecretSummary | null>;
  /** Create or replace the caller's (per-user) static secret keyed by its UTCP variable name. */
  putStatic(input: PutStaticSecretInput): Promise<SecretSummary>;
  /** Create or replace the SHARED (admin) static secret for a key — read by every invoker. */
  putSharedStatic(input: PutSharedStaticSecretInput): Promise<SecretSummary>;
  /** Register an oauth secret (provider config only; tokens arrive via the flow). */
  createOAuth(input: CreateOAuthSecretInput): Promise<SecretSummary>;
  /** Delete the caller's secret by id. */
  remove(userId: string, id: string): Promise<void>;
  /** Delete the caller's (per-user) secret by key. */
  removeUserByKey(userId: string, key: string): Promise<void>;
  /** Delete the SHARED (admin) secret for a key. */
  removeShared(key: string): Promise<void>;
  /** Per-key config status (shared value present? caller's own value present?) for the UI. */
  statusFor(userId: string, keys: string[]): Promise<SecretConfigStatus[]>;

  // --- OAuth authorization-code flow (routes own state signing/verification) ---
  /** Build the provider consent URL for an oauth secret; the caller supplies redirect + signed state. */
  beginOAuth(userId: string, id: string, redirectUri: string, state: string): Promise<string>;
  /** Exchange the returned code for tokens and persist them on the oauth secret. */
  completeOAuth(userId: string, id: string, code: string, redirectUri: string): Promise<void>;

  // --- Tool-declared OAuth variables (client secret + provider bound on the shared row) ---
  /**
   * Set the confidential client secret + provider config for a tool's OAuth-backed
   * variable, on the SHARED row (`user_id NULL`) for `key`. The provider meta is
   * stored ALONGSIDE the secret so a later `.tool` edit can't redirect it. Owner-
   * gated by the route (write access on the `.tool`).
   */
  putSharedOAuthClientSecret(input: {
    key: string;
    clientSecret: string;
    provider: OAuthProviderConfig;
  }): Promise<void>;
  /**
   * Set the provider config for a key's SHARED row where the client may be
   * PUBLIC (no secret) — the path auto-discovery uses after dynamically
   * registering a client with an MCP-spec provider. `putSharedOAuthClientSecret`
   * stays the owner-typed path (secret required).
   */
  putSharedOAuthProvider(input: {
    key: string;
    label?: string | null;
    provider: OAuthProviderConfig;
  }): Promise<void>;
  /**
   * The PUBLIC provider config stored on a key's shared oauth row (never the
   * secret), or null when no shared oauth row exists. Lets auto-discovery skip
   * re-registering a client whose registration is already persisted.
   */
  getSharedOAuthProvider(key: string): Promise<OAuthProviderConfig | null>;
  /**
   * Provision (if needed) the caller's per-user oauth row for `key` from the SHARED
   * row's stored provider meta + client secret, then build the consent URL. 409 if
   * the owner hasn't set the client secret. Returns the provisioned row's id (to
   * sign into the callback state) and the consent url.
   *
   * `scopes`, when given, are the permissions to REQUEST on the consent screen —
   * supplied by the caller from the live tool file so a scope added there takes
   * effect without the owner re-entering the secret. Only the requested scopes
   * follow the tool file; the client id, addresses, and secret are still read from
   * the owner-set shared row. Omitted → the shared row's stored scopes are used.
   */
  beginToolOAuthByKey(input: {
    userId: string;
    key: string;
    redirectUri: string;
    state: string;
    scopes?: string[];
  }): Promise<{ id: string; url: string }>;

  /**
   * Resolve the injectable value for a UTCP variable `key` — the only reader of
   * secret material. `static` → the decrypted value; `oauth` → a fresh access
   * token (refreshed on demand). Returns null when missing or not-yet-authorized.
   */
  resolve(userId: string, key: string): Promise<string | null>;
}

/** Thrown when input fails validation. Routes map to 422. */
export class InvalidSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSecretError';
  }
}

/** Thrown when the secret doesn't exist for this caller. Routes map to 404. */
export class SecretNotFoundError extends Error {
  constructor(id: string) {
    super(`Secret not found: ${id}`);
    this.name = 'SecretNotFoundError';
  }
}

/** Thrown when an OAuth operation can't proceed (e.g. resolve before authorize). Routes map to 409. */
export class SecretOAuthError extends Error {
  constructor(
    message: string,
    /**
     * The provider token-endpoint's HTTP status, when the failure IS a provider
     * response. Lets the refresh path tell a definitive rejection (400/401 —
     * the grant is dead, mark it so) from a transient outage (keep the tokens,
     * try again next call).
     */
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = 'SecretOAuthError';
  }
}

/**
 * Whether an OAuth token's granted scopes cover a tool's currently-required scopes:
 * every required scope must be among the granted ones. No required scopes → trivially
 * covered. Granted scopes unknown (a token minted before we recorded them, `undefined`)
 * → NOT covered when anything is required, so the caller is safely routed to re-auth
 * rather than hitting an opaque provider error. `granted` is the space-delimited string
 * the provider echoed (`SecretConfigStatus.grantedScopes`); `required` is the manual's
 * declared list. Lives here (a leaf, dependency-free) so both the MCP pre-check and the
 * connect route can share one definition without crossing module boundaries.
 */
// Google canonicalizes the OIDC convenience aliases `email`/`profile` to its
// userinfo.* URLs in the `scope` string it echoes at token grant, so a token asked
// for `email` comes back carrying `https://www.googleapis.com/auth/userinfo.email`.
// Map both spellings to one canonical form so exact set-membership still matches.
//
// INVARIANT — IDENTITY ALIASES ONLY. Every pair here MUST denote the exact same
// grant in both directions. NEVER add a subsumption (a broad scope that merely
// *contains* a narrower one, e.g. `.../m8/feeds/` → `.../auth/contacts`) or an
// unverified alias (`address`, `phone`, `plus.me`): either would let an under-scoped
// token satisfy a scope it was never granted, breaking the fail-closed guarantee.
// `openid` has NO url form — it is echoed verbatim, so it is intentionally absent
// and already matches on both sides.
const SCOPE_ALIASES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.email': 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.profile': 'https://www.googleapis.com/auth/userinfo.profile',
};

/** Collapse a scope string to its canonical form; unknown scopes pass through unchanged. */
function canonicalizeScope(s: string): string {
  return SCOPE_ALIASES[s] ?? s;
}

/**
 * The tool's currently-required scopes NOT covered by the token's granted scopes,
 * returned in their ORIGINAL declared form (so a UI shows what the tool author
 * wrote, not the canonical spelling). Matching is by canonical form, so `email`
 * declared against a granted `.../userinfo.email` is covered. Unknown/empty granted
 * → everything required is missing (fail-closed). No required scopes → none missing.
 */
export function missingScopes(required: string[] | undefined, granted: string | undefined): string[] {
  if (!required || required.length === 0) return [];
  const grantedSet = new Set((granted ?? '').split(/\s+/).filter(Boolean).map(canonicalizeScope));
  return required.filter((s) => !grantedSet.has(canonicalizeScope(s)));
}

export function scopesCovered(required: string[] | undefined, granted: string | undefined): boolean {
  return missingScopes(required, granted).length === 0;
}

/**
 * Is the stored row the KIND the manual now declares — i.e. would the thing the
 * UI is about to offer actually work?
 *
 * A `.tool` can be edited to turn a plain key into an OAuth variable, or back,
 * and the row set for the previous shape survives the edit. The two are not
 * interchangeable: `beginToolOAuthByKey` refuses a `static` shared row, and
 * `resolve` hands an OAuth row's ACCESS TOKEN to a variable whose consumer
 * wants the value. So "a row exists" is never "this variable is set up", and
 * every surface that asks the second question pairs the presence flag with the
 * kind rather than re-deriving the rule.
 */
export function configuredAs(
  want: SecretKind,
  present: boolean | undefined,
  stored: SecretKind | null | undefined,
): boolean {
  return present === true && stored === want;
}
