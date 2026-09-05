import { describe, expect, it, vi } from 'vitest';
import type { RemoteSyncPullResult } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { WorkflowEventBus } from '../event-bus.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService, syncConflictMessage } from '../workflow.service.js';
import { PullRebaseConflictError, RemoteBranchGoneError } from '../../../shared/domain-errors.js';

/**
 * `syncWorkspaceFromRemote` — the per-branch step a remote sync drives.
 * Built on a fake git whose one call, `syncFromRemote`, answers what the real
 * one observes under a single hold of the clone. The assertions are about
 * the CONTRACT: what gets announced when content changed, what does not
 * when it did not, that a conflict is both queued for the usual recovery and
 * reported as an outcome, and that nothing here ever throws.
 */
const PULLED: RemoteSyncPullResult = { before: 'aaa', after: 'bbb', treeChanged: true, changedPaths: [] };

function build(opts: { sync: () => Promise<RemoteSyncPullResult> }) {
  const git = { syncFromRemote: vi.fn(opts.sync) } as unknown as GitService;
  const prs = { invalidateListCache: vi.fn() } as unknown as PullRequestService;
  const pendingCommits = { enqueueIfAbsent: vi.fn(async () => true) } as unknown as PendingCommitsService;
  const events = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const svc = new WorkflowService(
    {} as Database,
    git,
    prs,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    pendingCommits,
    'knowledge-base',
    events,
  );
  return { svc, git, prs, pendingCommits, emit: events.emit as ReturnType<typeof vi.fn> };
}

const kinds = (emit: ReturnType<typeof vi.fn>) =>
  emit.mock.calls.map((c) => (c[0] as { kind: string }).kind);

