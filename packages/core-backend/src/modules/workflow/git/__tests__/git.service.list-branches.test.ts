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
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-list-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com' },
  });
}

/**
 * Seeds a bare upstream repo with protected + draft branches, then clones it
 * into `<root>/<workspaceId>/knowledge-base` to match the layout GitService
 * expects via `workspaceService.getWorkspacePath`.
 */
async function seedWorkspace(root: string, workspaceId: string): Promise<{ upstream: string; repo: string }> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'current-company-state', upstream]);

  // A scratch clone to create the initial branches, then push them upstream.
  // Can't pass `-b current-company-state` because the bare repo has no refs yet;
  // instead we init a regular repo on that branch and wire up origin manually.
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'current-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await runGit(seed, ['commit', '--allow-empty', '-m', 'init']);
  await runGit(seed, ['branch', 'target-company-state']);
  await runGit(seed, ['branch', 'alice/draft-one']);
  await runGit(seed, [
    'push', 'origin',
    'current-company-state', 'target-company-state', 'alice/draft-one',
  ]);
  // Point upstream's HEAD at current-company-state so a fresh clone checks it out.
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/current-company-state']);

  // Per-user clone — matches what workspace.service.ts does in prod.
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

describe('GitService.listBranches', () => {
  let root: string;
  const workspaceId = 'ws-list-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('unions local heads with refs/remotes/origin so target-company-state and pushed drafts appear', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const branches = await svc.listBranches(workspaceId);
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['alice/draft-one', 'current-company-state', 'target-company-state']);

    const protectedBranches = branches.filter((b) => b.isProtected).map((b) => b.name).sort();
    expect(protectedBranches).toEqual(['current-company-state', 'target-company-state']);
    // Under the per-branch workspace model `BranchInfo` no longer carries an
    // `isCurrent` flag — the workspace's identity IS the current branch.
    // Consumers derive it as `branch.name === decodeURIComponent(workspaceId)`.
  });

  it('skips the origin/HEAD symbolic ref instead of surfacing it as a branch named "origin"', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const branches = await svc.listBranches(workspaceId);
    expect(branches.find((b) => b.name === 'origin')).toBeUndefined();
    expect(branches.find((b) => b.name === 'HEAD')).toBeUndefined();
    expect(branches.find((b) => b.name === 'origin/HEAD')).toBeUndefined();
  });

  it('picks up a branch pushed to upstream after the first listBranches call (auto-fetch)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );
    // Prime the cache: first call fetches and populates lastImplicitFetchAt.
    await svc.listBranches(workspaceId);

    // Push a new branch to upstream via a throwaway clone (bypass the debounce
    // by constructing a fresh GitService instance — separate in-memory state).
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await runGit(pusher, ['checkout', '-b', 'bob/draft-two']);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'bob change']);
    await runGit(pusher, ['push', 'origin', 'bob/draft-two']);

    const freshSvc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );
    const branches = await freshSvc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).toContain('bob/draft-two');
  });

  it('serves the known branch list when origin is unreachable (fetch failure is swallowed)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    // Nuke upstream so fetch fails; remote-tracking refs already in the consumer clone survive.
    await fs.rm(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    // Should not throw and should return the refs we already had on disk.
    const branches = await svc.listBranches(workspaceId);
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['alice/draft-one', 'current-company-state', 'target-company-state']);
  });

  it('returns local branches before remote-only ones, order preserved through parallel ahead/behind', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );

    // current-company-state is the workspace clone's checked-out branch (the
    // only local head); the rest are remote-only. The result order must be
    // local-first then alphabetical — `listBranches` now computes ahead/behind
    // with `Promise.all`, so this pins that the mapping preserves row order.
    const branches = await svc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).toEqual([
      'current-company-state',
      'alice/draft-one',
      'target-company-state',
    ]);
  });

  it('skips the implicit fetch after noteWorkspaceFetched (a fresh clone already has every ref)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      'knowledge-base',
    );
    // Simulate a just-completed clone — the workspace is freshly fetched.
    svc.noteWorkspaceFetched(workspaceId);

    // Push a new branch upstream. A normal listBranches would fetch and see
    // it; with the implicit fetch skipped it must not appear yet.
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await runGit(pusher, ['checkout', '-b', 'carol/draft-three']);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'carol change']);
    await runGit(pusher, ['push', 'origin', 'carol/draft-three']);

    const branches = await svc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).not.toContain('carol/draft-three');
  });
});
