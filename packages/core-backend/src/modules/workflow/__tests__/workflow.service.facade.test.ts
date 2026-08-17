import { describe, it, expect, vi } from 'vitest';
import type {
  AuthUser,
  ChangeInput,
  PostChangeRequestCommentInput,
} from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { FileLockService } from '../file-lock.service.js';
import { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowService } from '../workflow.service.js';
import { PullRebaseConflictError } from '../workflow.errors.js';
import type { Database } from '../../database/connection.js';

// `deleteBranch`'s open-request guard is the only DB touch these tests
// exercise: a chainable select→from→where→limit stub resolving `rows` covers
// it (rows default to "no open request").
function makeDb(rows: unknown[] = []): Database {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain as unknown as Database;
}

function makeWorkspaceService(): WorkspaceService {
  // Bare stub. `sweepOrphanedWorkspaces` is exercised as a fire-and-forget
  // side effect of `listBranches` — stub it so the delegation tests aren't
  // surprised by a missing method on the mock.
  return {
    getWorkspacePath: vi.fn().mockResolvedValue('/tmp/ws'),
    sweepOrphanedWorkspaces: vi.fn().mockResolvedValue({ removed: [] }),
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch) })),
    ensureRemotesFetched: vi.fn().mockResolvedValue(undefined),
    hasBootstrappedWorkspace: vi.fn().mockResolvedValue(false),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceService;
}

function makeFileLockService(): FileLockService {
  // Stub returns "lock not held" defaults. Lock tests run against the real
  // service with a stubbed DB; the facade-level tests verify delegation only.
  return {
    acquire: vi.fn().mockResolvedValue({
      acquired: true,
      lock: { branch: 'b', path: 'p', holderUserId: 'u', holderName: 'U', acquiredAt: '', lastHeartbeatAt: '', expiresAt: '' },
    }),
    heartbeat: vi.fn(),
    release: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as FileLockService;
}

function makePendingCommits(): PendingCommitsService {
  // Stub — the facade-level tests verify delegation only; queue-side
  // behavior is covered by `pending-commits.service.test.ts`.
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    claimNext: vi.fn().mockResolvedValue(null),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markTransientFailure: vi.fn().mockResolvedValue(undefined),
    markRecoveryStarted: vi.fn().mockResolvedValue(undefined),
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
    listNeedsAttention: vi.fn().mockResolvedValue([]),
    countPending: vi.fn().mockResolvedValue(0),
    startupReconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingCommitsService;
}

function makeAccessControl(): IAccessControl {
  // Stub returns an all-allow map for the rejection broaden path; the
  // delegation-style tests don't exercise that branch.
  return {
    canWrite: vi.fn().mockResolvedValue(false),
    canWriteBatch: vi.fn().mockResolvedValue(new Map()),
    canRead: vi.fn().mockResolvedValue(true),
    canReadBatch: vi.fn().mockResolvedValue(new Map()),
    eligibleReaders: vi.fn().mockResolvedValue({ restricted: false, roles: [], users: [] }),
    canReadAtRef: vi.fn().mockResolvedValue(null),
    canDownload: vi.fn().mockResolvedValue(false),
    canOwner: vi.fn().mockResolvedValue(false),
    eligibleOwners: vi.fn().mockResolvedValue({ roles: [], users: [] }),
    eligibleDownloaders: vi.fn().mockResolvedValue({ roles: [], users: [] }),
    eligibleWriters: vi.fn().mockResolvedValue({ roles: [], users: [] }),
    eligibleWriterEmails: vi.fn().mockResolvedValue(new Map()),
    eligibleOwnerEmails: vi.fn().mockResolvedValue(new Map()),
    grantSources: vi.fn().mockResolvedValue({}),
    invalidate: vi.fn(),
    findEmailByHash: vi.fn().mockResolvedValue(null),
    kbPrincipals: vi.fn().mockResolvedValue({ plugins: [], people: [] }),
    validateRolesYaml: vi.fn().mockReturnValue({ ok: true }),
    referencesToRole: vi.fn().mockResolvedValue([]),
    canWriteAtRef: vi.fn().mockResolvedValue(null),
    canWriteBatchAtRef: vi.fn().mockResolvedValue(null),
    eligibleWritersAtRef: vi.fn().mockResolvedValue(null),
    eligibleWritersForPathsAtRef: vi.fn().mockResolvedValue(null),
  };
}

/**
 * The facade exists only to delegate — these tests pin down that contract.
 * For each backed method we verify (a) the right underlying call is made
 * with the right arguments, (b) the underlying return propagates back. For
 * each unimplemented method we verify it rejects with
 * `NotImplementedWorkflowError` so consumers can switch on the error class.
 *
 * Cache invalidation (`PullRequestService.invalidateDetailCache`) is part
 * of the facade contract for mutating change-request methods — without it
 * the legacy 30s detail cache would mask just-applied changes. Each mutating
 * test re-asserts the invalidation fires exactly once for the right PR.
 */
function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: overrides.id ?? 'u1',
    email: overrides.email ?? 'alice@example.com',
    name: overrides.name ?? 'Alice',
    avatarUrl: overrides.avatarUrl,
  };
}

