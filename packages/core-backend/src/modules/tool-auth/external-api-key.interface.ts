import type { AuthUser } from '@bevel-software/platform-shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Connection-key id bound by whichever auth middleware resolved a
       * `<tenant>_…` key (MCP auth, LLM-proxy auth) — consumers use it for
       * per-key attribution/metering. Declared beside the key contract so
       * every key-resolving surface shares one augmentation.
       */
      externalApiKeyId?: string;
    }
  }
}

/**
 * Summary row shown in the user's "Connection keys" settings panel. Never
 * carries the plaintext — that is returned exactly once from `mint`.
 */
export interface ExternalApiKeySummary {
  id: string;
  label: string;
  /**
   * What the key was minted AS — `key` for one a person created by hand,
   * another kind for one a flow minted on their behalf (a Claude link).
   * Stored with the row; the label is the person's to edit and proves nothing.
   */
  kind: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * Result of minting a new connection key. `plaintext` is shown to the user
 * once (with a "you won't see this again" warning); the stored DB row only
 * carries the hash.
 */
export interface MintedExternalApiKey {
  plaintext: string;
  summary: ExternalApiKeySummary;
}

/**
 * One row of the admin "Connection keys" overview: a key summary plus the
 * account it belongs to. Deployment-wide, so unlike {@link ExternalApiKeySummary}
 * the owner is not implied by the caller.
 */
export interface AdminExternalApiKeySummary extends ExternalApiKeySummary {
  user: {
    id: string;
    email: string;
    name: string;
  };
}

/** The kind of a key a person creates by hand. */
export const DEFAULT_KEY_KIND = 'key';

/**
 * How the plaintext of one kind of key is spelled: the prefix the outside
 * world sees (and that routes the bearer back here), and the shape of the
 * random part after it. `base64url` is the platform's own — 43 characters
 * from a 32-byte draw. `github-token` is what a GitHub OAuth token looks
 * like after its `gho_`: letters and digits only, 40 of them, so a consumer
 * that validates the shape of a GitHub token (they are documented as
 * alphanumeric) keeps it. Both hash the same way; the shape is only what a
 * client is shown.
 */
export interface KeyKindSpec {
  prefix: string;
  shape?: 'base64url' | 'github-token';
}

/**
 * How a key is minted. `kind` names one of the kinds the service was built
 * with, each of which carries its own spelling (the tenant's prefix for the
 * default kind, a GitHub-shaped token for a Claude link); an unknown kind is
 * refused, since nothing would route its bearer back.
 */
export interface MintOptions {
  kind?: string;
}

/**
 * Contract for connection-key (API token) lifecycle. Used by the MCP auth
 * middleware to resolve a Bearer token to a Bevel user, and by the settings
 * UI to mint, list, and revoke keys.
 *
 * Verification is a hash lookup on a unique index, so it stays O(1) even
 * with many tokens per user. Revoked tokens are kept (not deleted) so an
 * operator can audit `last_used_at` after a leak.
 */
export interface IExternalApiKeyService {
  /**
   * True if a bearer string carries this tenant's external-API-key prefix
   * (`<tenant>_…`). Lets auth middlewares route a key vs a JWT / internal token
   * without a DB round-trip, using the tenant prefix the service was built with.
   */
  looksLikeExternalApiKey(token: string): boolean;

  /**
   * Generate a new token, persist its hash, and return the plaintext. The
   * plaintext is **only** returned here — there is no read path that can
   * surface it again.
   */
  mint(userId: string, label: string, options?: MintOptions): Promise<MintedExternalApiKey>;

  /**
   * Resolve a plaintext token to the owning user. Returns null when the
   * token is unknown, revoked, or malformed. Bumps `last_used_at`
   * fire-and-forget — verification latency stays bounded by the hash
   * lookup, not the update.
   */
  verifyAndLoadUser(plaintext: string): Promise<AuthUser | null>;

  /**
   * Like `verifyAndLoadUser`, but also returns the matching token's id. The
   * LLM proxy needs the token id (not just the user) to meter per-key usage
   * against the daily cap. Returns null on unknown/revoked/malformed tokens.
   */
  verifyAndLoadToken(
    plaintext: string,
  ): Promise<{ tokenId: string; user: AuthUser } | null>;

  /** Active + revoked tokens for the user, newest-first. */
  listForUser(userId: string): Promise<ExternalApiKeySummary[]>;

  /**
   * Mark a token revoked. Idempotent — revoking an already-revoked token
   * is a no-op (the row's `revokedAt` is not overwritten). Throws
   * TokenNotFoundError if the token doesn't belong to the user.
   */
  revoke(id: string, userId: string): Promise<void>;

  /**
   * Every token on the deployment, active and revoked, with its owner —
   * the admin overview. Ordered by owner email, then newest-first, so the
   * caller can group per account without re-sorting.
   */
  listForDeployment(): Promise<AdminExternalApiKeySummary[]>;

  /**
   * Admin revoke: mark a token revoked WITHOUT scoping by owner. Same
   * idempotency as {@link revoke}; throws TokenNotFoundError when no such
   * token exists. Only reachable through an admin-gated route — the
   * per-user route must keep using {@link revoke}.
   */
  revokeAny(id: string): Promise<void>;

  /**
   * Permanently delete a token row, dropping its audit trail. Only permitted
   * on an already-revoked token — an active key must be disconnected first,
   * so a live agent's access is never yanked by a single click. Throws
   * TokenNotFoundError if the token doesn't belong to the user, and
   * TokenStillActiveError if it hasn't been revoked yet.
   */
  remove(id: string, userId: string): Promise<void>;
}
