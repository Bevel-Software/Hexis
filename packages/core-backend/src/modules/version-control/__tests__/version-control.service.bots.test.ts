import { describe, expect, it, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlEventBus } from '../event-bus.js';
import { VersionControlService } from '../version-control.service.js';
import type { Database } from '../../database/index.js';
import { BotChangesAccessError, type IChangeReadGate } from '../../access-model/index.js';

/**
 * A bot never changes access, at the two places every change of it passes:
 * the lock every write acquires (on any branch, drafts included, where no
 * write gate runs), and the merge of a change request. A person is held to
 * neither, and a bot's other writes and merges go through as before.
 */

const KB = 'knowledge-base';
const DRAFT = 'bots/proposal';
const WS = 'ws-1';
/** A protected branch of the test knowledge base. */
const PROTECTED = 'current-company-state';
const BOT: AuthUser = { id: 'u-bot', email: 'release-helper@agent.hexis', name: 'release-helper' };
const PERSON: AuthUser = { id: 'u-dana', email: 'dana@acme.com', name: 'Dana' };
const isBot = (email: string) => email === BOT.email;
/** The target and source commits every merge and detail here is read at. */
const TARGET_TIP = 'a'.repeat(40);
const SOURCE_TIP = 'b'.repeat(40);

type MergeHook = (t: { sha: string; sourceSha: string; changedPaths: string[]; workspaceId: string }) => Promise<void>;

/**
 * `changed` is what the merge writes, as the git layer reports it: every
 * path (roles.yaml and both sides of a rename included) with its content at
 * the target commit and at the source commit. Both merges run their hook the
 * way the real ones do — inside the merge, before anything lands — and record
 * whether the merge landed.
 */
function makeService(
  changed: Record<string, { base: string | null; head: string | null }> = {},
  db: unknown = {},
  /** Who may write a path, as the access rules at the target commit answer it. */
  mayWrite: (email: string, path: string) => boolean = () => true,
) {
  const acquire = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const gate: IChangeReadGate = { judge: vi.fn(), assertMayChange: vi.fn(async () => undefined) };
  const landed = { count: 0 };
  const target = (workspaceId: string) => ({ sha: TARGET_TIP, sourceSha: SOURCE_TIP, changedPaths: Object.keys(changed), workspaceId });
  const git = {
    fetch: vi.fn(async () => undefined),
    remoteBranchExists: vi.fn(async () => true),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, p: string) =>
      ref === TARGET_TIP ? (changed[p]?.base ?? null) : ref === SOURCE_TIP ? (changed[p]?.head ?? null) : null,
    ),
    // The authorizing set between the two commits, as the git layer reports
    // it: every path the merge writes, roles.yaml included.
    writtenPathsBetweenCommits: vi.fn(async (_ws: string, base: string, head: string) =>
      base === TARGET_TIP && head === SOURCE_TIP ? Object.keys(changed) : [],
    ),
    mergeChangeRequest: vi.fn(async (ws: string, _s: string, _t: string, _c: unknown, _u: unknown, opts: { authorize?: MergeHook }) => {
      await opts.authorize?.(target(ws));
      landed.count += 1;
      return { kind: 'conflicts', paths: [] };
    }),
  } as unknown as GitService;
  const prs = {
    getPr: vi.fn(async () => ({ base: 'main', branch: DRAFT })),
    invalidateDetailCache: vi.fn(),
    // The detail as the gate reads it: open and mergeable, at the two tips the
    // merge would use, listing the files the review surface lists — every
    // path of `changed` but roles.yaml, which that list leaves out.
    getPrDetail: vi.fn(async () => ({
      state: 'open',
      baseSha: TARGET_TIP,
      headSha: SOURCE_TIP,
      files: Object.keys(changed).filter((path) => path !== 'roles.yaml').map((path) => ({ path })),
      mergeableInBevel: true,
      mergeBlockedReasons: [],
      mergeWarnings: [],
    })),
  } as unknown as PullRequestService;
  const mergePr = vi.fn(async (...args: unknown[]) => {
    const opts = args[8] as { authorize?: MergeHook } | undefined;
    await opts?.authorize?.(target('ws-main'));
    landed.count += 1;
    return { merged: true };
  });
  const canWriteBatchAtRef = vi.fn(async (_ws: string, sha: string, email: string, paths: string[]) =>
    sha === TARGET_TIP ? new Map(paths.map((p) => [p, mayWrite(email, p)])) : null,
  );
  const svc = new VersionControlService(
    db as Database,
    git,
    prs,
    { mergePr } as unknown as IChangeRequestReviewService,
    { getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-draft' })) } as unknown as WorkspaceService,
    { canWriteBatchAtRef } as unknown as IAccessControl,
    { acquire, get: vi.fn(async () => null) } as unknown as FileLockService,
    { queuedOnBranch: vi.fn(async () => ({ queued: 0, stuck: 0, needsAttention: null })) } as unknown as PendingCommitsService,
    testKbContext({ kbDirName: KB }),
    gate,
    new VersionControlEventBus(),
    undefined,
    undefined,
    undefined,
    isBot,
  );
  return { svc, acquire, mergePr, landed, git, canWriteBatchAtRef };
}

