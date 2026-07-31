import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/shared';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { GitService } from '../git.service.js';
import {
  BranchAuthorshipError,
  ProtectedBranchError,
  WorkflowValidationError,
} from '../../workflow.errors.js';

const execFileAsync = promisify(execFile);

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-deleteBranch-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function remoteHasRef(upstream: string, ref: string): Promise<boolean> {
  const out = await gitOut(upstream, ['for-each-ref', `refs/heads/${ref}`, '--format', '%(refname)']);
  return out.length > 0;
}

/**
 * Seeds a bare upstream + a clone with three pushed branches:
 *   - target-company-state (protected, the workspace's HEAD)
 *   - alice/my-draft (owned by alice@example.com)
 *   - bob/other-draft (owned by someone else)
 */
async function seedWorkspace(root: string, workspaceId: string): Promise<{
  upstream: string;
  repo: string;
}> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);

  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'target-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await runGit(seed, ['commit', '--allow-empty', '-m', 'init']);
  await runGit(seed, ['branch', 'alice/my-draft']);
  await runGit(seed, ['branch', 'bob/other-draft']);
  await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/my-draft', 'bob/other-draft']);
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/target-company-state']);

  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  // Realistic production state: the user has worked on alice/my-draft from
  // this workspace at some point, so a local tracking ref exists alongside
  // the remote ref. bob/other-draft is remote-only (alice has never opened
  // it). This forces deleteBranch to handle the "delete both refs" case.
  await runGit(repo, ['branch', 'alice/my-draft', 'origin/alice/my-draft']);
  return { upstream, repo };
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

const ALICE: AuthUser = {
  id: 'u-alice',
  email: 'alice@example.com',
  name: 'Alice Test',
};

const CAROL: AuthUser = {
  id: 'u-carol',
  email: 'carol@example.com',
  name: 'Carol Admin',
};

/**
 * Minimal `IAccessControl` stub. `deleteBranch` only consults `canWrite` with
 * a `relativePath` of `'roles.yaml'` — which the production service already
 * uses as the admin-membership signal. Returns true for that path iff the
 * caller's email is in the admin allowlist; every other method throws so an
 * unexpected dependency surfaces loudly in the test rather than silently
 * passing through.
 */
function fakeAccessControl(adminEmails: string[]): IAccessControl {
  const admins = new Set(adminEmails.map((e) => e.trim().toLowerCase()));
  const notImpl = () => {
    throw new Error('IAccessControl method not stubbed for this test');
  };
  return {
    canWrite: async (_ws, email, relativePath) => {
      if (relativePath !== 'roles.yaml') {
        throw new Error(`unexpected canWrite path "${relativePath}" in deleteBranch test`);
      }
      return admins.has(email.trim().toLowerCase());
    },
    canWriteBatch: async () => notImpl(),
    eligibleWriters: async () => notImpl(),
    eligibleOwners: async () => notImpl(),
    eligibleDownloaders: async () => notImpl(),
    eligibleWriterEmails: async () => notImpl(),
    eligibleOwnerEmails: async () => notImpl(),
    grantSources: async () => notImpl(),
    canDownload: async () => notImpl(),
    canRead: async () => notImpl(),
    canReadBatch: async () => notImpl(),
    eligibleReaders: async () => notImpl(),
    canReadAtRef: async () => notImpl(),
    canOwner: async () => notImpl(),
    invalidate: () => {},
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ groups: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
    referencesToRole: async () => [],
    canWriteAtRef: async () => null,
    canWriteBatchAtRef: async () => null,
    eligibleWritersAtRef: async () => null,
    eligibleWritersForPathsAtRef: async () => null,
  };
}