function makeGit(): GitService {
  return {
    status: vi.fn(),
    listBranches: vi.fn(),
    createBranch: vi.fn(),
    switchBranch: vi.fn(),
    deleteBranch: vi.fn(),
    forkCurrentToDraft: vi.fn(),
    discardChanges: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
    diffStat: vi.fn(),
    pendingChanges: vi.fn(),
    resolveForkBase: vi.fn(),
    logForFile: vi.fn(),
    diffFileAtCommit: vi.fn(),
    diffFileBetweenBranches: vi.fn(),
    workingStatus: vi.fn(),
    diffFileWorking: vi.fn(),
    mergeFromOrigin: vi.fn(),
    commitFile: vi.fn(),
    // roles.yaml-preservation guard (preserveBaseRolesYaml): default to "no
    // roles.yaml change" — same content at base and head → the guard no-ops.
    resetToRemote: vi.fn().mockResolvedValue(undefined),
    commitChanges: vi.fn().mockResolvedValue(null),
    readFileAtRef: vi.fn().mockResolvedValue('roles:\n  Admin:\n    - admin@x.com\n'),
  } as unknown as GitService;
}

function makePrs(): PullRequestService {
  return {
    listOpenPrs: vi.fn(),
    listPrsAuthoredBy: vi.fn(),
    listPrsForOwnerEmail: vi.fn(),
    getPr: vi.fn(),
    getPrDetail: vi.fn(),
    invalidateDetailCache: vi.fn(),
    setDetailEnricher: vi.fn(),
  } as unknown as PullRequestService;
}

function makeReviewWorkflow(): IReviewWorkflowService {
  return {
    listComments: vi.fn(),
    postComment: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    getApprovalStates: vi.fn(),
    approveFile: vi.fn(),
    unapproveFile: vi.fn(),
    evaluateMergeGate: vi.fn(),
    mergePr: vi.fn(),
    cancelPr: vi.fn(),
  } as unknown as IReviewWorkflowService;
}

describe('WorkflowService — branch delegation', () => {
  it('listBranches delegates to git.listBranches', async () => {
    const git = makeGit();
    const branches = [{ name: 'main', isCurrent: true, isProtected: true, ahead: 0, behind: 0, hasRemote: true }];
    (git.listBranches as ReturnType<typeof vi.fn>).mockResolvedValue(branches);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await expect(svc.listBranches('w1')).resolves.toBe(branches);
    // listBranches(workspaceId, opts?) forwards opts — undefined when omitted.
    expect(git.listBranches).toHaveBeenCalledWith('w1', undefined);
  });

  it('createBranch forwards fromBase when provided', async () => {
    const git = makeGit();
    (git.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'feat' });

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await svc.createBranch('w1', 'feat', 'current-company-state');
    expect(git.createBranch).toHaveBeenCalledWith('w1', 'feat', 'current-company-state');
  });

  it('branchStatus delegates to git.status (rename only — same payload)', async () => {
    const git = makeGit();
    const status = { branch: 'main', isDirty: false, hasUpstream: true, unpushedCommits: 0, conflicted: [], unmergedFromUpstream: false };
    (git.status as ReturnType<typeof vi.fn>).mockResolvedValue(status);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await expect(svc.branchStatus('w1')).resolves.toBe(status);
    expect(git.status).toHaveBeenCalledWith('w1');
  });
});

