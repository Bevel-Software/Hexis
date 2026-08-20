import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AccessControlService } from '../access-control.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createSyncedGroupsCommitter } from '../synced-groups-committer.js';
import { PushNeedsAgentResolutionError } from '../../workflow/workflow.errors.js';

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

  function makeDeps(workflowOverrides: Partial<Record<'commitChanges', unknown>> = {}) {
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

  it('still rejects on a genuine pre-commit failure (nothing landed)', async () => {
    const { committer } = makeDeps({
      commitChanges: vi.fn(async () => {
        throw new Error('commit exploded');
      }),
    });
    await expect(committer.persist('groups: {}\n')).rejects.toThrow('commit exploded');
  });
});
