import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/platform-shared';
import { NodeFs } from '../../../kb-fs/node-fs.js';
import { WorkspaceMutex } from '../../../kb-fs/mutex.js';
import { WorkspaceService } from '../../../workspace/workspace.service.js';
import { KbRepository, repositoryDirFor } from '../../../workspace/kb-repository.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService, touchesSharedRepositoryState } from '../git.service.js';
import { NodeGitRunner } from '../node-git-runner.js';
import { workspaceIdForBranch } from '../../../../shared/workspace-id.js';

/**
 * The git layer over a knowledge base of WORKTREES of one repository: the
 * same answers as over clones of the same remote, two worktrees committing at
 * once, and a branch deleted while its own worktree is open. Real git.
 */

const execFileAsync = promisify(execFile);
const TARGET = 'current-company-state';
const ALICE: AuthUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
  return stdout.toString();
}

let root: string;
let upstream: string;
let workspacesRoot: string;
let workspaces: WorkspaceService;
let gitService: GitService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-worktrees-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', TARGET, upstream]);
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', TARGET]);
  await fs.writeFile(path.join(seed, 'base.md'), 'base\n');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  for (const draft of ['alice/a', 'bob/b']) {
    await git(seed, ['checkout', '-q', '-b', draft, TARGET]);
    await fs.writeFile(path.join(seed, `${draft.split('/')[0]}.md`), `${draft}\n`);
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', `on ${draft}`]);
  }
  await git(seed, ['push', '-q', upstream, TARGET, 'alice/a', 'bob/b']);

  // One mutex for the git layer and the repository, as the composition root wires them.
  const mutex = new WorkspaceMutex();
  const runner = new NodeGitRunner();
  const repository = new KbRepository({
    dir: repositoryDirFor(workspacesRoot, 'knowledge-base'),
    kbRepoUrl: () => upstream,
    gitRunner: runner,
    mutex,
  });
  workspaces = new WorkspaceService(
    workspacesRoot, upstream, testKbContext(), new NodeFs(), runner, undefined, undefined, repository,
  );
  gitService = new GitService(workspaces, new WorkflowHooks(), testKbContext(), mutex, null, runner);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const id = (branch: string) => workspaceIdForBranch(branch);
const checkoutOf = (branch: string) => path.join(workspacesRoot, id(branch), 'knowledge-base');

