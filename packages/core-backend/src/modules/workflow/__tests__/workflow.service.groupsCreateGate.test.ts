import { describe, it, expect, vi, beforeAll } from 'vitest';
import { configureBranchModel, type AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';

/**
 * The write gate's new-folder carve-out, at the point it is actually enforced:
 * lock acquisition on a protected branch.
 *
 * `Groups/` is admin-write at the repo root, but the product says making a
 * group makes you the one who runs it, and an ungrouped skill is "owned by
 * whoever made it". Both are folders one segment under `Groups/`, and both are
 * created by writing a file into a folder that does not exist yet — which the
 * root rule refused, for everyone who is not an Admin. These tests pin the
 * exemption open and, more importantly, pin its EDGES shut: the moment the
 * folder exists, the ordinary rules are back.
 */

const PROTECTED = 'target-company-state';

beforeAll(() => {
  // `assertCanWriteAtPath` only runs on a protected branch, and the branch
  // model is boot-time configuration that a unit test has to supply itself.
  configureBranchModel({ defaultBranch: PROTECTED, protectedBranches: [PROTECTED] });
});

function makeUser(): AuthUser {
  return { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera' };
}

/**
 * An access tree that refuses this user everything — the position a non-admin
 * is in anywhere under `Groups/`. `existing` is what the ref already carries.
 */
function makeAccessControl(existing: string[]) {
  return {
    canWriteBatchAtRef: vi.fn(async (_ws: string, _ref: string, _email: string, paths: string[]) =>
      new Map(paths.map((p) => [p, false])),
    ),
    existsAtRef: vi.fn(async (_ws: string, _ref: string, p: string) => existing.includes(p)),
    eligibleWritersAtRef: vi.fn().mockResolvedValue({ roles: ['Admin'], users: [] }),
  } as unknown as IAccessControl;
}

function makeService(access: IAccessControl) {
  const fileLocks = {
    acquire: vi.fn().mockResolvedValue({
      acquired: true,
      lock: {
        branch: PROTECTED,
        path: 'p',
        holderUserId: 'u1',
        holderName: 'Juan Viera',
        acquiredAt: '',
        lastHeartbeatAt: '',
        expiresAt: '',
      },
    }),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as FileLockService;

  const svc = new WorkflowService(
    {} as unknown as Database,
    { status: vi.fn() } as unknown as GitService,
    {} as unknown as PullRequestService,
    {} as unknown as IReviewWorkflowService,
    { getWorkspacePath: vi.fn().mockResolvedValue('/tmp/ws') } as unknown as WorkspaceService,
    access,
    fileLocks,
    { enqueue: vi.fn() } as unknown as PendingCommitsService,
    'knowledge-base',
  );
  return { svc, fileLocks };
}

/** Paths arrive workspace-relative; the gate strips the KB dir itself. */
const ws = (repoRelative: string) => `knowledge-base/${repoRelative}`;

describe('the write gate lets you create a new folder under Groups/', () => {
  it('admits the first file in a brand-new group folder', async () => {
    const { svc, fileLocks } = makeService(makeAccessControl(['Groups']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/Design/access.md'), makeUser()),
    ).resolves.toMatchObject({ acquired: true });
    expect(fileLocks.acquire).toHaveBeenCalled();
  });

  it('admits an ungrouped skill — the same shape, one segment down', async () => {
    // `Groups/<skill>/SKILL.md` sits at exactly the depth `Groups/<Group>/…`
    // does, which is why one carve-out covers both.
    const { svc } = makeService(makeAccessControl(['Groups']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/weekly-report/SKILL.md'), makeUser()),
    ).resolves.toMatchObject({ acquired: true });
  });

  it('admits the .gitkeep the directory route writes', async () => {
    const { svc } = makeService(makeAccessControl(['Groups']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/Design/.gitkeep'), makeUser()),
    ).resolves.toMatchObject({ acquired: true });
  });
});

describe('and nothing else', () => {
  it('refuses a folder that already exists — no writing into a live group', async () => {
    // The whole safety argument: an existing folder has content, rules and an
    // owner, so it is never reachable through the carve-out.
    const { svc, fileLocks } = makeService(makeAccessControl(['Groups', 'Groups/GTM']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/GTM/rfi/SKILL.md'), makeUser()),
    ).rejects.toThrow(/permission to write/);
    expect(fileLocks.acquire).not.toHaveBeenCalled();
  });

  it('refuses a file dropped directly into Groups/', async () => {
    // Two segments, not three: this creates no new folder, so it seeds no
    // access.md and would sit in the admin-only root ungoverned.
    const { svc } = makeService(makeAccessControl(['Groups']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/loose.md'), makeUser()),
    ).rejects.toThrow(/permission to write/);
  });

  it('refuses a new folder anywhere else in the repo', async () => {
    const { svc } = makeService(makeAccessControl(['Groups', 'KnowledgeBase']));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('KnowledgeBase/Secret/plan.md'), makeUser()),
    ).rejects.toThrow(/permission to write/);
  });

  it('refuses when Groups/ itself is not there — a ref that will not resolve', async () => {
    // `existsAtRef` cannot tell "missing path" from "missing ref", so the
    // carve-out corroborates the absence by requiring the PARENT. Without that
    // guard an unresolvable ref would report every path absent and wave
    // everything through.
    const { svc } = makeService(makeAccessControl([]));
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/Design/access.md'), makeUser()),
    ).rejects.toThrow(/permission to write/);
  });

  it('leaves a draft branch alone — the gate never ran there to begin with', async () => {
    const access = makeAccessControl(['Groups', 'Groups/GTM']);
    const { svc } = makeService(access);
    await expect(
      svc.acquireLock('w1', 'suggestions/juan/rfi', ws('Groups/GTM/rfi/SKILL.md'), makeUser()),
    ).resolves.toMatchObject({ acquired: true });
    expect(access.existsAtRef).not.toHaveBeenCalled();
  });
});

describe('a writer is unaffected', () => {
  it('never reaches the carve-out when the access tree already says yes', async () => {
    const access = {
      canWriteBatchAtRef: vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
        new Map(paths.map((p) => [p, true])),
      ),
      existsAtRef: vi.fn(),
      eligibleWritersAtRef: vi.fn(),
    } as unknown as IAccessControl;
    const { svc } = makeService(access);
    await expect(
      svc.acquireLock('w1', PROTECTED, ws('Groups/GTM/rfi/SKILL.md'), makeUser()),
    ).resolves.toMatchObject({ acquired: true });
    expect(access.existsAtRef).not.toHaveBeenCalled();
  });
});
