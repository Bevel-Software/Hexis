import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { NodeGitRunner } from '../node-git-runner.js';
import type { IGitRunner } from '../../../../shared/git.contract.js';

const execFileAsync = promisify(execFile);

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-list-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com' },
  });
}

/**
 * Seeds a bare upstream repo with protected + draft branches, then clones it
 * into `<root>/<workspaceId>/knowledge-base` to match the layout GitService
 * expects via `workspaceService.getWorkspacePath`.
 */
async function seedWorkspace(root: string, workspaceId: string): Promise<{ upstream: string; repo: string }> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'current-company-state', upstream]);

  // A scratch clone to create the initial branches, then push them upstream.
  // Can't pass `-b current-company-state` because the bare repo has no refs yet;
  // instead we init a regular repo on that branch and wire up origin manually.
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'current-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await runGit(seed, ['commit', '--allow-empty', '-m', 'init']);
  await runGit(seed, ['branch', 'target-company-state']);
  await runGit(seed, ['branch', 'alice/draft-one']);
  await runGit(seed, [
    'push', 'origin',
    'current-company-state', 'target-company-state', 'alice/draft-one',
  ]);
  // Point upstream's HEAD at current-company-state so a fresh clone checks it out.
  await runGit(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/current-company-state']);

  // Per-user clone — matches what workspace.service.ts does in prod.
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  return { upstream, repo };
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

describe('GitService.listBranches', () => {
  let root: string;
  const workspaceId = 'ws-list-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('unions local heads with refs/remotes/origin so target-company-state and pushed drafts appear', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );

    const branches = await svc.listBranches(workspaceId);
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['alice/draft-one', 'current-company-state', 'target-company-state']);

    const protectedBranches = branches.filter((b) => b.isProtected).map((b) => b.name).sort();
    expect(protectedBranches).toEqual(['current-company-state', 'target-company-state']);
    // Under the per-branch workspace model `BranchInfo` no longer carries an
    // `isCurrent` flag — the workspace's identity IS the current branch.
    // Consumers derive it as `branch.name === decodeURIComponent(workspaceId)`.
  });

  it('skips the origin/HEAD symbolic ref instead of surfacing it as a branch named "origin"', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );

    const branches = await svc.listBranches(workspaceId);
    expect(branches.find((b) => b.name === 'origin')).toBeUndefined();
    expect(branches.find((b) => b.name === 'HEAD')).toBeUndefined();
    expect(branches.find((b) => b.name === 'origin/HEAD')).toBeUndefined();
  });

  it('picks up a branch pushed to upstream after the first listBranches call (auto-fetch)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );
    // Prime the cache: first call fetches and populates lastImplicitFetchAt.
    await svc.listBranches(workspaceId);

    // Push a new branch to upstream via a throwaway clone (bypass the debounce
    // by constructing a fresh GitService instance — separate in-memory state).
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await runGit(pusher, ['checkout', '-b', 'bob/draft-two']);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'bob change']);
    await runGit(pusher, ['push', 'origin', 'bob/draft-two']);

    const freshSvc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );
    const branches = await freshSvc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).toContain('bob/draft-two');
  });

  it('serves the known branch list when origin is unreachable (fetch failure is swallowed)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    // Nuke upstream so fetch fails; remote-tracking refs already in the consumer clone survive.
    await fs.rm(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );

    // Should not throw and should return the refs we already had on disk.
    const branches = await svc.listBranches(workspaceId);
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['alice/draft-one', 'current-company-state', 'target-company-state']);
  });

  it('returns local branches before remote-only ones, then alphabetically', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );

    // current-company-state is the workspace clone's checked-out branch (the
    // only local head); the rest are remote-only. The result order must be
    // local-first then alphabetical.
    const branches = await svc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).toEqual([
      'current-company-state',
      'alice/draft-one',
      'target-company-state',
    ]);
  });

  it('skips the implicit fetch after noteWorkspaceFetched (a fresh clone already has every ref)', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );
    // Simulate a just-completed clone — the workspace is freshly fetched.
    svc.noteWorkspaceFetched(workspaceId);

    // Push a new branch upstream. A normal listBranches would fetch and see
    // it; with the implicit fetch skipped it must not appear yet.
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', upstream, pusher]);
    await runGit(pusher, ['checkout', '-b', 'carol/draft-three']);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'carol change']);
    await runGit(pusher, ['push', 'origin', 'carol/draft-three']);

    const branches = await svc.listBranches(workspaceId);
    expect(branches.map((b) => b.name)).not.toContain('carol/draft-three');
  });

  // A listing is the one moment the platform sees origin's set of branches,
  // and the workspace layer needs that memory to tell a branch that was
  // DELETED (410) from a name that never existed (404). Wired in the
  // composition root; the listener is how the fact gets there.
  it('tells the listener every branch name the listing returned', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );
    const seen: string[][] = [];
    svc.setBranchesListedListener((names) => seen.push(names));

    const branches = await svc.listBranches(workspaceId);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(branches.map((b) => b.name));
    expect(seen[0]).toContain('alice/draft-one');
  });

  it('still serves the listing when the listener throws', async () => {
    await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
    );
    svc.setBranchesListedListener(() => { throw new Error('listener blew up'); });

    await expect(svc.listBranches(workspaceId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alice/draft-one' })]),
    );
  });

  // A listing names branches; it counts nothing. Counting cost one to three
  // `rev-list` spawns a branch — about 120 git processes a listing on a
  // knowledge base with 121 branches — for numbers no listing reader shows.
  it('runs no git per branch: a listing over many branches spawns the same few commands as one over three', async () => {
    const { upstream } = await seedWorkspace(root, workspaceId);
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', upstream, pusher]);
    const drafts = Array.from({ length: 12 }, (_, i) => `team/draft-${String(i).padStart(2, '0')}`);
    for (const d of drafts) {
      await runGit(pusher, ['checkout', '-q', '-b', d, 'origin/current-company-state']);
      await runGit(pusher, ['commit', '--allow-empty', '-m', d]);
    }
    await runGit(pusher, ['push', '-q', 'origin', ...drafts]);
    // The workspace's own branch carries an upstream and local commits too:
    // exactly what the old listing counted against.
    const repo = path.join(root, workspaceId, 'knowledge-base');
    await runGit(repo, ['commit', '--allow-empty', '-m', 'unshared']);

    const { runner, commands } = recordingRunner();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      new WorkflowHooks(),
      testKbContext(),
      undefined,
      null,
      runner,
    );
    const branches = await svc.listBranches(workspaceId);

    expect(branches.map((b) => b.name)).toEqual([
      'current-company-state',
      'alice/draft-one',
      'target-company-state',
      ...drafts,
    ]);
    expect(branches[0]).toEqual({ name: 'current-company-state', isProtected: true, hasRemote: true });
    for (const b of branches) expect(Object.keys(b).sort()).toEqual(['hasRemote', 'isProtected', 'name']);
    expect(commands.filter((c) => c === 'rev-list')).toEqual([]);
    // Its fetch, and the two reads of what the repository holds — whatever
    // the number of branches.
    expect([...commands].sort()).toEqual(['fetch', 'for-each-ref', 'symbolic-ref']);
  });
});

