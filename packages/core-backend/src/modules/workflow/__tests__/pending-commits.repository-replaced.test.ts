import { describe, expect, it, vi } from 'vitest';
import { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';

/**
 * Commits still queued for a branch when the knowledge-base repository is
 * REPLACED.
 *
 * A release enqueues the bytes and only then drops its lock, so the moment the
 * locks on a branch are dropped there may be rows already waiting — written
 * against a working copy of the repository that is gone. Left `pending`, the
 * worker picks them up after the re-clone and commits them onto a same-named
 * branch of a DIFFERENT repository: somebody else's file, overwritten by a
 * change nobody made to it.
 *
 * So they are escalated, never dropped: the bytes stay in the row, the reason
 * is on it, and a person decides.
 */
function makeFakeDb(moved: Array<{ id: string }>) {
  const sets: Record<string, unknown>[] = [];
  const db = {
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => ({ returning: async () => moved }) };
      },
    })),
    // Queued bytes are never thrown away over this.
    delete: () => {
      throw new Error('a queued commit must never be deleted');
    },
  } as unknown as Database;
  return { db, sets };
}

describe('PendingCommitsService.markNeedsAttentionOnBranch', () => {
  it('escalates every queued commit on the branch, with the reason, and answers how many', async () => {
    const { db, sets } = makeFakeDb([{ id: 'a' }, { id: 'b' }]);
    const svc = new PendingCommitsService(db);

    await expect(
      svc.markNeedsAttentionOnBranch('alice/draft', 'The repository was replaced.'),
    ).resolves.toBe(2);

    expect(sets).toHaveLength(1);
    // `needs_attention` is the status the admin surface reads — the row is out
    // of the worker's reach and in front of a person.
    expect(sets[0]?.status).toBe('needs_attention');
    expect(sets[0]?.lastError).toBe('The repository was replaced.');
    expect(sets[0]?.lastAttemptedAt).toBeInstanceOf(Date);
  });

  it('answers zero when nothing was queued for that branch', async () => {
    const { db } = makeFakeDb([]);
    const svc = new PendingCommitsService(db);
    await expect(svc.markNeedsAttentionOnBranch('quiet/branch', 'whatever')).resolves.toBe(0);
  });
});
