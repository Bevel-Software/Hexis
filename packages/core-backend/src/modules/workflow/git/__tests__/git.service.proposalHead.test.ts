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

  it('reads a head already on the target against the target before it arrived', async () => {
    // A request sharing #7's commit: the head landed with #7's merge, so it
    // is read against that merge's first parent — its own edit, and not the
    // target's later work.
    const { headOf7 } = await seed();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf7);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['Pricing.md', 'modified', 1, 1],
    ]);
  });

  /**
   * Stacked drafts, no refresh (Local Testing attempt 19): B adds StackB.md,
   * C is cut from B and adds StackC.md, another request lands in between,
   * and C lands first carrying B's commit. B's apply stages nothing and
   * records B's own commit — already on the target — as the head.
   */
  async function seedStackedRaw(): Promise<{ headOfB: string }> {
    await seed();
    await runGit(repo, ['checkout', '-b', 'frss/stack-b', 'main']);
    await fs.writeFile(path.join(repo, 'StackB.md'), 'b\nb\nb\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'add StackB']);
    const headOfB = await gitOut(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['checkout', '-b', 'frss/stack-c', 'frss/stack-b']);
    await fs.writeFile(path.join(repo, 'StackC.md'), 'c\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'add StackC']);
    await runGit(repo, ['checkout', 'main']);
    await fs.writeFile(path.join(repo, 'Elsewhere.md'), 'someone else\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'another request']);
    await runGit(repo, ['merge', '--no-ff', '-m', mergeCommitSubject('Stack C', 13), 'frss/stack-c']);
    await fs.writeFile(path.join(repo, 'Later.md'), 'later\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'later work on the target']);
    await runGit(repo, ['push', 'origin', 'main']);
    await runGit(repo, ['branch', '-D', 'frss/stack-b', 'frss/stack-c']);
    // The head is on the target: the three-dot read lists nothing at all.
    expect(await gitOut(repo, ['diff', '--name-only', `main...${headOfB}`])).toBe('');
    return { headOfB };
  }

  it("lists a stacked draft's own change when it reached the target through the request cut from it", async () => {
    const { headOfB } = await seedStackedRaw();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOfB, {
      sourceBranch: 'frss/stack-b',
    });
    // Its own file only: not StackC.md (the request that carried it), not
    // Elsewhere.md or Later.md (the target's own work before and after).
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['StackB.md', 'added', 3, 0],
    ]);
  });

  /**
   * A head that lies on the target's first-parent line itself: its commit
   * reached the target without a merge (a fast-forward push), so no commit
   * on that line brought it in — the head is its own arrival.
   */
  async function seedOnLine(laterWork: boolean): Promise<{ head: string }> {
    await seed();
    await fs.writeFile(path.join(repo, 'OnLine.md'), 'x\ny\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'add OnLine']);
    const head = await gitOut(repo, ['rev-parse', 'HEAD']);
    if (laterWork) {
      await fs.writeFile(path.join(repo, 'Later.md'), 'later\n');
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-m', 'later work on the target']);
    }
    await runGit(repo, ['push', 'origin', 'main']);
    return { head };
  }

  it("reads a head on the target's first-parent line against its own parent, not itself", async () => {
    const { head } = await seedOnLine(true);
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', head);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['OnLine.md', 'added', 2, 0],
    ]);
  });

  it("reads a head that is the target's tip against its own parent", async () => {
    const { head } = await seedOnLine(false);
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', head);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['OnLine.md', 'added', 2, 0],
    ]);
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
    // Resolves when the read asks for the reservation: everything it does
    // before that has run by then, so a fetch ahead of the lock would show.
    let asked!: () => void;
    const reservationAsked = new Promise<void>((resolve) => (asked = resolve));
    const run = mutex.run.bind(mutex);
    vi.spyOn(mutex, 'run').mockImplementation(((key: string, fn: () => Promise<unknown>) => {
      if (key === workspaceId) asked();
      return run(key, fn);
    }) as typeof mutex.run);
    const read = git.changedFilesOfProposalHead(workspaceId, 'main', headOf9);
    // Another git operation holds the workspace: the read must not touch the
    // target's ref under it, so no fetch has run yet.
    await reservationAsked;
    expect(fetchesOf(runs)).toEqual([]);
    release();
    await held;
    expect((await read).map((f) => f.path)).toEqual(['Pricing.md']);
    expect(fetchesOf(runs)).toHaveLength(1);
  });

  it('gives the fetch it holds the reservation through a short deadline of its own', async () => {
    const { headOf9 } = await seedStaleTarget();
    const runs = vi.spyOn(runner, 'run');
    await git.changedFilesOfProposalHead(workspaceId, 'main', headOf9);
    const fetch = runs.mock.calls.find((c) => (c[1] as string[])[0] === 'fetch');
    const timeoutMs = (fetch?.[2] as { timeoutMs?: number } | undefined)?.timeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(15_000);
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

  /**
   * Stacked drafts (Local Testing attempt 18): B adds StackB.md; the target
   * moves on with another request's file; applying B refreshes its draft by
   * merging the target in; C, cut from B, lands first and carries B's commit.
   * B's apply then stages nothing and records its refresh merge as the head.
   * That head and the target now last met at TWO commits — B's own commit
   * and the target tip the refresh merged — and read from the first, the
   * diff is everything the refresh pulled from the target.
   */
  async function seedStacked(subject: string): Promise<{ headOfB: string }> {
    await seed();
    await runGit(repo, ['checkout', '-b', 'frss/stack-b', 'main']);
    await fs.writeFile(path.join(repo, 'StackB.md'), 'b\n');
    await runGit(repo, ['add', '-A']);
    // B's commit dated after the target's, as it was in the repro: git then
    // lists it first among the merge bases and a three-dot diff starts there.
    vi.stubEnv('GIT_COMMITTER_DATE', '2030-01-01T00:00:00Z');
    await runGit(repo, ['commit', '-m', 'add StackB']);
    vi.unstubAllEnvs();
    await runGit(repo, ['checkout', '-b', 'frss/stack-c', 'frss/stack-b']);
    await fs.writeFile(path.join(repo, 'StackC.md'), 'c\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'add StackC']);
    // Another request lands on the target while both drafts are open.
    await runGit(repo, ['checkout', 'main']);
    await fs.writeFile(path.join(repo, 'Elsewhere.md'), 'someone else\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'another request']);
    await runGit(repo, ['push', 'origin', 'main']);
    // B's apply refreshes its draft from the target...
    await runGit(repo, ['checkout', 'frss/stack-b']);
    await runGit(repo, ['merge', '--no-ff', '-m', subject, 'main']);
    const headOfB = await gitOut(repo, ['rev-parse', 'HEAD']);
    // ...while C lands with B's commit in it.
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, ['merge', '--no-ff', '-m', mergeCommitSubject('Stack C', 13), 'frss/stack-c']);
    await runGit(repo, ['push', 'origin', 'main']);
    await runGit(repo, ['branch', '-D', 'frss/stack-b', 'frss/stack-c']);
    const bases = await gitOut(repo, ['merge-base', '--all', 'main', headOfB]);
    expect(bases.split('\n')).toHaveLength(2);
    // The read this replaced: a three-dot diff starts from B's own commit.
    const threeDot = await gitOut(repo, ['diff', '--name-only', `main...${headOfB}`]);
    expect(threeDot.split('\n')).toContain('Elsewhere.md');
    return { headOfB };
  }

  it("reads a stacked draft's refresh merge against the target it merged, not the target's work", async () => {
    const { headOfB } = await seedStacked('Refresh frss/stack-b from main');
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOfB, {
      sourceBranch: 'frss/stack-b',
    });
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['StackB.md', 'added', 1, 0],
    ]);
  });

  it('answers no files when the head meets the target twice and is not its own refresh merge', async () => {
    const { headOfB } = await seedStacked('Merge main into frss/stack-b');
    expect(
      await git.changedFilesOfProposalHead(workspaceId, 'main', headOfB, { sourceBranch: 'frss/stack-b' }),
    ).toEqual([]);
  });

  it("answers no files for another branch's refresh merge, or with no branch to recognise it by", async () => {
    const { headOfB } = await seedStacked('Refresh frss/stack-b from main');
    expect(
      await git.changedFilesOfProposalHead(workspaceId, 'main', headOfB, { sourceBranch: 'frss/stack-c' }),
    ).toEqual([]);
    expect(await git.changedFilesOfProposalHead(workspaceId, 'main', headOfB)).toEqual([]);
  });

  it('refuses anything that is not a sha', async () => {
    await seed();
    await expect(git.changedFilesOfProposalHead(workspaceId, 'main', 'main')).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
  });
});
