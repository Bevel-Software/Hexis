import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ExternalApiKeyService } from '../external-api-key.service.js';
import {
  InvalidTokenLabelError,
  TokenNotFoundError,
  TokenStillActiveError,
} from '../external-api-key.errors.js';
import type { Database } from '../../database/connection.js';
import { externalApiKeys } from '../../database/schema.js';

/**
 * Builds a fake drizzle chain. Every chainable method returns the same
 * chain object, and the chain itself is thenable — so `await db.x().y().z()`
 * resolves to whatever the test queued for this operation. Each call to
 * `db.insert / .select / .update` pops the next result off `queue`.
 *
 * We use this instead of a real Postgres because the service is pure
 * domain logic on top of drizzle; integration coverage of the migration
 * shape lives with the route tests later.
 */
function makeFakeDb(queue: any[]) {
  const calls: Record<string, any[][]> = {
    insert: [],
    select: [],
    update: [],
    delete: [],
    values: [],
    set: [],
    where: [],
    orderBy: [],
    limit: [],
    innerJoin: [],
    from: [],
    returning: [],
  };

  function nextChain() {
    const result = queue.shift();
    const chain: any = {};
    const passthrough = (name: string) =>
      vi.fn((...args: any[]) => {
        calls[name].push(args);
        return chain;
      });
    chain.values = passthrough('values');
    chain.set = passthrough('set');
    chain.where = passthrough('where');
    chain.orderBy = passthrough('orderBy');
    chain.limit = passthrough('limit');
    chain.innerJoin = passthrough('innerJoin');
    chain.from = passthrough('from');
    chain.returning = passthrough('returning');
    chain.then = (onF: any, onR: any) =>
      Promise.resolve(result).then(onF, onR);
    return chain;
  }

  const db = {
    insert: vi.fn((...args: any[]) => {
      calls.insert.push(args);
      return nextChain();
    }),
    select: vi.fn((...args: any[]) => {
      calls.select.push(args);
      return nextChain();
    }),
    update: vi.fn((...args: any[]) => {
      calls.update.push(args);
      return nextChain();
    }),
    delete: vi.fn((...args: any[]) => {
      calls.delete.push(args);
      return nextChain();
    }),
    // Transactions run the callback against the same fake db, so queued
    // results are consumed in order just like a non-transactional call.
    transaction: vi.fn((fn: (tx: any) => Promise<unknown>) => fn(db)),
  } as unknown as Database;

  return { db, calls };
}

