import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { PullRebaseConflictError } from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/** See git.service.createBranch.test.ts — same prod-mirroring layout. */
async function seedWorkspace(root: string, workspaceId: string): Promise<{
  upstream: string;
  repo: string;
}> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);

  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'target-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await runGit(seed, ['commit', '--allow-empty', '-m', 'init']);
  await runGit(seed, ['push', 'origin', 'target-company-state']);
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/target-company-state']);

  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  // Give the clone a repo-local committer identity. Production workspaces
  // always have one (every commitFile commit relies on it), but the bare CI
  // runner has no global git identity — without this, a `pull --rebase` that
  // has to *replay* a local commit (the autostash regression below) dies with
  // "empty ident name". `GitService.git` runs git with the ambient env, so the
  // identity must live in the repo, not just in this test's runGit env.
  await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
  await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
  // autocrlf off: the autostash test reads back a file `git stash pop` wrote.
  // Under Git-for-Windows' system-level `core.autocrlf=true` that checkout
  // would rewrite the LF fixture as CRLF and fail the byte-for-byte assertion.
  // A no-op on Linux/CI.
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  return { upstream, repo };
}

/** Advance origin by one commit so a pull actually has something to fast-forward. */
async function advanceOrigin(root: string, upstream: string): Promise<void> {
  const pusher = path.join(root, '.pusher');
  await runGit(root, ['clone', upstream, pusher]);
  await fs.writeFile(path.join(pusher, 'remote-change.txt'), 'from origin\n');
  await runGit(pusher, ['add', '.']);
  await runGit(pusher, ['commit', '-m', 'remote change']);
  await runGit(pusher, ['push', 'origin', 'target-company-state']);
}

