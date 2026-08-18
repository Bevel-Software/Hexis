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
 * `GitService.commitChanges` — the atomic multi-file batch primitive behind bulk
 * node upload + the role-rename rewrite. It commits whatever is already dirty in
 * the working tree as ONE commit attributed to the user (it does NOT write
 * content — the caller writes the files first), idempotent on a clean tree.
 */

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';
const USER = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.com' },
  });
}

async function seedWorkspace(root: string, workspaceId: string): Promise<{ workspaceDir: string; repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'feature-test']);
  await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
  await runGit(repo, ['config', 'user.name', 'Test Runner']);
  await fs.writeFile(path.join(repo, 'Old.md'), 'old\n');
  await runGit(repo, ['add', 'Old.md']);
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

function makeValidator(): WorkflowHooks {
  const report = { ok: true, mustFix: [], warnings: [], rawOutput: '' };
  // A clean-report commit-validation hook — the seam GitService consults
  // where it used to call the injected validator.
  const hooks = new WorkflowHooks();
  hooks.onCommitValidation(vi.fn(async () => report));
  return hooks;
}

describe('GitService.commitChanges', () => {
  let root: string;
  const workspaceId = 'ws-commitchanges-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-commitchanges-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('commits many dirty files + a delete as ONE commit attributed to the user', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), makeValidator(), PROCESS_MAP_DIR);

    // The caller writes the batch to disk first (the git layer never writes content).
    await fs.mkdir(path.join(repo, 'Product/Knowledge'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Product/Knowledge/A.md'), 'a\n');
    await fs.writeFile(path.join(repo, 'Product/Knowledge/B.md'), 'b\n');
    await fs.rm(path.join(repo, 'Old.md'));

    const change = await svc.commitChanges(workspaceId, USER, 'Bulk node upload (2 created, 1 moved)');

    expect(change?.sha).toBeTruthy();
    expect(change?.authorEmail).toBe('alice@bevel.software');
    expect(change?.subject).toBe('Bulk node upload (2 created, 1 moved)');

    // All three changes ride ONE commit.
    const { stdout: nameStatus } = await execFileAsync('git', ['-C', repo, 'show', '--name-status', '--pretty=format:', 'HEAD']);
    expect(nameStatus).toMatch(/A\s+Product\/Knowledge\/A\.md/);
    expect(nameStatus).toMatch(/A\s+Product\/Knowledge\/B\.md/);
    expect(nameStatus).toMatch(/D\s+Old\.md/);

    // Working tree clean — everything was committed.
    const { stdout: status } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain']);
    expect(status.trim()).toBe('');
  });

  it('returns null on a clean tree (nothing to commit)', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), makeValidator(), PROCESS_MAP_DIR);

    const change = await svc.commitChanges(workspaceId, USER, 'no-op');
    expect(change).toBeNull();
  });

  it('onlyPaths scopes the commit — an unrelated dirty file is NOT swept in', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), makeValidator(), PROCESS_MAP_DIR);

    // The batch's own file, plus a CONCURRENT save's bytes whose commit is
    // still queued — the shared per-branch workspace makes this ordinary.
    await fs.writeFile(path.join(repo, 'synced-groups.yaml'), 'groups: {}\n');
    await fs.writeFile(path.join(repo, 'Old.md'), 'someone else mid-save\n');

    const change = await svc.commitChanges(workspaceId, USER, 'Sync directory groups', [
      `${PROCESS_MAP_DIR}/synced-groups.yaml`,
    ]);

    expect(change?.sha).toBeTruthy();
    const { stdout: nameStatus } = await execFileAsync('git', ['-C', repo, 'show', '--name-status', '--pretty=format:', 'HEAD']);
    expect(nameStatus).toMatch(/A\s+synced-groups\.yaml/);
    expect(nameStatus).not.toMatch(/Old\.md/);
    // The unrelated file stays dirty for its OWN queued commit.
    const { stdout: status } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain']);
    expect(status).toContain('Old.md');
  });

  it('onlyPaths keeps a staged RENAME whole — old path deletion rides the scoped commit', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), makeValidator(), PROCESS_MAP_DIR);

    // A staged rename shows as one `R` porcelain record (new-path + old-path).
    // The scope names only the NEW path; the old path must ride along or the
    // rename decays into an add that leaves Old.md alive in HEAD.
    await runGit(repo, ['mv', 'Old.md', 'New.md']);
    const change = await svc.commitChanges(workspaceId, USER, 'Rename via batch', [
      `${PROCESS_MAP_DIR}/New.md`,
    ]);

    expect(change?.sha).toBeTruthy();
    const { stdout: nameStatus } = await execFileAsync('git', ['-C', repo, 'show', '--name-status', '-M', '--pretty=format:', 'HEAD']);
    expect(nameStatus).toMatch(/R\d*\s+Old\.md\s+New\.md/);
    // Old.md is gone from HEAD — not left behind as a live file.
    const { stdout: lsTree } = await execFileAsync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'HEAD']);
    expect(lsTree).not.toContain('Old.md');
    expect(lsTree).toContain('New.md');
  });

  it('onlyPaths with nothing of its own dirty is a no-op even when other files are dirty', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(stubWorkspaceService(workspaceId, workspaceDir), makeValidator(), PROCESS_MAP_DIR);

    await fs.writeFile(path.join(repo, 'Old.md'), 'someone else mid-save\n');
    const change = await svc.commitChanges(workspaceId, USER, 'Sync directory groups', [
      `${PROCESS_MAP_DIR}/synced-groups.yaml`,
    ]);
    expect(change).toBeNull();
  });
});
