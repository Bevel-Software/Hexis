import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkspaceMutex } from '../../../kb-fs/mutex.js';

/**
 * Every git process the service starts, by argv, so a test can say what a
 * change-request read is allowed to cost. The fixture's own git runs through
 * `execFile` and is not logged.
 */
const { spawnLog } = vi.hoisted(() => ({ spawnLog: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((file: string, args: string[], options: unknown) => {
    if (file === 'git') spawnLog.push(args ?? []);
    return (actual.spawn as unknown as (...a: unknown[]) => unknown)(file, args, options);
  }) as unknown as typeof actual.spawn;
  return { ...actual, spawn };
});

const execFileAsync = promisify(execFile);

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

const spawnsOf = (subcommand: string) => spawnLog.filter((argv) => argv.includes(subcommand)).length;

/**
 * What a change request's changed paths cost: the tips come from the ref
 * files and the diff is read from git ONCE per pair of commits. A listing
 * that nothing has moved under asks git for nothing; a push moves a tip,
 * and that request alone is diffed again.
 */
describe('a change request is diffed once per pair of commits', () => {
  let root: string;
  let upstream: string;
  let repo: string;
  let other: string;
  let svc: GitService;
  const workspaceId = 'ws-main';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-changed-memo-'));
    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'main', upstream]);
    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', 'main']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await fs.writeFile(path.join(seed, 'base.md'), 'base\n');
    await runGit(seed, ['add', '-A']);
    await runGit(seed, ['commit', '-m', 'init']);
    await runGit(seed, ['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(seed, 'one.md'), 'one\n');
    await runGit(seed, ['add', '-A']);
    await runGit(seed, ['commit', '-m', 'one']);
    await runGit(seed, ['push', 'origin', 'main', 'feature']);
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(workspaceDir, { recursive: true });
    await runGit(root, ['clone', upstream, repo]);
    other = path.join(root, 'other');
    await runGit(root, ['clone', upstream, other]);
    const workspace = {
      getWorkspacePath: async (id: string) => {
        if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
        return workspaceDir;
      },
    } as unknown as WorkspaceService;
    svc = new GitService(
      workspace,
      new WorkflowHooks(),
      testKbContext({ branchModel: { defaultBranch: 'main', protectedBranches: ['main'] } }),
      new WorkspaceMutex(),
    );
    spawnLog.length = 0;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the tips from the ref files, diffs once, and asks git nothing the second time', async () => {
    const first = await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'feature', { fetch: false });
    expect(first.paths).toEqual(['one.md']);
    expect(first.pairs).toEqual([{ path: 'one.md' }]);
    expect(spawnsOf('diff')).toBe(1);
    expect(spawnsOf('rev-parse')).toBe(0);

    spawnLog.length = 0;
    const second = await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'feature', { fetch: false });
    expect(second).toEqual(first);
    expect(spawnLog).toEqual([]);

    // The access-check flavour reads the same pair: the memo answers it too.
    spawnLog.length = 0;
    expect(await svc.changedPathsForPr(workspaceId, 'main', 'feature', { fetch: false, forAccessCheck: true })).toEqual(['one.md']);
    expect(spawnLog).toEqual([]);
  });

  it('diffs again, once, when a push moves a tip', async () => {
    await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'feature', { fetch: false });
    // Someone else pushes to feature; the workspace fetches as a listing's
    // whole-clone refresh does, which rewrites the ref file.
    await runGit(other, ['checkout', 'feature']);
    await fs.writeFile(path.join(other, 'two.md'), 'two\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'two']);
    await runGit(other, ['push', 'origin', 'feature']);
    await runGit(repo, ['fetch', 'origin']);

    spawnLog.length = 0;
    const after = await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'feature', { fetch: false });
    expect(after.paths.sort()).toEqual(['one.md', 'two.md']);
    expect(spawnsOf('diff')).toBe(1);
    expect(spawnsOf('rev-parse')).toBe(0);

    spawnLog.length = 0;
    expect(await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'feature', { fetch: false })).toEqual(after);
    expect(spawnLog).toEqual([]);
  });

  it('still asks git about a branch the ref files do not hold, and answers as before', async () => {
    // A branch this clone has never fetched: the files say missing for both
    // of its names, which is rev-parse's answer too — and `fetch: false`
    // then turns into the per-request fetch the caller was promised.
    await runGit(other, ['checkout', '-b', 'later']);
    await fs.writeFile(path.join(other, 'three.md'), 'three\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'three']);
    await runGit(other, ['push', 'origin', 'later']);

    spawnLog.length = 0;
    const got = await svc.changedPathsAndPairsForPr(workspaceId, 'main', 'later', { fetch: false });
    expect(got.paths).toEqual(['three.md']);
    expect(spawnsOf('fetch')).toBe(1);
    expect(spawnsOf('diff')).toBe(1);
  });
});