describe('GitService.pull', () => {
  let root: string;
  const workspaceId = 'target-company-state';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-pull-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Regression: a hand edit to the tracked branch can append a second
  // `branch.<name>.merge` line, after which a bare `pull --rebase` dies with
  // "Cannot rebase onto multiple branches". The explicit `pull origin <branch>`
  // plus upstream self-heal must recover and actually pull origin's commit.
  it('recovers from a multi-valued branch.<name>.merge config', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);
    await advanceOrigin(root, upstream);

    // Corrupt the upstream exactly as an out-of-band re-point would: a second
    // merge ref bolted onto the existing one.
    await runGit(repo, [
      'config', '--add', 'branch.target-company-state.merge', 'refs/heads/some-other-branch',
    ]);
    const mergeRefsBefore = (await gitOut(repo, [
      'config', '--get-all', 'branch.target-company-state.merge',
    ])).split('\n').filter(Boolean);
    expect(mergeRefsBefore.length).toBe(2);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: true });

    // The pull landed origin's commit...
    const head = await gitOut(repo, ['log', '-1', '--pretty=%s']);
    expect(head).toBe('remote change');
    const pulled = await fs.readFile(path.join(repo, 'remote-change.txt'), 'utf8');
    expect(pulled.trim()).toBe('from origin');

    // ...and the config self-healed back to a single merge ref.
    const mergeRefsAfter = (await gitOut(repo, [
      'config', '--get-all', 'branch.target-company-state.merge',
    ])).split('\n').filter(Boolean);
    expect(mergeRefsAfter).toEqual(['refs/heads/target-company-state']);
  });

  // Regression: the same clone can also accumulate a SECOND
  // `remote.origin.fetch` refspec — a re-run `git remote add`, a
  // `git remote set-branches --add`, a hand-edited `.git/config` — after which
  // one fetch maps the branch in twice and the refresh dies with "Cannot
  // rebase onto multiple branches". The pull must land origin's commit anyway
  // and collapse the refspec list back to the single canonical one.
  it('recovers from duplicated remote.origin.fetch refspecs', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);
    await advanceOrigin(root, upstream);

    await runGit(repo, [
      'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*',
    ]);
    await runGit(repo, [
      'config', '--add', 'remote.origin.fetch',
      '+refs/heads/target-company-state:refs/remotes/origin/target-company-state',
    ]);
    const refspecsBefore = (await gitOut(repo, [
      'config', '--get-all', 'remote.origin.fetch',
    ])).split('\n').filter(Boolean);
    expect(refspecsBefore.length).toBe(3);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: true });

    // Origin's commit landed...
    expect(await gitOut(repo, ['log', '-1', '--pretty=%s'])).toBe('remote change');
    // ...and the clone fetches through exactly one refspec again.
    const refspecsAfter = (await gitOut(repo, [
      'config', '--get-all', 'remote.origin.fetch',
    ])).split('\n').filter(Boolean);
    expect(refspecsAfter).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
  });

  // The invariant behind the reported failure: `.git/FETCH_HEAD` is a single
  // mutable file shared by every git process in the clone, and this app runs
  // fetches on the same clone from paths that don't share the workspace mutex.
  // A refresh that reads it can be steered by any of them; one that writes it
  // can steer them. So the refresh must do neither.
  it('neither reads nor writes the shared FETCH_HEAD', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);
    await advanceOrigin(root, upstream);

    // A hostile FETCH_HEAD: two for-merge entries, the first pointing at an
    // unrelated commit. This is what a concurrent bare `git fetch origin`
    // leaves on a clone whose `branch.<name>.merge` has drifted to two values
    // — and what made `git pull --rebase` die with "Cannot rebase onto
    // multiple branches".
    // The stray entry must name a commit the refresh can never legitimately
    // land on — this clone hasn't fetched yet, so plain `HEAD` still equals
    // `origin/target-company-state` and the assertion below would pass even if
    // FETCH_HEAD had been honoured. Park an unrelated commit in the object
    // store instead, then step off it.
    await runGit(repo, ['commit', '--allow-empty', '-m', 'stray']);
    const strayCommit = await gitOut(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['reset', '--hard', 'HEAD~1']);
    const originTip = await gitOut(repo, ['rev-parse', 'origin/target-company-state']);
    const hostile =
      `${strayCommit}\t\tbranch 'some-other-branch' of ${upstream}\n` +
      `${originTip}\t\tbranch 'target-company-state' of ${upstream}\n`;
    const fetchHeadPath = path.join(repo, '.git', 'FETCH_HEAD');
    await fs.writeFile(fetchHeadPath, hostile);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: true });

    // Landed origin's commit — not the stray head the hostile file names.
    expect(await gitOut(repo, ['log', '-1', '--pretty=%s'])).toBe('remote change');
    // ...and left the shared file exactly as it found it.
    expect(await fs.readFile(fetchHeadPath, 'utf8')).toBe(hostile);
  });

  // Regression (BEVA-114): the cooperative push recovery pulls --rebase to
  // integrate a diverged origin before retrying the push. A bare
  // `pull --rebase` aborts outright when the working tree carries a modified
  // tracked file ("cannot pull with rebase: You have unstaged changes") —
  // exactly the state the validator's dashboard regeneration leaves behind —
  // which strands the branch in an unrecoverable non-fast-forward loop.
  // `--autostash` must stash the dirty edit, rebase the local commit onto
  // origin, and reapply the edit so the retry push can fast-forward.
  it('rebases past a dirty tracked file via autostash', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);

    // A tracked, generated-style artifact shared by both sides as the base.
    await fs.writeFile(path.join(repo, 'dash.html'), 'v0\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'add dashboard']);
    await runGit(repo, ['push', 'origin', 'target-company-state']);

    // Origin advances independently...
    await advanceOrigin(root, upstream);

    // ...and so does the local branch → the two have diverged and a real
    // rebase (not a fast-forward) is required to reconcile them.
    await fs.writeFile(path.join(repo, 'local-change.txt'), 'local\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'local change']);

    // The validator-style regeneration leaves a modified tracked file dirty in
    // the working tree — the exact condition that makes a bare `pull --rebase`
    // abort with "you have unstaged changes".
    await fs.writeFile(path.join(repo, 'dash.html'), 'v1\n');

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: true });

    // Both commits are present — the local commit was rebased onto origin's.
    const log = await gitOut(repo, ['log', '--pretty=%s']);
    expect(log).toContain('remote change');
    expect(log).toContain('local change');
    const remote = await fs.readFile(path.join(repo, 'remote-change.txt'), 'utf8');
    expect(remote.trim()).toBe('from origin');

    // The dirty tracked edit survived — autostash reapplied it after the rebase.
    const dash = await fs.readFile(path.join(repo, 'dash.html'), 'utf8');
    expect(dash).toBe('v1\n');
  });

  // `treeChanged` is what keeps an "already up to date" sync from broadcasting
  // a tree change that did not happen (every catalog cache dropped, every
  // attached browser refetching its file tree). The fixture pulls above all
  // land a commit and assert `treeChanged: true`; this is the other half.
  it('reports treeChanged: false when origin has nothing new', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: false });
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  // TREE ids are compared, not commit ids: a pull that lands only an empty
  // commit moves HEAD but changes no content, and must not read as a tree
  // change — the consumers of this signal (catalog drops, browser file-tree
  // reloads) care about bytes, not refs.
  it('reports treeChanged: false for a pull that lands only an empty commit', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);
    const pusher = path.join(root, '.empty-pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'empty remote commit']);
    await runGit(pusher, ['push', 'origin', 'target-company-state']);
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.pull(workspaceId)).resolves.toEqual({ treeChanged: false });
    // HEAD DID move — the empty commit landed — which is exactly why commit
    // ids would have been the wrong thing to compare.
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).not.toBe(headBefore);
    expect(await gitOut(repo, ['log', '-1', '--pretty=%s'])).toBe('empty remote commit');
  });

  // The production stuck-workspace state: a local commit and an origin commit
  // both rewrote the same file, so replaying the local commit conflicts. The
  // pull must (a) abort the rebase so the clone isn't left in a detached
  // apply state, (b) surface a TYPED error naming the contested paths so the
  // workflow layer can queue background recovery, and (c) leave the local
  // commit intact (it's someone's saved content).
  it('throws PullRebaseConflictError with the conflicted paths and aborts the rebase cleanly', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);

    // Shared base version of the contested file.
    await fs.writeFile(path.join(repo, 'PR-7.html'), 'base\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'add overview']);
    await runGit(repo, ['push', 'origin', 'target-company-state']);

    // Origin rewrites it one way...
    const pusher = path.join(root, '.conflict-pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await fs.writeFile(path.join(pusher, 'PR-7.html'), 'origin version\n');
    await runGit(pusher, ['add', '.']);
    await runGit(pusher, ['commit', '-m', 'origin rewrite']);
    await runGit(pusher, ['push', 'origin', 'target-company-state']);

    // ...and the local branch rewrites it another way (the stranded commit).
    await fs.writeFile(path.join(repo, 'PR-7.html'), 'local version\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'local rewrite']);
    const localHead = await gitOut(repo, ['rev-parse', 'HEAD']);

    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    const err = await svc.pull(workspaceId).then(() => null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRebaseConflictError);
    expect((err as PullRebaseConflictError).branch).toBe('target-company-state');
    expect((err as PullRebaseConflictError).conflictedPaths).toEqual(['PR-7.html']);

    // The rebase was aborted: no in-progress rebase state, clean tree, and
    // the local commit is still HEAD with its version of the file on disk.
    await expect(
      fs.access(path.join(repo, '.git', 'rebase-merge')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(localHead);
    // \r tolerated: Windows checkouts with autocrlf rewrite the file on the
    // abort's checkout — content identity is what matters here.
    const onDisk = await fs.readFile(path.join(repo, 'PR-7.html'), 'utf8');
    expect(onDisk.replace(/\r/g, '')).toBe('local version\n');
  });

  // hasUnpushedCommits backs the worker's no-op arm (see runPendingCommit).
  it('hasUnpushedCommits: false when in sync, true once a local commit lands', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );

    await expect(svc.hasUnpushedCommits(workspaceId)).resolves.toBe(false);

    await fs.writeFile(path.join(repo, 'new.txt'), 'x\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'unpushed']);
    await expect(svc.hasUnpushedCommits(workspaceId)).resolves.toBe(true);

    await runGit(repo, ['push', 'origin', 'target-company-state']);
    await expect(svc.hasUnpushedCommits(workspaceId)).resolves.toBe(false);
  });
});
