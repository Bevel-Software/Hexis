import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';

/**
 * `GitService.commitFile` — the `skipValidator` flag. The reject flow passes
 * `skipValidator: true` because it re-commits a pre-agent baseline that was
 * already validated when first written; running the (advisory) KB validator
 * there is pure latency.
 */

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';
const USER = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };

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

async function seedWorkspace(
  root: string,
  workspaceId: string,
): Promise<{ workspaceDir: string; repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  // A feature branch — not a protected branch — so `commitFile` skips the
  // protected-branch access gate; this test is only about the validator.
  await runGit(repo, ['init', '-b', 'feature-test']);
  await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
  await runGit(repo, ['config', 'user.name', 'Test Runner']);
  // Repo-local so GitService's own git children (which run with the ambient
  // env) see them too: autocrlf off keeps `git checkout` (discardPath) from
  // rewriting the LF fixtures as CRLF under Git-for-Windows' system-level
  // `core.autocrlf=true`; longpaths lifts Windows' 260-char MAX_PATH, which
  // the deep-KB-path subject-truncation test exceeds. Both are no-ops on Linux.
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  await runGit(repo, ['config', 'core.longpaths', 'true']);
  // An initial commit so HEAD exists.
  await fs.writeFile(path.join(repo, 'seed.md'), 'seed\n');
  await runGit(repo, ['add', 'seed.md']);
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

function makeValidator(): { hooks: WorkflowHooks; runValidation: ReturnType<typeof vi.fn> } {
  const report = { ok: true, mustFix: [], warnings: [], rawOutput: '' };
  const runValidation = vi.fn(async () => report);
  // Registered as a commit-validation hook — the seam GitService consults
  // where it used to call the injected validator.
  const hooks = new WorkflowHooks();
  hooks.onCommitValidation(() => runValidation());
  return { hooks, runValidation };
}

describe('GitService.commitFile — skipValidator', () => {
  let root: string;
  const workspaceId = 'ws-commitfile-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-commitfile-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('skipValidator=true commits the file WITHOUT running the KB validator', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const { hooks, runValidation } = makeValidator();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      hooks,
      'knowledge-base',
    );

    await fs.writeFile(path.join(repo, 'Foo.md'), 'reverted content\n');
    const change = await svc.commitFile(workspaceId, USER, 'Foo.md', 'Revert agent change', true);

    expect(runValidation).not.toHaveBeenCalled();
    expect(change?.sha).toBeTruthy();
    expect(change?.subject).toBe('Revert agent change');
  });

  it('runs the KB validator when skipValidator is omitted', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const { hooks, runValidation } = makeValidator();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      hooks,
      'knowledge-base',
    );

    await fs.writeFile(path.join(repo, 'Bar.md'), 'new content\n');
    const change = await svc.commitFile(workspaceId, USER, 'Bar.md', 'normal commit');

    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(change?.sha).toBeTruthy();
  });

  // Regression: filenames with bracketed prefixes (`[Approved] …`, `[New] …`,
  // `[Updated 03.09.2025] …`) used to be rejected at `assertValidRelativePath`
  // because their `[` / `]` characters would be interpreted by `git add -- <path>`
  // as pathspec globs. The fix is `GIT_LITERAL_PATHSPECS=1` on the subprocess
  // env (set in `GitService.git()`), which forces literal matching. This test
  // commits one of the user-reported offenders end-to-end through real git so
  // a regression in the env-var plumbing would surface as a subprocess failure
  // here rather than as a 400 on the upload route.
  it('commits a filename containing pathspec glob characters (regression: [Approved] / [New] prefixes)', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const { hooks } = makeValidator();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      hooks,
      'knowledge-base',
    );

    const relPath = 'Purchasing/[Updated 03.09.2025] Purchasing_How to search_Product detail page.md';
    await fs.mkdir(path.join(repo, 'Purchasing'), { recursive: true });
    await fs.writeFile(path.join(repo, relPath), 'content\n');

    const change = await svc.commitFile(workspaceId, USER, relPath);

    expect(change?.sha).toBeTruthy();
    // Working tree must end up clean — `git add -- <path>` literally matched
    // the bracketed name, so there's no leftover untracked file ghost on disk.
    const { stdout: status } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain'], {
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    });
    expect(status.trim()).toBe('');
  });

  // Regression: deep KB paths (≥194 chars) made the default `Update <path>`
  // subject exceed the 200-char limit, so the lock-release auto-commit
  // propagated `commit summary must be ≤ 200 characters` back through the
  // agent's write tool. The default now falls back to the basename when the
  // full path doesn't fit.
  it('truncates the default subject when the path makes "Update <path>" exceed 200 chars', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const { hooks } = makeValidator();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      hooks,
      'knowledge-base',
    );

    const deepDir = path.join(
      'Product',
      'Knowledge',
      '1. Service Commitment Management',
      '1.1 In - Architecture Layering (AL)',
      '0-Governance',
      '0.5-Layer-Group-Specific-Governance-Principles',
    );
    const fileName = '0.5.5-Buyer-Side-Commercial-Agreement-Governance.md';
    const relPath = path.posix.join(deepDir.split(path.sep).join('/'), fileName);
    expect(`Update ${relPath}`.length).toBeGreaterThan(200);

    await fs.mkdir(path.join(repo, deepDir), { recursive: true });
    await fs.writeFile(path.join(repo, deepDir, fileName), 'content\n');

    const change = await svc.commitFile(workspaceId, USER, relPath);

    expect(change?.subject).toBe(`Update ${fileName}`);
    expect(change?.subject.length).toBeLessThanOrEqual(200);
  });

  // Regression: pathspec literal handling. `git checkout HEAD -- '[Approved] x.md'`
  // and `git ls-files --error-unmatch -- '[Approved] x.md'` would interpret the
  // brackets as a character-class glob, so discardPath would either silently
  // no-op or fail to revert the on-disk content. Belongs alongside the
  // commitFile regression because no dedicated discardPath test file exists
  // yet — its full surface is covered transitively elsewhere.
  it('discardPath reverts an unstaged modification to a bracketed-name file', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const { hooks } = makeValidator();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      hooks,
      'knowledge-base',
    );

    const relPath = '[Approved] config.md';
    const committed = 'committed content\n';
    await fs.writeFile(path.join(repo, relPath), committed);
    await svc.commitFile(workspaceId, USER, relPath, 'add bracketed config');

    // Dirty the working tree.
    await fs.writeFile(path.join(repo, relPath), 'dirty content\n');
    await svc.discardPath(workspaceId, relPath);

    const restored = await fs.readFile(path.join(repo, relPath), 'utf-8');
    expect(restored).toBe(committed);
  });
});
