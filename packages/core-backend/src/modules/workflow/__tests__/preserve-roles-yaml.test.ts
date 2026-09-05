import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { FileLockService } from '../file-lock.service.js';
import { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowService } from '../workflow.service.js';
import type { Database } from '../../database/connection.js';
import { RolesYamlPreservationError } from '../../../shared/domain-errors.js';

/**
 * Focused tests for the roles.yaml-preservation guard inside
 * `mergeChangeRequest`. The security property: a change request can NEVER carry
 * a roles.yaml change across its merge — if the CR's roles.yaml differs from the
 * base branch's, the base version is restored on the SOURCE branch (commit +
 * push) before the merge fires, so the merged diff has no roles.yaml change.
 * roles.yaml is mutable only via the admin Roles & Members surface.
 */

const KB_DIR = 'knowledge-base';
const BASE = 'current-company-state';
const HEAD = 'mallory/escalate';
const USER = { id: 'u-mallory', email: 'mallory@x.com', name: 'Mallory' };
const BASE_ROLES = 'roles:\n  Admin:\n    - admin@x.com\n';
const ATTACKER_ROLES = 'roles:\n  Admin:\n    - admin@x.com\n    - mallory@x.com\n';

function noopAccessControl(): IAccessControl {
  return {
    canWrite: vi.fn(), canWriteBatch: vi.fn(), canRead: vi.fn(), canReadBatch: vi.fn(),
    eligibleReaders: vi.fn(), canReadAtRef: vi.fn(),
    canDownload: vi.fn(), canOwner: vi.fn(), eligibleOwners: vi.fn(), eligibleDownloaders: vi.fn(),
    eligibleWriters: vi.fn(), eligibleWriterEmails: vi.fn(), eligibleOwnerEmails: vi.fn(),
    grantSources: vi.fn(), invalidate: vi.fn(), findEmailByHash: vi.fn(), kbPrincipals: vi.fn(),
    validateRolesYaml: vi.fn(), canWriteAtRef: vi.fn(),
    canWriteBatchAtRef: vi.fn(), eligibleWritersAtRef: vi.fn(), eligibleWritersForPathsAtRef: vi.fn(),
  } as unknown as IAccessControl;
}

