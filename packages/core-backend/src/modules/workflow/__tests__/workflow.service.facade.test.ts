import { describe, it, expect, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
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
import {
  PullRebaseConflictError,
  PushNeedsAgentResolutionError,
  WorkflowDomainError,
} from '../../../shared/domain-errors.js';
import type { WorkflowEventBus } from '../event-bus.js';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { hashEmail } from '../../../shared/email-identity.js';

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

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await expect(svc.listBranches('w1')).resolves.toBe(branches);
    // listBranches(workspaceId, opts?) forwards opts — undefined when omitted.
    expect(git.listBranches).toHaveBeenCalledWith('w1', undefined);
  });

  it('createBranch forwards fromBase when provided', async () => {
    const git = makeGit();
    (git.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'feat' });

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await svc.createBranch('w1', 'feat', 'current-company-state');
    expect(git.createBranch).toHaveBeenCalledWith('w1', 'feat', 'current-company-state');
  });

  it('branchStatus delegates to git.status (rename only — same payload)', async () => {
    const git = makeGit();
    const status = { branch: 'main', isDirty: false, hasUpstream: true, unpushedCommits: 0, conflicted: [], unmergedFromUpstream: false };
    (git.status as ReturnType<typeof vi.fn>).mockResolvedValue(status);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await expect(svc.commitChange('w1', user, input)).resolves.toBe(commit);
    expect(git.commit).toHaveBeenCalledWith('w1', user, input);
  });

  it('listChangesForFile clamps via the underlying git.logForFile', async () => {
    const git = makeGit();
    (git.logForFile as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await svc.listChangesForFile('w1', 'Knowledge/Foo.md', 5);
    expect(git.logForFile).toHaveBeenCalledWith('w1', 'Knowledge/Foo.md', 5);
  });

  it('compareFile delegates to git.diffFileBetweenBranches', async () => {
    const git = makeGit();
    (git.diffFileBetweenBranches as ReturnType<typeof vi.fn>).mockResolvedValue('@@ diff');

    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    const diff = await svc.compareFile('w1', 'Foo.md', 'a', 'b');
    expect(diff).toBe('@@ diff');
    expect(git.diffFileBetweenBranches).toHaveBeenCalledWith('w1', 'Foo.md', 'a', 'b');
  });
});