describe('WorkflowService — change delegation', () => {
  it('commitChange delegates to git.commit', async () => {
    const git = makeGit();
    const user = makeUser();
    const input: ChangeInput = { summary: 'tweak owner' };
    const commit = { sha: 'abc', authorName: 'Alice', authorEmail: 'alice@example.com', subject: 'tweak owner', committedAt: '2026-01-01T00:00:00Z' };
    (git.commit as ReturnType<typeof vi.fn>).mockResolvedValue(commit);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await expect(svc.commitChange('w1', user, input)).resolves.toBe(commit);
    expect(git.commit).toHaveBeenCalledWith('w1', user, input);
  });

  it('listChangesForFile clamps via the underlying git.logForFile', async () => {
    const git = makeGit();
    (git.logForFile as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await svc.listChangesForFile('w1', 'Knowledge/Foo.md', 5);
    expect(git.logForFile).toHaveBeenCalledWith('w1', 'Knowledge/Foo.md', 5);
  });

  it('compareFile delegates to git.diffFileBetweenBranches', async () => {
    const git = makeGit();
    (git.diffFileBetweenBranches as ReturnType<typeof vi.fn>).mockResolvedValue('@@ diff');

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    const diff = await svc.compareFile('w1', 'Foo.md', 'a', 'b');
    expect(diff).toBe('@@ diff');
    expect(git.diffFileBetweenBranches).toHaveBeenCalledWith('w1', 'Foo.md', 'a', 'b');
  });
});

describe('WorkflowService — change request delegation + cache invalidation', () => {
  it('listChangeRequests forwards opts to prs.listOpenPrs', async () => {
    const prs = makePrs();
    (prs.listOpenPrs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await svc.listChangeRequests({ fresh: true });
    expect(prs.listOpenPrs).toHaveBeenCalledWith({ fresh: true });
  });

  it('postComment delegates AND invalidates the PR detail cache', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    const comment = { id: 'c1' };
    const input: PostChangeRequestCommentInput = { body: 'hi' };
    (reviewWorkflow.postComment as ReturnType<typeof vi.fn>).mockResolvedValue(comment);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    const user = makeUser();
    await expect(svc.postComment(42, user, input, 'sha1')).resolves.toBe(comment);
    expect(reviewWorkflow.postComment).toHaveBeenCalledWith(42, user, input, 'sha1');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(42);
    expect(prs.invalidateDetailCache).toHaveBeenCalledTimes(1);
  });

  it('approveFile invalidates the PR detail cache exactly once', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    (reviewWorkflow.approveFile as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await svc.approveFile(7, 'Foo.md', makeUser(), [], 'sha', 'main', null, 'w1');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(prs.invalidateDetailCache).toHaveBeenCalledTimes(1);
  });

  it('rejectChangeRequest delegates to reviewWorkflow.cancelPr', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    (reviewWorkflow.cancelPr as ReturnType<typeof vi.fn>).mockResolvedValue({ prNumber: 9, cancelledAt: 't' });

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    const user = makeUser();
    await svc.rejectChangeRequest(9, user, 'open', null, 'main', 'w1');
    expect(reviewWorkflow.cancelPr).toHaveBeenCalledWith(9, user, 'open', null, 'main', 'w1');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(9);
  });

  it('mergeChangeRequest wraps the underlying merge result in a "merged" outcome', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    const mergeResult = { prNumber: 4, sha: 'abc', mergedAt: 't' };
    (reviewWorkflow.mergePr as ReturnType<typeof vi.fn>).mockResolvedValue(mergeResult);
    // The roles.yaml-preservation guard resolves the CR's source branch via
    // getPr. readFileAtRef (stubbed in makeGit) returns identical roles.yaml for
    // base + head, so the guard no-ops and the merge proceeds.
    (prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue({ branch: 'alice/feat', base: 'main' });

    const git = makeGit();
    const workspaceService = makeWorkspaceService();
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    // Conflicts are surfaced by the local merge inside `reviewWorkflow.mergePr`
    // (mocked here), so there's no provider "mergeable" pre-check to stub.
    const outcome = await svc.mergeChangeRequest(
      4,
      makeUser(),
      'sha',
      [],
      'open',
      'PR title',
      'main',
      'w1',
      { bypass: true },
    );
    expect(outcome).toEqual({ kind: 'merged', result: mergeResult });
    // The target branch's workspace is pulled so it doesn't fall behind origin.
    expect(workspaceService.getOrCreateForBranch).toHaveBeenCalledWith('main');
    expect(git.pull).toHaveBeenCalledWith('main');
    expect(reviewWorkflow.mergePr).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ email: 'alice@example.com' }),
      'sha',
      [],
      'open',
      'PR title',
      'main',
      'w1',
      { bypass: true },
    );
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(4);
  });

  it('mergeChangeRequest still merges when the post-merge pull conflicts, and queues recovery on the TARGET workspace', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    const mergeResult = { prNumber: 4, sha: 'abc', mergedAt: 't' };
    (reviewWorkflow.mergePr as ReturnType<typeof vi.fn>).mockResolvedValue(mergeResult);
    (prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue({ branch: 'alice/feat', base: 'main' });

    const git = makeGit();
    const conflict = new PullRebaseConflictError(
      'main',
      // Deliberately unsorted — the representative row must be the smallest.
      ['b-second.md', 'a-first.md'],
      'git rebase failed: could not apply deadbee',
    );
    (git.pull as ReturnType<typeof vi.fn>).mockRejectedValue(conflict);
    const workspaceService = makeWorkspaceService();
    // Return an id that ISN'T derivable from the branch name, pinning that
    // the dispatch uses the id `getOrCreateForBranch` returned rather than
    // re-deriving it.
    (workspaceService.getOrCreateForBranch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'resolved-target-ws',
    });
    const pending = makePendingCommits();
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), pending, 'knowledge-base');

    const outcome = await svc.mergeChangeRequest(
      4, makeUser(), 'sha', [], 'open', 'PR title', 'main', 'w1', { bypass: true },
    );

    // The merge already landed on origin — a stuck target workspace must not
    // fail the response.
    expect(outcome).toEqual({ kind: 'merged', result: mergeResult });
    expect(pending.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(pending.enqueueIfAbsent).toHaveBeenCalledWith({
      workspaceId: 'resolved-target-ws',
      branch: 'main',
      path: 'a-first.md',
      authorEmail: 'alice@example.com',
      authorName: 'Alice',
    });
  });
});

