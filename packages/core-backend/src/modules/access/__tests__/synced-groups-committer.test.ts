import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AccessControlService } from '../access-control.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createSyncedGroupsCommitter } from '../synced-groups-committer.js';
import { PushNeedsAgentResolutionError, WorkflowValidationError } from '../../workflow/workflow.errors.js';

const KB = 'knowledge-base';
const BOT: AuthUser = { id: 'bot-1', email: 'directory-sync@bevel.local', name: 'Directory Sync Bot' };

describe('createSyncedGroupsCommitter.persist — post-commit push failures', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-sg-committer-'));
    await fs.mkdir(path.join(root, KB), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeDeps(workflowOverrides: Partial<Record<'commitChanges' | 'releaseLock', unknown>> = {}) {
    const workspaceService = {
      getOrCreateForBranch: vi.fn(async () => ({})),
      getWorkspacePath: vi.fn(async () => root),
      readFile: vi.fn(async (_id: string, wsRel: string) =>
        fs.readFile(path.join(root, wsRel), 'utf-8'),
      ),
    } as unknown as WorkspaceService;
    const releaseLock = vi.fn(async () => undefined);
    const releaseLockNoCommit = vi.fn(async () => undefined);
    const workflowService = {
      acquireLock: vi.fn(async () => ({ acquired: true, lock: {} })),
      releaseLock,
      releaseLockNoCommit,
      commitChanges: vi.fn(async () => ({})),
      ...workflowOverrides,
    } as unknown as IWorkflowService;
    const accessControl = { invalidate: vi.fn() } as unknown as AccessControlService;
    const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
    const committer = createSyncedGroupsCommitter({
      workspaceService,
      workflowService,
      accessControl,
      eventBus,
      kbDirName: KB,
      bot: BOT,
      defaultBranchOf: () => 'main',
    });
    return { committer, releaseLock, releaseLockNoCommit };
  }

  it('resolves (edit is saved) when only the PUSH failed after a landed commit', async () => {
    // The regression this pins: a push failure after a successful local commit
    // used to reject persist — the next sync then read the committed bytes,
    // saw a no-op, and the update stayed unpublished forever. A landed commit
    // is a saved edit; the pending-commits ladder retries the share.
    const { committer, releaseLock, releaseLockNoCommit } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new PushNeedsAgentResolutionError('main', '(batch)', 'non-fast-forward', 'rebase failed');
      }),
    });
    await expect(committer.persist('groups:\n  Team:\n    - a@x.io\n')).resolves.toBeUndefined();
    // The bytes landed on disk (write happened before the commit attempt)...
    expect(await fs.readFile(path.join(root, KB, 'synced-groups.yaml'), 'utf-8')).toContain('a@x.io');
    // ...and the lock released through the RETRY-ARMING path, never the discard.
    expect(releaseLock).toHaveBeenCalled();
    expect(releaseLockNoCommit).not.toHaveBeenCalled();
  });

  it('treats a lock-not-held answer from the arm probe as "retry already armed" (the normal shape)', async () => {
    // In production the writeFiles push-retry release has usually SUCCEEDED —
    // enqueue first, then drop the row — so the committer's verification
    // release finds no lock to release. That proves the enqueue happened;
    // persist must resolve.
    const releaseLock = vi
      .fn()
      // writeFiles' own push-retry release: succeeded (row enqueued + dropped).
      .mockResolvedValueOnce(undefined)
      // The committer's arm probe: nothing left to release.
      .mockRejectedValue(
        new WorkflowValidationError('Cannot release lock: not held by you.', {
          kind: 'lock-not-held',
        }),
      );
    const { committer } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new PushNeedsAgentResolutionError('main', '(batch)', 'non-fast-forward', 'rebase failed');
      }),
      releaseLock,
    });
    await expect(committer.persist('groups:\n  Team:\n    - a@x.io\n')).resolves.toBeUndefined();
    expect(releaseLock).toHaveBeenCalledTimes(2);
  });

  it('re-arms the retry itself when the push-retry release could not enqueue its row', async () => {
    // writeFiles' release swallows an enqueue failure (warn + continue), so
    // without the committer's own arm the landed commit would have NO retry
    // vehicle: the next sync reads the committed bytes, sees a no-op, and the
    // update stays unpublished forever. The committer must retry the release
    // (which enqueues the pending-commit row) before reporting success.
    const releaseLock = vi
      .fn()
      .mockRejectedValueOnce(new Error('pending_commits insert failed')) // writeFiles' release
      .mockResolvedValueOnce(undefined); // the committer's re-arm succeeds
    const { committer } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new PushNeedsAgentResolutionError('main', '(batch)', 'non-fast-forward', 'rebase failed');
      }),
      releaseLock,
    });
    await expect(committer.persist('groups:\n  Team:\n    - a@x.io\n')).resolves.toBeUndefined();
    expect(releaseLock).toHaveBeenCalledTimes(2);
  });

  it('REJECTS when no retry vehicle can be proven (both the release and the re-arm fail)', async () => {
    // The one shape that may not report success: the commit landed, the push
    // needs help, and no pending-commit row could be enqueued. Resolving here
    // would tell the writer the update is published-or-retried when nothing
    // will ever retry it — the failure signal must survive to the caller.
    const releaseLock = vi.fn().mockRejectedValue(new Error('pending_commits insert failed'));
    const { committer } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new PushNeedsAgentResolutionError('main', '(batch)', 'non-fast-forward', 'rebase failed');
      }),
      releaseLock,
    });
    await expect(committer.persist('groups:\n  Team:\n    - a@x.io\n')).rejects.toBeInstanceOf(
      PushNeedsAgentResolutionError,
    );
  });

  it('still rejects on a genuine pre-commit failure (nothing landed)', async () => {
    const { committer } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new Error('commit exploded');
      }),
    });
    await expect(committer.persist('groups: {}\n')).rejects.toThrow('commit exploded');
  });
});
