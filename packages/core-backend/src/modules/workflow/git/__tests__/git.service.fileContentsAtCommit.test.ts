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
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-file-at-commit-'));
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

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.toString().trim();
}

async function seedWorkspace(
  root: string,
  workspaceId: string,
): Promise<{ workspaceDir: string; repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'current-company-state']);
  await runGit(repo, ['config', 'user.email', 't@x.com']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  return { workspaceDir, repo };
}

async function commitFile(
  repo: string,
  relativePath: string,
  contents: string,
  subject: string,
): Promise<string> {
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
  await runGit(repo, ['add', relativePath]);
  await runGit(repo, ['commit', '-m', subject]);
  return gitStdout(repo, ['rev-parse', 'HEAD']);
}

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

describe('GitService.fileContentsAtCommit', () => {
  let root: string;
  const workspaceId = 'ws-file-at-commit-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('covers root-commit add, modify, later add, and delete in one history', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const rootAdd = await commitFile(repo, 'Knowledge/Foo.md', '# one\n', 'add foo');
    const modify = await commitFile(repo, 'Knowledge/Foo.md', '# two\n', 'edit foo');
    const laterAdd = await commitFile(repo, 'Knowledge/Bar.md', '# bar\n', 'add bar');
    await runGit(repo, ['rm', 'Knowledge/Foo.md']);
    await runGit(repo, ['commit', '-m', 'delete foo']);
    const del = await gitStdout(repo, ['rev-parse', 'HEAD']);

    // Root commit: no parent side at all → baseline null.
    expect(await svc.fileContentsAtCommit(workspaceId, 'Knowledge/Foo.md', rootAdd)).toEqual({
      baseline: null,
      current: '# one\n',
    });
    // Plain modification: both sides present.
    expect(await svc.fileContentsAtCommit(workspaceId, 'Knowledge/Foo.md', modify)).toEqual({
      baseline: '# one\n',
      current: '# two\n',
    });
    // File added mid-history: parent exists, file absent there → baseline null.
    expect(await svc.fileContentsAtCommit(workspaceId, 'Knowledge/Bar.md', laterAdd)).toEqual({
      baseline: null,
      current: '# bar\n',
    });
    // Deletion: absent at the commit itself → current null.
    expect(await svc.fileContentsAtCommit(workspaceId, 'Knowledge/Foo.md', del)).toEqual({
      baseline: '# two\n',
      current: null,
    });
  });

  it('rejects an invalid sha', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );
    await expect(
      svc.fileContentsAtCommit(workspaceId, 'Knowledge/Foo.md', 'not-a-sha'),
    ).rejects.toThrow(/invalid commit sha/);
  });
});
