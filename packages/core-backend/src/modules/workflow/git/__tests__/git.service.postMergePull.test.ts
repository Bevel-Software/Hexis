import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/platform-shared';
import { GitService } from '../git.service.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * The post-merge refresh path: `WorkflowService.mergeChangeRequest` merges a
 * change request onto `origin/<base>` and then pulls the BASE branch's own
 * workspace so its working tree (what every file read serves) isn't left behind
 * the remote.
 *
 * The bug this covers: that pull ran against a clone whose git config had
 * drifted — a duplicated `remote.origin.fetch` refspec and/or a multi-valued
 * `branch.<base>.merge` — so git refused to refresh it with "Cannot rebase onto
 * multiple branches", and the merge was followed by a
 * `[merge] post-merge pull … failed` warning with the workspace stuck on the
 * pre-merge tree.
 */

const execFileAsync = promisify(execFile);
const BASE = 'current-company-state';
const SOURCE = 'alice/add-feature';
const KB_DIR = 'knowledge-base';
const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

/** Clone `branch` into `<root>/<wsId>/knowledge-base`, like prod's layout. */
async function cloneWorkspace(root: string, upstream: string, branch: string): Promise<string> {
  const wsDir = path.join(root, encodeURIComponent(branch));
  const repo = path.join(wsDir, KB_DIR);
  await fs.mkdir(wsDir, { recursive: true });
  await runGit(root, ['clone', '-b', branch, upstream, repo]);
  await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
  await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
  return repo;
}

/**
 * Bare upstream carrying BASE and a SOURCE branch with one new file, plus the
 * two workspaces prod would have: the source draft's (where the merge runs) and
 * the base branch's own (the one the post-merge pull refreshes).
 */
async function seed(root: string) {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', BASE, upstream]);

  const seedDir = path.join(root, '.seed');
  await fs.mkdir(seedDir);
  await runGit(seedDir, ['init', '-b', BASE]);
  await runGit(seedDir, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seedDir, 'base.md'), 'base\n');
  await runGit(seedDir, ['add', '-A']);
  await runGit(seedDir, ['commit', '-m', 'base']);
  await runGit(seedDir, ['push', 'origin', BASE]);
  await runGit(seedDir, ['checkout', '-b', SOURCE]);
  await fs.writeFile(path.join(seedDir, 'feature.md'), 'from the change request\n');
  await runGit(seedDir, ['add', '-A']);
  await runGit(seedDir, ['commit', '-m', 'add feature']);
  await runGit(seedDir, ['push', 'origin', SOURCE]);

  const sourceRepo = await cloneWorkspace(root, upstream, SOURCE);
  const baseRepo = await cloneWorkspace(root, upstream, BASE);
  return { upstream, sourceRepo, baseRepo };
}

