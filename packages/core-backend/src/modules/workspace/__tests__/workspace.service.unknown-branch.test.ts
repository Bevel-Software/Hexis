import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

const execFileAsync = promisify(execFile);

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

/**
 * Origin answering "I have no such ref" is ONE git failure with two stories,
 * and which one the platform tells depends on whether it has ever heard of
 * the name. A branch it cloned or listed is a branch that was DELETED (410).
 * A name nothing has ever shown it is not a branch at all (404) — telling
 * that caller their typo "no longer exists on the remote" states, falsely,
 * that it once did.
 */
describe('WorkspaceService — a branch origin does not have', () => {
  let root: string;
  let workspacesRoot: string;
  let upstream: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-unknown-branch-'));
    workspacesRoot = path.join(root, 'workspaces');
    await fs.mkdir(workspacesRoot, { recursive: true });

    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);

    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', 'target-company-state']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-target', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init target']);
    await runGit(seed, ['checkout', '-b', 'alice/draft']);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-draft', 'utf-8');
    await runGit(seed, ['commit', '-am', 'draft change']);
    await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/draft']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Delete a branch on the git host, as a teammate or a merge would. */
  const deleteOnHost = (branch: string): Promise<void> => runGit(upstream, ['branch', '-D', branch]);

  const service = (repoUrl = upstream): WorkspaceService =>
    new WorkspaceService(workspacesRoot, repoUrl, testKbContext(), new NodeFs());

  it('a name nothing has ever cloned or listed is a 404 that names only the branch', async () => {
    const svc = service();

    await expect(svc.getOrCreateForBranch('nobody/never-made-this')).rejects.toMatchObject({
      name: 'BranchNotFoundError',
      status: 404,
      message: 'There is no branch named nobody/never-made-this.',
      payload: { kind: 'branch-not-found', branch: 'nobody/never-made-this' },
    });
  });

  it('a name a listing showed us, and origin no longer has, stays a 410', async () => {
    const svc = service();
    // What the branch selector saw while the draft still existed.
    svc.noteBranchesListed(['target-company-state', 'alice/draft']);
    await deleteOnHost('alice/draft');

    await expect(svc.getOrCreateForBranch('alice/draft')).rejects.toMatchObject({
      name: 'RemoteBranchGoneError',
      status: 410,
      payload: { kind: 'remote-branch-gone', branch: 'alice/draft' },
    });
  });

  it('a branch it had cloned, deleted on the host and swept off disk, is still a 410', async () => {
    const svc = service();
    // The whole life of a deleted draft: listed, opened (cloned), deleted on
    // the host, its stale clone retired by the sync — and then someone opens
    // an old link to it.
    svc.noteBranchesListed(['target-company-state', 'alice/draft']);
    await svc.getOrCreateForBranch('alice/draft');
    await deleteOnHost('alice/draft');
    await svc.deleteWorkspace(workspaceIdForBranch('alice/draft'));

    await expect(svc.getOrCreateForBranch('alice/draft')).rejects.toMatchObject({
      name: 'RemoteBranchGoneError',
      status: 410,
    });
  });

  it('a branch opened by link and never listed is still a 410 once its clone is swept', async () => {
    const svc = service();
    // No listing ever happened: someone followed a direct link, the branch
    // cloned, the host deleted it, and the sweep retired the stale clone.
    // The clone was the platform hearing of the name, and losing the clone
    // must not lose that.
    await svc.getOrCreateForBranch('alice/draft');
    await deleteOnHost('alice/draft');
    await svc.deleteWorkspace(workspaceIdForBranch('alice/draft'));

    await expect(svc.getOrCreateForBranch('alice/draft')).rejects.toMatchObject({
      name: 'RemoteBranchGoneError',
      status: 410,
    });
  });

  it('after a restart, a deleted branch with no clone left on disk reads as never known', async () => {
    const svc = service();
    svc.noteBranchesListed(['target-company-state', 'alice/draft']);
    await svc.getOrCreateForBranch('alice/draft');
    await deleteOnHost('alice/draft');
    await svc.deleteWorkspace(workspaceIdForBranch('alice/draft'));

    // The other half of the restart story: the clone is gone from disk and
    // the listing memory died with the process, so nothing anywhere has ever
    // shown this instance the name. 404 is then the honest answer — the
    // platform is not claiming the branch never existed, only that it knows
    // of no such branch.
    await expect(service().getOrCreateForBranch('alice/draft')).rejects.toMatchObject({
      name: 'BranchNotFoundError',
      status: 404,
      message: 'There is no branch named alice/draft.',
    });
  });

  it('a clone probe that cannot be read is our failure, not a branch that never existed', async () => {
    const svc = service();
    await deleteOnHost('alice/draft');

    // The probe for a clone on disk hits a permission fault rather than an
    // empty directory. "I could not look" is not "there is no such branch":
    // answering 404 here would blame the user's link for our broken storage.
    const realAccess = fs.access.bind(fs);
    const probePath = path.join(workspacesRoot, workspaceIdForBranch('alice/draft'), 'knowledge-base', '.git');
    vi.spyOn(fs, 'access').mockImplementation(async (p: Parameters<typeof fs.access>[0], mode?: number) => {
      if (String(p) === probePath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realAccess(p, mode);
    });

    try {
      const err = await svc.getOrCreateForBranch('alice/draft').catch((e: unknown) => e);
      expect((err as { name?: string }).name).not.toBe('BranchNotFoundError');
      expect((err as { status?: number }).status).toBeUndefined();
      expect((err as Error).message).toContain('Failed to clone process map');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a clone on disk answers for its branch with no listing in memory at all', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/draft');
    await deleteOnHost('alice/draft');

    // A fresh instance stands in for a restarted process: nothing listed,
    // nothing registered, only the clone left on disk. That clone is the
    // record — the branch opens, and no 404 is anywhere near this path.
    await expect(service().getOrCreateForBranch('alice/draft')).resolves.toMatchObject({
      id: workspaceIdForBranch('alice/draft'),
    });
  });

  it('a branch that exists still bootstraps — neither error is on the happy path', async () => {
    const svc = service();
    const info = await svc.getOrCreateForBranch('alice/draft');
    const repo = path.join(info.absolutePath, 'knowledge-base');
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-draft');
  });

  it('an unreachable remote is neither 404 nor 410 — it is our failure, not the branch’s', async () => {
    const svc = service(path.join(root, 'no-such-repo.git'));

    const err = await svc.getOrCreateForBranch('alice/draft').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // No domain status at all: the routes answer 500 and the operator reads
    // the log, rather than the user being told their branch does not exist.
    expect((err as { status?: number }).status).toBeUndefined();
    expect((err as Error).message).toContain('Failed to clone process map');
  });
});