describe('WorkflowService — file lock delegation', () => {
  it('acquireLock delegates to FileLockService.acquire', async () => {
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base');
    await svc.acquireLock('w1', 'b', 'p', makeUser());
    expect(fileLocks.acquire).toHaveBeenCalledWith('w1', 'b', 'p', expect.objectContaining({ email: 'alice@example.com' }));
  });

  it('getLock delegates to FileLockService.get', async () => {
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base');
    await expect(svc.getLock('w1', 'b', 'p')).resolves.toBeNull();
    expect(fileLocks.get).toHaveBeenCalledWith('w1', 'b', 'p');
  });

  it('releaseLock enqueues a pending commit then drops the lock (no synchronous commit)', async () => {
    const git = makeGit();
    const fileLocks = makeFileLockService();
    // releaseLock guards on ownership via fileLocks.get — stub it to
    // return the caller's lock so the guard passes.
    (fileLocks.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      branch: 'feat', path: 'Foo.md', holderUserId: 'u1', holderName: 'Alice',
      acquiredAt: '', lastHeartbeatAt: '', expiresAt: '',
    });
    const pending = makePendingCommits();
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, pending, 'knowledge-base');
    await expect(svc.releaseLock('w1', 'feat', 'Foo.md', makeUser())).resolves.toBeUndefined();
    // No inline git work — the worker handles that out of band.
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(pending.enqueue).toHaveBeenCalledWith({
      workspaceId: 'w1',
      branch: 'feat',
      path: 'Foo.md',
      authorEmail: 'alice@example.com',
      authorName: 'Alice',
    });
    expect(fileLocks.release).toHaveBeenCalledWith('w1', 'feat', 'Foo.md', expect.any(Object));
  });

  it('deleteBranch refuses while the branch carries an open change request', async () => {
    const git = makeGit();
    // One open request rides the branch — deleting it would strand the request.
    const svc = new WorkflowService(makeDb([{ number: 7 }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).rejects.toThrow(/open change request \(#7\)/);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deleteBranch deletes when the branch has no open change request', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).resolves.toBeUndefined();
    expect(git.deleteBranch).toHaveBeenCalledWith('w1', 'feat/x', expect.objectContaining({ email: 'alice@example.com' }), undefined);
  });

  /**
   * The lifecycle lock is what keeps merge-time retirement from deleting a
   * branch mid-`openChangeRequest`. The full interleaving needs a real git
   * repo + DB; what IS unit-testable is the lock's contract — two operations
   * keyed on the same branch never overlap, the second fully waiting out the
   * first.
   */
  it('serialises same-branch lifecycle operations', async () => {
    const order: string[] = [];
    const git = makeGit();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(git.deleteBranch)
      .mockImplementationOnce(async () => { order.push('first:start'); await gate; order.push('first:end'); })
      .mockImplementationOnce(async () => { order.push('second'); });
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base');
    const first = svc.deleteBranch('w1', 'feat/x', makeUser());
    const second = svc.deleteBranch('w1', 'feat/x', makeUser());
    // Only release the gate once the first operation is provably inside its
    // critical section — otherwise a non-serialised second could sneak
    // through before 'first:start' and the assertion would not distinguish.
    await vi.waitFor(() => { expect(order).toContain('first:start'); });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releaseLock refuses when the caller does not hold the lock', async () => {
    const git = makeGit();
    const fileLocks = makeFileLockService(); // default: get → null
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base');
    await expect(svc.releaseLock('w1', 'feat', 'Foo.md', makeUser())).rejects.toThrow(/not held by you/);
    // The commit must NOT run when the caller doesn't hold the lock —
    // otherwise a non-holder could trigger a commit attributed as them.
    expect(git.commitFile).not.toHaveBeenCalled();
  });
});

/**
 * The reviewer's per-file scalpel, and the empty-close it can trigger. All
 * collaborators stubbed — what's under test is the orchestration: the auth
 * predicate, the restore→commit→push order, the lock discipline, and the
 * authoritative emptiness re-check before anything closes.
 */
describe('WorkflowService — revertChangeRequestFile / closeEmptyChangeRequest', () => {
  const SUMMARY = { number: 7, base: 'main', branch: 'ali/x', state: 'open' };

  function makeRevertGit(overrides: Record<string, unknown> = {}): GitService {
    return Object.assign(makeGit(), {
      pull: vi.fn().mockResolvedValue(undefined),
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md', 'Docs/b.md']),
      mergeBaseForPr: vi.fn().mockResolvedValue('mb-sha'),
      restorePathFromRef: vi.fn().mockResolvedValue(undefined),
      commitFile: vi.fn().mockResolvedValue({}),
      push: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as unknown as GitService;
  }

  function makeHarness(opts: {
    git?: GitService;
    canWriteAtRef?: boolean | null;
    prState?: string;
    updateRows?: unknown[];
  } = {}) {
    const git = opts.git ?? makeRevertGit();
    const prs = makePrs();
    (prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SUMMARY,
      state: opts.prState ?? 'open',
    });
    const access = makeAccessControl();
    (access.canWriteAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(
      opts.canWriteAtRef ?? true,
    );
    const fileLocks = makeFileLockService();
    // The chainable stub answers SELECTs with [] (no open request rows) and
    // UPDATE...returning with `updateRows` (default: one row = the close won).
    const updateRows = opts.updateRows ?? [{ id: 1 }];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => []),
      update: vi.fn(() => chain),
      set: vi.fn(() => chain),
      returning: vi.fn(async () => updateRows),
    });
    const db = chain as unknown as Database;
    const svc = new WorkflowService(db, git, prs, makeReviewWorkflow(), makeWorkspaceService(), access, fileLocks, makePendingCommits(), 'knowledge-base');
    return { svc, git, prs, access, fileLocks, db: chain };
  }

  it('restores the merge-base copy on the source branch: restore, commit (validator skipped), push — under the file lock', async () => {
    const { svc, git, prs, fileLocks } = makeHarness();
    const result = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md');

    expect(git.restorePathFromRef).toHaveBeenCalledWith('ali%2Fx', 'mb-sha', 'Docs/a.md');
    expect(git.commitFile).toHaveBeenCalledWith(
      'ali%2Fx',
      expect.objectContaining({ email: 'alice@example.com' }),
      'Docs/a.md',
      expect.stringContaining('change request #7'),
      true,
    );
    expect(git.push).toHaveBeenCalled();
    expect(fileLocks.acquire).toHaveBeenCalledWith(
      'ali%2Fx',
      'ali/x',
      'knowledge-base/Docs/a.md',
      expect.anything(),
    );
    expect(fileLocks.release).toHaveBeenCalled();
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    // Both diffs answered two paths → one revert leaves one.
    expect(result).toEqual({ closed: false, remainingPaths: ['Docs/a.md', 'Docs/b.md'] });
  });

  it('refuses a caller who could not approve the file — same permission, both verbs', async () => {
    const { svc, git } = makeHarness({ canWriteAtRef: false });
    await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).rejects.toMatchObject({
      status: 403,
    });
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it('refuses a path the request does not touch', async () => {
    const { svc, git } = makeHarness();
    await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/elsewhere.md')).rejects.toMatchObject({
      status: 422,
    });
    expect(git.restorePathFromRef).not.toHaveBeenCalled();
  });

  it('refuses a request that is no longer open', async () => {
    const { svc } = makeHarness({ prState: 'closed' });
    await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('closes the request when the LAST file is reverted', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi
        .fn()
        // in order: the pre-revert list, the post-revert remainder, and the
        // close path's own authoritative re-check.
        .mockResolvedValueOnce(['Docs/a.md'])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    });
    const { svc, db } = makeHarness({ git });
    const result = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md');
    expect(result).toEqual({ closed: true, remainingPaths: [] });
    expect(db.update).toHaveBeenCalled();
  });

  it('closeEmptyChangeRequest never closes on a FAILED diff', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi.fn().mockRejectedValue(new Error('git down')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, db } = makeHarness({ git });
    await expect(svc.closeEmptyChangeRequest(7, makeUser())).resolves.toBe(false);
    expect(db.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('closeEmptyChangeRequest leaves a request with real changes alone', async () => {
    const { svc, db } = makeHarness();
    await expect(svc.closeEmptyChangeRequest(7, makeUser())).resolves.toBe(false);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('closeEmptyChangeRequest closes an emptied request', async () => {
    const git = makeRevertGit({ changedPathsForPr: vi.fn().mockResolvedValue([]) });
    const { svc, db, prs } = makeHarness({ git });
    await expect(svc.closeEmptyChangeRequest(7, makeUser())).resolves.toBe(true);
    expect(db.update).toHaveBeenCalled();
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
  });
});

describe('WorkflowService — deleteChangeRequest (admin moderation verb)', () => {
  function makeDeleteHarness(opts: { isAdmin?: boolean; prState?: string } = {}) {
    const git = Object.assign(makeGit(), {
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md']),
    }) as unknown as GitService;
    const prs = makePrs();
    (prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 9,
      base: 'main',
      branch: 'mallory/spam',
      state: opts.prState ?? 'open',
    });
    const access = makeAccessControl();
    (access.canWriteAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(opts.isAdmin ?? false);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => []),
      update: vi.fn(() => chain),
      set: vi.fn(() => chain),
      returning: vi.fn(async () => [{ id: 1 }]),
    });
    const svc = new WorkflowService(chain as unknown as Database, git, prs, makeReviewWorkflow(), makeWorkspaceService(), access, makeFileLockService(), makePendingCommits(), 'knowledge-base');
    return { svc, prs, db: chain, access };
  }

  it('refuses a non-admin with 403 and touches nothing', async () => {
    const { svc, db } = makeDeleteHarness({ isAdmin: false });
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({ status: 403 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('an admin closes the request (row flipped, cache dropped)', async () => {
    const { svc, prs, db } = makeDeleteHarness({ isAdmin: true });
    await svc.deleteChangeRequest(9, makeUser());
    expect(db.update).toHaveBeenCalled();
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(9);
  });

  it('refuses a merged request — applied history is not deletable', async () => {
    const { svc, db } = makeDeleteHarness({ isAdmin: true, prState: 'merged' });
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({ status: 422 });
    expect(db.update).not.toHaveBeenCalled();
  });
});