function makeRow(overrides: Partial<{
  id: string;
  userId: string;
  tokenHash: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? 'tok-1',
    userId: overrides.userId ?? 'user-1',
    tokenHash: overrides.tokenHash ?? 'hash-1',
    label: overrides.label ?? 'My laptop',
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    lastUsedAt: overrides.lastUsedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
  };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Flush queued microtasks so a fire-and-forget `.catch(...)` runs before
// we assert. The service intentionally does not await its touchLastUsed
// call, so the rejection handler runs in a later microtask.
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

describe('ExternalApiKeyService', () => {
  describe('mint', () => {
    it('generates a bevel_-prefixed token, persists its sha256 hash (never the plaintext), and returns both', async () => {
      const row = makeRow({ id: 'tok-42', label: 'My laptop' });
      const { db, calls } = makeFakeDb([[row]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      const result = await service.mint('user-1', 'My laptop');

      expect(result.plaintext.startsWith('bevel_')).toBe(true);
      // 32 random bytes base64url-encoded => 43 chars after the prefix.
      expect(result.plaintext.length).toBe('bevel_'.length + 43);

      const inserted = calls.values[0][0];
      expect(inserted.userId).toBe('user-1');
      expect(inserted.label).toBe('My laptop');
      expect(inserted.tokenHash).toBe(sha256Hex(result.plaintext));
      // The plaintext must never land in the DB row.
      expect(inserted.tokenHash).not.toBe(result.plaintext);
      expect(inserted).not.toHaveProperty('plaintext');

      expect(result.summary).toEqual({
        id: 'tok-42',
        label: 'My laptop',
        createdAt: row.createdAt.getTime(),
        lastUsedAt: null,
        revokedAt: null,
      });
    });

    it('trims the label before persisting', async () => {
      const { db, calls } = makeFakeDb([[makeRow()]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await service.mint('user-1', '   spacey   ');

      expect(calls.values[0][0].label).toBe('spacey');
    });

    it('rejects empty/whitespace labels without touching the DB', async () => {
      const { db } = makeFakeDb([]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(service.mint('user-1', '')).rejects.toBeInstanceOf(
        InvalidTokenLabelError,
      );
      await expect(service.mint('user-1', '   \n\t  ')).rejects.toBeInstanceOf(
        InvalidTokenLabelError,
      );
      expect((db as any).insert).not.toHaveBeenCalled();
    });

    it('rejects oversized labels (>200 chars) without touching the DB', async () => {
      const { db } = makeFakeDb([]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(
        service.mint('user-1', 'a'.repeat(201)),
      ).rejects.toBeInstanceOf(InvalidTokenLabelError);
      expect((db as any).insert).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndLoadUser', () => {
    it('returns the owning user when the token hash matches an un-revoked row', async () => {
      const row = {
        tokenId: 'tok-1',
        userId: 'user-7',
        email: 'alice@example.com',
        name: 'Alice',
        avatarUrl: null,
      };
      // Two queued ops: the SELECT for verify, then the UPDATE for the
      // fire-and-forget last_used_at touch.
      const { db } = makeFakeDb([[row], undefined]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      const user = await service.verifyAndLoadUser('bevel_abc123');

      expect(user).toEqual({
        id: 'user-7',
        email: 'alice@example.com',
        name: 'Alice',
        avatarUrl: undefined,
      });
    });

    it('returns null for tokens not carrying the `bevel_` prefix without hitting the DB', async () => {
      const { db } = makeFakeDb([]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      expect(await service.verifyAndLoadUser('eyJhbGciOiJIUzI1NiJ9')).toBeNull();
      expect(await service.verifyAndLoadUser('')).toBeNull();
      expect(await service.verifyAndLoadUser(null as any)).toBeNull();
      expect((db as any).select).not.toHaveBeenCalled();
    });

    it('returns null when no matching un-revoked row exists', async () => {
      const { db } = makeFakeDb([[]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      expect(await service.verifyAndLoadUser('bevel_unknown')).toBeNull();
    });

    it('still resolves with the user even when the last_used_at update fails (fire-and-forget)', async () => {
      const row = {
        tokenId: 'tok-1',
        userId: 'user-7',
        email: 'alice@example.com',
        name: 'Alice',
        avatarUrl: null,
      };
      // Queue: SELECT returns the row; UPDATE rejects.
      const queue: any[] = [[row]];
      const { db } = makeFakeDb(queue);
      // Replace the update chain with one that rejects on await, so the
      // service's fire-and-forget `.catch` handler runs.
      (db as any).update = vi.fn(() => {
        const chain: any = {};
        chain.set = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockReturnValue(chain);
        chain.then = (_onF: any, onR: any) =>
          Promise.resolve().then(() => onR(new Error('connection lost')));
        return chain;
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new ExternalApiKeyService(db, 'bevel_');
      const user = await service.verifyAndLoadUser('bevel_abc');

      expect(user?.id).toBe('user-7');
      await flushMicrotasks();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('listForUser', () => {
    it('maps DB rows to summaries, newest-first via desc(createdAt)', async () => {
      const rows = [
        makeRow({
          id: 'a',
          createdAt: new Date('2026-03-01T00:00:00Z'),
          lastUsedAt: new Date('2026-03-02T00:00:00Z'),
        }),
        makeRow({
          id: 'b',
          revokedAt: new Date('2026-02-15T00:00:00Z'),
        }),
      ];
      const { db, calls } = makeFakeDb([rows]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      const summaries = await service.listForUser('user-1');

      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toEqual({
        id: 'a',
        label: rows[0].label,
        createdAt: rows[0].createdAt.getTime(),
        lastUsedAt: rows[0].lastUsedAt!.getTime(),
        revokedAt: null,
      });
      expect(summaries[1].revokedAt).toBe(rows[1].revokedAt!.getTime());
      // sanity-check that ordering was requested (we can't introspect the
      // SQL fragment here, but we can confirm the call shape).
      expect(calls.orderBy).toHaveLength(1);
    });
  });

  describe('revoke', () => {
    it('updates the row and returns silently when the token belongs to the user and was active', async () => {
      // First op: UPDATE returns 1 row.
      const { db, calls } = makeFakeDb([[{ id: 'tok-1' }]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await service.revoke('tok-1', 'user-1');

      const setArgs = calls.set[0][0];
      expect(setArgs.revokedAt).toBeInstanceOf(Date);
      // No follow-up SELECT — the UPDATE found a row.
      expect((db as any).select).not.toHaveBeenCalled();
    });

    it('is idempotent on already-revoked tokens: returns silently without throwing', async () => {
      // UPDATE matches 0 rows (because `isNull(revokedAt)` filtered it out),
      // then SELECT confirms the row exists for this user → idempotent path.
      const { db } = makeFakeDb([[], [{ id: 'tok-1' }]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(service.revoke('tok-1', 'user-1')).resolves.toBeUndefined();
    });

    it('throws TokenNotFoundError when the token does not exist or belongs to another user', async () => {
      // UPDATE matches 0 rows, follow-up SELECT also returns empty.
      const { db } = makeFakeDb([[], []]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(service.revoke('tok-x', 'user-1')).rejects.toBeInstanceOf(
        TokenNotFoundError,
      );
    });
  });

  describe('remove', () => {
    it('validates then deletes the key (dependents cascade at the DB layer)', async () => {
      // Queue: SELECT finds a revoked row; then the key delete consumes one.
      const { db } = makeFakeDb([
        [{ revokedAt: new Date('2026-02-01T00:00:00Z') }],
        undefined,
      ]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await service.remove('tok-1', 'user-1');

      // Validation SELECT first, then ONE delete of the key row. Dependent
      // rows (e.g. llm_usage metering) are removed by ON DELETE CASCADE —
      // this service must not know those tables exist.
      expect((db as any).select).toHaveBeenCalledTimes(1);
      expect((db as any).delete).toHaveBeenCalledTimes(1);
      expect((db as any).delete).toHaveBeenCalledWith(externalApiKeys);
    });

    it('throws TokenStillActiveError when the token exists but was never disconnected', async () => {
      // SELECT finds the row with a null revokedAt → still active; no delete.
      const { db } = makeFakeDb([[{ revokedAt: null }]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(service.remove('tok-1', 'user-1')).rejects.toBeInstanceOf(
        TokenStillActiveError,
      );
      expect((db as any).delete).not.toHaveBeenCalled();
    });

    it('throws TokenNotFoundError when the token does not exist or belongs to another user', async () => {
      // SELECT returns empty → not found; no delete.
      const { db } = makeFakeDb([[]]);
      const service = new ExternalApiKeyService(db, 'bevel_');

      await expect(service.remove('tok-x', 'user-1')).rejects.toBeInstanceOf(
        TokenNotFoundError,
      );
      expect((db as any).delete).not.toHaveBeenCalled();
    });
  });
});
