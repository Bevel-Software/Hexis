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

async function seedWorkspace(root: string, workspaceId: string) {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'current-company-state']);
  await runGit(repo, ['config', 'user.email', 't@x.com']);
  await runGit(repo, ['config', 'user.name', 'Test']);
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

describe('GitService.readFileAtRef', () => {
  let root: string;
  const workspaceId = 'ws-read-at-ref-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-read-at-ref-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function makeSvc(workspaceDir: string) {
    return new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      PROCESS_MAP_DIR,
    );
  }

  it('returns the file content at a ref without touching the working tree', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = makeSvc(workspaceDir);
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - a@x.com\n');
    await runGit(repo, ['add', 'roles.yaml']);
    await runGit(repo, ['commit', '-m', 'add roles']);

    const out = await svc.readFileAtRef(workspaceId, 'HEAD', 'roles.yaml');
    expect(out).toBe('roles:\n  Admin:\n    - a@x.com\n');
  });

  it('returns null when the path is absent at the ref (true absence)', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = makeSvc(workspaceDir);
    await fs.writeFile(path.join(repo, 'other.md'), 'x\n');
    await runGit(repo, ['add', 'other.md']);
    await runGit(repo, ['commit', '-m', 'add other']);

    const out = await svc.readFileAtRef(workspaceId, 'HEAD', 'roles.yaml');
    expect(out).toBeNull();
  });

  it('THROWS (fail-closed) on a non-absence git error such as an unresolvable ref', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = makeSvc(workspaceDir);
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles: {}\n');
    await runGit(repo, ['add', 'roles.yaml']);
    await runGit(repo, ['commit', '-m', 'add roles']);

    // An unresolvable ref is NOT "the path is absent" — it must propagate so a
    // caller comparing base-vs-head can't misread the failure as "no roles.yaml".
    await expect(
      svc.readFileAtRef(workspaceId, 'origin/does-not-exist', 'roles.yaml'),
    ).rejects.toThrow();
  });
});
