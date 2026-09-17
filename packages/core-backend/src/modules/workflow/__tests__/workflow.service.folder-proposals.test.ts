import { describe, it, expect, vi } from 'vitest';
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

/**
 * Deleting a folder that holds proposed files: which open change requests the
 * delete names, who may take the folder's files out of them, and what taking
 * them out does — every file under the folder leaves every request, nothing
 * else does, and a request left empty is withdrawn.
 *
 * The git fake is stateful on purpose: a request's changed paths are what the
 * restore commits change, so "left empty" is observed, not stubbed.
 */

const ALICE: AuthUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };

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
  /** Emails with write on `Data/Reports/access.md` at the base. */
  folderWriters?: string[];
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
    push: vi.fn().mockResolvedValue(undefined),
    changedPathsForPr: vi.fn(async (_ws: string, _base: string, head: string) => [...changed.get(head)!]),
    mergeBaseForPr: vi.fn().mockResolvedValue('mb-sha'),
    // Restoring from the merge base takes a path out of the request; restoring
    // from the checkout's own earlier HEAD (an undo) puts it back.
    restorePathFromRef: vi.fn(async (ws: string, ref: string, p: string) => {
      if (ref === 'mb-sha') changed.get(decodeURIComponent(ws))!.delete(p);
      else changed.get(decodeURIComponent(ws))!.add(p);
    }),
    commitFile: vi.fn().mockResolvedValue({}),
    headCommit: vi.fn().mockResolvedValue('head-sha'),
    resetToRemote: vi.fn().mockResolvedValue(undefined),
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
      if (p === 'Data/Reports/access.md') return (access.folderWriters ?? []).includes(email);
      return false;
    }),
  } as unknown as IAccessControl;

  const fileLocks = {
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileLockService;

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
    {} as PendingCommitsService,
    'knowledge-base',
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
  return { svc, git, prs, changed, closed, fileLocks };
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
      reason: expect.stringMatching(/#40 was proposed by Bob; only its author, an admin or a writer of this folder/),
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

  it('lets a writer of the folder act on any request', async () => {
    const { svc } = makeHarness([aliceRequest, bobRequest], { folderWriters: ['dan@example.com'] });
    const dan = { id: 'u-dan', email: 'dan@example.com', name: 'Dan' };
    const requests = await svc.changeRequestsUnderFolder('Data/Reports', dan);
    expect(requests.every((r) => r.mayRemove)).toBe(true);
  });
});

describe('WorkflowService.removeFolderFromChangeRequests', () => {
  it('takes every file under the folder out of every request, keeps the rest, and withdraws a request left empty', async () => {
    const { svc, git, changed, closed, fileLocks } = makeHarness([aliceRequest, bobRequest, elsewhere], {
      admins: [ALICE.email],
    });
    const results = await svc.removeFolderFromChangeRequests('Data/Reports', ALICE);

    expect(results).toEqual([
      { number: 12, removedPaths: ['Data/Reports/proposed.md', 'Data/Reports/Sub/deep.md'], withdrawn: false },
      { number: 40, removedPaths: ['Data/Reports/q3.md'], withdrawn: true },
    ]);
    // #12 still proposes its file outside the folder and stays open; #40
    // proposed nothing else and is withdrawn; #50 was never touched.
    expect([...changed.get(aliceRequest.branch)!]).toEqual(['KnowledgeBase/Other.md']);
    expect(changed.get(bobRequest.branch)!.size).toBe(0);
    expect(closed).toEqual([40]);
    expect([...changed.get(elsewhere.branch)!]).toEqual(['Data/ReportsArchive/old.md']);

    // Each restore is its own commit under the path's lock; one push per request.
    expect(git.commitFile).toHaveBeenCalledTimes(3);
    expect(fileLocks.acquire).toHaveBeenCalledWith(
      encodeURIComponent(aliceRequest.branch),
      aliceRequest.branch,
      'knowledge-base/Data/Reports/proposed.md',
      ALICE,
    );
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
    expect(git.push).toHaveBeenCalledTimes(2);
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
      { number: 7, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true },
    ]);
    expect(closed).toEqual([7]);
  });

  it('refuses as a whole, touching nothing, when one request is not the caller’s to change', async () => {
    const { svc, git, changed, closed } = makeHarness([aliceRequest, bobRequest]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('#40'),
    });
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
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
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
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
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(changed.get(aliceRequest.branch)!.size).toBe(3);
    expect(fileLocks.release).toHaveBeenCalledTimes(2);
  });

  it('pushes nothing and undoes every restore when a later request’s restore fails', async () => {
    const { svc, git, changed, closed, fileLocks } = makeHarness([aliceRequest, bobRequest], {
      admins: [ALICE.email],
    });
    vi.mocked(git.commitFile)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).rejects.toThrow('disk full');
    expect(git.push).not.toHaveBeenCalled();
    // Undone by restoring from each checkout's own earlier HEAD — never a reset
    // that would take unrelated local commits with it.
    expect(git.resetToRemote).not.toHaveBeenCalled();
    expect(git.restorePathFromRef).toHaveBeenCalledWith(
      encodeURIComponent(aliceRequest.branch),
      'head-sha',
      'Data/Reports/proposed.md',
    );
    expect(git.restorePathFromRef).toHaveBeenCalledWith(
      encodeURIComponent(bobRequest.branch),
      'head-sha',
      'Data/Reports/q3.md',
    );
    expect([...changed.get(aliceRequest.branch)!].sort()).toEqual([...aliceRequest.touchedNodePaths].sort());
    expect(closed).toEqual([]);
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
  });

  it('says which requests were finished when a later push fails, and leaves that one as it was', async () => {
    const { svc, git, changed, closed } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(git.push).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('rejected'));
    const err = await svc.removeFolderFromChangeRequests('Data/Reports', ALICE).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500 });
    expect((err as Error).message).toMatch(/removed from #12, but #40 could not be updated/);
    expect(git.resetToRemote).not.toHaveBeenCalled();
    const undone = vi.mocked(git.restorePathFromRef).mock.calls.filter(([, ref]) => ref === 'head-sha');
    expect(undone).toEqual([[encodeURIComponent(bobRequest.branch), 'head-sha', 'Data/Reports/q3.md']]);
    expect([...changed.get(bobRequest.branch)!]).toEqual(['Data/Reports/q3.md']);
    // #12 was pushed, so its bookkeeping still runs; #40 is not closed.
    expect(closed).not.toContain(40);
  });

  it('lets every other lock go when one release fails', async () => {
    const { svc, fileLocks } = makeHarness([aliceRequest, bobRequest], { admins: [ALICE.email] });
    vi.mocked(fileLocks.release).mockRejectedValueOnce(new Error('db down'));
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toHaveLength(2);
    expect(fileLocks.release).toHaveBeenCalledTimes(3);
  });

  it('handles two requests on one source branch proposing the same file with one lock, one restore and one push', async () => {
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
      { number: 12, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true },
      { number: 13, removedPaths: ['Data/Reports/proposed.md'], withdrawn: true },
    ]);
    expect(fileLocks.acquire).toHaveBeenCalledTimes(1);
    expect(git.restorePathFromRef).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([12, 13]);
  });

  it('is a no-op for a folder no request touches', async () => {
    const { svc, git } = makeHarness([elsewhere]);
    await expect(svc.removeFolderFromChangeRequests('Data/Reports', ALICE)).resolves.toEqual([]);
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
  });
});