/** The real runner, recording the subcommand of every git it is asked to run. */
function recordingRunner(): { runner: IGitRunner; commands: string[] } {
  const inner = new NodeGitRunner();
  const commands: string[] = [];
  const runner = {
    defaultTimeoutMs: inner.defaultTimeoutMs,
    credentials: inner.credentials,
    run: async (cwd: string, args: string[], opts?: object) => {
      // Skip `-c key=value` pairs: the subcommand is the first bare word.
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-c' ? 2 : 1;
      commands.push(args[i] ?? '');
      return inner.run(cwd, args, opts as never);
    },
  } as unknown as IGitRunner;
  return { runner, commands };
}

describe('GitService.branchCounts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const draftWs = encodeURIComponent('alice/draft-one');

  /** The draft's own workspace, on the draft, three commits ahead of what it shared. */
  async function seedDraft(): Promise<{ upstream: string; repo: string }> {
    const { upstream, repo } = await seedWorkspace(root, draftWs);
    await runGit(repo, ['checkout', '-q', 'alice/draft-one']);
    for (const m of ['one', 'two', 'three']) await runGit(repo, ['commit', '--allow-empty', '-m', m]);
    return { upstream, repo };
  }

  function svcFor(runner: IGitRunner = new NodeGitRunner(), kb = testKbContext()): GitService {
    return new GitService(stubWorkspaceService(draftWs, path.join(root, draftWs)), new WorkflowHooks(), kb, undefined, null, runner);
  }

  it('counts the workspace\'s own branch against its upstream, with rev-list for that branch alone', async () => {
    const { upstream, repo } = await seedDraft();
    // A teammate shares one commit on the same draft, which this clone fetches.
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', '-q', '-b', 'alice/draft-one', upstream, pusher]);
    await runGit(pusher, ['commit', '--allow-empty', '-m', 'teammate']);
    await runGit(pusher, ['push', '-q', 'origin', 'alice/draft-one']);
    await runGit(repo, ['fetch', '-q', 'origin']);

    const { runner, commands } = recordingRunner();
    await expect(svcFor(runner).branchCounts(draftWs)).resolves.toEqual({ ahead: 3, behind: 1 });
    // The upstream resolved, so one count was enough.
    expect(commands.filter((c) => c === 'rev-list')).toHaveLength(1);
  });

  it('falls back to the protected branch on origin it is fewest commits ahead of when it has no upstream', async () => {
    const { upstream, repo } = await seedDraft();
    await runGit(repo, ['branch', '--unset-upstream']);
    // `target-company-state` moves on by two commits; `current-company-state` stays.
    const pusher = path.join(root, '.pusher');
    await runGit(root, ['clone', '-q', '-b', 'target-company-state', upstream, pusher]);
    for (const m of ['t1', 't2']) await runGit(pusher, ['commit', '--allow-empty', '-m', m]);
    await runGit(pusher, ['push', '-q', 'origin', 'target-company-state']);
    await runGit(repo, ['fetch', '-q', 'origin']);

    const { runner, commands } = recordingRunner();
    // Three ahead of both; ties keep the first protected branch, which is behind by nothing.
    await expect(svcFor(runner).branchCounts(draftWs)).resolves.toEqual({ ahead: 3, behind: 0 });
    // The upstream it tried, then each protected branch.
    expect(commands.filter((c) => c === 'rev-list')).toHaveLength(3);
  });

  it('answers null for a branch never shared, with no protected base to count against', async () => {
    const { repo } = await seedDraft();
    await runGit(repo, ['branch', '--unset-upstream']);
    const kb = testKbContext({ branchModel: { defaultBranch: 'main', protectedBranches: ['main'] } });
    await expect(svcFor(undefined, kb).branchCounts(draftWs)).resolves.toEqual({ ahead: null, behind: null });
  });
});
