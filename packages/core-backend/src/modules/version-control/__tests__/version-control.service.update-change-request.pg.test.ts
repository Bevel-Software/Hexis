import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { runCoreMigrations } from '../../database/migrate.js';
import { changeRequests } from '../../database/core-schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { hashEmail } from '../../../shared/email-identity.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlService } from '../version-control.service.js';

/**
 * An edit against a real Postgres with column encryption ON. `title` and
 * `body` are sealed with a fresh IV on every write, so no stub of the driver
 * shows what a guard comparing the stored body would do: never match, and
 * refuse every permitted edit with 409. Here the row is real and encrypted.
 */
const KEY = randomBytes(32).toString('base64');
const AUTHOR = 'alice@example.com';
const alice: AuthUser = { id: 'u-alice', email: AUTHOR, name: 'Alice' };
const open: Database[] = [];

async function seeded(): Promise<{ svc: VersionControlService; db: Database; number: number }> {
  const db = createDb(await scratchDatabaseUrl('hexis_cr_edit'), { piiKey: KEY });
  open.push(db);
  await runCoreMigrations(db, coreMigrationsDir());
  const [row] = await db
    .insert(changeRequests)
    .values({
      sourceBranch: 'alice/draft',
      targetBranch: 'main',
      title: 'Old title',
      body: 'Old reason.',
      authorEmail: AUTHOR,
      authorEmailBidx: AUTHOR,
      authorName: 'Alice',
    })
    .returning({ number: changeRequests.number });
  const number = row.number!;
  const readRow = async () =>
    (await db.select().from(changeRequests).where(eq(changeRequests.number, number)))[0];
  const prs = {
    getPr: vi.fn(async () => {
      const r = await readRow();
      return { number, title: r.title, base: 'main', branch: 'alice/draft', state: r.state, authorId: hashEmail(AUTHOR) };
    }),
    invalidateDetailCache: vi.fn(),
  } as unknown as PullRequestService;
  const svc = new VersionControlService(
    db,
    {} as GitService,
    prs,
    {} as IChangeRequestReviewService,
    {} as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    {} as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
  );
  return { svc, db, number };
}

describe.skipIf(!PG_ADMIN_URL)('VersionControlService.updateChangeRequest on a real, encrypted Postgres', () => {
  afterAll(async () => {
    for (const db of open) await closeDb(db);
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    'lets the author change the title and description, and reads the new text back',
    async () => {
      const { svc, db, number } = await seeded();
      await svc.updateChangeRequest(number, alice, { title: 'New title', description: 'New reason.' });
      const [row] = await db.select().from(changeRequests).where(eq(changeRequests.number, number));
      expect(row.title).toBe('New title');
      expect(row.body).toBe('New reason.');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'lands two appends racing each other, neither lost',
    async () => {
      const { svc, db, number } = await seeded();
      await Promise.all([
        svc.updateChangeRequest(number, alice, { appendDescription: 'Note one.' }),
        svc.updateChangeRequest(number, alice, { appendDescription: 'Note two.' }),
      ]);
      const [row] = await db.select().from(changeRequests).where(eq(changeRequests.number, number));
      expect(row.body).toMatch(/^Old reason\.\n\nNote (one|two)\.\n\nNote (one|two)\.$/);
      expect(row.body).toContain('Note one.');
      expect(row.body).toContain('Note two.');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'refuses a closed request with the worded 409',
    async () => {
      const { svc, db, number } = await seeded();
      await db.update(changeRequests).set({ state: 'closed' }).where(eq(changeRequests.number, number));
      await expect(svc.updateChangeRequest(number, alice, { title: 'Nope' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('closed'),
      });
    },
    PG_TEST_TIMEOUT,
  );
});