describe('GitService.deleteBranch — authorship + remote delete', () => {
  let root: string;
  const workspaceId = 'target-company-state';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function makeService(): GitService {
    return new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );
  }

  it('lets the author delete their own draft — removes both local and remote refs', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = makeService();

    await svc.deleteBranch(workspaceId, 'alice/my-draft', ALICE);

    // Local ref gone — `for-each-ref` returns empty when ref is missing
    const localRefs = await gitOut(
      path.join(root, workspaceId, 'knowledge-base'),
      ['for-each-ref', 'refs/heads/alice/my-draft', '--format', '%(refname)'],
    );
    expect(localRefs).toBe('');

    // Remote ref ALSO gone — this is the new behaviour, the original
    // implementation only deleted locally and left the orphan on origin.
    expect(await remoteHasRef(upstream, 'alice/my-draft')).toBe(false);
  });

  it("refuses when the user isn't the author — leaves the remote ref intact", async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = makeService();

    await expect(
      svc.deleteBranch(workspaceId, 'bob/other-draft', ALICE),
    ).rejects.toBeInstanceOf(BranchAuthorshipError);

    // Refused delete must not push to origin — bob's draft must still be
    // there for him.
    expect(await remoteHasRef(upstream, 'bob/other-draft')).toBe(true);
  });

  it('refuses to delete a branch with no recognisable author prefix', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    // Create a `fix/...` style branch (no email prefix) locally + push.
    await runGit(repo, ['branch', 'fix/no-author']);
    await runGit(repo, ['push', 'origin', 'fix/no-author']);

    const svc = makeService();
    await expect(
      svc.deleteBranch(workspaceId, 'fix/no-author', ALICE),
    ).rejects.toBeInstanceOf(BranchAuthorshipError);
  });

  it('still rejects protected branches with ProtectedBranchError (regression guard)', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = makeService();

    await expect(
      svc.deleteBranch(workspaceId, 'target-company-state', ALICE),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
  });

  it('still rejects deleting the currently-checked-out branch (regression guard)', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    // Switch to alice's draft so it's the checked-out branch.
    await runGit(repo, ['checkout', 'alice/my-draft']);

    const svc = makeService();
    await expect(
      svc.deleteBranch(workspaceId, 'alice/my-draft', ALICE),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('onlyIfNoRemote: true bypasses the authorship check (orphan-tidy-up path stays open)', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    // Simulate an orphan: branch exists locally but its remote counterpart
    // was already pruned (e.g. PR merged + remote head deleted on GitHub).
    await runGit(repo, ['branch', 'someone-else/orphan']);
    // Don't push it — so origin never had it.

    const svc = makeService();
    await svc.deleteBranch(workspaceId, 'someone-else/orphan', ALICE, { onlyIfNoRemote: true });

    const localRefs = await gitOut(repo, [
      'for-each-ref', 'refs/heads/someone-else/orphan', '--format', '%(refname)',
    ]);
    expect(localRefs).toBe('');
    // Origin never had it; sanity check the workspace clone's remote cache too.
    expect(await remoteHasRef(upstream, 'someone-else/orphan')).toBe(false);
  });

  it('refuses orphan delete when remote still has the ref (onlyIfNoRemote contract)', async () => {
    // Regression: even with onlyIfNoRemote, if origin still has the ref the
    // delete is refused — preserves the existing safety property.
    await seedWorkspace(root, workspaceId);
    const svc = makeService();

    await expect(
      svc.deleteBranch(workspaceId, 'alice/my-draft', ALICE, { onlyIfNoRemote: true }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  // Admin-can-delete: when the user is in the `Admin` role per `roles.yaml`
  // (detected via canWrite on that file — its existing source of truth), the
  // gate opens for any non-protected, non-current branch, including teammates'
  // drafts and unprefixed CLI branches with no recognisable author.
  function makeServiceWithAccess(ac: IAccessControl): GitService {
    return new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
      undefined,
      ac,
    );
  }

  it("lets an admin delete another user's draft — removes both local and remote refs", async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    // Realistic state: carol has opened bob's draft from this workspace at
    // some point, so a local tracking ref exists. deleteBranch must clean
    // both sides.
    await runGit(repo, ['branch', 'bob/other-draft', 'origin/bob/other-draft']);
    const svc = makeServiceWithAccess(fakeAccessControl([CAROL.email]));

    await svc.deleteBranch(workspaceId, 'bob/other-draft', CAROL);

    const localRefs = await gitOut(repo, [
      'for-each-ref', 'refs/heads/bob/other-draft', '--format', '%(refname)',
    ]);
    expect(localRefs).toBe('');
    expect(await remoteHasRef(upstream, 'bob/other-draft')).toBe(false);
  });

  it('lets an admin delete an unprefixed CLI branch (no recognisable author)', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    await runGit(repo, ['branch', 'fix/no-author']);
    await runGit(repo, ['push', 'origin', 'fix/no-author']);

    const svc = makeServiceWithAccess(fakeAccessControl([CAROL.email]));
    await svc.deleteBranch(workspaceId, 'fix/no-author', CAROL);

    expect(await remoteHasRef(upstream, 'fix/no-author')).toBe(false);
  });

  it("still refuses a non-admin non-author — the gate didn't widen for everyone", async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    // Alice is not admin and not bob's author → must still reject.
    const svc = makeServiceWithAccess(fakeAccessControl([CAROL.email]));

    await expect(
      svc.deleteBranch(workspaceId, 'bob/other-draft', ALICE),
    ).rejects.toBeInstanceOf(BranchAuthorshipError);
    expect(await remoteHasRef(upstream, 'bob/other-draft')).toBe(true);
  });

  it('admin power does NOT extend to protected branches', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = makeServiceWithAccess(fakeAccessControl([CAROL.email]));

    await expect(
      svc.deleteBranch(workspaceId, 'target-company-state', CAROL),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
  });
});
