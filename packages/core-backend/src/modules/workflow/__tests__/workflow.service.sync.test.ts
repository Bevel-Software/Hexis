import { describe, expect, it, vi } from 'vitest';
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
import { PullRebaseConflictError } from '../../../shared/domain-errors.js';

/**
 * `syncWorkspaceFromRemote` — the per-branch step a remote sync drives.
 * Built on a fake git so the assertions are about the CONTRACT: what gets
 * announced when HEAD moves, what does not when it does not, and — the one
 * rule that differs from every other pull path — that a conflict is reported
 * and never handed to the recovery ladder.
 */
function build(opts: {
  heads: string[];
  pull?: () => Promise<void>;
  changedPaths?: string[];
}) {
  const heads = [...opts.heads];
  const git = {
    headSha: vi.fn(async () => heads.shift() ?? 'zzz'),
    pull: vi.fn(opts.pull ?? (async () => {})),
    changedPathsBetween: vi.fn(async () => opts.changedPaths ?? []),
  } as unknown as GitService;
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
  it('HEAD moved: reports updated, announces the tree and each changed file, drops the CR list cache', async () => {
    const { svc, prs, emit } = build({
      heads: ['aaa', 'bbb'],
      changedPaths: ['Plugins/x/SKILL.md', 'Docs/a.md'],
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

  it('HEAD unchanged: up-to-date, nothing announced, nothing invalidated', async () => {
    const { svc, prs, emit } = build({ heads: ['aaa', 'aaa'] });
    expect(await svc.syncWorkspaceFromRemote('main')).toEqual({
      branch: 'main',
      outcome: 'up-to-date',
      to: 'aaa',
    });
    expect(emit).not.toHaveBeenCalled();
    expect(prs.invalidateListCache).not.toHaveBeenCalled();
  });

  it('a large change set announces the tree only', async () => {
    const { svc, emit } = build({
      heads: ['aaa', 'bbb'],
      changedPaths: Array.from({ length: 201 }, (_, i) => `f${i}.md`),
    });
    await svc.syncWorkspaceFromRemote('main');
    expect(kinds(emit)).toEqual(['fs-tree-changed']);
  });

  it('a conflict queues the same recovery as a normal update, and is reported with the files', async () => {
    const { svc, pendingCommits, emit } = build({
      heads: ['aaa'],
      pull: async () => {
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
    // Short enough to reach the banner whole through the 200-char sanitiser.
    expect(message.length).toBeLessThan(200);
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

  it('a second sync of a still-conflicted branch answers the same, and the clone is untouched', async () => {
    let pulls = 0;
    const { svc, git, pendingCommits } = build({
      heads: ['aaa', 'aaa'],
      pull: async () => {
        pulls++;
        throw new PullRebaseConflictError('main', ['a.md'], 'CONFLICT');
      },
    });
    const first = await svc.syncWorkspaceFromRemote('main');
    const second = await svc.syncWorkspaceFromRemote('main');
    expect(second).toEqual(first);
    expect(pulls).toBe(2);
    // Only the pull ran (it aborts its own rebase); nothing rewrote the tree.
    expect(git.changedPathsBetween).not.toHaveBeenCalled();
    // Recovery is asked for on each sync, through the idempotent enqueue that
    // keeps the existing row's retry counters intact.
    expect(pendingCommits.enqueueIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('any other pull failure is an error outcome with a sanitised message, and raises the banner', async () => {
    const { svc, emit } = build({
      heads: ['aaa'],
      pull: async () => {
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
      heads: ['aaa', 'aaa', 'aaa'],
      pull: async () => {
        if (fail) throw new Error('could not read from remote');
      },
    });
    await svc.syncWorkspaceFromRemote('main');
    fail = false;
    await svc.syncWorkspaceFromRemote('main');
    expect(kinds(emit)).toEqual(['git-sync-failed', 'git-sync-recovered']);
  });
});
