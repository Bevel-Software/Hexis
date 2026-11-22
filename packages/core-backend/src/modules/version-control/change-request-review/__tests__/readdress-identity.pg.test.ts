import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { changeRequests, prFileApprovals, type Database } from '../../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../../__tests__/pg-scratch.js';
import { hashEmail } from '../../../../shared/email-identity.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';

/**
 * A bots' domain change moves what names a bot by its address: the approvals
 * it made (as approver, and as the person behind another bot's approval) and
 * the change requests it authored or made. Without it the bot stops being the
 * author of its own open requests (edit, cancel, the author filter and
 * self-approval all hash the stored address), and its approvals stop
 * counting. On a real Postgres, where the address columns are ciphertext and
 * only the blind index finds a row.
 */

const BOT_OLD = 'coder@agent.hexis';
const BOT_NEW = 'coder@bots.acme.com';
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

  const request = (author: string, madeBy: string | null, title: string) => ({
    sourceBranch: `b/${title}`,
    targetBranch: 'main',
    title,
    authorEmail: author,
    authorEmailBidx: author,
    authorName: author.split('@')[0]!,
    madeByEmail: madeBy,
    madeByEmailBidx: madeBy,
    madeByName: madeBy ? madeBy.split('@')[0]! : null,
  });
  const approval = (path: string, approver: string, madeBy: string | null) => ({
    prNumber: 1,
    path,
    approverEmail: approver,
    approverEmailBidx: approver,
    approverName: approver.split('@')[0]!,
    madeByEmail: madeBy,
    madeByEmailBidx: madeBy,
    madeByName: madeBy ? madeBy.split('@')[0]! : null,
    headSha: 'head-1',
  });

  it('moves its approvals and its requests to the new address, leaves a person\'s alone, and moves them back', async () => {
    await db.insert(changeRequests).values([
      request(BOT_OLD, PERSON, 'by-bot'),
      request(PERSON, null, 'by-person'),
      request('mechanic@agent.hexis', BOT_OLD, 'bot-for-bot'),
    ]);
    await db.insert(prFileApprovals).values([
      approval('Team/a.md', BOT_OLD, PERSON),
      approval('Team/b.md', PERSON, null),
      approval('Team/c.md', 'mechanic@agent.hexis', BOT_OLD),
    ]);

    await db.transaction((tx) => svc.readdressIdentity(tx, BOT_OLD, BOT_NEW));

    const requests = async () =>
      (await db.select().from(changeRequests))
        .map((r) => `${r.title} ${r.authorEmail} ${r.madeByEmail ?? '-'}`)
        .sort();
    expect(await requests()).toEqual([
      `bot-for-bot mechanic@agent.hexis ${BOT_NEW}`,
      `by-bot ${BOT_NEW} ${PERSON}`,
      `by-person ${PERSON} -`,
    ]);
    // What every "is this the author" check compares: the hash of the stored address.
    const [byBot] = (await db.select().from(changeRequests)).filter((r) => r.title === 'by-bot');
    expect(hashEmail(byBot!.authorEmail)).toBe(hashEmail(BOT_NEW));

    const approvals = async () =>
      (await db.select().from(prFileApprovals))
        .map((a) => `${a.path} ${a.approverEmail} ${a.madeByEmail ?? '-'}`)
        .sort();
    expect(await approvals()).toEqual([
      `Team/a.md ${BOT_NEW} ${PERSON}`,
      `Team/b.md ${PERSON} -`,
      `Team/c.md mechanic@agent.hexis ${BOT_NEW}`,
    ]);

    // The blind index moved too: the reverse move finds the rows by the new address.
    await db.transaction((tx) => svc.readdressIdentity(tx, BOT_NEW, BOT_OLD));
    expect(await requests()).toEqual([
      `bot-for-bot mechanic@agent.hexis ${BOT_OLD}`,
      `by-bot ${BOT_OLD} ${PERSON}`,
      `by-person ${PERSON} -`,
    ]);
    expect(await approvals()).toEqual([
      `Team/a.md ${BOT_OLD} ${PERSON}`,
      `Team/b.md ${PERSON} -`,
      `Team/c.md mechanic@agent.hexis ${BOT_OLD}`,
    ]);
  });

  it('moves nothing when the caller\'s transaction rolls back', async () => {
    await db.delete(prFileApprovals);
    await db.insert(prFileApprovals).values([approval('Team/d.md', BOT_OLD, PERSON)]);
    await expect(
      db.transaction(async (tx) => {
        await svc.readdressIdentity(tx, BOT_OLD, BOT_NEW);
        throw new Error('row update failed');
      }),
    ).rejects.toThrow('row update failed');
    const rows = await db.select().from(prFileApprovals);
    expect(rows.map((a) => a.approverEmail)).toEqual([BOT_OLD]);
  });
});
