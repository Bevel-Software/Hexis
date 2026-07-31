import type { AuthUser } from '@bevel-software/shared';

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
  mint(userId: string, label: string): Promise<MintedExternalApiKey>;

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
   * Permanently delete a token row, dropping its audit trail. Only permitted
   * on an already-revoked token — an active key must be disconnected first,
   * so a live agent's access is never yanked by a single click. Throws
   * TokenNotFoundError if the token doesn't belong to the user, and
   * TokenStillActiveError if it hasn't been revoked yet.
   */
  remove(id: string, userId: string): Promise<void>;
}
