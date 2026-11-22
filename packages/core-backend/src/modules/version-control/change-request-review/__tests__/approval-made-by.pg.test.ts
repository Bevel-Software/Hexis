import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { prFileApprovals, users, type Database } from '../../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../../__tests__/pg-scratch.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';
import type { IAccessControl } from '../../../access/index.js';
import type { WorkspaceService } from '../../../workspace/index.js';
import type { GitService } from '../../git/git.service.js';

/**
 * A bot's approval names the person who made its connection beside it, and
 * that person's erasure rewrites the name under the approval lock. The
 * approval asks for them under the same lock, so an erasure that committed
 * first is not undone by an approval in flight. On a real Postgres.
 */

const FILE = { path: 'Team/page.md', status: 'modified', additions: 1, deletions: 0, sha: '', rawUrl: '' } as never;

describe.skipIf(!PG_ADMIN_URL)("a bot's approval and the person behind it", () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let svc: ChangeRequestReviewService;
  let botId: string;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_approval_made_by'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const [bot] = await db
      .insert(users)
      .values({ email: 'ops@agent.hexis', emailBidx: 'ops@agent.hexis', name: 'Ops', botId: 'ops' })
      .returning({ id: users.id });
    botId = bot!.id;
    await db.insert(users).values({ email: 'dana@acme.com', emailBidx: 'dana@acme.com', name: 'Dana' });
    svc = new ChangeRequestReviewService(
      db,
      {
        canWriteAtRef: async () => true,
        // The states the approval answers with are not what this suite
        // checks: no access tree to resolve them against, so none is read.
        eligibleWritersForPathsAtRef: async () => null,
        canWriteBatchAtRef: async () => null,
      } as unknown as IAccessControl,
      { ensureRemotesFetched: async () => undefined } as unknown as WorkspaceService,
      {} as GitService,
    );
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  const approveAs = (madeBy: string, head: string) =>
    svc.approveFile(7, FILE.path, { id: botId, email: 'ops@agent.hexis', name: 'Ops', madeBy: { name: 'X', email: madeBy } }, [FILE], head, 'main', null, 'ws');

  it('records the person behind the bot when they have an account', async () => {
    await expect(approveAs('Dana@Acme.com', 'head-1')).resolves.toHaveLength(1);
    const rows = await db.select().from(prFileApprovals).where(eq(prFileApprovals.headSha, 'head-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.madeByEmail).toBe('dana@acme.com');
  });

  it('refuses, and records nothing, when the person behind the bot has no account any more', async () => {
    await expect(approveAs('gone@acme.com', 'head-2')).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/person who made this connection/),
    });
    expect(await db.select().from(prFileApprovals).where(eq(prFileApprovals.headSha, 'head-2'))).toEqual([]);
  });
});
