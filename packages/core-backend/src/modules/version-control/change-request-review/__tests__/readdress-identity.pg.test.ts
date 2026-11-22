import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { changeRequests, pendingCommits, prFileApprovals, prMergeLog, users, type Database } from '../../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../../__tests__/pg-scratch.js';
import { hashEmail } from '../../../../shared/email-identity.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';
import { takeApprovalLock } from '../approval-lock.js';
import { recordedAddress, writeNamingActor } from '../../made-by.js';

/**
 * A bots' domain change moves every address version control records of a
 * bot: its approvals (as approver, and as the person behind another bot's
 * approval), the change requests it authored or made or could not apply, the
 * merges it started or made, and its queued saves. Without it the bot stops
 * being the author of its own open requests (edit, cancel, the author filter
 * and self-approval all hash the stored address), and its approvals stop
 * counting. A record a call writes while the change runs names the address
 * the bot's row has, whichever commits first. On a real Postgres, where the
 * address columns are ciphertext and only the blind index finds a row.
 */

const BOT_OLD = 'coder@agent.hexis';
const BOT_NEW = 'coder@bots.acme.com';
const OTHER_BOT = 'mechanic@agent.hexis';
const PERSON = 'dana@acme.com';

describe.skipIf(!PG_ADMIN_URL)("readdressing a bot's recorded identity", () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let svc: ChangeRequestReviewService;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_readdress_identity'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    svc = new ChangeRequestReviewService(db, {} as never, {} as never, {} as never);
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  beforeEach(async () => {
    for (const table of [prFileApprovals, changeRequests, prMergeLog, pendingCommits, users] as const) await db.delete(table);
  });

  const made = (madeBy: string | null) => ({
    madeByEmail: madeBy,
    madeByEmailBidx: madeBy,
    madeByName: madeBy ? madeBy.split('@')[0]! : null,
  });
  const request = (author: string, madeBy: string | null, title: string, applyFailedBy: string | null = null) => ({
    sourceBranch: `b/${title}`,
    targetBranch: 'main',
    title,
    authorEmail: author,
    authorEmailBidx: author,
    authorName: author.split('@')[0]!,
    ...made(madeBy),
    applyFailedByName: applyFailedBy ? applyFailedBy.split('@')[0]! : null,
    applyFailedByEmailBidx: applyFailedBy,
  });
  const approval = (path: string, approver: string, madeBy: string | null) => ({
    prNumber: 1,
    path,
    approverEmail: approver,
    approverEmailBidx: approver,
    approverName: approver.split('@')[0]!,
    ...made(madeBy),
    headSha: 'head-1',
  });
  const merge = (prNumber: number, by: string, madeBy: string | null) => ({
    prNumber,
    triggeredByEmail: by,
    triggeredByEmailBidx: by,
    triggeredByName: by.split('@')[0]!,
    ...made(madeBy),
    headShaAtMerge: 'head-1',
    mergeMethod: 'merge',
    succeeded: true,
  });
  const save = (path: string, author: string, madeBy: string | null) => ({
    workspaceId: 'main',
    branch: 'main',
    path,
    authorEmail: author,
    authorEmailBidx: author,
    authorName: author.split('@')[0]!,
    ...made(madeBy),
  });

  /** Every record, one line each, sorted: what names whom. */
  const recorded = async () => {
    const lines: string[] = [];
    for (const r of await db.select().from(changeRequests)) {
      lines.push(`request ${r.title} author=${r.authorEmail} madeBy=${r.madeByEmail ?? '-'} applyFailedBy=${r.applyFailedByEmailBidx ? 'set' : '-'}`);
    }
    for (const a of await db.select().from(prFileApprovals)) lines.push(`approval ${a.path} ${a.approverEmail} madeBy=${a.madeByEmail ?? '-'}`);
    for (const m of await db.select().from(prMergeLog)) lines.push(`merge #${m.prNumber} ${m.triggeredByEmail} madeBy=${m.madeByEmail ?? '-'}`);
    for (const p of await db.select().from(pendingCommits)) lines.push(`save ${p.path} ${p.authorEmail} madeBy=${p.madeByEmail ?? '-'}`);
    return lines.sort();
  };
  /** The requests whose refusal to apply names `address` — found as every reader finds it, by its index. */
  const refusedBy = async (address: string) =>
    (await db.select().from(changeRequests).where(eq(changeRequests.applyFailedByEmailBidx, address))).map((r) => r.title).sort();

  const seed = async () => {
    await db.insert(changeRequests).values([
      request(BOT_OLD, PERSON, 'by-bot'),
      request(PERSON, null, 'by-person', BOT_OLD),
      request(OTHER_BOT, BOT_OLD, 'bot-for-bot'),
    ]);
    await db.insert(prFileApprovals).values([
      approval('Team/a.md', BOT_OLD, PERSON),
      approval('Team/b.md', PERSON, null),
      approval('Team/c.md', OTHER_BOT, BOT_OLD),
    ]);
    await db.insert(prMergeLog).values([merge(1, BOT_OLD, PERSON), merge(2, PERSON, null), merge(3, OTHER_BOT, BOT_OLD)]);
    await db.insert(pendingCommits).values([save('Team/a.md', BOT_OLD, PERSON), save('Team/b.md', PERSON, null), save('Team/c.md', OTHER_BOT, BOT_OLD)]);
  };
  const at = (bot: string) => [
    `approval Team/a.md ${bot} madeBy=${PERSON}`,
    `approval Team/b.md ${PERSON} madeBy=-`,
    `approval Team/c.md ${OTHER_BOT} madeBy=${bot}`,
    `merge #1 ${bot} madeBy=${PERSON}`,
    `merge #2 ${PERSON} madeBy=-`,
    `merge #3 ${OTHER_BOT} madeBy=${bot}`,
    `request bot-for-bot author=${OTHER_BOT} madeBy=${bot} applyFailedBy=-`,
    `request by-bot author=${bot} madeBy=${PERSON} applyFailedBy=-`,
    `request by-person author=${PERSON} madeBy=- applyFailedBy=set`,
    `save Team/a.md ${bot} madeBy=${PERSON}`,
    `save Team/b.md ${PERSON} madeBy=-`,
    `save Team/c.md ${OTHER_BOT} madeBy=${bot}`,
  ].sort();

  it("moves every record of the bot to the new address, leaves a person's alone, and moves them back", async () => {
    await seed();
    await db.transaction((tx) => svc.readdressIdentity(tx, BOT_OLD, BOT_NEW));
    expect(await recorded()).toEqual(at(BOT_NEW));
    expect(await refusedBy(BOT_NEW)).toEqual(['by-person']);
    expect(await refusedBy(BOT_OLD)).toEqual([]);
    // What every "is this the author" check compares: the hash of the stored address.
    const [byBot] = (await db.select().from(changeRequests)).filter((r) => r.title === 'by-bot');
    expect(hashEmail(byBot!.authorEmail)).toBe(hashEmail(BOT_NEW));

    // The blind indexes moved too: the reverse move finds the rows by the new address.
    await db.transaction((tx) => svc.readdressIdentity(tx, BOT_NEW, BOT_OLD));
    expect(await recorded()).toEqual(at(BOT_OLD));
    expect(await refusedBy(BOT_OLD)).toEqual(['by-person']);
  });

  it("moves nothing when the caller's transaction rolls back", async () => {
    await seed();
    await expect(
      db.transaction(async (tx) => {
        await svc.readdressIdentity(tx, BOT_OLD, BOT_NEW);
        throw new Error('row update failed');
      }),
    ).rejects.toThrow('row update failed');
    // Every column the move rewrites, the person-behind ones and the requests included, is where it was.
    expect(await recorded()).toEqual(at(BOT_OLD));
    expect(await refusedBy(BOT_OLD)).toEqual(['by-person']);
  });

  describe('a record written while the domain changes', () => {
    let botUser: { id: string; email: string; name: string; madeBy: { name: string; email: string } };

    beforeEach(async () => {
      const [row] = await db
        .insert(users)
        .values({ email: BOT_OLD, emailBidx: BOT_OLD, name: 'Coder', botId: 'coder' })
        .returning({ id: users.id });
      // The person who made the connection, with an account (`holdMaker` asks).
      await db.insert(users).values({ email: PERSON, emailBidx: PERSON, name: 'Dana' });
      // The identity a connection resolved before the change: the old address.
      botUser = { id: row!.id, email: BOT_OLD, name: 'Coder', madeBy: { name: 'Dana', email: PERSON } };
    });

    /** The domain change's transaction, in the order `IRecordedIdentity` lays down. */
    const changeDomain = (afterRow?: () => Promise<void>) =>
      db.transaction(async (tx) => {
        await svc.holdRecordWriters(tx);
        await tx.update(users).set({ email: BOT_NEW, emailBidx: BOT_NEW }).where(eq(users.id, botUser.id));
        await afterRow?.();
        await svc.readdressIdentity(tx, BOT_OLD, BOT_NEW);
      });
    /**
     * Resolves once another transaction of this database is blocked on a
     * lock: the barrier that says the competing transaction has reached the
     * lock the test is about, read from Postgres rather than guessed from a
     * pause. Fails after ten seconds, so a race that never forms is a
     * failure, not a pass.
     */
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

    it('names the address the row has now, not the one the call resolved', async () => {
      await db.transaction((tx) => svc.readdressIdentity(tx, BOT_OLD, BOT_NEW));
      await db.update(users).set({ email: BOT_NEW, emailBidx: BOT_NEW }).where(eq(users.id, botUser.id));
      expect(await db.transaction((tx) => recordedAddress(tx, botUser))).toBe(BOT_NEW);
      // A person's is the address they act under; their row is not read.
      expect(await db.transaction((tx) => recordedAddress(tx, { id: botUser.id, email: 'Dana@Acme.com' }))).toBe(PERSON);
      // The write a record goes through: a bot's in a transaction that reads its row, a person's as it is, on no transaction.
      expect(await writeNamingActor(db, botUser, async (_q, address) => address)).toBe(BOT_NEW);
      const noTransactions = {} as Database;
      expect(await writeNamingActor(noTransactions, { id: botUser.id, email: 'Dana@Acme.com' }, async (q, address) => (q === noTransactions ? address : 'other'))).toBe(PERSON);
    });

    it('is moved with the rest when it held the bot first, and the change waits for it', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let changed = false;
      const rowHeld = signal();
      // A change request opened as the bot: it reads the row, then is slow to insert.
      const writer = db.transaction(async (tx) => {
        const author = await recordedAddress(tx, botUser);
        rowHeld.open();
        await held;
        await tx.insert(changeRequests).values({ ...request(author, PERSON, 'racing'), authorEmail: author, authorEmailBidx: author });
      });
      // The change starts only once the writer holds the row, and the insert
      // is let go only once the change is blocked on it.
      await rowHeld.opened;
      const change = changeDomain().then(() => {
        changed = true;
      });
      await blockedOnLock();
      // Held back by the writer's hold on the row, not finished before the insert.
      const heldBack = !changed;
      release();
      await writer;
      await change;
      expect(heldBack).toBe(true);
      expect((await db.select().from(changeRequests)).map((r) => r.authorEmail)).toEqual([BOT_NEW]);
    });

    it('names the new address when the change held the bot first, and an approval waiting on it does not deadlock', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      // The change has taken the record writers and the row, and has not committed yet.
      const changeHolds = signal();
      const change = changeDomain(() => {
        changeHolds.open();
        return held;
      });
      await changeHolds.opened;
      // An approval as the bot: the approval lock, then the bot's row, then the insert.
      const writer = db.transaction(async (tx) => {
        await takeApprovalLock(tx, 1);
        const approver = await recordedAddress(tx, botUser);
        await tx.insert(prFileApprovals).values(approval('Team/z.md', approver, PERSON));
      });
      // The change commits only once the approval is blocked behind it.
      await blockedOnLock();
      release();
      await change;
      await writer;
      expect((await db.select().from(prFileApprovals)).map((a) => a.approverEmail)).toEqual([BOT_NEW]);
    });
  });
});
