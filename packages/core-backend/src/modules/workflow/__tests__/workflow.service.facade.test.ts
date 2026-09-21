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
import { PullRebaseConflictError, WorkflowDomainError } from '../../../shared/domain-errors.js';
import { DEFAULT_BRANCH, isProtectedBranch } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';

// `deleteBranch`'s open-request guard is the only DB touch these tests
// exercise. The stub ANSWERS FROM THE WHERE-CLAUSE rather than returning the
// rows unfiltered — a guard that dropped the `state = 'open'` filter or asked
// about only one branch end used to pass these tests anyway, because any row
// came back regardless of the predicate.
//
// The evaluator walks the drizzle condition tree (duck-typing the
// SQL/Column/Param/StringChunk shapes) and evaluates it against the row:
// an `eq(column, value)` leaf compares the row's field, and a node combines
// its children with whichever connector its literal chunks carry (`and` /
// `or` — drizzle nests them, so one node never mixes both).
function rowMatches(cond: unknown, row: Record<string, unknown>): boolean {
  // snake_case column → camelCase row field (the stubs carry row objects in
  // the service's own field names).
  const field = (col: string) => col.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  const evalNode = (node: unknown): boolean => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return true;
    const results: boolean[] = [];
    let anyOr = false;
    let pendingColumn: string | null = null;
    for (const c of chunks) {
      if (!c || typeof c !== 'object') continue;
      if ('queryChunks' in c) {
        results.push(evalNode(c));
      } else if ('name' in c && 'keyAsName' in c) {
        pendingColumn = String((c as { name: unknown }).name);
      } else if ('encoder' in c && 'value' in c) {
        if (pendingColumn !== null) {
          results.push(row[field(pendingColumn)] === (c as { value: unknown }).value);
          pendingColumn = null;
        }
      } else if ('value' in c) {
        if (String((c as { value: unknown }).value).includes(' or ')) anyOr = true;
      }
    }
    // A node this walker cannot decompose (`inArray`, `isNull`, a future
    // rewrite of the query) must NOT read as a match — `true` here would be
    // the permissive direction, returning rows the real query excludes and
    // masking exactly the guard regressions these tests exist to catch.
    if (results.length === 0) return false;
    return anyOr ? results.some(Boolean) : results.every(Boolean);
  };
  return evalNode(cond);
}

function makeDb(rows: Record<string, unknown>[] = []): Database {
  let lastWhere: unknown;
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn((cond: unknown) => {
      lastWhere = cond;
      return chain;
    }),
    limit: vi.fn(async () => rows.filter((r) => rowMatches(lastWhere, r))),
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
    hasAnyActive: vi.fn().mockResolvedValue(false),
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
    hasAnyForWorkspace: vi.fn().mockResolvedValue(false),
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
    pull: vi.fn().mockResolvedValue({ treeChanged: true }),
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

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await expect(svc.listBranches('w1')).resolves.toBe(branches);
    // listBranches(workspaceId, opts?) forwards opts — undefined when omitted.
    expect(git.listBranches).toHaveBeenCalledWith('w1', undefined);
  });

  it('createBranch forwards fromBase when provided', async () => {
    const git = makeGit();
    (git.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'feat' });

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.createBranch('w1', 'feat', 'current-company-state');
    expect(git.createBranch).toHaveBeenCalledWith('w1', 'feat', 'current-company-state');
  });

  it('branchStatus delegates to git.status (rename only — same payload)', async () => {
    const git = makeGit();
    const status = { branch: 'main', isDirty: false, hasUpstream: true, unpushedCommits: 0, conflicted: [], unmergedFromUpstream: false };
    (git.status as ReturnType<typeof vi.fn>).mockResolvedValue(status);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await expect(svc.commitChange('w1', user, input)).resolves.toBe(commit);
    expect(git.commit).toHaveBeenCalledWith('w1', user, input);
  });

  it('listChangesForFile clamps via the underlying git.logForFile', async () => {
    const git = makeGit();
    (git.logForFile as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.listChangesForFile('w1', 'Knowledge/Foo.md', 5);
    expect(git.logForFile).toHaveBeenCalledWith('w1', 'Knowledge/Foo.md', 5);
  });

  it('compareFile delegates to git.diffFileBetweenBranches', async () => {
    const git = makeGit();
    (git.diffFileBetweenBranches as ReturnType<typeof vi.fn>).mockResolvedValue('@@ diff');

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    const diff = await svc.compareFile('w1', 'Foo.md', 'a', 'b');
    expect(diff).toBe('@@ diff');
    expect(git.diffFileBetweenBranches).toHaveBeenCalledWith('w1', 'Foo.md', 'a', 'b');
  });
});