describe('post-merge refresh of the target branch workspace', () => {
  let root: string;
  const sourceWsId = encodeURIComponent(SOURCE);
  const baseWsId = encodeURIComponent(BASE);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-post-merge-pull-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });

  it('pulls the target workspace up to origin after a merge, even with a drifted clone config', async () => {
    const { sourceRepo, baseRepo } = await seed(root);

    // The target branch's workspace has drifted into the state that strands the
    // refresh: the branch tracks two merge refs and origin is fetched through
    // three refspecs.
    await runGit(baseRepo, ['config', '--add', `branch.${BASE}.merge`, `refs/heads/${SOURCE}`]);
    await runGit(baseRepo, ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await runGit(baseRepo, [
      'config', '--add', 'remote.origin.fetch', `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`,
    ]);
    // Guard: in this state git really does refuse to rebase — without the fix
    // this is exactly what the post-merge pull hit. `LC_ALL`/`LANG` pinned to
    // `C` for the same reason `GitService.git` pins them: the assertion below
    // matches git's English text, and a non-English runner would otherwise
    // report a false regression.
    await expect(
      execFileAsync('git', ['pull', '--rebase'], {
        cwd: baseRepo,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }),
    ).rejects.toThrow(/multiple branches/i);

    const git = new GitService(
      stubWorkspaceService({
        [sourceWsId]: path.dirname(sourceRepo),
        [baseWsId]: path.dirname(baseRepo),
      }),
      stubWorkflowHooks(),
      KB_DIR,
    );

    // 1. The merge lands on origin/BASE (run from the caller's workspace).
    const merged = await git.mergeChangeRequest(
      sourceWsId, SOURCE, BASE, { subject: 'Add feature (#1)', body: 'Merged via Bevel' }, USER,
    );
    expect(merged.kind).toBe('merged');

    // 2. The post-merge refresh of the TARGET branch's own workspace succeeds.
    await expect(git.pull(baseWsId)).resolves.toBeUndefined();

    // The workspace is at origin's head, and serves the merged file.
    const originHead = await gitOut(baseRepo, ['rev-parse', `origin/${BASE}`]);
    expect(await gitOut(baseRepo, ['rev-parse', 'HEAD'])).toBe(originHead);
    if (merged.kind === 'merged') expect(originHead).toBe(merged.sha);
    const feature = await fs.readFile(path.join(baseRepo, 'feature.md'), 'utf8');
    expect(feature.replace(/\r\n/g, '\n')).toBe('from the change request\n');

    // The clone was repaired rather than merely worked around, so the next
    // refresh starts from a healthy config.
    const mergeRefs = (await gitOut(baseRepo, ['config', '--get-all', `branch.${BASE}.merge`]))
      .split('\n').filter(Boolean);
    expect(mergeRefs).toEqual([`refs/heads/${BASE}`]);
    const refspecs = (await gitOut(baseRepo, ['config', '--get-all', 'remote.origin.fetch']))
      .split('\n').filter(Boolean);
    expect(refspecs).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
  });

  // The reported failure, reproduced. `git pull` reads its rebase target from
  // `.git/FETCH_HEAD`, and the app fetches into the same clone from paths that
  // don't share the workspace mutex (`GitService.fetchOriginIfStale`,
  // `WorkspaceService.ensureRemotesFetched` — both driven by the polling the UI
  // does around a merge). On a clone whose `branch.<base>.merge` has drifted to
  // two values, one of those bare fetches writes TWO for-merge FETCH_HEAD
  // entries; landing inside the pull's fetch→read window makes it die with
  // "Cannot rebase onto multiple branches".
  //
  // Reproduced deterministically below: the drift is applied, ONE real bare
  // fetch is run to capture the exact FETCH_HEAD bytes it produces (asserted to
  // carry two for-merge entries — the loaded gun), and a second process then
  // replays those real bytes in a tight loop while the refresh runs. Replaying
  // is the concurrent fetch's last step; looping it removes the timing luck
  // that a `git fetch` loop leaves to chance. Against the pre-fix
  // `git pull --rebase --autostash origin <base>` this dies with the reported
  // fatal; the refresh now touches no shared state, so it cannot.
  it('refreshes the target workspace while a concurrent fetch rewrites FETCH_HEAD', async () => {
    const { sourceRepo, baseRepo } = await seed(root);
    const git = new GitService(
      stubWorkspaceService({
        [sourceWsId]: path.dirname(sourceRepo),
        [baseWsId]: path.dirname(baseRepo),
      }),
      stubWorkflowHooks(),
      KB_DIR,
    );

    const merged = await git.mergeChangeRequest(
      sourceWsId, SOURCE, BASE, { subject: 'Add feature (#1)', body: 'Merged via Bevel' }, USER,
    );
    expect(merged.kind).toBe('merged');

    // The drift, then one real bare fetch — exactly what
    // `fetchOriginIfStale` / `ensureRemotesFetched` run outside the mutex.
    await runGit(baseRepo, ['config', '--add', `branch.${BASE}.merge`, `refs/heads/${SOURCE}`]);
    await runGit(baseRepo, ['fetch', '--prune', 'origin']);
    const fetchHeadPath = path.join(baseRepo, '.git', 'FETCH_HEAD');
    const concurrentFetchWrote = await fs.readFile(fetchHeadPath, 'utf8');
    const forMerge = concurrentFetchWrote
      .split('\n').filter((l) => l && !l.includes('not-for-merge'));
    expect(forMerge.length).toBe(2);

    // Now run that same bare fetch in a loop alongside the refresh. It re-adds
    // the drift each round the way whatever added it in production kept doing
    // — the refresh's own self-heal would otherwise disarm the reproduction
    // after round one. A real `git fetch` (rather than a tight write loop) also
    // keeps the competitor self-throttling instead of starving the box.
    //
    // Driven from Node rather than `sh -c` so the suite stays runnable on
    // Windows: each round still spawns real, genuinely concurrent git
    // processes — `git.pull` is awaiting its own child while these run.
    let stop = false;
    const noise = (async () => {
      while (!stop) {
        await runGit(baseRepo, [
          'config', '--add', `branch.${BASE}.merge`, `refs/heads/${SOURCE}`,
        ]).catch(() => undefined);
        await runGit(baseRepo, ['fetch', '--prune', 'origin']).catch(() => undefined);
      }
    })();
    try {
      // ~40% of rounds hit the fatal pre-fix (measured), so 20 rounds makes a
      // pre-fix regression a practical certainty while staying quick.
      for (let round = 0; round < 20; round += 1) {
        await expect(git.pull(baseWsId)).resolves.toBeUndefined();
      }
    } finally {
      stop = true;
      await noise;
    }

    // Still exactly where the merge left origin, with the merged file served.
    expect(await gitOut(baseRepo, ['rev-parse', 'HEAD']))
      .toBe(await gitOut(baseRepo, ['rev-parse', `origin/${BASE}`]));
    const feature = await fs.readFile(path.join(baseRepo, 'feature.md'), 'utf8');
    expect(feature.replace(/\r\n/g, '\n')).toBe('from the change request\n');
  }, 60_000);

  // The same config drift, one step earlier in the flow. `git fetch origin
  // <branch>` updates `refs/remotes/origin/<branch>` only *opportunistically* —
  // git consults `remote.origin.fetch` to decide — so a refspec narrowed to
  // some other branch leaves `origin/<source>` frozen at whatever the clone
  // last saw. The merge then lands a stale source tip on the base and the CR's
  // latest revision silently goes missing (and every push attempt burns against
  // the same stale ref). Naming the destination refspecs explicitly is what
  // makes the fetch independent of that config.
  it('merges the latest source tip even when remote.origin.fetch no longer covers it', async () => {
    const { upstream, sourceRepo, baseRepo } = await seed(root);

    // Drift: the clone the merge runs in now fetches ONLY the base branch, so
    // nothing refreshes `origin/<SOURCE>` through ambient config any more.
    await runGit(sourceRepo, [
      'config', '--replace-all', 'remote.origin.fetch',
      `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`,
    ]);

    // The change request gets another revision pushed after that clone's last
    // sight of it — the commit the merge must not miss.
    const author = path.join(root, '.author');
    await runGit(root, ['clone', '-b', SOURCE, upstream, author]);
    await fs.writeFile(path.join(author, 'revision.md'), 'second revision\n');
    await runGit(author, ['add', '-A']);
    await runGit(author, ['commit', '-m', 'address review feedback']);
    await runGit(author, ['push', 'origin', SOURCE]);
    const latestSource = await gitOut(author, ['rev-parse', 'HEAD']);

    const git = new GitService(
      stubWorkspaceService({
        [sourceWsId]: path.dirname(sourceRepo),
        [baseWsId]: path.dirname(baseRepo),
      }),
      stubWorkflowHooks(),
      KB_DIR,
    );

    const merged = await git.mergeChangeRequest(
      sourceWsId, SOURCE, BASE, { subject: 'Add feature (#1)', body: 'Merged via Bevel' }, USER,
    );
    expect(merged.kind).toBe('merged');

    // Origin's base carries the LATEST source commit, not the tip the drifted
    // refspec would have left behind.
    const upstreamLog = await gitOut(upstream, ['log', '--format=%H', BASE]);
    expect(upstreamLog.split('\n')).toContain(latestSource);

    // ...and the post-merge refresh of the base workspace serves that revision.
    await expect(git.pull(baseWsId)).resolves.toBeUndefined();
    const revision = await fs.readFile(path.join(baseRepo, 'revision.md'), 'utf8');
    expect(revision.replace(/\r\n/g, '\n')).toBe('second revision\n');
  });
});
