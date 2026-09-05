import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { RemoteBranchGoneError } from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * `syncFromRemote` against real repositories: what it reports about the clone
 * before and after, the paths it names, an upstream that has no commits yet,
 * and a branch the host has deleted.
 */
const BRANCH = 'target-company-state';

async function bareUpstream(root: string, withCommit: boolean): Promise<string> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', BRANCH, upstream]);
  if (withCommit) {
    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', BRANCH]);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await fs.writeFile(path.join(seed, 'a.md'), 'a\n');
    await fs.writeFile(path.join(seed, 'old name.md'), 'same content that survives a rename\n');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init']);
    await runGit(seed, ['push', 'origin', BRANCH]);
  }
  await runGit(upstream, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
  return upstream;
}

async function cloneWorkspace(root: string, upstream: string, workspaceId: string, branch = BRANCH) {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['-c', 'core.autocrlf=false', 'clone', '-b', branch, upstream, repo]);
  await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
  await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  return { workspaceDir, repo };
}

/** Land one commit on origin from a second clone; returns the paths it touched. */
async function pushFromElsewhere(root: string, upstream: string, edit: (dir: string) => Promise<void>, branch = BRANCH) {
  const pusher = path.join(root, `.pusher-${Math.random().toString(36).slice(2)}`);
  await runGit(root, ['-c', 'core.autocrlf=false', 'clone', '-b', branch, upstream, pusher]);
  await runGit(pusher, ['config', 'user.email', 'other@bevel.test']);
  await runGit(pusher, ['config', 'user.name', 'Other']);
  await edit(pusher);
  await runGit(pusher, ['add', '-A']);
  await runGit(pusher, ['commit', '-m', 'from origin']);
  await runGit(pusher, ['push', 'origin', branch]);
}

describe('GitService.syncFromRemote', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-sync-'));
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it('reports where HEAD was and is, that the tree changed, and every path including both ends of a rename', async () => {
    const upstream = await bareUpstream(root, true);
    const { workspaceDir, repo } = await cloneWorkspace(root, upstream, 'ws');
    const before = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();
    await pushFromElsewhere(root, upstream, async (dir) => {
      await fs.writeFile(path.join(dir, 'a.md'), 'a changed\n');
      await fs.writeFile(path.join(dir, 'b.md'), 'b\n');
      await fs.rename(path.join(dir, 'old name.md'), path.join(dir, 'new name.md'));
    });
    const git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');

    const r = await git.syncFromRemote('ws');
    expect(r.before).toBe(before);
    expect(r.after).toBe((await gitOut(repo, ['rev-parse', 'HEAD'])).trim());
    expect(r.after).not.toBe(before);
    expect(r.treeChanged).toBe(true);
    expect([...r.changedPaths].sort()).toEqual(['a.md', 'b.md', 'new name.md', 'old name.md'].sort());

    // Nothing new: same shas, no change, no paths.
    const again = await git.syncFromRemote('ws');
    expect(again).toEqual({ before: r.after, after: r.after, treeChanged: false, changedPaths: [] });
  });

  it('an unborn clone of an empty upstream is tolerated, and receives its first content as a change from null', async () => {
    const upstream = await bareUpstream(root, false);
    const workspaceDir = path.join(root, 'ws');
    const repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(workspaceDir, { recursive: true });
    // Cloning an empty repository warns but succeeds; HEAD is unborn.
    await runGit(root, ['-c', 'core.autocrlf=false', 'clone', upstream, repo]);
    await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
    await runGit(repo, ['checkout', '-b', BRANCH]).catch(() => undefined);
    const git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');

    // Still empty on both sides: nothing to sync, and NOT 'remote gone' — a
    // fresh deployment nobody has pushed to must never have its clone retired.
    expect(await git.syncFromRemote('ws')).toEqual({ before: null, after: null, treeChanged: false, changedPaths: [] });

    // Origin gains its first commit.
    const seed = path.join(root, '.first');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', BRANCH]);
    await runGit(seed, ['config', 'user.email', 'other@bevel.test']);
    await runGit(seed, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(seed, 'README.md'), 'hello\n');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'first']);
    await runGit(seed, ['push', upstream, BRANCH]);

    const r = await git.syncFromRemote('ws');
    expect(r.before).toBeNull();
    expect(r.after).toMatch(/^[0-9a-f]{40}$/);
    expect(r.treeChanged).toBe(true);
    expect(r.changedPaths).toEqual(['README.md']);
  });

  it('a branch deleted on the host is a typed "remote branch gone", not an unreachable remote', async () => {
    const upstream = await bareUpstream(root, true);
    await runGit(upstream, ['branch', 'ali/x', BRANCH]);
    const { workspaceDir } = await cloneWorkspace(root, upstream, 'ali%2Fx', 'ali/x');
    await runGit(upstream, ['update-ref', '-d', 'refs/heads/ali/x']);
    const git = new GitService(stubWorkspaceService({ 'ali%2Fx': workspaceDir }), stubWorkflowHooks(), 'knowledge-base');
    await expect(git.syncFromRemote('ali%2Fx')).rejects.toBeInstanceOf(RemoteBranchGoneError);
  });
});

