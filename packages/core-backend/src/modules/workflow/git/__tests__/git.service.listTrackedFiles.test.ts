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
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-tracked-files-'));
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

async function seedWorkspace(root: string, workspaceId: string): Promise<{ repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'current-company-state']);
  return { repo };
}

async function writeFile(repo: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function commitFile(repo: string, relativePath: string, contents: string, subject: string): Promise<void> {
  await writeFile(repo, relativePath, contents);
  await runGit(repo, ['add', relativePath]);
  await runGit(repo, ['commit', '-m', subject]);
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

async function makeSvc(root: string, workspaceId: string) {
  const { repo } = await seedWorkspace(root, workspaceId);
  const svc = new GitService(
    stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
    new WorkflowHooks(),
    'knowledge-base',
  );
  return { svc, repo };
}

describe('GitService.listTrackedFiles', () => {
  let root: string;
  const workspaceId = 'ws-tracked-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('lists committed tracked files', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/A.md', 'a\n', 'add a');
    await commitFile(repo, 'Knowledge/Sub/B.md', 'b\n', 'add b');

    expect((await svc.listTrackedFiles(workspaceId)).sort()).toEqual([
      'Knowledge/A.md',
      'Knowledge/Sub/B.md',
    ]);
  });

  it('excludes untracked files — an untracked scratch doc is never listed', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/A.md', 'a\n', 'add a');
    await writeFile(repo, 'scratch.md', 'untracked\n');

    const tracked = await svc.listTrackedFiles(workspaceId);
    expect(tracked).toContain('Knowledge/A.md');
    expect(tracked).not.toContain('scratch.md');
  });

  it('excludes ignored files', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, '.gitignore', 'secret.md\n', 'add ignore');
    await writeFile(repo, 'secret.md', 'shh\n');

    const tracked = await svc.listTrackedFiles(workspaceId);
    expect(tracked).toContain('.gitignore');
    expect(tracked).not.toContain('secret.md');
  });

  it('preserves filenames with spaces and bracketed prefixes verbatim', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, '[Approved] hello world.md', 'ok\n', 'add bracketed');

    expect(await svc.listTrackedFiles(workspaceId)).toEqual(['[Approved] hello world.md']);
  });

  it('returns an empty list for a repo with no commits', async () => {
    const { svc } = await makeSvc(root, workspaceId);
    expect(await svc.listTrackedFiles(workspaceId)).toEqual([]);
  });
});