describe('GitService over worktrees', () => {
  it('lands two commits requested at the same time in two worktrees, and pushes both', async () => {
    await workspaces.getOrCreateForBranch('alice/a');
    await workspaces.getOrCreateForBranch('bob/b');
    await fs.writeFile(path.join(checkoutOf('alice/a'), 'alice.md'), 'alice edits\n');
    await fs.writeFile(path.join(checkoutOf('bob/b'), 'bob.md'), 'bob edits\n');

    const [a, b] = await Promise.all([
      gitService.commitFile(id('alice/a'), ALICE, 'knowledge-base/alice.md', 'alice edits'),
      gitService.commitFile(id('bob/b'), ALICE, 'knowledge-base/bob.md', 'bob edits'),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await Promise.all([gitService.push(id('alice/a'), ALICE), gitService.push(id('bob/b'), ALICE)]);

    expect(await git(upstream, ['show', 'alice/a:alice.md'])).toBe('alice edits\n');
    expect(await git(upstream, ['show', 'bob/b:bob.md'])).toBe('bob edits\n');
    // Each push left its branch tracking its own remote branch.
    expect((await git(checkoutOf('alice/a'), ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim()).toBe('origin/alice/a');
    expect((await git(checkoutOf('bob/b'), ['status', '--porcelain'])).trim()).toBe('');
  });

  it("answers a change request's files and merges it exactly as a clone of the same remote does", async () => {
    await workspaces.getOrCreateForBranch(TARGET);
    await workspaces.getOrCreateForBranch('alice/a');
    const onWorktrees = await gitService.changedFilesForPr(id(TARGET), TARGET, 'alice/a');

    // The same question asked of a full clone of the same remote.
    const cloneRoot = path.join(root, 'clones');
    const clone = path.join(cloneRoot, id(TARGET), 'knowledge-base');
    await fs.mkdir(path.dirname(clone), { recursive: true });
    await git(root, ['clone', '-q', '-b', TARGET, upstream, clone]);
    const clones = new WorkspaceService(cloneRoot, upstream, testKbContext(), new NodeFs());
    const onClones = await new GitService(clones, new WorkflowHooks(), testKbContext()).changedFilesForPr(
      id(TARGET), TARGET, 'alice/a',
    );
    expect(onWorktrees).toEqual(onClones);

    await gitService.mergeChangeRequest(
      id(TARGET), 'alice/a', TARGET, { subject: 'Merge alice/a (#1)', body: '' }, ALICE,
    );
    expect(await git(upstream, ['show', `${TARGET}:alice.md`])).toBe('alice/a\n');
  });

  it('deletes a branch whose own worktree is open, and removing that workspace takes the worktree and its ref', async () => {
    await workspaces.getOrCreateForBranch(TARGET);
    await workspaces.getOrCreateForBranch('alice/a');

    await gitService.deleteBranch(id(TARGET), 'alice/a', ALICE, { systemCleanup: true });
    await workspaces.deleteWorkspace(id('alice/a'));

    await expect(git(upstream, ['rev-parse', '--verify', 'refs/heads/alice/a'])).rejects.toThrow();
    await expect(git(workspaces.repository.dir, ['rev-parse', '--verify', 'refs/heads/alice/a'])).rejects.toThrow();
    await expect(fs.access(checkoutOf('alice/a'))).rejects.toThrow();
    expect((await git(checkoutOf(TARGET), ['status', '--porcelain'])).trim()).toBe('');
  });

  it("finishes a branch's first open raced by git operations on that branch, and a fetch joined from inside one", async () => {
    // The first request for a branch fans out: the page opens the workspace
    // while the git layer asks for its status — inside the branch's
    // reservation, resolving the same workspace — and a listing fetches.
    // The worktree add waits for running git operations, and they wait for
    // the open: nothing may wait for itself.
    await workspaces.getOrCreateForBranch(TARGET);
    const all = Promise.all([
      workspaces.getOrCreateForBranch('bob/b'),
      gitService.status(id('bob/b')),
      gitService.listBranches(id(TARGET), { freshFetch: true }),
      gitService.status(id('bob/b')),
    ]);
    const timedOut = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 20_000));
    await Promise.race([all, timedOut]);
    expect((await git(checkoutOf('bob/b'), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('bob/b');
  });

  it('lists branches from one fetch of the repository, strictly', async () => {
    await workspaces.getOrCreateForBranch(TARGET);
    const branches = await gitService.listBranches(id(TARGET), { freshFetch: true, strictFetch: true });
    expect(branches.map((b) => b.name).sort()).toEqual(['alice/a', 'bob/b', TARGET].sort());
    expect(gitService.lastRemoteContact()?.ok).toBe(true);
  });
});

describe('touchesSharedRepositoryState', () => {
  it('names what rewrites the state every worktree shares', () => {
    for (const args of [
      ['fetch', '--no-write-fetch-head', 'origin'],
      ['-c', 'http.lowSpeedLimit=1000', 'fetch', 'origin'],
      ['gc', '--auto'],
      ['worktree', 'prune'],
      ['config', '--replace-all', 'branch.x.merge', 'refs/heads/x'],
      ['branch', '-D', 'x'],
      ['push', '-u', 'origin', 'x'],
      ['remote', 'set-url', 'origin', 'u'],
    ]) {
      expect(touchesSharedRepositoryState(args), args.join(' ')).toBe(true);
    }
    for (const args of [
      ['config', '--get', 'remote.origin.url'],
      ['commit', '-m', 'x'],
      ['push', 'origin', 'x'],
      ['branch', 'x', 'y'],
      ['status', '--porcelain'],
      ['rev-parse', 'HEAD'],
    ]) {
      expect(touchesSharedRepositoryState(args), args.join(' ')).toBe(false);
    }
  });
});