describe('mergeChangeRequest — roles.yaml preservation guard', () => {
  let root: string;
  let headRepoDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'preserve-roles-'));
    // The source branch's per-branch workspace, laid out like the real one:
    // <root>/<encoded-branch>/<kbDir>/roles.yaml
    headRepoDir = path.join(root, encodeURIComponent(HEAD), KB_DIR);
    await fs.mkdir(headRepoDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeSvc(opts: {
    headRoles: string | null;
    baseRoles: string | null;
    commitFileResult?: unknown;
    pushImpl?: () => Promise<void>;
    getPrResult?: { branch: string; base: string } | null;
    getPrDetailResult?: unknown;
    // Simulate a concurrent editor already holding the roles.yaml lock. When set,
    // acquire returns { acquired: false } and the restore must fail-closed.
    lockHeldBy?: string;
  }) {
    const ac = noopAccessControl();
    const reviewWorkflow = {
      mergePr: vi.fn().mockResolvedValue({ prNumber: 1, sha: 'merged', mergedAt: 't' }),
    } as unknown as IReviewWorkflowService;

    const workspaceService = {
      getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch) })),
      getWorkspacePath: vi.fn(async (id: string) => path.join(root, id)),
    } as unknown as WorkspaceService;

    const git = {
      fetch: vi.fn().mockResolvedValue(undefined),
      pull: vi.fn().mockResolvedValue({ treeChanged: true }),
      // Resolve roles.yaml at origin/<ref> from the per-test content.
      readFileAtRef: vi.fn(async (_ws: string, ref: string) =>
        ref === `origin/${BASE}` ? opts.baseRoles : ref === `origin/${HEAD}` ? opts.headRoles : null,
      ),
      commitFile: vi.fn().mockResolvedValue(
        'commitFileResult' in opts ? opts.commitFileResult : { sha: 'preserve-sha' },
      ),
      push: vi.fn(opts.pushImpl ?? (async () => undefined)),
    } as unknown as GitService;

    const prs = {
      getPr: vi.fn().mockResolvedValue(
        opts.getPrResult === undefined ? { branch: HEAD, base: BASE } : opts.getPrResult,
      ),
      // After a preservation commit, mergeChangeRequest refreshes the CR detail
      // (fresh headSha + approvals) before merging. Deterministic stub.
      getPrDetail: vi.fn().mockResolvedValue(
        'getPrDetailResult' in opts
          ? opts.getPrDetailResult
          : { headSha: 'sha-after-preserve', approvals: [], state: 'open', title: 'Title', base: BASE },
      ),
      invalidateDetailCache: vi.fn(),
    } as unknown as PullRequestService;

    // The restore holds the SAME per-file lock a concurrent editor would (keyed
    // on `<kbDir>/roles.yaml`), so a live edit can't race the neutralisation.
    const acquire = vi.fn(async () =>
      opts.lockHeldBy
        ? { acquired: false as const, lock: { holderName: opts.lockHeldBy } }
        : { acquired: true as const, lock: { holderName: USER.name } },
    );
    const release = vi.fn(async () => undefined);
    const fileLocks = { acquire, release } as unknown as FileLockService;

    const svc = new WorkflowService(
      {} as unknown as Database,
      git, prs, reviewWorkflow, workspaceService, ac,
      fileLocks, {} as unknown as PendingCommitsService,
      KB_DIR,
    );
    // Conflicts are now surfaced by the local merge inside `reviewWorkflow.mergePr`
    // (mocked to resolve here), so there's no provider "mergeable" pre-check to stub.
    return { svc, git, prs, reviewWorkflow, fileLocks };
  }

  async function merge(svc: WorkflowService) {
    return svc.mergeChangeRequest(1, USER, 'sha', [], 'open', 'Title', BASE, 'w1', { bypass: false });
  }

  it('no-ops when the CR does not change roles.yaml (identical content)', async () => {
    const { svc, git, reviewWorkflow } = makeSvc({ headRoles: BASE_ROLES, baseRoles: BASE_ROLES });
    await merge(svc);
    // No restore write/commit/push, but the merge still proceeds.
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(reviewWorkflow.mergePr).toHaveBeenCalledTimes(1);
  });

  it('no-ops when neither base nor head has a roles.yaml (both absent)', async () => {
    const { svc, git, reviewWorkflow } = makeSvc({ headRoles: null, baseRoles: null });
    await merge(svc);
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(reviewWorkflow.mergePr).toHaveBeenCalledTimes(1);
  });

  it('restores base roles.yaml on the source branch when the CR changed it (escalation guard)', async () => {
    // Seed the source workspace with the ATTACKER version, as it would be after
    // reset-to-origin of the CR head.
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, git, reviewWorkflow, fileLocks } = makeSvc({ headRoles: ATTACKER_ROLES, baseRoles: BASE_ROLES });

    await merge(svc);

    // The restore ran under the SAME per-file lock a human/agent editor uses,
    // keyed on the workspace-relative `<kbDir>/roles.yaml` path on the SOURCE
    // branch — so a concurrent edit can't slip past the neutralisation.
    expect(fileLocks.acquire).toHaveBeenCalledWith(
      encodeURIComponent(HEAD),
      HEAD,
      `${KB_DIR}/roles.yaml`,
      USER,
    );
    // The working-tree roles.yaml was rewritten back to the BASE version...
    const onDisk = await fs.readFile(path.join(headRepoDir, 'roles.yaml'), 'utf-8');
    expect(onDisk).toBe(BASE_ROLES);
    // ...committed (single-path, not `add -A`) + pushed on the SOURCE branch...
    expect(git.commitFile).toHaveBeenCalledWith(
      encodeURIComponent(HEAD),
      USER,
      'roles.yaml',
      expect.stringMatching(/preserve official roles\.yaml/i),
      true,
    );
    expect(git.push).toHaveBeenCalledWith(encodeURIComponent(HEAD), USER);
    // ...the lock was released after the inline commit...
    expect(fileLocks.release).toHaveBeenCalledWith(
      encodeURIComponent(HEAD),
      HEAD,
      `${KB_DIR}/roles.yaml`,
      USER,
    );
    // ...and only THEN does the merge proceed.
    expect(reviewWorkflow.mergePr).toHaveBeenCalledTimes(1);
  });

  it('ABORTS the merge when roles.yaml is locked by a concurrent editor (fail-closed)', async () => {
    // A same-branch editor holds the roles.yaml lock. The restore must NOT race
    // it — acquire returns { acquired: false }, so the merge aborts rather than
    // writing over (or being overwritten by) the live edit.
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, git, reviewWorkflow } = makeSvc({
      headRoles: ATTACKER_ROLES,
      baseRoles: BASE_ROLES,
      lockHeldBy: 'Someone Else',
    });

    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    // Nothing was written/committed/pushed, and the merge never ran.
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
    // The on-disk attacker version is untouched — the lock holder's edit stands.
    const onDisk = await fs.readFile(path.join(headRepoDir, 'roles.yaml'), 'utf-8');
    expect(onDisk).toBe(ATTACKER_ROLES);
  });

  it('restores by deleting roles.yaml when the base branch has none', async () => {
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, git } = makeSvc({ headRoles: ATTACKER_ROLES, baseRoles: null });

    await merge(svc);

    await expect(fs.access(path.join(headRepoDir, 'roles.yaml'))).rejects.toThrow();
    expect(git.commitFile).toHaveBeenCalled();
    expect(git.push).toHaveBeenCalled();
  });

  it('ABORTS the merge (RolesYamlPreservationError) if the restore push fails', async () => {
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, reviewWorkflow } = makeSvc({
      headRoles: ATTACKER_ROLES,
      baseRoles: BASE_ROLES,
      pushImpl: async () => { throw new Error('push rejected: non-fast-forward'); },
    });

    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    // Fail-closed: the merge must NOT have run.
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
  });

  it('ABORTS the merge if the CR (PR) cannot be resolved', async () => {
    const { svc, reviewWorkflow } = makeSvc({ headRoles: BASE_ROLES, baseRoles: BASE_ROLES, getPrResult: null });
    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
  });

  it('refreshes the merge inputs from the updated PR head after a preservation commit', async () => {
    // The restore commit advances the source head, so the caller's headSha/approvals
    // (resolved pre-preservation) go stale. mergeChangeRequest must re-resolve them
    // from the live PR before merging, not forward the originals.
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, prs, reviewWorkflow } = makeSvc({ headRoles: ATTACKER_ROLES, baseRoles: BASE_ROLES });

    await merge(svc);

    expect(prs.getPrDetail).toHaveBeenCalledWith(1, expect.objectContaining({ fresh: true }));
    // mergePr is called with the REFRESHED head sha, not the original 'sha'.
    expect(reviewWorkflow.mergePr).toHaveBeenCalledWith(
      1, USER, 'sha-after-preserve', [], 'open', 'Title', BASE, 'w1', { bypass: false },
    );
  });

  it('does NOT refresh (keeps the caller inputs) when the CR does not touch roles.yaml', async () => {
    // No preservation commit → no head advance → nothing to refresh; the original
    // headSha/approvals flow straight through.
    const { svc, prs, reviewWorkflow } = makeSvc({ headRoles: BASE_ROLES, baseRoles: BASE_ROLES });
    await merge(svc);
    expect(prs.getPrDetail).not.toHaveBeenCalled();
    expect(reviewWorkflow.mergePr).toHaveBeenCalledWith(
      1, USER, 'sha', [], 'open', 'Title', BASE, 'w1', { bypass: false },
    );
  });

  it('ABORTS the merge when the restore produces no commit while origin still diverges (fail-closed)', async () => {
    // origin/base vs origin/head differ (restore required), but commitFile is a
    // no-op — e.g. the local checkout is out of sync and already matched base.
    // origin/head would still carry the divergent roles.yaml, so this must fail
    // closed rather than return "nothing to do".
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), BASE_ROLES);
    const { svc, git, reviewWorkflow } = makeSvc({
      headRoles: ATTACKER_ROLES,
      baseRoles: BASE_ROLES,
      commitFileResult: null,
    });
    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    expect(git.push).not.toHaveBeenCalled();
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
  });

  it('ABORTS the merge when the post-preservation CR detail cannot be reloaded (fail-closed)', async () => {
    // After a preservation commit advances the head, the gate inputs must be
    // re-resolved. If the fresh detail is unavailable, abort — never fall back to
    // the stale headSha/approvals.
    await fs.writeFile(path.join(headRepoDir, 'roles.yaml'), ATTACKER_ROLES);
    const { svc, reviewWorkflow } = makeSvc({
      headRoles: ATTACKER_ROLES,
      baseRoles: BASE_ROLES,
      getPrDetailResult: null,
    });
    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
  });

  it('ABORTS the merge when reading roles.yaml fails for a non-absence reason (fail-closed)', async () => {
    // readFileAtRef now rethrows real git errors (only true absence maps to null),
    // so a fatal read must surface as RolesYamlPreservationError — never be mistaken
    // for "roles.yaml absent" and waved through.
    const { svc, git, reviewWorkflow } = makeSvc({ headRoles: ATTACKER_ROLES, baseRoles: BASE_ROLES });
    (git.readFileAtRef as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('git show failed: fatal: unable to read tree object'),
    );
    await expect(merge(svc)).rejects.toBeInstanceOf(RolesYamlPreservationError);
    expect(reviewWorkflow.mergePr).not.toHaveBeenCalled();
  });
});
