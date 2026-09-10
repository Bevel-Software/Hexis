import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { Database } from '../database/connection.js';
import { externalApiKeys, users } from '../database/schema.js';
import {
  InvalidTokenLabelError,
  TokenNotFoundError,
  TokenStillActiveError,
} from './external-api-key.errors.js';
import {
  DEFAULT_KEY_KIND,
  type AdminExternalApiKeySummary,
  type ExternalApiKeySummary,
  type IExternalApiKeyService,
  type KeyKindSpec,
  type MintOptions,
  type MintedExternalApiKey,
} from './external-api-key.interface.js';

// Plaintext format: `<prefix><43 base64url chars>`. 32 random bytes encoded
// base64url is 43 chars and gives 256 bits of entropy — overkill against
// brute force, cheap to copy. The prefix lets the auth middleware route
// key-vs-JWT requests without parsing both shapes.
const TOKEN_BYTES = 32;
// A GitHub-shaped token: 20 random bytes as 40 hex digits — alphanumeric,
// as GitHub's own are, and 160 bits, which a hash lookup never exhausts.
const GITHUB_TOKEN_BYTES = 20;

const MAX_LABEL_LEN = 200;

export class ExternalApiKeyService implements IExternalApiKeyService {
  private readonly prefixes: readonly string[];

  /**
   * @param keyPrefix Tenant-derived plaintext prefix (e.g. `bevel_`) — injected
   *   from {@link AppConfig.externalApiKeyPrefix} so a deploy can brand its keys.
   *   Every key of the default kind is minted with it.
   * @param kinds Other kinds a key may be minted as, each with the spelling
   *   that kind has — a Claude link's `gho_` and GitHub's alphabet, the
   *   shape claude.ai expects from a GitHub host. Same key, same table, same
   *   revocation; the KIND is stored on the row and is what tells such keys
   *   apart (a label is the person's to edit), the spelling is only what the
   *   outside world sees and what routes the bearer back here.
   */
  constructor(
    private readonly db: Database,
    private readonly keyPrefix: string,
    private readonly kinds: Readonly<Record<string, KeyKindSpec>> = {},
  ) {
    this.prefixes = [keyPrefix, ...Object.values(kinds).map((k) => k.prefix)];
  }

  /** True if a bearer string carries one of this service's key prefixes. */
  looksLikeExternalApiKey(token: string): boolean {
    return typeof token === 'string' && this.prefixes.some((p) => token.startsWith(p));
  }

  async mint(userId: string, label: string, options: MintOptions = {}): Promise<MintedExternalApiKey> {
    const kind = options.kind ?? DEFAULT_KEY_KIND;
    const spec: KeyKindSpec | undefined = kind === DEFAULT_KEY_KIND ? { prefix: this.keyPrefix } : this.kinds[kind];
    if (!spec) throw new Error(`Unknown key kind "${kind}"`);
    const trimmed = (label ?? '').trim();
    if (trimmed.length === 0) {
      throw new InvalidTokenLabelError('Label cannot be empty');
    }
    if (trimmed.length > MAX_LABEL_LEN) {
      throw new InvalidTokenLabelError(
        `Label cannot exceed ${MAX_LABEL_LEN} characters`,
      );
    }

    const random =
      spec.shape === 'github-token'
        ? randomBytes(GITHUB_TOKEN_BYTES).toString('hex')
        : randomBytes(TOKEN_BYTES).toString('base64url');
    const plaintext = spec.prefix + random;
    const tokenHash = hashToken(plaintext);

    const [row] = await this.db
      .insert(externalApiKeys)
      .values({ userId, tokenHash, label: trimmed, kind })
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

  async listForDeployment(): Promise<AdminExternalApiKeySummary[]> {
    // Owner joined in so the admin overview is one round-trip; ordered by
    // owner email so per-account grouping is a linear pass, newest key
    // first within an account (same order the owner sees on their own page).
    const rows = await this.db
      .select({
        key: externalApiKeys,
        userId: users.id,
        email: users.email,
        name: users.name,
      })
      .from(externalApiKeys)
      .innerJoin(users, eq(externalApiKeys.userId, users.id))
      .orderBy(asc(users.email), desc(externalApiKeys.createdAt));
    return rows.map((row) => ({
      ...toSummary(row.key),
      user: { id: row.userId, email: row.email, name: row.name },
    }));
  }

  async revoke(id: string, userId: string): Promise<void> {
    // Scope by userId so a user can never revoke another user's token even
    // if they learn the id.
    await this.markRevoked(and(eq(externalApiKeys.id, id), eq(externalApiKeys.userId, userId))!);
  }

  async revokeAny(id: string): Promise<void> {
    // No owner scope: the caller is an admin acting across the deployment.
    // The route that exposes this is admin-gated; nothing user-facing may
    // reach it.
    await this.markRevoked(eq(externalApiKeys.id, id));
  }

  /**
   * Set `revokedAt` on the rows matching `scope`. Idempotent on
   * already-revoked rows because we only set `revokedAt` when it's currently
   * null — re-revoking returns 0 rows changed but no error. Throws
   * TokenNotFoundError when `scope` matches nothing at all.
   */
  private async markRevoked(scope: SQL): Promise<void> {
    const result = await this.db
      .update(externalApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(scope, isNull(externalApiKeys.revokedAt)))
      .returning({ id: externalApiKeys.id });

    if (result.length === 0) {
      // Distinguish "doesn't exist / out of scope" from "already revoked".
      // The latter must stay idempotent (return success); only the former
      // throws.
      const [existing] = await this.db
        .select({ id: externalApiKeys.id })
        .from(externalApiKeys)
        .where(scope)
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
    kind: row.kind,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}
