import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/shared';
import type { Database } from '../database/connection.js';
import { externalApiKeys, users } from '../database/schema.js';
import {
  InvalidTokenLabelError,
  TokenNotFoundError,
  TokenStillActiveError,
} from './external-api-key.errors.js';
import type {
  ExternalApiKeySummary,
  IExternalApiKeyService,
  MintedExternalApiKey,
} from './external-api-key.interface.js';

// Plaintext format: `<tenant>_<43 base64url chars>`. 32 random bytes encoded
// base64url is 43 chars and gives 256 bits of entropy — overkill against
// brute force, cheap to copy. The tenant prefix (default `bevel_`) lets the
// auth middleware route key-vs-JWT requests without parsing both shapes.
const TOKEN_BYTES = 32;

const MAX_LABEL_LEN = 200;

export class ExternalApiKeyService implements IExternalApiKeyService {
  /**
   * @param keyPrefix Tenant-derived plaintext prefix (e.g. `bevel_`) — injected
   *   from {@link AppConfig.externalApiKeyPrefix} so a deploy can brand its keys.
   */
  constructor(
    private readonly db: Database,
    private readonly keyPrefix: string,
  ) {}

  /** True if a bearer string carries this tenant's external-API-key prefix. */
  looksLikeExternalApiKey(token: string): boolean {
    return typeof token === 'string' && token.startsWith(this.keyPrefix);
  }

  async mint(userId: string, label: string): Promise<MintedExternalApiKey> {
    const trimmed = (label ?? '').trim();
    if (trimmed.length === 0) {
      throw new InvalidTokenLabelError('Label cannot be empty');
    }
    if (trimmed.length > MAX_LABEL_LEN) {
      throw new InvalidTokenLabelError(
        `Label cannot exceed ${MAX_LABEL_LEN} characters`,
      );
    }

    const plaintext = this.keyPrefix + randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = hashToken(plaintext);

    const [row] = await this.db
      .insert(externalApiKeys)
      .values({ userId, tokenHash, label: trimmed })
      .returning();

    return {
      plaintext,
      summary: toSummary(row),
    };
  }

  async verifyAndLoadUser(plaintext: string): Promise<AuthUser | null> {
    const resolved = await this.verifyAndLoadToken(plaintext);
    return resolved ? resolved.user : null;
  }

  async verifyAndLoadToken(
    plaintext: string,
  ): Promise<{ tokenId: string; user: AuthUser } | null> {
    if (!this.looksLikeExternalApiKey(plaintext)) {
      return null;
    }
    const tokenHash = hashToken(plaintext);

    // Join users so a single round-trip resolves both "token is valid" and
    // "load the user it belongs to". The unique index on token_hash makes
    // this a point-lookup. `isNull(revokedAt)` is what enforces revocation
    // — the row remains for audit.
    const [row] = await this.db
      .select({
        tokenId: externalApiKeys.id,
        userId: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(externalApiKeys)
      .innerJoin(users, eq(externalApiKeys.userId, users.id))
      .where(and(eq(externalApiKeys.tokenHash, tokenHash), isNull(externalApiKeys.revokedAt)))
      .limit(1);

    if (!row) return null;

    // Fire-and-forget so verification latency is bounded by the SELECT, not
    // the UPDATE. A failed touch is logged but never blocks the caller —
    // the worst case is a slightly stale `last_used_at`, which is fine for
    // a "when was this key last used" audit view.
    this.touchLastUsed(row.tokenId).catch((err) => {
      console.warn('[external-api-key] touchLastUsed failed:', err);
    });

    return {
      tokenId: row.tokenId,
      user: {
        id: row.userId,
        email: row.email,
        name: row.name,
        avatarUrl: row.avatarUrl ?? undefined,
      },
    };
  }

  async listForUser(userId: string): Promise<ExternalApiKeySummary[]> {
    const rows = await this.db
      .select()
      .from(externalApiKeys)
      .where(eq(externalApiKeys.userId, userId))
      .orderBy(desc(externalApiKeys.createdAt));
    return rows.map(toSummary);
  }

  async revoke(id: string, userId: string): Promise<void> {
    // Scope the WHERE by userId so a user can never revoke another user's
    // token even if they learn the id. Idempotent on already-revoked rows
    // because we only set `revokedAt` when it's currently null — re-revoking
    // returns 0 rows changed but no error.
    const result = await this.db
      .update(externalApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(externalApiKeys.id, id),
          eq(externalApiKeys.userId, userId),
          isNull(externalApiKeys.revokedAt),
        ),
      )
      .returning({ id: externalApiKeys.id });

    if (result.length === 0) {
      // Distinguish "doesn't exist / not yours" from "already revoked".
      // The latter must stay idempotent (return success); only the former
      // throws.
      const [existing] = await this.db
        .select({ id: externalApiKeys.id })
        .from(externalApiKeys)
        .where(and(eq(externalApiKeys.id, id), eq(externalApiKeys.userId, userId)))
        .limit(1);
      if (!existing) {
        throw new TokenNotFoundError();
      }
    }
  }

  async remove(id: string, userId: string): Promise<void> {
    // Only revoked rows may be hard-deleted — deleting an active key would
    // silently cut off a live agent. Scope by userId so a user can only
    // delete their own tokens. Validate first (so we can return a precise
    // not-found vs still-active error), then delete inside a transaction.
    const [existing] = await this.db
      .select({ revokedAt: externalApiKeys.revokedAt })
      .from(externalApiKeys)
      .where(and(eq(externalApiKeys.id, id), eq(externalApiKeys.userId, userId)))
      .limit(1);
    if (!existing) {
      throw new TokenNotFoundError();
    }
    if (existing.revokedAt === null) {
      // Exists and is yours, but wasn't revoked — refuse rather than delete.
      throw new TokenStillActiveError();
    }

    // Dependents (e.g. the enterprise LLM-usage metering rows) hang off this
    // row via ON DELETE CASCADE foreign keys, so a bare delete takes any audit
    // trail with it — this service doesn't have to know those tables exist.
    await this.db
      .delete(externalApiKeys)
      .where(
        and(
          eq(externalApiKeys.id, id),
          eq(externalApiKeys.userId, userId),
          isNotNull(externalApiKeys.revokedAt),
        ),
      );
  }

  private async touchLastUsed(tokenId: string): Promise<void> {
    await this.db
      .update(externalApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(externalApiKeys.id, tokenId));
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function toSummary(row: typeof externalApiKeys.$inferSelect): ExternalApiKeySummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}
