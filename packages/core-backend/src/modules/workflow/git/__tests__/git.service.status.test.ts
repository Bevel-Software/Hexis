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
const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-status-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

/**
 * Seeds an upstream + per-user clone exactly like the list-branches harness,
 * so a `git push -u` actually has somewhere to land. The clone starts on
 * `current-company-state` with its upstream set; new local branches the test
 * creates have no upstream until explicitly pushed.
 */
async function seedWorkspace(
  root: string,
  workspaceId: string,
): Promise<{ workspaceDir: string; repo: string }> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'current-company-state', upstream]);

  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'current-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await runGit(seed, ['commit', '--allow-empty', '-m', 'init']);
  await runGit(seed, ['push', 'origin', 'current-company-state']);
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/current-company-state']);

  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  return { workspaceDir, repo };
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

describe('GitService.status — hasUpstream', () => {
  let root: string;
  const workspaceId = 'ws-status-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reports hasUpstream=true on a tracked branch (cloned from origin)', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), 'knowledge-base');

    const status = await svc.status(workspaceId);
    expect(status.branch).toBe('current-company-state');
    expect(status.hasUpstream).toBe(true);
    expect(status.unmergedFromUpstream).toBe(false);
  });

  it('reports hasUpstream=false on a freshly-created local branch that has never been pushed', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    // Branch off the protected base into a draft. No `--track` and no push,
    // so it has no upstream — exactly the "unpublished draft" case the
    // ShareChangesButton must offer to publish.
    await runGit(repo, ['checkout', '-b', 'alice/unpublished-draft']);
    await runGit(repo, ['commit', '--allow-empty', '-m', 'local-only edit']);

    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), 'knowledge-base');
    const status = await svc.status(workspaceId);

    expect(status.branch).toBe('alice/unpublished-draft');
    expect(status.hasUpstream).toBe(false);
    // No upstream means there's nothing to diff against — the previous
    // "always 0" behaviour is preserved, but the UI now learns the truth
    // via `hasUpstream` instead of conflating it with "0 ahead".
    expect(status.unmergedFromUpstream).toBe(false);
  });

  it('flips hasUpstream to true after the branch is pushed with -u', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await runGit(repo, ['checkout', '-b', 'alice/published-draft']);
    await runGit(repo, ['commit', '--allow-empty', '-m', 'one']);
    await runGit(repo, ['commit', '--allow-empty', '-m', 'two']);
    await runGit(repo, ['push', '-u', 'origin', 'alice/published-draft']);

    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), 'knowledge-base');
    const status = await svc.status(workspaceId);

    expect(status.branch).toBe('alice/published-draft');
    expect(status.hasUpstream).toBe(true);
    // `unpushedCommits` removed from WorkingTreeStatus under save=share —
    // every commit auto-pushes on lock release, so "ahead" is always 0 by
    // construction. The remaining upstream-sync signal is
    // `unmergedFromUpstream` (origin ahead of us, driven by teammates).
  });
});
