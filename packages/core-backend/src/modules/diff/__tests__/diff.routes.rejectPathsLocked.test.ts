import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { IDiffService } from '../diff.interface.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { WorkflowValidationError } from '../../../shared/domain-errors.js';
import { rejectPathsLocked } from '../diff.routes.js';

/**
 * `rejectPathsLocked` — the BATCH reject. All paths go through ONE
 * `LockingFilesystem.writeFiles` cycle: every lock acquired before the first
 * disk mutation, baselines restored / agent-added files deleted, then a single
 * `commitChanges` and lock release. Fail-closed: contention or a commit error
 * aborts with nothing committed.
 */

const USER: AuthUser = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };
const BRANCH = 'alice/revert-test';
const WORKSPACE_ID = workspaceIdForBranch(BRANCH);

interface Harness {
  workflow: IWorkflowService;
  diff: IDiffService;
  calls: string[];
  workspaceDir: string;
}

async function makeHarness(overrides: {
  /** Per-path acquire outcome. Default: every path acquires cleanly. */
  acquire?: (relPath: string) => { acquired: boolean; lock: { holderName: string } };
  /** Throw from commitChanges to simulate a commit failure. */
  commit?: () => void;
} = {}): Promise<Harness> {
  const calls: string[] = [];
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-reject-'));
  // Baseline-carrying file (backup exists → revert = write baseline bytes)
  // and an agent-added file (no backup → revert = delete).
  await fs.mkdir(path.join(workspaceDir, 'knowledge-base'), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'knowledge-base/a.md'), 'agent version\n');
  await fs.writeFile(path.join(workspaceDir, 'knowledge-base/added.md'), 'agent-added\n');

  const acquireLock = vi.fn(async (_ws: string, _branch: string, relPath: string) => {
    const result = overrides.acquire
      ? overrides.acquire(relPath)
      : { acquired: true, lock: { holderName: 'Alice' } };
    calls.push(`acquire:${relPath}:${result.acquired}`);
    return result;
  });
  const releaseLockNoCommit = vi.fn(async (_ws: string, _branch: string, relPath: string) => {
    calls.push(`releaseNoCommit:${relPath}`);
  });
  const commitChanges = vi.fn(async (_ws: string, _user: AuthUser, summary: string) => {
    calls.push(`commit:${summary}`);
    overrides.commit?.();
    return { sha: 'abc', summary } as never;
  });
  const workflow = { acquireLock, releaseLockNoCommit, commitChanges } as unknown as IWorkflowService;

  const revertPlan = vi.fn(async (_ws: string, paths: string[]) => ({
    workspaceDir,
    writes: paths
      .filter((p) => p.endsWith('a.md'))
      .map((p) => ({ path: p, content: Buffer.from('baseline\n') })),
    deletes: paths.filter((p) => p.endsWith('added.md')),
  }));
  const diff = { revertPlan } as unknown as IDiffService;
  return { workflow, diff, calls, workspaceDir };
}

describe('rejectPathsLocked', () => {
  let workspaceDir: string | undefined;
  beforeEach(() => {
    workspaceDir = undefined;
  });
  afterEach(async () => {
    if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('acquires EVERY lock before mutating, restores + deletes, then commits ONCE and releases', async () => {
    const h = await makeHarness();
    workspaceDir = h.workspaceDir;

    await rejectPathsLocked(h.workflow, h.diff, WORKSPACE_ID, USER, 'knowledge-base', [
      'knowledge-base/a.md',
      'knowledge-base/added.md',
    ]);

    // All locks first (sorted), ONE commit, then per-path release (no per-file commit).
    expect(h.calls).toEqual([
      'acquire:knowledge-base/a.md:true',
      'acquire:knowledge-base/added.md:true',
      'commit:Revert agent changes (2 files)',
      'releaseNoCommit:knowledge-base/a.md',
      'releaseNoCommit:knowledge-base/added.md',
    ]);
    // Disk: baseline restored, agent-added file gone.
    expect(await fs.readFile(path.join(h.workspaceDir, 'knowledge-base/a.md'), 'utf-8')).toBe('baseline\n');
    await expect(fs.access(path.join(h.workspaceDir, 'knowledge-base/added.md'))).rejects.toThrow();
  });

  it('is a no-op for an empty path list', async () => {
    const h = await makeHarness();
    workspaceDir = h.workspaceDir;
    await expect(
      rejectPathsLocked(h.workflow, h.diff, WORKSPACE_ID, USER, 'knowledge-base', []),
    ).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('fails CLOSED on a contended lock: nothing mutated, nothing committed', async () => {
    const h = await makeHarness({
      acquire: (relPath) =>
        relPath.endsWith('added.md')
          ? { acquired: false, lock: { holderName: 'Bob' } }
          : { acquired: true, lock: { holderName: 'Alice' } },
    });
    workspaceDir = h.workspaceDir;

    await expect(
      rejectPathsLocked(h.workflow, h.diff, WORKSPACE_ID, USER, 'knowledge-base', [
        'knowledge-base/a.md',
        'knowledge-base/added.md',
      ]),
    ).rejects.toBeInstanceOf(WorkflowValidationError);

    // No commit landed and the disk is untouched — the batch is atomic.
    expect(h.calls.some((c) => c.startsWith('commit:'))).toBe(false);
    expect(await fs.readFile(path.join(h.workspaceDir, 'knowledge-base/a.md'), 'utf-8')).toBe('agent version\n');
    await expect(fs.access(path.join(h.workspaceDir, 'knowledge-base/added.md'))).resolves.toBeUndefined();
  }, 15_000);

  it('surfaces a commit failure as a WorkflowValidationError and releases without committing', async () => {
    const h = await makeHarness({
      commit: () => {
        throw new Error('push rejected');
      },
    });
    workspaceDir = h.workspaceDir;

    await expect(
      rejectPathsLocked(h.workflow, h.diff, WORKSPACE_ID, USER, 'knowledge-base', [
        'knowledge-base/a.md',
      ]),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    // Locks were dropped via the no-commit path after the failure.
    expect(h.calls.filter((c) => c.startsWith('releaseNoCommit:'))).toHaveLength(1);
  });
});