describe('WorkflowService — change request delegation + cache invalidation', () => {
  it('listChangeRequests forwards opts to prs.listOpenPrs', async () => {
    const prs = makePrs();
    (prs.listOpenPrs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.listChangeRequests({ fresh: true });
    expect(prs.listOpenPrs).toHaveBeenCalledWith({ fresh: true });
  });

  it('postComment delegates AND invalidates the PR detail cache', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    const comment = { id: 'c1' };
    const input: PostChangeRequestCommentInput = { body: 'hi' };
    (reviewWorkflow.postComment as ReturnType<typeof vi.fn>).mockResolvedValue(comment);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.approveFile(7, 'Foo.md', makeUser(), [], 'sha', 'main', null, 'w1');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(prs.invalidateDetailCache).toHaveBeenCalledTimes(1);
  });

  it('rejectChangeRequest delegates to reviewWorkflow.cancelPr', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    (reviewWorkflow.cancelPr as ReturnType<typeof vi.fn>).mockResolvedValue({ prNumber: 9, cancelledAt: 't' });

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), pending, 'knowledge-base', openChangeGate());

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
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.acquireLock('w1', 'b', 'p', makeUser());
    expect(fileLocks.acquire).toHaveBeenCalledWith('w1', 'b', 'p', expect.objectContaining({ email: 'alice@example.com' }), undefined);
  });

  it('acquireLock forwards the coordination flag so the lock row persists its mode', async () => {
    // The mode must reach the store: an in-memory-only distinction would let
    // a coordination hold masquerade as an edit lock on the very next read
    // (which is how the write paths decide what the holder may do).
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base', openChangeGate());
    await svc.acquireLock('w1', 'b', 'p', makeUser(), { coordination: true });
    expect(fileLocks.acquire).toHaveBeenCalledWith(
      'w1', 'b', 'p', expect.objectContaining({ email: 'alice@example.com' }), { coordination: true },
    );
  });

  it('getLock delegates to FileLockService.get', async () => {
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base', openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, pending, 'knowledge-base', openChangeGate());
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
    // `sourceBranch` matters to the guard now: it decides whether the refusal
    // says "withdraw yours" (source) or names the other request's actors (target).
    const svc = new WorkflowService(makeDb([{ number: 7, sourceBranch: 'feat/x', targetBranch: 'dev', state: 'open' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).rejects.toThrow(/open change request \(#7\)/);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deleteBranch refuses when an open request proposes INTO the branch (target end)', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb([{ number: 9, sourceBranch: 'other/y', targetBranch: 'feat/x', state: 'open' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).rejects.toThrow(/proposes changes into/);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deleteBranch proceeds past a CLOSED request — the guard filters on state, not mere mention', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb([{ number: 7, sourceBranch: 'feat/x', targetBranch: 'dev', state: 'closed' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).resolves.toBeUndefined();
    expect(git.deleteBranch).toHaveBeenCalled();
  });

  it('deleteBranch deletes when the branch has no open change request', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), 'knowledge-base', openChangeGate());
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
      pull: vi.fn().mockResolvedValue({ treeChanged: true }),
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md', 'Docs/b.md']),
      mergeBaseForPr: vi.fn().mockResolvedValue('mb-sha'),
      restorePathFromRef: vi.fn().mockResolvedValue(undefined),
      pathExistsAtRef: vi.fn().mockResolvedValue(true),
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
    const svc = new WorkflowService(db, git, prs, makeReviewWorkflow(), makeWorkspaceService(), access, fileLocks, makePendingCommits(), 'knowledge-base', openChangeGate());
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

  it('never names a folder placeholder among the remaining files', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi
        .fn()
        .mockResolvedValueOnce(['Docs/a.md', 'Docs/b.md', 'Docs/.gitkeep'])
        .mockResolvedValueOnce(['Docs/b.md', 'Docs/.gitkeep']),
    });
    const { svc } = makeHarness({ git });
    const result = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md');
    expect(result).toEqual({ closed: false, remainingPaths: ['Docs/b.md'] });
  });

  it('reverting a file the request removed also reverts the placeholder that kept its folder', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi
        .fn()
        .mockResolvedValueOnce(['Docs/a.md', 'Docs/.gitkeep', 'Other/b.md'])
        .mockResolvedValueOnce(['Other/b.md']),
      // `Docs/a.md` is at the base; the placeholder is not.
      pathExistsAtRef: vi.fn(async (_ws: string, _ref: string, p: string) => p === 'Docs/a.md'),
    });
    const { svc, fileLocks } = makeHarness({ git });
    const result = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md');

    expect((git.restorePathFromRef as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([
      'Docs/a.md',
      'Docs/.gitkeep',
    ]);
    expect((git.commitFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([
      'Docs/a.md',
      'Docs/.gitkeep',
    ]);
    expect((fileLocks.acquire as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([
      'knowledge-base/Docs/a.md',
      'knowledge-base/Docs/.gitkeep',
    ]);
    expect(fileLocks.release).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ closed: false, remainingPaths: ['Other/b.md'] });
  });

  it('releases every lock it took even when one release fails, and still reports the failure', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md', 'Docs/.gitkeep']),
      pathExistsAtRef: vi.fn(async (_ws: string, _ref: string, p: string) => p === 'Docs/a.md'),
    });
    const { svc, fileLocks } = makeHarness({ git });
    (fileLocks.release as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('lock store down'));

    await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).rejects.toThrow('lock store down');
    expect((fileLocks.release as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([
      'knowledge-base/Docs/a.md',
      'knowledge-base/Docs/.gitkeep',
    ]);
  });

  it('releases every lock it took when the revert itself fails, and reports that failure', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md', 'Docs/.gitkeep']),
      pathExistsAtRef: vi.fn(async (_ws: string, _ref: string, p: string) => p === 'Docs/a.md'),
      commitFile: vi.fn().mockRejectedValue(new Error('commit failed')),
    });
    const { svc, fileLocks } = makeHarness({ git });
    (fileLocks.release as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('lock store down'));

    await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).rejects.toThrow('commit failed');
    expect(fileLocks.release).toHaveBeenCalledTimes(2);
  });

  it('never reverts a placeholder when that would leave the folder with nothing', async () => {
    const git = makeRevertGit({
      changedPathsForPr: vi
        .fn()
        .mockResolvedValueOnce(['Docs/new.md', 'Docs/.gitkeep'])
        .mockResolvedValueOnce(['Docs/.gitkeep']),
      // An added file, and a placeholder the request added too.
      pathExistsAtRef: vi.fn(async () => false),
    });
    const { svc } = makeHarness({ git });
    await svc.revertChangeRequestFile(7, makeUser(), 'Docs/new.md');

    expect((git.restorePathFromRef as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual(['Docs/new.md']);
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
    const workspaces = makeWorkspaceService();
    const svc = new WorkflowService(chain as unknown as Database, git, prs, makeReviewWorkflow(), workspaces, access, makeFileLockService(), makePendingCommits(), 'knowledge-base', openChangeGate());
    return { svc, prs, db: chain, access, workspaces };
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

  it('kicks the deleted-branch sweep when the base workspace cannot be resolved', async () => {
    const { svc, db, workspaces } = makeDeleteHarness({ isAdmin: true });
    (workspaces.getOrCreateForBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Remote branch main not found in upstream origin'),
    );
    const sweep = vi.spyOn(svc, 'closeChangeRequestsWithDeletedBranches').mockResolvedValue(0);

    // The failure still surfaces (it is not proven absence, so the verb must
    // not pretend to succeed), but the sweep is kicked so a genuinely
    // stranded request is closed without waiting for a restart.
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toThrow(/not found/);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not kick the sweep on a plain authorization refusal', async () => {
    const { svc, db } = makeDeleteHarness({ isAdmin: false });
    const sweep = vi.spyOn(svc, 'closeChangeRequestsWithDeletedBranches').mockResolvedValue(0);
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({ status: 403 });
    expect(sweep).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.mergeBranch — an agent merges branches, never an open change request', () => {
  // One open request, `alice/feat` → the protected default branch;
  // `alice/other` is an unprotected draft with no request.
  const PROTECTED = DEFAULT_BRANCH;
  const OPEN_REQUEST = { number: 12, sourceBranch: 'alice/feat', targetBranch: PROTECTED, state: 'open' };

  // The tip `mergeChangeRequest` reports it built the merge on. Authorizing
  // against THIS rather than the workspace `HEAD` is the point: the clone can
  // be behind origin, and the roles that matter are the ones at the commit
  // being published.
  const TARGET_TIP = 'target-tip-sha';

  function harness(opts: { canWrite?: Map<string, boolean> | null } = {}) {
    const git = makeGit();
    (git as unknown as Record<string, unknown>).remoteBranchExists = vi.fn().mockResolvedValue(true);
    (git as unknown as Record<string, unknown>).hasUnpushedCommits = vi.fn().mockResolvedValue(false);
    (git.pendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (git as unknown as Record<string, unknown>).changedPathsForPr = vi.fn().mockResolvedValue(['Team/Process.md']);
    // Stands in for the REAL `mergeChangeRequest` contract, not just its
    // return value: the unshared-edits refusal and the authorization both
    // live inside its workspace reservation now — that is what closes the
    // window between asking and resetting the target's clone — so a fake that
    // ignored them would let this suite pass with the window wide open.
    (git as unknown as Record<string, unknown>).mergeChangeRequest = vi.fn(
      async (
        workspaceId: string,
        source: string,
        target: string,
        _commit: unknown,
        _user: unknown,
        mergeOpts: {
          requireCleanTarget?: boolean;
          authorize?: (t: { sha: string; changedPaths: string[] }) => Promise<void>;
        } = {},
      ) => {
        if (mergeOpts.requireCleanTarget) {
          const dirty = (await git.pendingChanges(workspaceId)) as string[];
          const unpushed = await (git as unknown as { hasUnpushedCommits: (id: string) => Promise<boolean> })
            .hasUnpushedCommits(workspaceId);
          if (dirty.length > 0 || unpushed) {
            throw new WorkflowDomainError(
              `"${target}" has edits that are not shared yet.`,
              409,
              { kind: 'merge-target-busy', targetBranch: target },
            );
          }
        }
        if (mergeOpts.authorize) {
          const changedPaths = await (
            git as unknown as {
              changedPathsForPr: (id: string, base: string, head: string, o: unknown) => Promise<string[]>;
            }
          ).changedPathsForPr(workspaceId, target, source, { forAccessCheck: true });
          await mergeOpts.authorize({ sha: TARGET_TIP, changedPaths });
        }
        return { kind: 'merged', sha: 'merge-sha' };
      },
    );
    const access = makeAccessControl();
    (access.canWriteBatchAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(opts.canWrite === undefined ? null : opts.canWrite);
    const workspaceService = makeWorkspaceService();
    const svc = new WorkflowService(makeDb([OPEN_REQUEST]), git, makePrs(), makeReviewWorkflow(), workspaceService, access, makeFileLockService(), makePendingCommits(), 'knowledge-base');
    const merge = (git as unknown as { mergeChangeRequest: ReturnType<typeof vi.fn> }).mergeChangeRequest;
    return { svc, git, access, merge };
  }

  it('refuses to merge a source into the target of its open change request, naming the request', async () => {
    const { svc, merge } = harness();
    const err = await svc.mergeBranch(makeUser(), 'alice/feat', PROTECTED).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, payload: { kind: 'open-change-request-blocks-merge', number: 12 } });
    expect((err as Error).message).toContain('#12');
    expect((err as Error).message).toMatch(/ask the user to review #12 in the app/);
    expect(merge).not.toHaveBeenCalled();
  });

  it('allows the sync merge — the target into the draft — while that request is open', async () => {
    const { svc, merge } = harness();
    const outcome = await svc.mergeBranch(makeUser(), PROTECTED, 'alice/feat');
    expect(outcome).toEqual({ kind: 'merged', sha: 'merge-sha' });
    // Runs in the TARGET's workspace, authored as the caller.
    expect(merge).toHaveBeenCalledWith(
      'alice%2Ffeat',
      PROTECTED,
      'alice/feat',
      expect.objectContaining({ subject: `Merge ${PROTECTED} into alice/feat` }),
      expect.objectContaining({ email: 'alice@example.com' }),
      // The unshared-edits refusal is the merge's own, inside its reservation.
      expect.objectContaining({ requireCleanTarget: true }),
    );
  });

  it('allows an unrelated merge between drafts with no request', async () => {
    const { svc, merge, access } = harness();
    expect(await svc.mergeBranch(makeUser(), 'alice/other', 'alice/feat')).toEqual({ kind: 'merged', sha: 'merge-sha' });
    expect(merge).toHaveBeenCalledTimes(1);
    // An unprotected target needs no direct-write check — so no hook at all.
    expect(merge.mock.calls[0][5]).toMatchObject({ authorize: undefined });
    expect(access.canWriteBatchAtRef).not.toHaveBeenCalled();
  });

  it('refuses a protected target when the caller could not commit the changed files directly', async () => {
    expect(isProtectedBranch(PROTECTED)).toBe(true);
    const { svc, git, access, merge } = harness({ canWrite: new Map([['Team/Process.md', false]]) });
    const err = await svc.mergeBranch(makeUser(), 'alice/other', PROTECTED).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, payload: { kind: 'protected-merge-target', deniedPaths: ['Team/Process.md'] } });
    // roles.yaml is not stripped from this merge, and a rename's old path is a
    // file it deletes, so both are in the check.
    expect(git.changedPathsForPr).toHaveBeenCalledWith(PROTECTED, PROTECTED, 'alice/other', { forAccessCheck: true });
    // Decided at the tip the merge is built on, never the workspace HEAD.
    expect(access.canWriteBatchAtRef).toHaveBeenCalledWith(PROTECTED, TARGET_TIP, 'alice@example.com', ['Team/Process.md']);
    // The refusal is the HOOK's, raised inside the merge — not a caller-side
    // pre-check that ran before it. That is what this level can see: the merge
    // was entered, and it was handed an `authorize` to refuse with.
    expect(merge).toHaveBeenCalledTimes(1);
    expect(typeof merge.mock.calls[0][5].authorize).toBe('function');
    // That refusing hook commits and pushes nothing is a git-level guarantee,
    // pinned on a real repository by
    // `git.service.mergeChangeRequest.test.ts` > authorize > "refuses before
    // anything is committed or pushed when the hook throws". A `git.pull`
    // assertion here could not see it: `mergeBranch` only reaches a pull
    // through `pullMergeTarget`, which no refusal path gets to anyway.
  });

  it('refuses a protected target whose merge would change roles.yaml, whoever the caller is', async () => {
    // Every path writable — an admin. The refusal is about the FILE, not the
    // caller: a change request's merge never lets roles.yaml across either
    // (`preserveBaseRolesYaml`), and this is the one other path that lands a
    // draft's content on a protected branch. Roles are changed in the app,
    // where the file is validated; a merge would land it unvalidated.
    const { svc, git, access, merge } = harness({
      canWrite: new Map([['Team/Process.md', true], ['roles.yaml', true]]),
    });
    (git.changedPathsForPr as ReturnType<typeof vi.fn>).mockResolvedValue(['Team/Process.md', 'roles.yaml']);
    const err = await svc.mergeBranch(makeUser(), 'alice/other', PROTECTED).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 403,
      payload: { kind: 'protected-merge-changes-roles', targetBranch: PROTECTED, sourceBranch: 'alice/other' },
    });
    // Decided on the path set alone, inside the merge's hook: the write check
    // is never asked, because no answer of its could allow this.
    expect(merge).toHaveBeenCalledTimes(1);
    expect(access.canWriteBatchAtRef).not.toHaveBeenCalled();
  });

  it('merges into a protected target when the caller could commit every changed file directly', async () => {
    const { svc, merge } = harness({ canWrite: new Map([['Team/Process.md', true]]) });
    expect(await svc.mergeBranch(makeUser(), 'alice/other', PROTECTED)).toEqual({ kind: 'merged', sha: 'merge-sha' });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('returns conflicts-need-resolution with the conflicting paths', async () => {
    const { svc, merge, git } = harness();
    merge.mockResolvedValue({ kind: 'conflicts', paths: ['A.md', 'B.md'] });
    expect(await svc.mergeBranch(makeUser(), 'alice/other', 'alice/feat')).toEqual({
      kind: 'conflicts-need-resolution',
      conflictedPaths: ['A.md', 'B.md'],
    });
    // A conflict returns before `pullMergeTarget`, so the post-merge pull is
    // skipped: nothing landed on origin for this workspace to catch up to.
    expect(git.pull).not.toHaveBeenCalled();
  });

  it('refuses while the target has edits not yet shared, asked inside the merge', async () => {
    const { svc, git, merge } = harness();
    (git.pendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue(['knowledge-base/X.md']);
    await expect(svc.mergeBranch(makeUser(), 'alice/other', 'alice/feat')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'merge-target-busy' },
    });
    // The guard lives INSIDE the merge now, so the merge is entered and
    // refuses from there — a caller-side pre-check would show up here as
    // `merge` never being called, which is the regression this pins. The
    // question and the `reset --hard` it guards then share one workspace
    // reservation; that a save landing in between survives is pinned on a
    // real repository by `git.service.mergeChangeRequest.test.ts` >
    // requireCleanTarget.
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][5]).toMatchObject({ requireCleanTarget: true });
  });
});