describe('GitService.syncFromRemote — the cases git exits 0 on but should not pass', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-sync2-'));
  });
  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it('an autostashed edit that conflicts on reapply is a typed conflict, the tree is left clean, the edit is kept in stash', async () => {
    const upstream = await bareUpstream(root, true);
    const { workspaceDir, repo } = await cloneWorkspace(root, upstream, 'ws');
    // A tracked edit nobody committed — what a lock-holder's in-progress save looks like.
    await fs.writeFile(path.join(repo, 'a.md'), 'edited locally\n');
    await pushFromElsewhere(root, upstream, async (dir) => {
      await fs.writeFile(path.join(dir, 'a.md'), 'edited on the host\n');
    });
    const git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');

    await expect(git.syncFromRemote('ws')).rejects.toMatchObject({
      name: 'PullRebaseConflictError',
      conflictedPaths: ['a.md'],
    });
    // Clean tree at the remote commit; the local edit survives in the stash.
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(await gitOut(repo, ['rev-parse', 'refs/remotes/origin/' + BRANCH]));
    expect((await gitOut(repo, ['stash', 'list'])).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('an unborn clone whose branch was created and deleted on an origin that has other branches is remote gone, not fresh', async () => {
    const upstream = await bareUpstream(root, true); // origin has BRANCH
    const workspaceDir = path.join(root, 'ws');
    const repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(workspaceDir, { recursive: true });
    // An unborn clone checked out on a branch origin does not have.
    await runGit(root, ['-c', 'core.autocrlf=false', 'clone', upstream, repo]);
    await runGit(repo, ['checkout', '--orphan', 'ali/x']);
    await runGit(repo, ['rm', '-rf', '--cached', '.']).catch(() => undefined);
    await fs.rm(path.join(repo, 'a.md'), { force: true });
    await fs.rm(path.join(repo, 'old name.md'), { force: true });
    const git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');
    await expect(git.syncFromRemote('ws')).rejects.toBeInstanceOf(RemoteBranchGoneError);
  });

  it('remoteBranchExists answers from origin, not from the clone', async () => {
    const upstream = await bareUpstream(root, true);
    await runGit(upstream, ['branch', 'ali/x', BRANCH]);
    const { workspaceDir } = await cloneWorkspace(root, upstream, 'ws');
    const git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');
    expect(await git.remoteBranchExists('ws', 'ali/x')).toBe(true);
    await runGit(upstream, ['update-ref', '-d', 'refs/heads/ali/x']);
    expect(await git.remoteBranchExists('ws', 'ali/x')).toBe(false);
  });
});
