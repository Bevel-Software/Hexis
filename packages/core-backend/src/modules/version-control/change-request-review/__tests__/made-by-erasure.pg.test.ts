import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { changeRequests, pendingCommits, prFileApprovals, users, type Database } from '../../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../../__tests__/pg-scratch.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';
import { madeByColumns, writeNamingActor } from '../../made-by.js';
import { PendingCommitsService } from '../../pending-commits.service.js';

/**
 * A record of a bot's action names the person who made its connection
 * (`madeBy`), and that person's erasure rewrites the name out of every
 * record under the every-request approval lock, then deletes their row. A
 * record written while the erasure runs must not put the name back: the
 * writer joins that lock and asks for the person's account before it writes
 * (`holdMaker`), so it either commits first and is rewritten with the rest,
 * or waits for the erasure and refuses. On a real Postgres, where the
 * ordering is the database's.
 */

const BOT = 'coder@agent.hexis';
const PERSON = 'dana@acme.com';
const ERASED = { email: 'erased-1@erased.invalid', name: 'Deleted user' };

describe.skipIf(!PG_ADMIN_URL)('a record naming the person behind a bot, against their erasure', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let svc: ChangeRequestReviewService;
  let botUser: { id: string; email: string; name: string; madeBy: { name: string; email: string } };

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_made_by_erasure'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    svc = new ChangeRequestReviewService(db, {} as never, {} as never, {} as never);
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  beforeEach(async () => {
    for (const table of [prFileApprovals, changeRequests, pendingCommits, users] as const) await db.delete(table);
    const [bot] = await db
      .insert(users)
      .values({ email: BOT, emailBidx: BOT, name: 'Coder', botId: 'coder' })
      .returning({ id: users.id });
    await db.insert(users).values({ email: PERSON, emailBidx: PERSON, name: 'Dana' });
    botUser = { id: bot!.id, email: BOT, name: 'Coder', madeBy: { name: 'Dana', email: 'Dana@Acme.com' } };
  });

  /** A change request opened as the bot, through the one write that names it. */
  const openRequest = (title: string, beforeInsert?: () => Promise<void>) =>
    writeNamingActor(db, botUser, async (q, author) => {
      await beforeInsert?.();
      return q.insert(changeRequests).values({
        sourceBranch: `b/${title}`,
        targetBranch: 'main',
        title,
        authorEmail: author,
        authorEmailBidx: author,
        authorName: 'Coder',
        ...madeByColumns(botUser.madeBy),
      });
    });

  /** The part of account erasure that matters here, in its order: the lock, the rewrite, the row. */
  const erase = (afterLock?: () => Promise<void>) =>
    db.transaction(async (tx) => {
      await svc.eraseApprover(tx, PERSON, ERASED);
      await afterLock?.();
      await tx
        .update(changeRequests)
        .set({ madeByEmail: ERASED.email, madeByEmailBidx: ERASED.email, madeByName: ERASED.name })
        .where(eq(changeRequests.madeByEmailBidx, PERSON));
      await tx.delete(users).where(eq(users.emailBidx, PERSON));
    });

  const blockedOnLock = async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
      );
      if (Number((rows[0] as { n: number }).n) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no transaction is waiting on a lock');
  };
  const signal = () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  };
  const madeByOf = async () => (await db.select().from(changeRequests)).map((r) => r.madeByEmail);

  it('records the person when they have an account, and refuses with nothing written when they have none', async () => {
    await openRequest('first');
    expect(await madeByOf()).toEqual([PERSON]);
    await db.delete(users).where(eq(users.emailBidx, PERSON));
    await expect(openRequest('second')).rejects.toMatchObject({ status: 401, payload: { kind: 'connection-maker-erased' } });
    expect(await madeByOf()).toEqual([PERSON]);
    // A record that keeps nothing of the person (who could not apply a request) is not refused.
    await expect(writeNamingActor(db, botUser, async (_q, address) => address, { namesMaker: false })).resolves.toBe(BOT);
  });

  it('waits for an erasure that took the lock first, then refuses instead of writing the erased name', async () => {
    const locked = signal();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const erasure = erase(async () => {
      locked.open();
      await held;
    });
    await locked.opened;
    const writer = openRequest('racing');
    // Let the erasure commit only once the writer is blocked behind it.
    await blockedOnLock();
    release();
    await erasure;
    await expect(writer).rejects.toMatchObject({ payload: { kind: 'connection-maker-erased' } });
    expect(await madeByOf()).toEqual([]);
  });

  it('holds back an erasure that starts while it writes, and the erasure rewrites its record with the rest', async () => {
    const writing = signal();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const writer = openRequest('racing', async () => {
      writing.open();
      await held;
    });
    await writing.opened;
    const erasure = erase();
    // Let the record commit only once the erasure is blocked behind it.
    await blockedOnLock();
    release();
    await writer;
    await erasure;
    expect(await madeByOf()).toEqual([ERASED.email]);
  });

  // A queued save's bytes are already on disk, possibly on top of another
  // save of the same path still queued, so the queue never refuses it for the
  // person behind the bot: there would be nothing safe to put back. Erasure's
  // passes rewrite the row instead (`account-erasure.approval-gate.test.ts`).
  it("queues a bot's save even once the person behind it has no account, naming the address it was made with", async () => {
    const queue = new PendingCommitsService(db);
    const save = (path: string) =>
      queue.enqueue({ workspaceId: 'main', branch: 'main', path, authorEmail: BOT, authorName: 'Coder', madeBy: botUser.madeBy });
    await save('a.md');
    await db.delete(users).where(eq(users.emailBidx, PERSON));
    await save('b.md');
    await expect(
      queue.enqueueIfAbsent({ workspaceId: 'main', branch: 'main', path: 'c.md', authorEmail: BOT, authorName: 'Coder', madeBy: botUser.madeBy }),
    ).resolves.toBe(true);
    const rows = (await db.select().from(pendingCommits)).map((r) => [r.path, r.madeByEmail]);
    expect(rows.sort()).toEqual([['a.md', PERSON], ['b.md', PERSON], ['c.md', PERSON]]);
  });

  it('answers a wait past the bound on an erasure as a retryable busy refusal, not a database error', async () => {
    const locked = signal();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // An erasure that holds the lock and does not let go.
    const erasure = db.transaction(async (tx) => {
      await svc.eraseApprover(tx, 'nobody@example.com', ERASED);
      locked.open();
      await held;
    });
    await locked.opened;
    const queue = new PendingCommitsService(db);
    const busy = { status: 503, payload: { kind: 'record-write-busy', retryable: true } };
    try {
      // A queued save does not wait on that lock at all: it lands at once,
      // while the request gives up after the bound.
      await queue.enqueue({ workspaceId: 'main', branch: 'main', path: 'a.md', authorEmail: BOT, authorName: 'Coder', madeBy: botUser.madeBy });
      await expect(openRequest('waiting')).rejects.toMatchObject(busy);
    } finally {
      release();
      await erasure;
    }
    expect(await madeByOf()).toEqual([]);
    expect((await db.select().from(pendingCommits)).map((r) => r.path)).toEqual(['a.md']);
  }, 20_000);
});
