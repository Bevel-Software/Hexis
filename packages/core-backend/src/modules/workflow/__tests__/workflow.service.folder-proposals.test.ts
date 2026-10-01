import { describe, it, expect, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser, PullRequestSummary } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { hashEmail } from '../../../shared/email-identity.js';
import { WorkflowService } from '../workflow.service.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';

/**
 * Deleting a folder that holds proposed files: which open change requests the
 * delete names, who may take the folder's files out of them, and what taking
 * them out does — every file under the folder leaves every request, nothing
 * else does, and a request left empty is withdrawn.
 *
 * The git fake is stateful on purpose: a request's changed paths are what the
 * revert changes, so "left empty" is observed, not stubbed.
 */

const ALICE: AuthUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };
const DAN: AuthUser = { id: 'u-dan', email: 'dan@example.com', name: 'Dan' };

function summary(over: Partial<PullRequestSummary> & { number: number; branch: string }): PullRequestSummary {
  return {
    title: `Request ${over.number}`,
    author: { login: 'svc' },
    base: 'main',
    state: 'open',
    createdAt: '2026-09-01T00:00:00.000Z',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '',
    ...over,
  };
}

interface Access {
  /** Emails with write on roles.yaml at the base. */
  admins?: string[];
  /** Email → the folder prefixes it may write under at the base. */
  writes?: Record<string, string[]>;
}

function makeHarness(requests: PullRequestSummary[], access: Access = {}) {
  // branch → the paths its request still changes.
  const changed = new Map(requests.map((r) => [r.branch, new Set(r.touchedNodePaths)]));
  const states = new Map(requests.map((r) => [r.number, r.state]));
  const current = (r: PullRequestSummary): PullRequestSummary => ({
    ...r,
    state: states.get(r.number)!,
    touchedNodePaths: [...changed.get(r.branch)!],
  });

  const git = {
    pull: vi.fn().mockResolvedValue({ treeChanged: false }),
    changedPathsForPr: vi.fn(async (_ws: string, _base: string, head: string) => [...changed.get(head)!]),
    mergeBaseForPr: vi.fn().mockResolvedValue('mb-sha'),
    // The git half as it goes when every step succeeds: each reverted path
    // leaves its request, and every branch is published. Its failure modes
    // are GitService's own, and tested there against a real git.
    revertPathsAndPush: vi.fn(async (_user: AuthUser, plans: { workspaceId: string; paths: { path: string }[] }[]) => {
      for (const plan of plans) {
        for (const entry of plan.paths) changed.get(decodeURIComponent(plan.workspaceId))!.delete(entry.path);
      }
      return { pushed: plans.map((plan) => plan.workspaceId), failed: null };
    }),
  } as unknown as GitService;

  const prs = {
    listOpenPrs: vi.fn(async () => requests.filter((r) => states.get(r.number) === 'open').map(current)),
    getPr: vi.fn(async (n: number) => {
      const r = requests.find((x) => x.number === n);
      return r ? current(r) : null;
    }),
    invalidateDetailCache: vi.fn(),
  } as unknown as PullRequestService;

  const accessControl = {
    canWriteAtRef: vi.fn(async (_ws: string, ref: string, email: string, p: string) => {
      expect(ref).toBe('origin/main');
      if (p === 'roles.yaml') return (access.admins ?? []).includes(email);
      return false;
    }),
    canWriteBatchAtRef: vi.fn(async (_ws: string, ref: string, email: string, paths: string[]) => {
      expect(ref).toBe('origin/main');
      const prefixes = access.writes?.[email] ?? [];
      return new Map(paths.map((p) => [p, prefixes.some((prefix) => p.startsWith(prefix))]));
    }),
  } as unknown as IAccessControl;

  const fileLocks = {
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    release: vi.fn().mockResolvedValue(undefined),
    hasAnyActive: vi.fn().mockResolvedValue(false),
  } as unknown as FileLockService;
  const pendingCommits = {
    hasAnyForWorkspace: vi.fn().mockResolvedValue(false),
  } as unknown as PendingCommitsService;

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch) })),
    ensureRemotesFetched: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceService;

  // The empty-close is a guarded UPDATE; record which request it closed. The
  // source-branch retirement that follows reads no row here, so it retires
  // nothing — that half has its own tests.
  const closed: number[] = [];
  let updating: number | null = null;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => []),
    update: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(async () => {
      if (updating === null) return [];
      closed.push(updating);
      states.set(updating, 'closed');
      return [{ id: updating }];
    }),
  });

  const svc = new WorkflowService(
    chain as unknown as Database,
    git,
    prs,
    {} as IReviewWorkflowService,
    workspaceService,
    accessControl,
    fileLocks,
    pendingCommits,
    testKbContext(),
    openChangeGate(),
  );
  // Which request an UPDATE is closing is not recoverable from the drizzle
  // condition, so note it on the way in.
  const closeEmpty = svc.closeEmptyChangeRequest.bind(svc);
  vi.spyOn(svc, 'closeEmptyChangeRequest').mockImplementation(async (n, u) => {
    updating = n;
    try {
      return await closeEmpty(n, u);
    } finally {
      updating = null;
    }
  });
  return { svc, git, prs, changed, closed, fileLocks, pendingCommits };
}

