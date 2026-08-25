import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkflowValidationError } from '../../../../shared/domain-errors.js';

/**
 * `commitFile` on a path whose bytes sit BESIDE the repository.
 *
 * The workspace dir holds the clone as `knowledge-base/`. A caller that
 * writes a workspace-relative path without that prefix puts the file next to
 * the clone, where `git status` inside the clone reports it clean. Before,
 * `commitFile` read that as "nothing to commit" and returned null, so the
 * write was reported as landed while git never saw it. Now it throws, and the
 * pending-commits ladder escalates the row instead of dropping it.
 *
 * The three honest null cases must survive unchanged: a clean committed path,
 * a path that exists nowhere (a queued re-apply of a committed deletion), and
 * a repo-relative path some internal callers pass directly.
 */

const execFileAsync = promisify(execFile);
const KB = 'knowledge-base';

const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-stray-'));
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@x.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@x.com',
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout.toString().trim();
}

async function seedWorkspace(root: string, workspaceId: string): Promise<{ workspaceDir: string; repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, KB);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.email', 't@x.com']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  await runGit(repo, ['config', 'gc.auto', '0']);
  // One committed file so HEAD exists and the "clean path" cases have something to be clean about.
  await fs.mkdir(path.join(repo, 'Knowledge'), { recursive: true });
  await fs.writeFile(path.join(repo, 'Knowledge/A.md'), 'a\n');
  await runGit(repo, ['add', 'Knowledge/A.md']);
  await runGit(repo, ['commit', '-m', 'seed']);
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

describe('GitService.commitFile with bytes beside the repository', () => {
  let root: string;
  const workspaceId = 'ws-stray';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('throws instead of returning null when the file exists at the workspace root and not in the clone', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), KB);
    // The prefix-less write the agent made: beside the clone, not inside it.
    await fs.mkdir(path.join(workspaceDir, 'KnowledgeBase/Reviews'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'KnowledgeBase/Reviews/PR-12.html'), '<p>review</p>');
    const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

    const attempt = svc.commitFile(workspaceId, USER, 'KnowledgeBase/Reviews/PR-12.html');
    await expect(attempt).rejects.toBeInstanceOf(WorkflowValidationError);
    await expect(attempt).rejects.toThrow('"knowledge-base/KnowledgeBase/Reviews/PR-12.html"');

    // Nothing landed, and the stray is left where it is for someone to recover.
    expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await fs.readFile(path.join(workspaceDir, 'KnowledgeBase/Reviews/PR-12.html'), 'utf-8')).toBe('<p>review</p>');
  });

  it('still returns null for a clean, committed path (the honest no-op)', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), KB);
    expect(await svc.commitFile(workspaceId, USER, `${KB}/Knowledge/A.md`)).toBeNull();
  });

  it('still returns null for a path that exists nowhere (a queued re-apply of a committed deletion)', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), KB);
    expect(await svc.commitFile(workspaceId, USER, `${KB}/Knowledge/Gone.md`)).toBeNull();
  });

  it('still returns null for a repo-relative path that is clean inside the clone (the form internal callers pass)', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), KB);
    expect(await svc.commitFile(workspaceId, USER, 'Knowledge/A.md')).toBeNull();
  });

  it('still commits a prefixed path inside the clone', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), new WorkflowHooks(), KB);
    await fs.writeFile(path.join(repo, 'Knowledge/B.md'), 'b\n');
    const committed = await svc.commitFile(workspaceId, USER, `${KB}/Knowledge/B.md`);
    expect(committed).not.toBeNull();
    expect(committed!.authorEmail).toBe('alice@example.com');
    expect(await runGit(repo, ['log', '--oneline'])).toMatch(/^\S+ .*\n\S+ seed$/);
  });
});
