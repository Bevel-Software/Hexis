import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';

const execFileAsync = promisify(execFile);

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-createBranch-'));
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

/**
 * Seeds a bare upstream + a single clone on `target-company-state`, mirroring
 * the prod layout: `<root>/<workspaceId>/knowledge-base`. The clone has
 * `origin` wired to the bare upstream so any push from `GitService` can land
 * on a real remote that downstream `git clone` / `ls-remote` can observe.
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
  await runGit(seed, ['push', 'origin', 'target-company-state']);
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/target-company-state']);

  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
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

describe('GitService.createBranch', () => {
  let root: string;
  const workspaceId = 'target-company-state';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Bug 1: the per-branch workspace bootstrap (`WorkspaceService.getOrCreateForBranch`)
  // clones with `git clone -b <name>` from origin, so the new draft's ref MUST exist on
  // origin before any user navigates to its URL. If `createBranch` leaves the branch
  // local-only, the next workspace bootstrap fails with "Remote branch not found in
  // upstream origin" and the user lands on a dead URL.
  it('publishes the new draft to origin so a fresh clone -b <name> can find it', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const info = await svc.createBranch(workspaceId, 'alice/new-draft');

    // The draft must be on origin — `BranchInfo.hasRemote` is the contract
    // signalling to the workspace-bootstrap path that the ref is reachable.
    expect(info.hasRemote).toBe(true);

    // And `git ls-remote` against the bare upstream must actually see it,
    // because the bootstrap shells out to `git clone -b <name>` against
    // exactly this remote — assertion-on-disk, not just on the return value.
    const lsRemote = await gitOut(path.join(root, workspaceId, 'knowledge-base'), [
      'ls-remote', '--heads', upstream, 'alice/new-draft',
    ]);
    expect(lsRemote).toMatch(/refs\/heads\/alice\/new-draft$/);

    // End-to-end safeguard: a fresh, independent clone with `-b <name>` must
    // succeed. This is the exact command `cloneProcessMapForBranch` runs when
    // the user navigates to the new draft's URL — if it fails here, Bug 1 is
    // still live regardless of what `hasRemote` says.
    const newWorkspace = path.join(root, 'new-workspace');
    await fs.mkdir(newWorkspace);
    await runGit(root, ['clone', '-b', 'alice/new-draft', upstream, path.join(newWorkspace, 'knowledge-base')]);
    const checkedOut = await gitOut(
      path.join(newWorkspace, 'knowledge-base'),
      ['rev-parse', '--abbrev-ref', 'HEAD'],
    );
    expect(checkedOut).toBe('alice/new-draft');
  });

  // Regression: createBranch must NOT leave a local `refs/heads/<name>` in the
  // creating workspace's clone. Under the per-branch workspace model the new
  // draft lives in its own workspace; a stray local head here survives
  // `fetch --prune` after the draft is deleted from another workspace, so it
  // resurfaces in the picker as a phantom orphan that "won't delete". The draft
  // must exist only as a remote-tracking ref in this clone.
  it('leaves no local head in the creating clone — only a remote-tracking ref', async () => {
    await seedWorkspace(root, workspaceId);
    const repo = path.join(root, workspaceId, 'knowledge-base');
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await svc.createBranch(workspaceId, 'alice/new-draft');

    // No local head for the draft (the bug left one here).
    const localHead = await gitOut(repo, [
      'for-each-ref', '--format=%(refname)', 'refs/heads/alice/new-draft',
    ]);
    expect(localHead).toBe('');

    // But it IS reachable as a remote-tracking ref, so the picker still lists it
    // and `fetch --prune` can clean it up when origin drops it.
    const remoteTracking = await gitOut(repo, [
      'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/alice/new-draft',
    ]);
    expect(remoteTracking).toBe('refs/remotes/origin/alice/new-draft');
  });
});
