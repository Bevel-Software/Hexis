import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { NodeGitRunner } from '../node-git-runner.js';
import { WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { mergeCommitSubject } from '../merge-commit.js';
import { WorkspaceMutex } from '../../../kb-fs/mutex.js';
import { runGit, gitOut, stubWorkspaceService } from './git-test-helpers.js';

/**
 * The files an applied change request proposed when its apply made no merge
 * commit of its own (hx-finished-request-says-so): request #8 carried the
 * same change as #7, #7 landed first, so applying #8 staged nothing and wrote
 * no commit. Nothing on the target names #8's files; the source head its
 * merge-log row recorded still does.
 */
describe('GitService.changedFilesOfProposalHead', () => {
  const workspaceId = 'ws-proposal-head';
  let root: string;
  let repo: string;
  let git: GitService;
  // The runner the service is given, so a test can see every git command it
  // runs — fetches above all — without reaching into the service.
  let runner: NodeGitRunner;
  // The workspace reservation the service takes, so a test can hold it.
  let mutex: WorkspaceMutex;

  /** The `git fetch` argument lists the service ran since `runs` began watching. */
  function fetchesOf(runs: { mock: { calls: unknown[][] } }): string[][] {
    return runs.mock.calls.map(([, args]) => args as string[]).filter((args) => args[0] === 'fetch');
  }

  /** The bare repository the clone fetches its target from. */
  let origin: string;

  async function seed(): Promise<{ headOf8: string; headOf7: string }> {
    repo = path.join(root, workspaceId, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(path.dirname(repo), ['init', '-b', 'main', 'knowledge-base']);
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);
    await fs.writeFile(path.join(repo, 'Pricing.md'), 'basic\n');
    await fs.writeFile(path.join(repo, 'Other.md'), 'other\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'init']);

    // #7 and #8: the same edit, on two branches, as two different commits.
    for (const branch of ['robin/seven', 'robin/eight']) {
      await runGit(repo, ['checkout', '-b', branch, 'main']);
      await fs.writeFile(path.join(repo, 'Pricing.md'), 'premium\n');
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-m', `edit on ${branch}`]);
    }
    const headOf7 = await gitOut(repo, ['rev-parse', 'robin/seven']);
    const headOf8 = await gitOut(repo, ['rev-parse', 'robin/eight']);

    // #7 lands with a merge commit of its own; the target moves on in an
    // unrelated file afterwards.
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, ['merge', '--no-ff', '-m', mergeCommitSubject('Raise the price', 7), 'robin/seven']);
    await fs.writeFile(path.join(repo, 'Other.md'), 'changed later\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'unrelated work on the target']);
    // Both branches retire with their requests.
    await runGit(repo, ['branch', '-D', 'robin/seven', 'robin/eight']);
    // Origin holds the target, and neither retired branch.
    origin = path.join(root, 'origin.git');
    await runGit(root, ['init', '--bare', '-b', 'main', 'origin.git']);
    await runGit(repo, ['remote', 'add', 'origin', origin]);
    await runGit(repo, ['push', 'origin', 'main']);

    runner = new NodeGitRunner();
    mutex = new WorkspaceMutex();
    git = new GitService(
      stubWorkspaceService({ [workspaceId]: path.dirname(repo) }),
      new WorkflowHooks(),
      testKbContext(),
      mutex,
      null,
      runner,
    );
    return { headOf8, headOf7 };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-proposal-head-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('answers the files the request proposed, though the target already holds them', async () => {
    const { headOf8 } = await seed();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf8);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['Pricing.md', 'modified', 1, 1],
    ]);
  });

  it("reports nothing the target did on its own, and none of another request's work", async () => {
    const { headOf8 } = await seed();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf8);
    expect(files.map((f) => f.path)).not.toContain('Other.md');
  });

  it('answers nothing for a head that is already part of the target', async () => {
    const { headOf7 } = await seed();
    expect(await git.changedFilesOfProposalHead(workspaceId, 'main', headOf7)).toEqual([]);
  });

  it('refuses a head this clone does not hold, rather than reaching for it', async () => {
    await seed();
    const runs = vi.spyOn(runner, 'run');
    const missing = 'e'.repeat(40);
    await expect(git.changedFilesOfProposalHead(workspaceId, 'main', missing)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
    // Not a fetch that was tried and failed: no fetch ever names the head.
    expect(fetchesOf(runs).flat().join(' ')).not.toContain(missing);
  });

  /**
   * A head forked from a target tip this clone's `origin/main` has not seen:
   * read against the stale ref, the target's own later work would show as
   * the request's. The target is refreshed from origin first; the head's
   * branch is gone from origin and is never asked for.
   */
  async function seedStaleTarget(): Promise<{ headOf9: string }> {
    await seed();
    const init = await gitOut(repo, ['rev-list', '--max-parents=0', 'main']);
    await runGit(repo, ['checkout', '-b', 'robin/nine', 'main']);
    await fs.writeFile(path.join(repo, 'Pricing.md'), 'gold\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'edit on robin/nine']);
    const headOf9 = await gitOut(repo, ['rev-parse', 'robin/nine']);
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, ['branch', '-D', 'robin/nine']);
    // The clone last saw the target before any of its later work — before
    // even the commit robin/nine forked from.
    await runGit(repo, ['update-ref', 'refs/remotes/origin/main', init]);
    return { headOf9 };
  }

  it('refreshes the target before reading, so its later work is not the request\'s', async () => {
    const { headOf9 } = await seedStaleTarget();
    const runs = vi.spyOn(runner, 'run');
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf9);
    // One fetch, of the target alone: never the head, its sha or its branch.
    const fetches = fetchesOf(runs);
    expect(fetches).toEqual([
      ['fetch', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    ]);
    expect(fetches.flat().join(' ')).not.toContain(headOf9);
    expect(files.map((f) => f.path)).toEqual(['Pricing.md']);
    expect(await gitOut(repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      await gitOut(repo, ['rev-parse', 'main']),
    );
  });

  it('fetches the target only under the workspace reservation, with the read that relies on it', async () => {
    const { headOf9 } = await seedStaleTarget();
    const runs = vi.spyOn(runner, 'run');
    let release!: () => void;
    const held = mutex.run(workspaceId, () => new Promise<void>((resolve) => (release = resolve)));
    const read = git.changedFilesOfProposalHead(workspaceId, 'main', headOf9);
    // Another git operation holds the workspace: the read must not touch the
    // target's ref under it, so no fetch has run yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchesOf(runs)).toEqual([]);
    release();
    await held;
    expect((await read).map((f) => f.path)).toEqual(['Pricing.md']);
    expect(fetchesOf(runs)).toHaveLength(1);
  });

  it("fails closed when origin cannot be reached and the clone's target predates the fork", async () => {
    const { headOf9 } = await seedStaleTarget();
    await fs.rm(origin, { recursive: true, force: true });
    // Read against the stale tip, Other.md (the target's own later work)
    // would show as this request's. No answer at all is the honest one.
    const err = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Retryable, not "this head is not readable here".
    expect(err).not.toBeInstanceOf(WorkflowValidationError);
    // And the read against the same stale tip is exactly what it refused.
    const stale = await gitOut(repo, ['diff', '--name-only', `refs/remotes/origin/main...${headOf9}`]);
    expect(stale.split('\n')).toContain('Other.md');
  });

  it('reads again once origin answers again', async () => {
    const { headOf9 } = await seedStaleTarget();
    const moved = path.join(root, 'origin-away.git');
    await fs.rename(origin, moved);
    await expect(git.changedFilesOfProposalHead(workspaceId, 'main', headOf9)).rejects.toBeInstanceOf(Error);
    await fs.rename(moved, origin);
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf9);
    expect(files.map((f) => f.path)).toEqual(['Pricing.md']);
  });

  it('a git failure other than "no such object" propagates as itself', async () => {
    const { headOf8 } = await seed();
    // A clone whose object store is broken is not a clone that lacks the head.
    await fs.rm(path.join(repo, '.git', 'objects'), { recursive: true, force: true });
    await fs.writeFile(path.join(repo, '.git', 'objects'), 'not a directory');
    const err = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkflowValidationError);
  });

  it('refuses anything that is not a sha', async () => {
    await seed();
    await expect(git.changedFilesOfProposalHead(workspaceId, 'main', 'main')).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
  });
});
