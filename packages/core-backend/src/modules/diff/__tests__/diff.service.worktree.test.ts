import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceMutex } from '../../kb-fs/mutex.js';
import { WorkspaceService } from '../../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { DiffService } from '../diff.service.js';

/**
 * The review session names the branch the workspace is on, read from HEAD
 * without spawning git. In a worktree `.git` is a FILE naming the worktree's
 * folder in the repository, where its HEAD lives.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-diff-worktree-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('DiffService on a worktree', () => {
  it("names the worktree's own branch in the review session", async () => {
    const upstream = path.join(root, 'upstream.git');
    await git(root, ['init', '--bare', '-b', 'main', upstream]);
    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await git(seed, ['init', '-b', 'alice/draft']);
    await fs.writeFile(path.join(seed, 'page.md'), 'before\n');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', 'init']);
    await git(seed, ['push', '-q', upstream, 'alice/draft']);

    const workspacesRoot = path.join(root, 'workspaces');
    const workspaces = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    const diff = new DiffService(
      workspaces,
      new WorkspaceMutex(),
      workspacesRoot,
      path.join(root, 'backups'),
      'knowledge-base',
      new NodeFs(),
    );
    workspaces.setDiffService(diff);
    const workspaceId = workspaceIdForBranch('alice/draft');
    const info = await workspaces.getOrCreateForBranch('alice/draft');
    expect((await fs.stat(path.join(info.absolutePath, 'knowledge-base', '.git'))).isFile()).toBe(true);

    // The first look seeds the ledger; a change made after it is pending.
    expect(await diff.currentSession(workspaceId)).toBeNull();
    await fs.writeFile(path.join(info.absolutePath, 'knowledge-base', 'page.md'), 'after\n');

    const session = await diff.currentSession(workspaceId);
    expect(session?.branchName).toBe('alice/draft');
  });
});
