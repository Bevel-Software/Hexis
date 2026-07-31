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
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-log-file-'));
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
  // Disable auto-gc and force any gc that does run to stay in the foreground.
  // The clamp test below makes 150 sequential commits, which crosses git's
  // `gc.autoPackLimit` (default 50) and trips auto-gc mid-loop. With the
  // default `gc.autoDetach=true`, gc runs in a background process that races
  // the next `git commit` ("fatal: unable to read <sha>" when gc packs an
  // object the next commit just referenced) and the afterEach `fs.rm`
  // (`ENOTEMPTY` on Linux, `EBUSY` on Windows when the gc process still has
  // file handles into `.git/objects`).
  await runGit(repo, ['config', 'gc.auto', '0']);
  await runGit(repo, ['config', 'gc.autoDetach', 'false']);
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

describe('GitService.logForFile', () => {
  let root: string;
  const workspaceId = 'ws-log-file-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    // `maxRetries` covers the residual case where a background git process
    // (index lock, fsmonitor, etc.) still has `.git/` open when the test
    // finishes — `fs.rm` will retry on EBUSY/ENOTEMPTY/EPERM before failing.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns single-commit history with attribution fields', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'one\n', 'first save');
    const sha = await headSha(repo);

    const history = await svc.logForFile(workspaceId, 'Knowledge/Foo.md', 20);
    expect(history).toHaveLength(1);
    expect(history[0].sha).toBe(sha);
    expect(history[0].authorName).toBe('Test');
    expect(history[0].authorEmail).toBe('t@x.com');
    expect(history[0].subject).toBe('first save');
    expect(history[0].committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes parent-branch and feature-branch commits in newest-first order', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'base\n', 'base edit');
    const baseSha = await headSha(repo);
    await runGit(repo, ['checkout', '-b', 'alice/edit']);
    await commitFile(repo, 'Knowledge/Foo.md', 'base\nfeature\n', 'feature edit');
    const featureSha = await headSha(repo);

    const history = await svc.logForFile(workspaceId, 'Knowledge/Foo.md', 20);
    expect(history.map((c) => c.sha)).toEqual([featureSha, baseSha]);
    expect(history.map((c) => c.subject)).toEqual(['feature edit', 'base edit']);
  });

  it('returns an empty list when the file has never been committed', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    await writeFile(repo, 'Knowledge/Untracked.md', 'draft content\n');

    const history = await svc.logForFile(workspaceId, 'Knowledge/Untracked.md', 20);
    expect(history).toEqual([]);
  });

  it('clamps history length to 100 max and respects smaller limits', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    // 110 commits is the minimum that still proves "clamped to 100" — going
    // higher just multiplies process-spawn cost on Windows (`git add` + `git
    // commit` per iteration, ~80 ms each) without strengthening the assertion.
    const COMMITS = 110;
    for (let i = 1; i <= COMMITS; i += 1) {
      await commitFile(repo, 'Knowledge/Foo.md', `value ${i}\n`, `commit ${i}`);
    }

    const clamped = await svc.logForFile(workspaceId, 'Knowledge/Foo.md', 200);
    expect(clamped).toHaveLength(100);

    const limited = await svc.logForFile(workspaceId, 'Knowledge/Foo.md', 5);
    expect(limited).toHaveLength(5);
    // Timeout is generous because Windows process-spawn dominates here — on
    // Linux CI this finishes in ~3 s.
  }, 60000);

  // Regression: pathspec literal handling. `git log -- '[Approved] foo.md'`
  // would otherwise interpret `[Approved]` as a character-class glob and
  // return zero commits even though the file has a real history. Routes the
  // SETUP commit through `svc.commitFile` (which carries the env var) rather
  // than the local `runGit` helper, since the helper does not.
  it('returns history for a bracketed filename — pathspec literal regression', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );
    await runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const user = { id: 'u', name: 'Test', email: 't@x.com' };
    const relPath = 'Purchasing/[Approved] memo.md';
    await writeFile(repo, relPath, 'first content\n');
    await svc.commitFile(workspaceId, user, relPath, 'add bracketed memo');

    const history = await svc.logForFile(workspaceId, relPath, 20);
    expect(history).toHaveLength(1);
    expect(history[0].subject).toBe('add bracketed memo');
  });
});
