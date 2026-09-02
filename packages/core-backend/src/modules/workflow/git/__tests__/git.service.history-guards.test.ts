import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

// The history surfaces are per-file: their read gate checked exactly one
// path, but a directory pathspec walks every child — and `show <ref>:<dir>`
// even prints the tree listing. A tree at the ref is refused; a file, and a
// path absent at the ref, are served.

describe('GitService history guards', () => {
  let root: string;
  const workspaceId = 'target-company-state';
  let repo: string;
  let sha: string;
  let svc: GitService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-histguard-'));
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(root, ['init', '-b', 'target-company-state', repo]);
    await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'child.md'), 'secret child\n');
    await fs.writeFile(path.join(repo, 'top.md'), 'top\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'seed']);
    sha = await gitOut(repo, ['rev-parse', 'HEAD']);
    svc = new GitService(
      stubWorkspaceService({ [workspaceId]: workspaceDir }),
      stubWorkflowHooks(),
      'knowledge-base',
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('diffFileAtCommit refuses a directory and serves a file', async () => {
    await expect(svc.diffFileAtCommit(workspaceId, 'knowledge-base/docs', sha)).rejects.toThrow(
      /history is served per file/,
    );
    const diff = await svc.diffFileAtCommit(workspaceId, 'knowledge-base/top.md', sha);
    expect(diff).toContain('top');
  });

  it('logForFile refuses a directory even when it was deleted before HEAD, and lists a file', async () => {
    // A directory removed before HEAD is absent NOW — a HEAD-shape check
    // passes — but `git log -- <dir>` still traverses its historical
    // children. The proof comes from what the log touched.
    await fs.rm(path.join(repo, 'docs'), { recursive: true });
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'remove docs']);
    await expect(svc.logForFile(workspaceId, 'knowledge-base/docs')).rejects.toThrow(
      /history is served per file/,
    );
    const log = await svc.logForFile(workspaceId, 'knowledge-base/top.md');
    expect(log.length).toBe(1);
    expect(log[0]!.subject).toBe('seed');
    expect(log[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fileContentsAtCommit refuses a directory and still serves a deleted file', async () => {
    await expect(svc.fileContentsAtCommit(workspaceId, 'knowledge-base/docs', sha)).rejects.toThrow(
      /history is served per file/,
    );
    // Delete the file; its history stays its own — absent is not a tree.
    await fs.rm(path.join(repo, 'top.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'remove top']);
    const delSha = await gitOut(repo, ['rev-parse', 'HEAD']);
    const { baseline, current } = await svc.fileContentsAtCommit(
      workspaceId,
      'knowledge-base/top.md',
      delSha,
    );
    expect(baseline).toContain('top');
    expect(current).toBeNull();
  });
});
