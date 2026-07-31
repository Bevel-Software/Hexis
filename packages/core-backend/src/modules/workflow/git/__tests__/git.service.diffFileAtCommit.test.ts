import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkflowValidationError } from '../../workflow.errors.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-file-diff-'));
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
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
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
  // CI runners have no global user.email / user.name. The local `runGit`
  // helper sets author/committer via env vars, but `svc.commitFile` spawns
  // its own git process that doesn't see them — so pin identity in the repo
  // config too, otherwise `git commit` fails with "empty ident name" on CI.
  await runGit(repo, ['config', 'user.email', 't@x.com']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  return { workspaceDir, repo };
}

async function writeFile(repo: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function commitFile(
  repo: string,
  relativePath: string,
  contents: string,
  subject: string,
): Promise<void> {
  await writeFile(repo, relativePath, contents);
  await runGit(repo, ['add', relativePath]);
  await runGit(repo, ['commit', '-m', subject]);
}

async function headSha(repo: string): Promise<string> {
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

describe('GitService.diffFileAtCommit', () => {
  let root: string;
  const workspaceId = 'ws-file-diff-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('returns the patch for the selected commit when the file changed', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'line one\n', 'A');
    await commitFile(repo, 'Knowledge/Foo.md', 'line one\nline two\n', 'B');
    const shaB = await headSha(repo);

    const patch = await svc.diffFileAtCommit(workspaceId, 'Knowledge/Foo.md', shaB);
    expect(patch).toContain('diff --git a/Knowledge/Foo.md b/Knowledge/Foo.md');
    expect(patch).toContain('+line two');
  });

  it('returns additions for a root commit that created the file', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'root line\n', 'root');
    const rootSha = await headSha(repo);

    const patch = await svc.diffFileAtCommit(workspaceId, 'Knowledge/Foo.md', rootSha);
    expect(patch).toContain('diff --git a/Knowledge/Foo.md b/Knowledge/Foo.md');
    expect(patch).toContain('+root line');
  });

  it("returns an empty diff when the selected commit didn't touch the file", async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/file2.md', 'base\n', 'add file2');
    await commitFile(repo, 'Knowledge/file1.md', 'change\n', 'touch file1');
    const sha = await headSha(repo);

    const patch = await svc.diffFileAtCommit(workspaceId, 'Knowledge/file2.md', sha);
    expect(patch).toBe('');
  });

  it('rejects an invalid commit sha before invoking git', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileAtCommit(workspaceId, 'Knowledge/Foo.md', 'not-a-sha'),
    ).rejects.toThrow('invalid commit sha');
  });

  it('rejects an invalid relative path', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileAtCommit(workspaceId, '../etc/passwd', 'abcdef1'),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  // Regression: pathspec literal handling. `git show <sha> -- '[New] memo.md'`
  // would interpret the brackets as a character-class glob and emit no diff
  // even when the path is real. Routes the SETUP commit through
  // `svc.commitFile` so the bracketed `git add` runs under the env var.
  it('renders a diff for a bracketed filename — pathspec literal regression', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );
    await runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const user = { id: 'u', name: 'Test', email: 't@x.com' };
    const relPath = '[New] memo.md';
    await writeFile(repo, relPath, 'first content\n');
    await svc.commitFile(workspaceId, user, relPath, 'add bracketed memo');
    const sha = await headSha(repo);

    const diff = await svc.diffFileAtCommit(workspaceId, relPath, sha);
    expect(diff).toContain('first content');
  });
});