describe('a bot at the lock', () => {
  it.each(['roles.yaml', 'access.md', 'Team/access.md', 'groups.yaml', 'synced-groups.yaml'])(
    'is refused %s, on a draft branch too, before any lock is taken',
    async (file) => {
      const { svc, acquire } = makeService();
      await expect(svc.acquireLock(WS, DRAFT, `${KB}/${file}`, BOT)).rejects.toBeInstanceOf(BotChangesAccessError);
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it('takes the lock on any other file, and a person takes it on an access file as before', async () => {
    const { svc, acquire } = makeService();
    expect((await svc.acquireLock(WS, DRAFT, `${KB}/Team/page.md`, BOT)).acquired).toBe(true);
    expect((await svc.acquireLock(WS, DRAFT, `${KB}/Team/access.md`, PERSON)).acquired).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
  });
});

describe('a bot merging a change request', () => {
  const merge = (svc: VersionControlService, user: AuthUser) =>
    svc.mergeChangeRequest(7, user, 'sha', [], 'open' as never, 'title', 'main', WS);

  it('is refused one that changes an access.md, naming it, and nothing is merged', async () => {
    const { svc, landed } = makeService({ 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } });
    await expect(merge(svc, BOT)).rejects.toThrow(/"Team\/access\.md" decides who may reach what/);
    expect(landed.count).toBe(0);
  });

  it("is refused one that changes a file's own access lines", async () => {
    const { svc, landed } = makeService({
      'Team/page.md': { base: '---\nread:\n  - Eng\n---\n# p\n', head: '---\nread:\n  - everyone\n---\n# p\n' },
    });
    await expect(merge(svc, BOT)).rejects.toThrow(/access lines/);
    expect(landed.count).toBe(0);
  });

  it('is refused one that changes roles.yaml, which is refused rather than quietly restored', async () => {
    const { svc, landed, git } = makeService({ 'roles.yaml': { base: 'roles: {}\n', head: 'roles:\n  admin: [x]\n' } });
    await expect(merge(svc, BOT)).rejects.toThrow(/"roles\.yaml" decides who may reach what/);
    expect(landed.count).toBe(0);
    // Nothing was rewritten on the bot's behalf before the refusal.
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('is refused one that renames an access.md away: the old side is a path it writes', async () => {
    const { svc, landed } = makeService({
      'Team/access.md': { base: 'read:\n  - Eng\n', head: null },
      'Team/notes.md': { base: null, head: 'read:\n  - Eng\n' },
    });
    await expect(merge(svc, BOT)).rejects.toThrow(/"Team\/access\.md"/);
    expect(landed.count).toBe(0);
  });

  it('merges one that only renames a granted person or reformats the lines', async () => {
    const { svc, landed } = makeService({
      'Team/page.md': {
        base: '---\nread:\n  - Ada <ada@acme.com>\n  - Eng\n---\n# p\n',
        head: '---\nread: ["Ada Lovelace <ADA@acme.com>", "eng"]\n---\n# p, edited\n',
      },
    });
    await merge(svc, BOT);
    expect(landed.count).toBe(1);
  });

  it("is refused one that changes a file it may not write, though others approved it, naming the file; a person's Apply is not asked", async () => {
    const changed = {
      'Team/page.md': { base: '# p\n', head: '# p, edited\n' },
      'Ops/runbook.md': { base: '# r\n', head: '# r, edited\n' },
    };
    const mayWrite = (email: string, p: string) => email !== BOT.email || p.startsWith('Team/');
    const { svc, landed, canWriteBatchAtRef } = makeService(changed, {}, mayWrite);
    const refused = merge(svc, BOT);
    await expect(refused).rejects.toMatchObject({
      status: 403,
      payload: { kind: 'bot-merge-outside-grant', deniedPaths: ['Ops/runbook.md'] },
    });
    expect(landed.count).toBe(0);
    // Judged for the bot, at the target commit the merge is built on.
    expect(canWriteBatchAtRef).toHaveBeenCalledWith('ws-main', TARGET_TIP, BOT.email, Object.keys(changed));

    const person = makeService(changed, {}, () => false);
    await merge(person.svc, PERSON);
    expect(person.landed.count).toBe(1);
    expect(person.canWriteBatchAtRef).not.toHaveBeenCalled();
  });

  it('is refused when its write access cannot be read at the target commit', async () => {
    const { svc, landed, canWriteBatchAtRef } = makeService({ 'Team/page.md': { base: '# p\n', head: '# q\n' } });
    canWriteBatchAtRef.mockResolvedValueOnce(null);
    await expect(merge(svc, BOT)).rejects.toMatchObject({ payload: { kind: 'bot-merge-outside-grant' } });
    expect(landed.count).toBe(0);
  });
});

describe('a bot merging a branch into a protected branch', () => {
  const noOpenRequest = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };

  it('is refused a merge that changes access, by the same check, and nothing lands', async () => {
    const { svc, landed } = makeService({ 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } }, noOpenRequest);
    await expect(svc.mergeBranch(BOT, DRAFT, PROTECTED)).rejects.toBeInstanceOf(BotChangesAccessError);
    expect(landed.count).toBe(0);
  });

  it("is refused a merge that changes a file's own access lines", async () => {
    const { svc, landed } = makeService(
      { 'Team/page.md': { base: '---\nread:\n  - Eng\n---\n', head: '---\nread:\n  - everyone\n---\n' } },
      noOpenRequest,
    );
    await expect(svc.mergeBranch(BOT, DRAFT, PROTECTED)).rejects.toThrow(/access lines/);
    expect(landed.count).toBe(0);
  });
});

describe('a bot merging a branch that an open change request proposes', () => {
  /** A database whose one answer is the open request #12 from the source into the target. */
  const openRequest = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ number: 12 }] }) }) }) };

  it('is pointed at apply_change_request, where the request\'s own gate decides; a person is pointed at the app', async () => {
    const { svc } = makeService({}, openRequest);
    const forBot = await svc.mergeBranch(BOT, DRAFT, 'main').catch((e: unknown) => e as Error);
    expect(forBot.message).toMatch(/Change request #12 proposes merging "bots\/proposal" into "main" and is still open\./);
    expect(forBot.message).toMatch(/use `apply_change_request` with number 12 if this connection is offered it; otherwise a person applies #12 in the app\./);
    expect(forBot.message).not.toMatch(/ask the user/);
    const forPerson = await svc.mergeBranch(PERSON, DRAFT, 'main').catch((e: unknown) => e as Error);
    expect(forPerson.message).toMatch(/A change request is merged by a person: ask the user to review #12 in the app\./);
  });
});

describe("a change request as a bot reads it: its own refusals are among the blockers", () => {
  const detail = (svc: VersionControlService, viewer: AuthUser) =>
    svc.getChangeRequestDetail(7, { workspaceId: 'ws-main', viewerEmail: viewer.email });

  it('names a change to access as a blocker, so nothing derived from the blockers claims the bot may apply it', async () => {
    const { svc } = makeService({ 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } });
    const d = await detail(svc, BOT);
    expect(d?.mergeableInBevel).toBe(false);
    expect(d?.mergeBlockedReasons).toEqual([expect.stringMatching(/A bot cannot change access: "Team\/access\.md"/)]);
  });

  it("names a change to a file's own access lines, and a file outside the bot's write access", async () => {
    const lines = makeService({ 'Team/page.md': { base: '---\nread:\n  - Eng\n---\n', head: '---\nread:\n  - everyone\n---\n' } });
    expect((await detail(lines.svc, BOT))?.mergeBlockedReasons).toEqual([expect.stringMatching(/access lines/)]);
    const outside = makeService({ 'Ops/runbook.md': { base: '# a\n', head: '# b\n' } }, {}, (email) => email !== BOT.email);
    const d = await detail(outside.svc, BOT);
    expect(d?.mergeBlockedReasons).toEqual([expect.stringMatching(/outside its write access \(Ops\/runbook\.md\)/)]);
    expect(d?.mergeableInBevel).toBe(false);
  });

  it('names a roles.yaml change, which the displayed file list leaves out but the merge refuses', async () => {
    const { svc } = makeService({ 'roles.yaml': { base: 'roles: {}\n', head: 'roles:\n  admin: [x]\n' } });
    const d = await detail(svc, BOT);
    expect(d?.files).toEqual([]);
    expect(d?.mergeableInBevel).toBe(false);
    expect(d?.mergeBlockedReasons).toEqual([expect.stringMatching(/A bot cannot change access: "roles\.yaml"/)]);
  });

  it('judges a pair of commits once while its verdict is kept, and judges again once it is not', async () => {
    vi.useFakeTimers();
    try {
      const { svc, git, canWriteBatchAtRef } = makeService({ 'Team/page.md': { base: '# a\n', head: '# b\n' } });
      await detail(svc, BOT);
      await detail(svc, BOT);
      expect(git.writtenPathsBetweenCommits).toHaveBeenCalledTimes(1);
      expect(canWriteBatchAtRef).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_001);
      await detail(svc, BOT);
      expect(git.writtenPathsBetweenCommits).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the check could not be made when a commit cannot be read, rather than leaving the bot cleared', async () => {
    const { svc, git } = makeService({ 'Team/page.md': { base: '# a\n', head: '# b\n' } });
    (git.readFileAtRef as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fatal: bad object'));
    const d = await detail(svc, BOT);
    expect(d?.mergeableInBevel).toBe(false);
    expect(d?.mergeBlockedReasons).toEqual(['Whether this bot may apply the request could not be checked right now.']);
    // Not kept: once the commit reads again, the next look clears the bot.
    (git.readFileAtRef as ReturnType<typeof vi.fn>).mockImplementation(async () => '# a\n');
    expect((await detail(svc, BOT))?.mergeBlockedReasons).toEqual([]);
  });

  it('adds nothing for a request the bot may apply, nor for a person reading one it would refuse', async () => {
    const plain = makeService({ 'Team/page.md': { base: '# a\n', head: '# b\n' } });
    expect((await detail(plain.svc, BOT))?.mergeBlockedReasons).toEqual([]);
    const access = makeService({ 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } });
    const d = await detail(access.svc, PERSON);
    expect(d?.mergeBlockedReasons).toEqual([]);
    expect(d?.mergeableInBevel).toBe(true);
  });
});
