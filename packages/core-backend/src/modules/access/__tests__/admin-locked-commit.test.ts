import { describe, it, expect, vi } from 'vitest';

import { AdminLockedCommits } from '../admin-locked-commit.js';
import { PushNeedsAgentResolutionError, WorkflowDomainError } from '../../workflow/workflow.errors.js';
import type { AuthUser, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';

const KB = 'knowledge-base';
const BRANCH = 'main';
const WS = 'ws-locked';
const ACTOR: AuthUser = { id: 'u-1', email: 'admin@x.io', name: 'Admin' } as AuthUser;

/**
 * Lock-release semantics of `withFileLocks` (cubic P2: a releaseLock whose
 * commit ENQUEUE fails after a successful batch commit stranded every held
 * lock until TTL). Success path must release via releaseLockNoCommit (no
 * enqueue involved); the push-retry path must keep releaseLock (the enqueued
 * commit IS the retry); and a single failed release must not strand the rest.
 */

function makeHarness(opts: {
  commitError?: Error;
  releaseLockError?: Error;
}) {
  const files = new Map<string, string>();
  const locks = new Map<string, AuthUser>();
  const releaseLockCalls: string[] = [];
  const releaseNoCommitCalls: string[] = [];

  const workspaceService = {
    getWorkspacePath: async () => '/tmp/nowhere',
    readFile: async (_id: string, wsRel: string) => {
      const v = files.get(wsRel);
      if (v === undefined) {
        const err = new Error(`ENOENT ${wsRel}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFile: async (_id: string, wsRel: string, content: string) => void files.set(wsRel, content),
    deleteFile: async (_id: string, wsRel: string) => void files.delete(wsRel),
  } as unknown as IWorkspaceService;

  const workflowService = {
    acquireLock: vi.fn(async (_w: string, _b: string, p: string, user: AuthUser) => {
      if (locks.has(p)) return { acquired: false, lock: { holderUserId: 'x', holderName: 'X' } };
      locks.set(p, user);
      return { acquired: true, lock: { holderUserId: user.id, holderName: user.name } };
    }),
    releaseLock: vi.fn(async (_w: string, _b: string, p: string) => {
      releaseLockCalls.push(p);
      if (opts.releaseLockError) throw opts.releaseLockError; // enqueue failed → row NOT dropped
      locks.delete(p);
    }),
    releaseLockNoCommit: vi.fn(async (_w: string, _b: string, p: string) => {
      releaseNoCommitCalls.push(p);
      locks.delete(p);
    }),
    commitChanges: vi.fn(async () => {
      if (opts.commitError) throw opts.commitError;
      return {};
    }),
  } as unknown as IWorkflowService;

  const locked = new AdminLockedCommits({
    workspaceService,
    workflowService,
    kbDirName: KB,
    defaultBranchOf: () => BRANCH,
    makeError: (message, status, payload) => new WorkflowDomainError(message, status, payload),
    logTag: 'test-admin',
    contendedSubject: 'Things',
  });

  return { locked, locks, files, releaseLockCalls, releaseNoCommitCalls };
}

describe('AdminLockedCommits.withFileLocks — release semantics', () => {
  it('SUCCESS: batch-committed paths release via releaseLockNoCommit — a broken enqueue cannot strand them', async () => {
    // releaseLock models "the pending-commit ENQUEUE fails": it throws and the
    // lock row stays held. If the success path still used it, both locks would
    // strand until TTL. With the fix they must all be free afterwards.
    const h = makeHarness({ releaseLockError: new Error('enqueue exploded: sqlite disk I/O error') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await h.locked.withFileLocks(WS, ACTOR, ['groups.yaml', 'roles.yaml'], async () => {
        await h.locked.writeAndCommitLocked(
          WS,
          ACTOR,
          [
            { repoRel: 'groups.yaml', content: 'groups: {}\n', original: null },
            { repoRel: 'roles.yaml', content: 'roles: {}\n', original: 'roles:\n' },
          ],
          'test commit',
        );
      });
      expect(h.locks.size).toBe(0); // ZERO held locks
      expect(h.releaseNoCommitCalls.sort()).toEqual([`${KB}/groups.yaml`, `${KB}/roles.yaml`]);
      expect(h.releaseLockCalls).toEqual([]); // the queue was never touched
    } finally {
      warn.mockRestore();
    }
  });

  it('POST-COMMIT FAILURE: fn throwing after the batch landed still releases committed paths without the queue', async () => {
    // The commit+push succeeded; a later step inside fn (roster read, event
    // emission) blew up. The failure says nothing about the tree — the
    // committed paths are clean, and enqueueing a release commit for them
    // risks stranding a known-clean lock on a broken queue.
    const h = makeHarness({ releaseLockError: new Error('enqueue exploded') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        h.locked.withFileLocks(WS, ACTOR, ['groups.yaml', 'roles.yaml'], async () => {
          await h.locked.writeAndCommitLocked(
            WS,
            ACTOR,
            [
              { repoRel: 'groups.yaml', content: 'groups: {}\n', original: null },
              { repoRel: 'roles.yaml', content: 'roles: {}\n', original: 'roles:\n' },
            ],
            'test commit',
          );
          throw new Error('post-commit boom');
        }),
      ).rejects.toThrow(/post-commit boom/);
      expect(h.locks.size).toBe(0); // ZERO held locks
      expect(h.releaseNoCommitCalls.sort()).toEqual([`${KB}/groups.yaml`, `${KB}/roles.yaml`]);
      expect(h.releaseLockCalls).toEqual([]); // the queue was never touched
    } finally {
      warn.mockRestore();
    }
  });

  it('SUCCESS: a held path the batch never committed keeps commit-on-release (releaseLock)', async () => {
    // A prior holder's queued work could still be dirty on such a path — a
    // discard would destroy it, so the untouched lock releases the old way.
    const h = makeHarness({});
    await h.locked.withFileLocks(WS, ACTOR, ['groups.yaml', 'roles.yaml'], async () => {
      await h.locked.writeAndCommitLocked(
        WS,
        ACTOR,
        [{ repoRel: 'roles.yaml', content: 'roles: {}\n', original: 'roles:\n' }],
        'test commit',
      );
    });
    expect(h.locks.size).toBe(0);
    expect(h.releaseNoCommitCalls).toEqual([`${KB}/roles.yaml`]);
    expect(h.releaseLockCalls).toEqual([`${KB}/groups.yaml`]);
  });

  it('PUSH-RETRY: PushNeedsAgentResolutionError keeps releaseLock (the enqueued commit retries the push)', async () => {
    const h = makeHarness({
      commitError: new PushNeedsAgentResolutionError(BRANCH, `${KB}/roles.yaml`, 'push refused', 'no retry'),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        h.locked.withFileLocks(WS, ACTOR, ['roles.yaml'], async () => {
          await h.locked.writeAndCommitLocked(
            WS,
            ACTOR,
            [{ repoRel: 'roles.yaml', content: 'roles: {}\n', original: 'roles:\n' }],
            'test commit',
          );
        }),
      ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
      expect(h.releaseLockCalls).toEqual([`${KB}/roles.yaml`]); // releaseLock, NOT noCommit
      expect(h.releaseNoCommitCalls).toEqual([]);
      expect(h.locks.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('PUSH-RETRY: one failed release logs and continues — the REST of the locks are still released', async () => {
    const h = makeHarness({
      commitError: new PushNeedsAgentResolutionError(BRANCH, `${KB}/roles.yaml`, 'push refused', 'no retry'),
      releaseLockError: new Error('enqueue exploded'),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        h.locked.withFileLocks(WS, ACTOR, ['a.yaml', 'b.yaml'], async () => {
          await h.locked.writeAndCommitLocked(
            WS,
            ACTOR,
            [
              { repoRel: 'a.yaml', content: 'a\n', original: null },
              { repoRel: 'b.yaml', content: 'b\n', original: null },
            ],
            'test commit',
          );
        }),
      ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
      // BOTH releases were attempted despite the first one throwing.
      expect(h.releaseLockCalls.sort()).toEqual([`${KB}/a.yaml`, `${KB}/b.yaml`]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('FAILURE with restore: commit-on-release is kept (restored bytes are clean; queued work preserved)', async () => {
    const h = makeHarness({ commitError: new Error('commit exploded') });
    await expect(
      h.locked.withFileLocks(WS, ACTOR, ['roles.yaml'], async () => {
        await h.locked.writeAndCommitLocked(
          WS,
          ACTOR,
          [{ repoRel: 'roles.yaml', content: 'roles: {}\n', original: 'roles:\n' }],
          'test commit',
        );
      }),
    ).rejects.toThrow('commit exploded');
    expect(h.releaseLockCalls).toEqual([`${KB}/roles.yaml`]);
    expect(h.releaseNoCommitCalls).toEqual([]);
    expect(h.locks.size).toBe(0);
    expect(h.files.get(`${KB}/roles.yaml`)).toBe('roles:\n'); // restored
  });
});
