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
import type { IChangeReadGate } from '../../access-model/index.js';

/**
 * A bot changes access as a person does: the lock every write acquires and
 * the merges judge it by the rules every account is judged by, with no
 * refusal of its own for an access file or a file's access lines. Its one
 * extra condition is on a change request's merge: it may write every file
 * the merge changes, since no approval of others stands in for its grants.
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
  it.each(['roles.yaml', 'access.md', 'Team/access.md', 'groups.yaml', 'synced-groups.yaml', 'Team/page.md'])(
    'takes the lock on %s on a draft branch, as a person does',
    async (file) => {
      const { svc, acquire } = makeService();
      expect((await svc.acquireLock(WS, DRAFT, `${KB}/${file}`, BOT)).acquired).toBe(true);
      expect((await svc.acquireLock(WS, DRAFT, `${KB}/${file}`, PERSON)).acquired).toBe(true);
      expect(acquire).toHaveBeenCalledTimes(2);
    },
  );
});

describe('a bot merging a change request', () => {
  const merge = (svc: VersionControlService, user: AuthUser) =>
    svc.mergeChangeRequest(7, user, 'sha', [], 'open' as never, 'title', 'main', WS);

  it.each([
    ['an access.md', { 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } }],
    ["a file's own access lines", { 'Team/page.md': { base: '---\nread:\n  - Eng\n---\n# p\n', head: '---\nread:\n  - everyone\n---\n# p\n' } }],
    ['a group file', { 'groups.yaml': { base: 'groups: {}\n', head: 'groups:\n  Ops: [x@acme.com]\n' } }],
  ])('merges one that changes %s where it may write every changed file', async (_what, changed) => {
    const { svc, landed, canWriteBatchAtRef } = makeService(changed);
    await merge(svc, BOT);
    expect(landed.count).toBe(1);
    expect(canWriteBatchAtRef).toHaveBeenCalledWith('ws-main', TARGET_TIP, BOT.email, Object.keys(changed));
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

  it('lands a merge that changes an access.md or access lines, judged as any account is', async () => {
    const { svc, landed } = makeService(
      {
        'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' },
        'Team/page.md': { base: '---\nread:\n  - Eng\n---\n', head: '---\nread:\n  - everyone\n---\n' },
      },
      noOpenRequest,
    );
    await svc.mergeBranch(BOT, DRAFT, PROTECTED);
    expect(landed.count).toBe(1);
  });

  it('is refused one that changes a file it may not write at the target, as a person is', async () => {
    const changed = { 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } };
    const bot = makeService(changed, noOpenRequest, () => false);
    await expect(bot.svc.mergeBranch(BOT, DRAFT, PROTECTED)).rejects.toThrow();
    expect(bot.landed.count).toBe(0);
    const person = makeService(changed, noOpenRequest, () => false);
    await expect(person.svc.mergeBranch(PERSON, DRAFT, PROTECTED)).rejects.toThrow();
    expect(person.landed.count).toBe(0);
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

  it("names a file outside the bot's write access, so nothing derived from the blockers claims the bot may apply it", async () => {
    const outside = makeService({ 'Ops/runbook.md': { base: '# a\n', head: '# b\n' } }, {}, (email) => email !== BOT.email);
    const d = await detail(outside.svc, BOT);
    expect(d?.mergeBlockedReasons).toEqual([expect.stringMatching(/outside its write access \(Ops\/runbook\.md\)/)]);
    expect(d?.mergeableInBevel).toBe(false);
  });

  it('names no change to access: an access.md, access lines or a group file it may write leave the bot cleared', async () => {
    const { svc } = makeService({
      'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' },
      'Team/page.md': { base: '---\nread:\n  - Eng\n---\n', head: '---\nread:\n  - everyone\n---\n' },
      'groups.yaml': { base: 'groups: {}\n', head: 'groups:\n  Ops: [x@acme.com]\n' },
    });
    const d = await detail(svc, BOT);
    expect(d?.mergeBlockedReasons).toEqual([]);
    expect(d?.mergeableInBevel).toBe(true);
  });

  it('leaves out roles.yaml, whose change the merge restores away first for every account', async () => {
    // A bot may never write roles.yaml (only an admin may), yet a request
    // carrying a roles.yaml change is not its to be refused for: the merge
    // drops that change, as it does for a person.
    const mayWrite = (email: string, p: string) => email !== BOT.email || p !== 'roles.yaml';
    const { svc, canWriteBatchAtRef } = makeService(
      { 'roles.yaml': { base: 'roles: {}\n', head: 'roles:\n  admin: [x]\n' }, 'Team/page.md': { base: '# a\n', head: '# b\n' } },
      {},
      mayWrite,
    );
    const d = await detail(svc, BOT);
    expect(d?.mergeBlockedReasons).toEqual([]);
    expect(canWriteBatchAtRef).toHaveBeenCalledWith('ws-main', TARGET_TIP, BOT.email, ['Team/page.md']);
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

  it('says the check could not be made when the commits cannot be compared, rather than leaving the bot cleared', async () => {
    const { svc, git } = makeService({ 'Team/page.md': { base: '# a\n', head: '# b\n' } });
    (git.writtenPathsBetweenCommits as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fatal: bad object'));
    const d = await detail(svc, BOT);
    expect(d?.mergeableInBevel).toBe(false);
    expect(d?.mergeBlockedReasons).toEqual(['Whether this bot may apply the request could not be checked right now.']);
    // Not kept: once the commits compare again, the next look clears the bot.
    expect((await detail(svc, BOT))?.mergeBlockedReasons).toEqual([]);
  });

  it('adds nothing for a request the bot may apply, nor for a person reading one it would refuse', async () => {
    const plain = makeService({ 'Team/page.md': { base: '# a\n', head: '# b\n' } });
    expect((await detail(plain.svc, BOT))?.mergeBlockedReasons).toEqual([]);
    const outside = makeService({ 'Ops/runbook.md': { base: '# a\n', head: '# b\n' } }, {}, (email) => email !== BOT.email);
    const d = await detail(outside.svc, PERSON);
    expect(d?.mergeBlockedReasons).toEqual([]);
    expect(d?.mergeableInBevel).toBe(true);
  });
});