const aliceRequest = summary({
  number: 12,
  branch: 'suggestions/alice-u-alice/knowledge',
  authorId: hashEmail(ALICE.email),
  appAuthor: { name: 'Alice' },
  touchedNodePaths: ['Data/Reports/proposed.md', 'Data/Reports/Sub/deep.md', 'KnowledgeBase/Other.md'],
});
const bobRequest = summary({
  number: 40,
  branch: 'suggestions/bob-u-bob/knowledge',
  authorId: hashEmail(BOB.email),
  appAuthor: { name: 'Bob' },
  touchedNodePaths: ['Data/Reports/q3.md'],
});
const elsewhere = summary({
  number: 50,
  branch: 'carol/elsewhere',
  touchedNodePaths: ['Data/ReportsArchive/old.md'],
});

describe('WorkflowService.changeRequestsUnderFolder', () => {
  it('names only the requests proposing files under the folder, with only those paths', async () => {
    const { svc } = makeHarness([aliceRequest, bobRequest, elsewhere], { admins: [ALICE.email] });
    const requests = await svc.changeRequestsUnderFolder('Data/Reports', ALICE);
    // `Data/ReportsArchive` shares the spelling, not the folder.
    expect(requests.map((r) => r.number)).toEqual([12, 40]);
    expect(requests[0]).toMatchObject({
      title: 'Request 12',
      authorName: 'Alice',
      mine: true,
      paths: ['Data/Reports/proposed.md', 'Data/Reports/Sub/deep.md'],
      mayRemove: true,
    });
    expect(requests[1]).toMatchObject({ mine: false, paths: ['Data/Reports/q3.md'] });
  });

  it('lets the author act on their own request, and nobody else’s', async () => {
    const { svc } = makeHarness([aliceRequest, bobRequest]);
    const [own, other] = await svc.changeRequestsUnderFolder('Data/Reports/', ALICE);
    expect(own).toMatchObject({ number: 12, mayRemove: true });
    expect(other).toMatchObject({
      number: 40,
      mayRemove: false,
      reason: expect.stringMatching(/#40 was proposed by Bob; only its author, an admin or someone who can write every file it proposes here/),
    });
  });

  it('lets an admin act on any request', async () => {
    const { svc } = makeHarness([aliceRequest, bobRequest], { admins: ['carol@example.com'] });
    const carol = { id: 'u-carol', email: 'carol@example.com', name: 'Carol' };
    const requests = await svc.changeRequestsUnderFolder('Data/Reports', carol);
    expect(requests.every((r) => r.mayRemove)).toBe(true);
  });

  it('reads a request listed with no paths again, since the list reports an unreadable diff as empty', async () => {
    const { svc, prs, git } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(prs.listOpenPrs).mockResolvedValueOnce([aliceRequest, { ...bobRequest, touchedNodePaths: [] }]);
    const requests = await svc.changeRequestsUnderFolder('Data/Reports', ALICE);
    expect(requests.map((r) => r.number)).toEqual([12, 40]);
    expect(git.changedPathsForPr).toHaveBeenCalledWith(
      encodeURIComponent(bobRequest.branch),
      'main',
      bobRequest.branch,
    );
  });

  it('fails the question when a request’s diff cannot be read, rather than leaving it out', async () => {
    const { svc, prs, git } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(prs.listOpenPrs).mockResolvedValueOnce([aliceRequest, { ...bobRequest, touchedNodePaths: [] }]);
    vi.mocked(git.changedPathsForPr).mockRejectedValueOnce(new Error('unknown revision'));
    await expect(svc.changeRequestsUnderFolder('Data/Reports', ALICE)).rejects.toMatchObject({
      message: expect.stringContaining('#40'),
    });
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toHaveLength(2);
  });

  it('lets someone who may write every file a request proposes there act on it', async () => {
    const { svc } = makeHarness([aliceRequest, bobRequest], { writes: { [DAN.email]: ['Data/Reports/'] } });
    const requests = await svc.changeRequestsUnderFolder('Data/Reports', DAN);
    expect(requests.every((r) => r.mayRemove)).toBe(true);
  });

  it('judges every proposed file, so a subfolder the writer may not write keeps its request out of reach', async () => {
    // Dan writes the folder's own files but not `Sub/`, where #12 also proposes one.
    const { svc } = makeHarness([aliceRequest, bobRequest], {
      writes: { [DAN.email]: ['Data/Reports/proposed.md', 'Data/Reports/q3.md'] },
    });
    const [alices, bobs] = await svc.changeRequestsUnderFolder('Data/Reports', DAN);
    expect(alices).toMatchObject({ number: 12, mayRemove: false, reason: expect.stringContaining('#12') });
    expect(bobs).toMatchObject({ number: 40, mayRemove: true });
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', DAN)).rejects.toMatchObject({
      message: expect.stringContaining('#12'),
    });
  });
});

