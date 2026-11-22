import { describe, expect, it, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlEventBus } from '../event-bus.js';
import { VersionControlService } from '../version-control.service.js';
import type { Database } from '../../database/connection.js';
import type { IChangeReadGate } from '../../access-model/change-gate.js';
import { BotChangesAccessError } from '../../access-model/index.js';

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

type MergeHook = (t: { sha: string; sourceSha: string; changedPaths: string[]; workspaceId: string }) => Promise<void>;

/**
 * `changed` is what the merge writes, as the git layer reports it: every
 * path (roles.yaml and both sides of a rename included) with its content at
 * the target commit and at the source commit. Both merges run their hook the
 * way the real ones do — inside the merge, before anything lands — and record
 * whether the merge landed.
 */
function makeService(changed: Record<string, { base: string | null; head: string | null }> = {}, db: unknown = {}) {
  const acquire = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const gate: IChangeReadGate = { judge: vi.fn(), assertMayChange: vi.fn(async () => undefined) };
  const landed = { count: 0 };
  const target = (workspaceId: string) => ({ sha: 'target-tip', sourceSha: 'source-tip', changedPaths: Object.keys(changed), workspaceId });
  const git = {
    fetch: vi.fn(async () => undefined),
    remoteBranchExists: vi.fn(async () => true),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, p: string) =>
      ref === 'target-tip' ? (changed[p]?.base ?? null) : ref === 'source-tip' ? (changed[p]?.head ?? null) : null,
    ),
    mergeChangeRequest: vi.fn(async (ws: string, _s: string, _t: string, _c: unknown, _u: unknown, opts: { authorize?: MergeHook }) => {
      await opts.authorize?.(target(ws));
      landed.count += 1;
      return { kind: 'conflicts', paths: [] };
    }),
  } as unknown as GitService;
  const prs = { getPr: vi.fn(async () => ({ base: 'main', branch: DRAFT })), invalidateDetailCache: vi.fn() } as unknown as PullRequestService;
  const mergePr = vi.fn(async (...args: unknown[]) => {
    const opts = args[8] as { authorize?: MergeHook } | undefined;
    await opts?.authorize?.(target('ws-main'));
    landed.count += 1;
    return { merged: true };
  });
  const svc = new VersionControlService(
    db as Database,
    git,
    prs,
    { mergePr } as unknown as IChangeRequestReviewService,
    { getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-draft' })) } as unknown as WorkspaceService,
    { canWriteBatchAtRef: vi.fn(async (_ws: string, _sha: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true]))) } as unknown as IAccessControl,
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
  return { svc, acquire, mergePr, landed, git };
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
    expect(forBot.message).toMatch(/use `apply_change_request` with number 12/);
    expect(forBot.message).not.toMatch(/ask the user/);
    const forPerson = await svc.mergeBranch(PERSON, DRAFT, 'main').catch((e: unknown) => e as Error);
    expect(forPerson.message).toMatch(/A change request is merged by a person: ask the user to review #12 in the app\./);
  });
});