describe('WorkflowService.syncWorkspaceFromRemote', () => {
  it('content changed: reports updated, announces the tree and each changed file, drops the CR list cache', async () => {
    const { svc, prs, emit } = build({
      sync: async () => ({ ...PULLED, changedPaths: ['Plugins/x/SKILL.md', 'Docs/a.md'] }),
    });
    const out = await svc.syncWorkspaceFromRemote('ali%2Fx');
    expect(out).toEqual({ branch: 'ali/x', outcome: 'updated', from: 'aaa', to: 'bbb' });
    expect(prs.invalidateListCache).toHaveBeenCalledTimes(1);
    expect(kinds(emit)).toEqual(['fs-tree-changed', 'file-changed', 'file-changed']);
    expect(emit.mock.calls[0][0]).toEqual({
      kind: 'fs-tree-changed',
      workspaceId: 'ali%2Fx',
      branch: 'ali/x',
    });
    // Paths are announced workspace-relative — the shape open tabs hold.
    expect(emit.mock.calls[1][0]).toMatchObject({
      kind: 'file-changed',
      workspaceId: 'ali%2Fx',
      branch: 'ali/x',
      path: 'knowledge-base/Plugins/x/SKILL.md',
      newSha: 'bbb',
      byUserId: 'system',
    });
  });

  it('hands git the DECODED id — the spelling the HTTP routes use, so the mutex is shared with a concurrent save', async () => {
    const { svc, git } = build({ sync: async () => PULLED });
    await svc.syncWorkspaceFromRemote('ali%2Fnew-skill');
    expect(git.syncFromRemote).toHaveBeenCalledWith('ali/new-skill');
  });

  it('HEAD unchanged: up-to-date, nothing announced, nothing invalidated', async () => {
    const { svc, prs, emit } = build({
      sync: async () => ({ before: 'aaa', after: 'aaa', treeChanged: false, changedPaths: [] }),
    });
    expect(await svc.syncWorkspaceFromRemote('main')).toEqual({
      branch: 'main',
      outcome: 'up-to-date',
      to: 'aaa',
    });
    expect(emit).not.toHaveBeenCalled();
    expect(prs.invalidateListCache).not.toHaveBeenCalled();
  });

  it('HEAD moved across content-identical commits: updated, but nothing announced', async () => {
    const { svc, prs, emit } = build({
      sync: async () => ({ before: 'aaa', after: 'bbb', treeChanged: false, changedPaths: [] }),
    });
    expect(await svc.syncWorkspaceFromRemote('main')).toEqual({
      branch: 'main',
      outcome: 'updated',
      from: 'aaa',
      to: 'bbb',
    });
    expect(emit).not.toHaveBeenCalled();
    expect(prs.invalidateListCache).not.toHaveBeenCalled();
  });

  it('an unborn clone of an unborn upstream is up to date; one that just received content is updated from null', async () => {
    const empty = build({
      sync: async () => ({ before: null, after: null, treeChanged: false, changedPaths: [] }),
    });
    expect(await empty.svc.syncWorkspaceFromRemote('main')).toEqual({
      branch: 'main',
      outcome: 'up-to-date',
      to: '',
    });
    expect(empty.emit).not.toHaveBeenCalled();

    const born = build({
      sync: async () => ({ before: null, after: 'bbb', treeChanged: true, changedPaths: ['README.md'] }),
    });
    expect(await born.svc.syncWorkspaceFromRemote('main')).toEqual({
      branch: 'main',
      outcome: 'updated',
      from: null,
      to: 'bbb',
    });
    expect(kinds(born.emit)).toEqual(['fs-tree-changed', 'file-changed']);
  });

  it('a large change set announces the tree only', async () => {
    const { svc, emit } = build({
      sync: async () => ({ ...PULLED, changedPaths: Array.from({ length: 201 }, (_, i) => `f${i}.md`) }),
    });
    await svc.syncWorkspaceFromRemote('main');
    expect(kinds(emit)).toEqual(['fs-tree-changed']);
  });

  it('a conflict queues the same recovery as a normal update, and is reported with the files', async () => {
    const { svc, pendingCommits, emit } = build({
      sync: async () => {
        throw new PullRebaseConflictError('main', ['Plugins/x/SKILL.md'], 'CONFLICT (content)');
      },
    });
    const out = await svc.syncWorkspaceFromRemote('main');
    const message = syncConflictMessage('main', ['Plugins/x/SKILL.md']);
    expect(out).toEqual({
      branch: 'main',
      outcome: 'conflict',
      conflictedPaths: ['Plugins/x/SKILL.md'],
      error: message,
    });
    expect(message).toBe(
      'main is not in sync yet: Plugins/x/SKILL.md changed both in Hexis and on the git host. ' +
        'Recovery is queued; if this stays, open the files on main in Hexis, keep what you want, and save.',
    );
    // The retry → recovery-agent → escalate ladder — one row, never reset by
    // a repeat (the sync can fire on every hook).
    expect(pendingCommits.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    // The branch's banner gets the same sentence, plus the files to open.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      kind: 'git-sync-failed',
      workspaceId: 'main',
      branch: 'main',
      reason: message,
      conflictedPaths: ['Plugins/x/SKILL.md'],
    });
  });

  it('a conflict in many files reaches the banner with the SAME sentence as the response', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `Plugins/some-long-plugin-name-${i}/SKILL.md`);
    const { svc, emit } = build({
      sync: async () => {
        throw new PullRebaseConflictError('main', paths, 'CONFLICT');
      },
    });
    const out = await svc.syncWorkspaceFromRemote('main');
    const message = (out as { error: string }).error;
    expect(message).toContain('and 9 more files');
    expect(emit.mock.calls[0][0]).toMatchObject({ reason: message, conflictedPaths: paths });
  });

  it('a second sync of a still-conflicted branch answers the same, and asks for recovery idempotently', async () => {
    let pulls = 0;
    const { svc, pendingCommits } = build({
      sync: async () => {
        pulls++;
        throw new PullRebaseConflictError('main', ['a.md'], 'CONFLICT');
      },
    });
    const first = await svc.syncWorkspaceFromRemote('main');
    const second = await svc.syncWorkspaceFromRemote('main');
    expect(second).toEqual(first);
    expect(pulls).toBe(2);
    expect(pendingCommits.enqueueIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('a branch deleted on the host is remote-gone: no banner, no recovery', async () => {
    const { svc, emit, pendingCommits } = build({
      sync: async () => {
        throw new RemoteBranchGoneError('ali/x');
      },
    });
    expect(await svc.syncWorkspaceFromRemote('ali%2Fx')).toEqual({ branch: 'ali/x', outcome: 'remote-gone' });
    expect(emit).not.toHaveBeenCalled();
    expect(pendingCommits.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('any other pull failure is an error outcome with a sanitised message, and raises the banner', async () => {
    const { svc, emit } = build({
      sync: async () => {
        throw new Error("fatal: unable to access 'https://x-access-token:ghp_secret123@host/repo': timed out");
      },
    });
    const out = await svc.syncWorkspaceFromRemote('main');
    expect(out).toMatchObject({ branch: 'main', outcome: 'error' });
    const error = (out as { error: string }).error;
    expect(error).not.toContain('ghp_secret123');
    expect(error).toContain('timed out');
    expect(kinds(emit)).toEqual(['git-sync-failed']);
  });

  it('a clean pull clears a banner an earlier failure raised', async () => {
    let fail = true;
    const { svc, emit } = build({
      sync: async () => {
        if (fail) throw new Error('could not read from remote');
        return { before: 'aaa', after: 'aaa', treeChanged: false, changedPaths: [] };
      },
    });
    await svc.syncWorkspaceFromRemote('main');
    fail = false;
    await svc.syncWorkspaceFromRemote('main');
    expect(kinds(emit)).toEqual(['git-sync-failed', 'git-sync-recovered']);
  });

  it('a failing announcement is an error outcome, never a throw, and raises no banner', async () => {
    const { svc, prs, emit } = build({ sync: async () => PULLED });
    (prs.invalidateListCache as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('cache exploded');
    });
    await expect(svc.syncWorkspaceFromRemote('main')).resolves.toMatchObject({ outcome: 'error' });
    expect(kinds(emit)).toEqual([]);
  });
});

describe('WorkflowService.retireRemoteGoneClone', () => {
  function buildRetire(opts: { cloned: boolean; stillOnOrigin: boolean; bootstrapping?: boolean }) {
    const git = {
      remoteBranchExists: vi.fn(async () => opts.stillOnOrigin),
      createBranch: vi.fn(async (_ws: string, name: string) => ({ name })),
    } as unknown as GitService;
    const workspaceService = {
      hasBootstrappedWorkspace: vi.fn(async () => opts.cloned),
      isBootstrapInFlight: vi.fn(() => opts.bootstrapping === true),
      deleteWorkspace: vi.fn(async () => {}),
    } as unknown as WorkspaceService;
    const svc = new WorkflowService(
      {} as Database, git, {} as PullRequestService, {} as IReviewWorkflowService,
      workspaceService, {} as IAccessControl, {} as FileLockService, {} as PendingCommitsService,
      'knowledge-base',
    );
    return { svc, git, workspaceService };
  }

  it('removes the clone when origin still lacks the branch, asking origin again rather than trusting the pull', async () => {
    const { svc, git, workspaceService } = buildRetire({ cloned: true, stillOnOrigin: false });
    expect(await svc.retireRemoteGoneClone('ali%2Fx')).toBe(true);
    expect(git.remoteBranchExists).toHaveBeenCalledWith('ali/x', 'ali/x');
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ali%2Fx');
  });

  it('keeps the clone when the branch is back on origin', async () => {
    const { svc, workspaceService } = buildRetire({ cloned: true, stillOnOrigin: true });
    expect(await svc.retireRemoteGoneClone('ali%2Fx')).toBe(false);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing when there is no clone any more', async () => {
    const { svc, git, workspaceService } = buildRetire({ cloned: false, stillOnOrigin: false });
    expect(await svc.retireRemoteGoneClone('ali%2Fx')).toBe(false);
    expect(git.remoteBranchExists).not.toHaveBeenCalled();
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('is serialised with deleteBranch on the same branch — the lifecycle lock', async () => {
    // A deleteBranch holding `branch:ali/x` must finish before the retirement
    // examines the clone. Observed through ordering: the retirement's first
    // read happens after the held section releases.
    const order: string[] = [];
    const { svc, workspaceService } = buildRetire({ cloned: true, stillOnOrigin: false });
    const lifecycle = (svc as unknown as { branchLifecycle: { run<T>(k: string, f: () => Promise<T>): Promise<T> } }).branchLifecycle;
    let release!: () => void;
    const held = lifecycle.run('branch:ali/x', () => new Promise<void>((res) => {
      release = () => {
        order.push('released');
        res();
      };
    }));
    (workspaceService.hasBootstrappedWorkspace as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('retire-read');
      return true;
    });
    const retiring = svc.retireRemoteGoneClone('ali%2Fx');
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    release();
    await held;
    await retiring;
    expect(order).toEqual(['released', 'retire-read']);
  });
});

describe('WorkflowService.retireRemoteGoneClone — what can bring the branch back', () => {
  it('backs off while a clone of the branch is being bootstrapped', async () => {
    const git = { remoteBranchExists: vi.fn(async () => false) } as unknown as GitService;
    const workspaceService = {
      hasBootstrappedWorkspace: vi.fn(async () => true),
      isBootstrapInFlight: vi.fn(() => true),
      deleteWorkspace: vi.fn(async () => {}),
    } as unknown as WorkspaceService;
    const svc = new WorkflowService(
      {} as Database, git, {} as PullRequestService, {} as IReviewWorkflowService,
      workspaceService, {} as IAccessControl, {} as FileLockService, {} as PendingCommitsService,
      'knowledge-base',
    );
    expect(await svc.retireRemoteGoneClone('ali%2Fx')).toBe(false);
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('createBranch holds the same lifecycle lock, so a recreate cannot slip between the origin check and the delete', async () => {
    const order: string[] = [];
    const git = {
      remoteBranchExists: vi.fn(async () => {
        order.push('retire-checks-origin');
        return false;
      }),
      createBranch: vi.fn(async (_ws: string, name: string) => {
        order.push('create');
        return { name, isProtected: false, ahead: 0, behind: 0, hasRemote: true };
      }),
    } as unknown as GitService;
    const workspaceService = {
      hasBootstrappedWorkspace: vi.fn(async () => true),
      isBootstrapInFlight: vi.fn(() => false),
      deleteWorkspace: vi.fn(async () => {
        order.push('retire-deletes');
      }),
    } as unknown as WorkspaceService;
    const svc = new WorkflowService(
      {} as Database, git, {} as PullRequestService, {} as IReviewWorkflowService,
      workspaceService, {} as IAccessControl, {} as FileLockService, {} as PendingCommitsService,
      'knowledge-base',
    );
    // Retirement enters first; a createBranch for the same name arrives while
    // it holds the lock and must wait until the delete has happened — never
    // land between the check and the delete.
    const retiring = svc.retireRemoteGoneClone('ali%2Fx');
    const creating = svc.createBranch('main', 'ali/x');
    await Promise.all([retiring, creating]);
    expect(order).toEqual(['retire-checks-origin', 'retire-deletes', 'create']);
  });
});