describe('WorkflowService.removeFolderFromChangeRequests', () => {
  const aliceWs = encodeURIComponent(aliceRequest.branch);
  const bobWs = encodeURIComponent(bobRequest.branch);
  type Plans = Parameters<GitService['revertPathsAndPush']>[1];
  const plansOf = (git: GitService): Plans => vi.mocked(git.revertPathsAndPush).mock.calls[0][1];

  it('takes every file under the folder out of every request in one git operation, keeps the rest, and withdraws a request left empty', async () => {
    const { svc, git, changed, closed, fileLocks } = makeHarness([aliceRequest, bobRequest, elsewhere], {
      admins: [ALICE.email],
    });
    const results = await svc.removeFolderFromChangeRequests('Data/Reports', ALICE);

    expect(results).toEqual([
      {
        number: 12,
        removedPaths: ['Data/Reports/proposed.md', 'Data/Reports/Sub/deep.md'],
        withdrawn: false,
        stillProposed: [],
        keptForSaves: false,
      },
      { number: 40, removedPaths: ['Data/Reports/q3.md'], withdrawn: true, stillProposed: [], keptForSaves: false },
    ]);
    // #12 still proposes its file outside the folder and stays open; #40
    // proposed nothing else and is withdrawn; #50 was never touched.
    expect([...changed.get(aliceRequest.branch)!]).toEqual(['KnowledgeBase/Other.md']);
    expect(changed.get(bobRequest.branch)!.size).toBe(0);
    expect(closed).toEqual([40]);
    expect([...changed.get(elsewhere.branch)!]).toEqual(['Data/ReportsArchive/old.md']);

    // Every checkout goes to git in ONE call, each file reverted to its merge base.
    expect(git.revertPathsAndPush).toHaveBeenCalledTimes(1);
    expect(plansOf(git)).toEqual([
      {
        workspaceId: aliceWs,
        paths: [
          expect.objectContaining({ path: 'Data/Reports/proposed.md', ref: 'mb-sha' }),
          expect.objectContaining({ path: 'Data/Reports/Sub/deep.md', ref: 'mb-sha' }),
        ],
      },
      { workspaceId: bobWs, paths: [expect.objectContaining({ path: 'Data/Reports/q3.md', ref: 'mb-sha' })] },
    ]);
    expect(fileLocks.acquire).toHaveBeenCalledWith(aliceWs, aliceRequest.branch, 'knowledge-base/Data/Reports/proposed.md', ALICE);
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
  });

  it('holds every file lock for the whole git operation', async () => {
    const { svc, git, fileLocks } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    const events: string[] = [];
    vi.mocked(fileLocks.acquire).mockImplementation(async () => {
      events.push('lock');
      return { acquired: true } as never;
    });
    vi.mocked(fileLocks.release).mockImplementation(async () => {
      events.push('release');
    });
    const revert = vi.mocked(git.revertPathsAndPush).getMockImplementation()!;
    vi.mocked(git.revertPathsAndPush).mockImplementation(async (user, plans) => {
      events.push('git');
      return revert(user, plans);
    });
    await svc.removeFolderFromChangeRequests('Data/Reports', ALICE);
    expect(events).toEqual(['lock', 'lock', 'lock', 'git', 'release', 'release', 'release']);
  });

  it('withdraws the author’s own request when the folder held all of it', async () => {
    const only = summary({
      number: 7,
      branch: 'suggestions/alice-u-alice/knowledge',
      authorId: hashEmail(ALICE.email),
      touchedNodePaths: ['Data/Reports/proposed.md'],
    });
    // Alice is neither admin nor writer: authorship alone is enough.
    const { svc, closed } = makeHarness([only]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([
      { number: 7, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true, stillProposed: [], keptForSaves: false },
    ]);
    expect(closed).toEqual([7]);
  });

  it('names a file proposed under the folder while the removal ran, and leaves that request open', async () => {
    const { svc, git, changed, closed } = makeHarness([bobRequest], { admins: [ALICE.email] });
    // Bob's save lands after the paths were read, as the revert publishes.
    const revert = vi.mocked(git.revertPathsAndPush).getMockImplementation()!;
    vi.mocked(git.revertPathsAndPush).mockImplementation(async (user, plans) => {
      const outcome = await revert(user, plans);
      changed.get(bobRequest.branch)!.add('Data/Reports/notes.md');
      return outcome;
    });
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([
      {
        number: 40,
        removedPaths: ['Data/Reports/q3.md'],
        withdrawn: false,
        stillProposed: ['Data/Reports/notes.md'],
        keptForSaves: false,
      },
    ]);
    expect(closed).toEqual([]);
  });

  it('keeps a request open, and says so, when it looks empty while a save to its branch is still landing', async () => {
    const { svc, closed, pendingCommits } = makeHarness([bobRequest], { admins: [ALICE.email] });
    // Bob's save is on disk, its commit still queued: not in the diff yet.
    vi.mocked(pendingCommits.hasAnyForWorkspace).mockImplementation(async (ws) => ws === bobWs);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([
      { number: 40, removedPaths: ['Data/Reports/q3.md'], withdrawn: false, stillProposed: [], keptForSaves: true },
    ]);
    expect(closed).toEqual([]);
  });

  it('refuses as a whole, touching nothing, when one request is not the caller’s to change', async () => {
    const { svc, git, changed, closed } = makeHarness([aliceRequest, bobRequest]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('#40'),
    });
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
  });

  it('removes nothing from any request when one cannot be brought up to date', async () => {
    const { svc, git, changed, closed } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(git.pull)
      .mockResolvedValueOnce({ treeChanged: false } as never)
      .mockRejectedValueOnce(new Error('rebase conflict'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('#40'),
    });
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
  });

  it('removes nothing when a request proposed a file under the folder after its permission was judged', async () => {
    const { svc, git, changed, closed } = makeHarness([aliceRequest, bobRequest], {
      writes: { [DAN.email]: ['Data/Reports/'] },
    });
    // Bringing the checkouts up to date lands a file #40 proposed since.
    vi.mocked(git.pull).mockImplementation(async () => {
      changed.get(bobRequest.branch)!.add('Data/Reports/Locked/new.md');
      return { treeChanged: true } as never;
    });
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', DAN)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('#40 changed while the folder was being deleted (Data/Reports/Locked/new.md)'),
    });
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
  });

  it('removes nothing from any request when a later request’s file is locked, and lets every lock go', async () => {
    const { svc, git, changed, closed, fileLocks } = makeHarness([aliceRequest, bobRequest], {
      admins: [ALICE.email],
    });
    vi.mocked(fileLocks.acquire)
      .mockResolvedValueOnce({ acquired: true } as never)
      .mockResolvedValueOnce({ acquired: true } as never)
      .mockResolvedValueOnce({ acquired: false, lock: { holderName: 'Bob' } } as never);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Bob'),
    });
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
    expect(fileLocks.release).toHaveBeenCalledTimes(2);
  });

  it('withdraws nothing and lets every lock go when the git operation throws (nothing was pushed)', async () => {
    const { svc, git, changed, closed, fileLocks } = makeHarness([aliceRequest, bobRequest], {
      admins: [ALICE.email],
    });
    vi.mocked(git.revertPathsAndPush).mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toThrow('disk full');
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
  });

  it('says which requests were finished when a later push fails, and finishes only those', async () => {
    const only12 = { ...aliceRequest, touchedNodePaths: ['Data/Reports/proposed.md'] };
    const { svc, git, changed, closed } = makeHarness([only12, bobRequest], { admins: [ALICE.email] });
    vi.mocked(git.revertPathsAndPush).mockImplementationOnce(async () => {
      // #12's branch published; #40's push failed and git undid it.
      changed.get(aliceRequest.branch)!.clear();
      return { pushed: [aliceWs], failed: { workspaceId: bobWs, error: new Error('rejected') } };
    });
    const err = await svc.removeFolderFromChangeRequests('Data/Reports', ALICE).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500 });
    expect((err as Error).message).toMatch(/removed from #12, but #40 could not be updated/);
    expect(closed).toEqual([12]);
    expect([...changed.get(bobRequest.branch)!]).toEqual(['Data/Reports/q3.md']);
  });

  it('rethrows the push error itself when no branch was published', async () => {
    const { svc, git, closed } = makeHarness([bobRequest], { admins: [ALICE.email] });
    vi.mocked(git.revertPathsAndPush).mockResolvedValueOnce({
      pushed: [],
      failed: { workspaceId: bobWs, error: new Error('rejected') },
    });
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toThrow('rejected');
    expect(closed).toEqual([]);
  });

  it('lets every other lock go when one release fails', async () => {
    const { svc, fileLocks } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(fileLocks.release).mockRejectedValueOnce(new Error('db down'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toHaveLength(2);
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
  });

  it('handles two requests on one source branch proposing the same file with one lock and one revert', async () => {
    const shared = 'suggestions/alice-u-alice/knowledge';
    const first = summary({
      number: 12,
      branch: shared,
      authorId: hashEmail(ALICE.email),
      touchedNodePaths: ['Data/Reports/proposed.md'],
    });
    const second = summary({
      number: 13,
      branch: shared,
      authorId: hashEmail(ALICE.email),
      touchedNodePaths: ['Data/Reports/proposed.md'],
    });
    const { svc, git, closed, fileLocks } = makeHarness([first, second]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([
      { number: 12, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true, stillProposed: [], keptForSaves: false },
      { number: 13, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true, stillProposed: [], keptForSaves: false },
    ]);
    expect(fileLocks.acquire).toHaveBeenCalledTimes(1);
    expect(plansOf(git)).toEqual([
      { workspaceId: encodeURIComponent(shared), paths: [expect.objectContaining({ path: 'Data/Reports/proposed.md' })] },
    ]);
    expect(closed).toEqual([12, 13]);
  });

  it('refuses, before locking anything, requests on one branch that revert a shared file to different bases', async () => {
    const shared = 'suggestions/alice-u-alice/knowledge';
    const toMain = summary({ number: 12, branch: shared, authorId: hashEmail(ALICE.email), touchedNodePaths: ['Data/Reports/proposed.md'] });
    const toRelease = summary({
      number: 13,
      branch: shared,
      base: 'release',
      authorId: hashEmail(ALICE.email),
      touchedNodePaths: ['Data/Reports/proposed.md'],
    });
    const { svc, git, closed, fileLocks } = makeHarness([toMain, toRelease]);
    vi.mocked(git.mergeBaseForPr).mockImplementation(async (_ws, base) => (base === 'main' ? 'mb-sha' : 'mb-release'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('#12'),
    });
    expect(fileLocks.acquire).not.toHaveBeenCalled();
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
  });

  it('keeps every commit subject within git’s 200 characters, however many requests share a branch or however long the path', async () => {
    const shared = 'suggestions/alice-u-alice/knowledge';
    const deep = `Data/Reports/${'nested-folder-name/'.repeat(12)}proposed.md`;
    const many = Array.from({ length: 40 }, (_, i) =>
      summary({
        number: 1000 + i,
        branch: shared,
        authorId: hashEmail(ALICE.email),
        touchedNodePaths: ['Data/Reports/proposed.md', deep],
      }),
    );
    const { svc, git } = makeHarness(many);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toHaveLength(40);
    const [plan] = plansOf(git);
    const subjects = plan.paths.flatMap((entry) => [entry.subject, entry.undoSubject]);
    expect(subjects).toHaveLength(4);
    for (const subject of subjects) expect(subject.length).toBeLessThanOrEqual(200);
    expect(subjects).toContain('Revert proposed.md (folder deleted; removed from 40 change requests)');
  });

  it('is a no-op for a folder no request touches', async () => {
    const { svc, git } = makeHarness([elsewhere]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([]);
    expect(git.revertPathsAndPush).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.closeEmptyChangeRequest', () => {
  const emptied = summary({ number: 40, branch: 'suggestions/bob-u-bob/knowledge', touchedNodePaths: [] });

  it('withdraws a request whose diff is empty and whose branch has nothing landing', async () => {
    const { svc, closed } = makeHarness([emptied]);
    await expect(svc.closeEmptyChangeRequest(40, ALICE)).resolves.toBe(true);
    expect(closed).toEqual([40]);
  });

  it('never withdraws one while a save holds a lock on its branch — retiring it would delete that save', async () => {
    const { svc, closed, fileLocks } = makeHarness([emptied]);
    vi.mocked(fileLocks.hasAnyActive).mockResolvedValue(true);
    await expect(svc.closeEmptyChangeRequest(40, ALICE)).resolves.toBe(false);
    expect(closed).toEqual([]);
  });

  it('keeps it open when whether saves are landing cannot be read', async () => {
    const { svc, closed, pendingCommits } = makeHarness([emptied]);
    vi.mocked(pendingCommits.hasAnyForWorkspace).mockRejectedValue(new Error('db down'));
    await expect(svc.closeEmptyChangeRequest(40, ALICE)).resolves.toBe(false);
    expect(closed).toEqual([]);
  });
});