describe('WorkflowService — change request delegation + cache invalidation', () => {
  it('listChangeRequests forwards opts to prs.listOpenPrs', async () => {
    const prs = makePrs();
    (prs.listOpenPrs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await svc.listChangeRequests({ fresh: true });
    expect(prs.listOpenPrs).toHaveBeenCalledWith({ fresh: true });
  });

  it('postComment delegates AND invalidates the PR detail cache', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    const comment = { id: 'c1' };
    const input: PostChangeRequestCommentInput = { body: 'hi' };
    (reviewWorkflow.postComment as ReturnType<typeof vi.fn>).mockResolvedValue(comment);

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await svc.approveFile(7, 'Foo.md', makeUser(), [], 'sha', 'main', null, 'w1');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(prs.invalidateDetailCache).toHaveBeenCalledTimes(1);
  });

  it('rejectChangeRequest delegates to reviewWorkflow.cancelPr', async () => {
    const prs = makePrs();
    const reviewWorkflow = makeReviewWorkflow();
    (reviewWorkflow.cancelPr as ReturnType<typeof vi.fn>).mockResolvedValue({ prNumber: 9, cancelledAt: 't' });

    const svc = new WorkflowService(makeDb(), makeGit(), prs, reviewWorkflow, makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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
    expect(git.pull).toHaveBeenCalledWith('main', {});
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
    const svc = new WorkflowService(makeDb(), git, prs, reviewWorkflow, workspaceService, makeAccessControl(), makeFileLockService(), pending, testKbContext(), openChangeGate());

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
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), testKbContext(), openChangeGate());
    await svc.acquireLock('w1', 'b', 'p', makeUser());
    expect(fileLocks.acquire).toHaveBeenCalledWith('w1', 'b', 'p', expect.objectContaining({ email: 'alice@example.com' }), undefined);
  });

  it('acquireLock forwards the coordination flag so the lock row persists its mode', async () => {
    // The mode must reach the store: an in-memory-only distinction would let
    // a coordination hold masquerade as an edit lock on the very next read
    // (which is how the write paths decide what the holder may do).
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), testKbContext(), openChangeGate());
    await svc.acquireLock('w1', 'b', 'p', makeUser(), { coordination: true });
    expect(fileLocks.acquire).toHaveBeenCalledWith(
      'w1', 'b', 'p', expect.objectContaining({ email: 'alice@example.com' }), { coordination: true },
    );
  });

  it('getLock delegates to FileLockService.get', async () => {
    const fileLocks = makeFileLockService();
    const svc = new WorkflowService(makeDb(), makeGit(), makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), testKbContext(), openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, pending, testKbContext(), openChangeGate());
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
    const svc = new WorkflowService(makeDb([{ number: 7, sourceBranch: 'feat/x', targetBranch: 'dev', state: 'open' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).rejects.toThrow(/open change request \(#7\)/);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deleteBranch refuses when an open request proposes INTO the branch (target end)', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb([{ number: 9, sourceBranch: 'other/y', targetBranch: 'feat/x', state: 'open' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).rejects.toThrow(/proposes changes into/);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deleteBranch proceeds past a CLOSED request — the guard filters on state, not mere mention', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb([{ number: 7, sourceBranch: 'feat/x', targetBranch: 'dev', state: 'closed' }]), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    await expect(svc.deleteBranch('w1', 'feat/x', makeUser())).resolves.toBeUndefined();
    expect(git.deleteBranch).toHaveBeenCalled();
  });

  it('deleteBranch deletes when the branch has no open change request', async () => {
    const git = makeGit();
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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
    const svc = new WorkflowService(makeDb(), git, makePrs(), makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(), fileLocks, makePendingCommits(), testKbContext(), openChangeGate());
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
    events?: WorkflowEventBus;
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
    const svc = new WorkflowService(db, git, prs, makeReviewWorkflow(), makeWorkspaceService(), access, fileLocks, makePendingCommits(), testKbContext(), openChangeGate(), opts.events);
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

  describe('when the repository host refuses the push', () => {
    // What GitHub answered during its 2026-10-07 incident, credential and all.
    const REFUSED = new Error(
      "git push failed: remote: Internal Server Error\nTo https://x-access-token:ghp_abc123@github.com/acme/kb.git\n ! [remote rejected] ali/x -> ali/x (Internal Server Error)",
    );
    const kindsOf = (emit: ReturnType<typeof vi.fn>) =>
      emit.mock.calls
        .map((c) => (c[0] as { kind: string }).kind)
        .filter((k) => k.startsWith('git-sync-'));

    it('keeps the revert committed locally, answers 409 with the saved-locally sentence, and raises the banner', async () => {
      const emit = vi.fn();
      const git = makeRevertGit({
        push: vi.fn().mockRejectedValue(REFUSED),
        // A refused push is not a divergence — but "rejected" reads like one,
        // so the cooperative pull runs first; it changes nothing here.
        pull: vi.fn().mockResolvedValue({ treeChanged: false }),
      });
      const { svc, fileLocks, prs, db } = makeHarness({ git, events: { emit } as unknown as WorkflowEventBus });

      const err = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PushNeedsAgentResolutionError);
      const refusal = err as PushNeedsAgentResolutionError;
      expect(refusal.status).toBe(409);
      expect(refusal.message).toContain('Saved locally on "ali/x"');
      expect(refusal.message).toContain('the repository host refused the push');
      // The browser receives message + payload: neither carries git output.
      const body = JSON.stringify({ ...refusal.payload, error: refusal.message });
      expect(body).not.toMatch(/Internal Server Error|remote rejected|ghp_|github\.com/);

      // The local result stays: restored, committed, locks dropped, caches fresh.
      expect(git.restorePathFromRef).toHaveBeenCalledWith('ali%2Fx', 'mb-sha', 'Docs/a.md');
      expect(git.commitFile).toHaveBeenCalled();
      expect(fileLocks.release).toHaveBeenCalled();
      expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
      // Nothing is closed on the strength of a branch the host never received:
      // the remaining files (read from the published refs) are not even asked.
      expect(git.changedPathsForPr).toHaveBeenCalledTimes(1);
      // Nor is a recorded apply failure erased: the published head it
      // describes did not move.
      expect(db.update).not.toHaveBeenCalled();

      // The banner, on the request's source branch, in words — not git's.
      const failed = emit.mock.calls.map((c) => c[0] as Record<string, unknown>).find((e) => e.kind === 'git-sync-failed');
      expect(failed).toMatchObject({ workspaceId: 'ali/x', branch: 'ali/x' });
      expect(String(failed?.reason)).not.toMatch(/Internal Server Error|remote|ghp_/);
    });

    it('clears the banner on the next push of that branch that lands', async () => {
      const emit = vi.fn();
      const push = vi.fn().mockRejectedValueOnce(REFUSED).mockRejectedValueOnce(REFUSED).mockResolvedValue(undefined);
      const git = makeRevertGit({ push, pull: vi.fn().mockResolvedValue({ treeChanged: false }) });
      const { svc } = makeHarness({ git, events: { emit } as unknown as WorkflowEventBus });

      await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).rejects.toBeInstanceOf(
        PushNeedsAgentResolutionError,
      );
      // The host is back; the next push of the branch carries the revert.
      await svc.shareCurrentBranch('ali%2Fx', makeUser());
      expect(kindsOf(emit)).toEqual(['git-sync-failed', 'git-sync-recovered']);
      expect(emit).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'git-sync-recovered', workspaceId: 'ali/x' }),
      );
    });

    it('a divergence whose retry push the host then refuses is answered as a refusal, not a divergence', async () => {
      const push = vi
        .fn()
        .mockRejectedValueOnce(new Error('! [rejected] ali/x -> ali/x (non-fast-forward)'))
        .mockRejectedValueOnce(REFUSED);
      const git = makeRevertGit({ push, pull: vi.fn().mockResolvedValue({ treeChanged: true }) });
      const { svc } = makeHarness({ git });

      const err = await svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PushNeedsAgentResolutionError);
      expect((err as PushNeedsAgentResolutionError).message).toContain('the repository host refused the push');
      expect(push).toHaveBeenCalledTimes(2);
    });

    it('a non-fast-forward still takes the cooperative pull-rebase, then lands', async () => {
      const emit = vi.fn();
      const push = vi
        .fn()
        .mockRejectedValueOnce(new Error('! [rejected] ali/x -> ali/x (non-fast-forward)'))
        .mockResolvedValue(undefined);
      const pull = vi.fn().mockResolvedValue({ treeChanged: true });
      const git = makeRevertGit({ push, pull });
      const { svc } = makeHarness({ git, events: { emit } as unknown as WorkflowEventBus });

      await expect(svc.revertChangeRequestFile(7, makeUser(), 'Docs/a.md')).resolves.toMatchObject({ closed: false });
      expect(push).toHaveBeenCalledTimes(2);
      // Once to freshen the checkout, once as the cooperative recovery —
      // which replays merges as merges on every push.
      expect(pull).toHaveBeenCalledTimes(2);
      expect(pull).toHaveBeenLastCalledWith('ali%2Fx', { preserveMerges: true });
      expect(kindsOf(emit)).not.toContain('git-sync-failed');
    });
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

describe('WorkflowService — deleteChangeRequest (the author’s and the admin’s verb)', () => {
  const AUTHOR_EMAIL = 'alice@example.com'; // makeUser()'s default caller
  const STRANGER_AUTHOR = 'mallory@example.com';

  function makeDeleteHarness(
    opts: { isAdmin?: boolean; prState?: string; authorEmail?: string | null } = {},
  ) {
    const git = Object.assign(makeGit(), {
      changedPathsForPr: vi.fn().mockResolvedValue(['Docs/a.md']),
    }) as unknown as GitService;
    const prs = makePrs();
    (prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 9,
      base: 'main',
      branch: 'mallory/spam',
      state: opts.prState ?? 'open',
      // Authorship as the server reads it: the stored hash, never the caller's
      // claim. Defaults to someone OTHER than makeUser(), so a test that says
      // nothing about authorship is testing the admin grant alone.
      // `null` means a request with no stored author (opened outside this
      // backend); undefined means "someone, just not the caller".
      authorId:
        opts.authorEmail === null ? undefined : hashEmail(opts.authorEmail ?? STRANGER_AUTHOR),
    });
    const access = makeAccessControl();
    (access.canWriteAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(opts.isAdmin ?? false);
    const chain: Record<string, unknown> = {};
    // Two different selects run under one chain mock: the branch-retirement
    // lookup asks for `{ sourceBranch }`, and `openChangeRequestOn` asks for
    // `{ number, sourceBranch }`. Answer by projection rather than call order,
    // so the retirement path is exercised (a branch to retire, and no other
    // open request holding it) without the test depending on call sequence.
    let projection: Record<string, unknown> = {};
    Object.assign(chain, {
      select: vi.fn((proj?: Record<string, unknown>) => {
        projection = proj ?? {};
        return chain;
      }),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () =>
        'number' in projection ? [] : [{ sourceBranch: 'mallory/spam' }],
      ),
      update: vi.fn(() => chain),
      set: vi.fn(() => chain),
      returning: vi.fn(async () => [{ id: 1 }]),
    });
    const workspaces = makeWorkspaceService();
    const svc = new WorkflowService(chain as unknown as Database, git, prs, makeReviewWorkflow(), workspaces, access, makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
    return { svc, prs, db: chain, access, workspaces, git };
  }

  it('refuses a non-admin who is not the author, with 403 and the author-or-admin message', async () => {
    const { svc, db, git } = makeDeleteHarness({ isAdmin: false });
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({
      status: 403,
      message: "Only the request's author or an admin can delete it.",
    });
    // "Changes nothing" is the whole promise of the refusal: no row flipped,
    // no branch removed.
    expect(db.update).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('lets the AUTHOR delete their own request without admin rights: closes it and retires the branch', async () => {
    const { svc, prs, db, git } = makeDeleteHarness({
      isAdmin: false,
      authorEmail: AUTHOR_EMAIL,
    });
    await svc.deleteChangeRequest(9, makeUser());
    expect(db.update).toHaveBeenCalled();
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(9);
    expect(git.deleteBranch).toHaveBeenCalledWith(
      expect.any(String),
      'mallory/spam',
      expect.objectContaining({ email: AUTHOR_EMAIL }),
      expect.objectContaining({ systemCleanup: true }),
    );
  });

  it('matches the author case-insensitively, as hashEmail does', async () => {
    // The stored hash is of the normalized address; a caller signed in as
    // `Alice@Example.com` is the same person and must not be refused.
    const { svc, db } = makeDeleteHarness({ isAdmin: false, authorEmail: AUTHOR_EMAIL });
    await svc.deleteChangeRequest(9, makeUser({ email: '  Alice@Example.com  ' }));
    expect(db.update).toHaveBeenCalled();
  });

  it('refuses a request with no stored author to a non-admin', async () => {
    // Opened outside this backend: nobody can claim authorship of it, so the
    // admin grant is the only one left. An absent hash must never read as a
    // match.
    const { svc, db } = makeDeleteHarness({ isAdmin: false, authorEmail: null });
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

  it('refuses the AUTHOR on an applied request with 422 and the applied message', async () => {
    // Applied between opening the dialog and confirming. The author's new
    // grant does not reach applied history either.
    const { svc, db, git } = makeDeleteHarness({
      isAdmin: false,
      prState: 'merged',
      authorEmail: AUTHOR_EMAIL,
    });
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({
      status: 422,
      message: 'This change request has already been applied.',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('refuses the AUTHOR with 409 when the base cannot be verified, and changes nothing', async () => {
    // The strict base fetch is NOT skipped for an author, even though their
    // grant needs no roles.yaml read: an unreachable origin means the branch
    // removal would fail silently, and the delete must refuse whole rather
    // than close the request and leave the branch.
    const { svc, db, git, workspaces } = makeDeleteHarness({
      isAdmin: false,
      authorEmail: AUTHOR_EMAIL,
    });
    (workspaces.ensureRemotesFetched as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('origin unreachable'),
    );
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Retry in a moment.'),
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('refuses the AUTHOR with 409 when the base ref does not resolve', async () => {
    const { svc, db, access } = makeDeleteHarness({
      isAdmin: false,
      authorEmail: AUTHOR_EMAIL,
    });
    (access.canWriteAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(svc.deleteChangeRequest(9, makeUser())).rejects.toMatchObject({ status: 409 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a request already closed elsewhere still has its branch retired', async () => {
    // Withdrawn in another tab: the guarded update flips no row, the request
    // is not merged, so the delete finishes the job the withdraw left undone.
    const { svc, db, git } = makeDeleteHarness({
      isAdmin: false,
      prState: 'closed',
      authorEmail: AUTHOR_EMAIL,
    });
    // The update is guarded on `state = 'open'`, so it flips nothing here.
    (db.returning as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(svc.deleteChangeRequest(9, makeUser())).resolves.toBeUndefined();
    expect(git.deleteBranch).toHaveBeenCalledWith(
      expect.any(String),
      'mallory/spam',
      expect.anything(),
      expect.objectContaining({ systemCleanup: true }),
    );
  });

  it('keeps a branch another open request still uses, and closes the request silently', async () => {
    const { svc, db, git } = makeDeleteHarness({
      isAdmin: false,
      authorEmail: AUTHOR_EMAIL,
    });
    // `openChangeRequestOn` finds a live request on the branch (the
    // `{ number, sourceBranch }` projection), so retirement backs off.
    let projection: Record<string, unknown> = {};
    (db.select as ReturnType<typeof vi.fn>).mockImplementation((proj?: Record<string, unknown>) => {
      projection = proj ?? {};
      return db;
    });
    (db.limit as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      'number' in projection
        ? [{ number: 11, sourceBranch: 'mallory/spam' }]
        : [{ sourceBranch: 'mallory/spam' }],
    );
    // No throw, no message: the request closes and the branch survives.
    await expect(svc.deleteChangeRequest(9, makeUser())).resolves.toBeUndefined();
    expect(db.update).toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
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
    const svc = new WorkflowService(makeDb([OPEN_REQUEST]), git, makePrs(), makeReviewWorkflow(), workspaceService, access, makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate());
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
    expect(testKbContext().isProtectedBranch(PROTECTED)).toBe(true);
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

/**
 * Opening a request pushes its source after the auto-merge. A push the host
 * refuses must not undo the open: the merge is committed locally, the request
 * is a DB row, and the next push of the branch carries the commits.
 */
describe('WorkflowService.openChangeRequest — when the repository host refuses the push', () => {
  const INPUT = { sourceBranch: 'ali/x', targetBranch: 'main', title: 'Tidy the glossary' };

  function makeOpenHarness(push: ReturnType<typeof vi.fn>) {
    const emit = vi.fn();
    const git = Object.assign(makeGit(), {
      mergeFromOrigin: vi.fn().mockResolvedValue({ kind: 'clean', alreadyUpToDate: false }),
      push,
      pull: vi.fn().mockResolvedValue({ treeChanged: false }),
    }) as unknown as GitService;
    const prs = makePrs();
    (prs.listOpenPrs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prs.getPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 12, branch: 'ali/x', base: 'main' });
    const values = vi.fn(() => ({ returning: vi.fn(async () => [{ number: 12 }]) }));
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Database;
    const svc = new WorkflowService(
      db, git, prs, makeReviewWorkflow(), makeWorkspaceService(), makeAccessControl(),
      makeFileLockService(), makePendingCommits(), testKbContext(), openChangeGate(),
      { emit } as unknown as WorkflowEventBus,
    );
    return { svc, git, prs, values, emit };
  }

  it('creates the request, then answers 409 with the saved-locally sentence and raises the banner', async () => {
    const refused = new Error(
      'git push failed: remote: Internal Server Error\n ! [remote rejected] ali/x -> ali/x (Internal Server Error)',
    );
    const h = makeOpenHarness(vi.fn().mockRejectedValue(refused));

    const err = await h.svc.openChangeRequest('ali%2Fx', makeUser(), INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushNeedsAgentResolutionError);
    const refusal = err as PushNeedsAgentResolutionError;
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('Saved locally on "ali/x"');
    expect(JSON.stringify({ ...refusal.payload, error: refusal.message })).not.toMatch(/Internal Server Error|remote rejected/);

    // The request exists — the row was inserted and announced.
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: 'ali/x', targetBranch: 'main' }));
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(12);
    const kinds = h.emit.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain('change-request-opened');
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'git-sync-failed', workspaceId: 'ali/x', branch: 'ali/x' }),
    );
  });

  it('a push that lands answers the detail as before, with no banner', async () => {
    const h = makeOpenHarness(vi.fn().mockResolvedValue(undefined));
    await expect(h.svc.openChangeRequest('ali%2Fx', makeUser(), INPUT)).resolves.toMatchObject({ number: 12 });
    expect(h.git.push).toHaveBeenCalledWith('ali%2Fx', expect.objectContaining({ email: 'alice@example.com' }));
    const kinds = h.emit.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain('git-sync-failed');
  });

  it('a non-fast-forward recovers with a merge-preserving pull, and the request opens', async () => {
    const push = vi
      .fn()
      .mockRejectedValueOnce(new Error('! [rejected] ali/x -> ali/x (fetch first)'))
      .mockResolvedValue(undefined);
    const h = makeOpenHarness(push);
    await expect(h.svc.openChangeRequest('ali%2Fx', makeUser(), INPUT)).resolves.toMatchObject({ number: 12 });
    expect(h.git.pull).toHaveBeenCalledWith('ali%2Fx', { preserveMerges: true });
    expect(push).toHaveBeenCalledTimes(2);
  });
});
