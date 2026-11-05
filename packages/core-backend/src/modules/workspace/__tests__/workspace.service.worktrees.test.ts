import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbRepository, workingCopyShape } from '../kb-repository.js';
import { setAsideRepository } from '../set-aside-clone.js';
import { NodeGitRunner } from '../../version-control/git/node-git-runner.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { IGitRunner } from '../../../shared/git.contract.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';

/**
 * Branch workspaces are WORKTREES of one repository per knowledge base, at the
 * path a full clone had (`<workspacesRoot>/<branch id>/<kb folder>`). Real git
 * throughout: what is under test is what git does with the layout.
 */

const execFileAsync = promisify(execFile);

/**
 * A path as git prints it: on Windows git writes `C:/x/y` where node writes
 * `C:\x\y`, so both sides of a comparison go through this.
 */
const asGit = (p: string): string => p.replace(/\\/g, '/');

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

/** Every git call the service makes, with when it started and ended. */
interface Call {
  cwd: string;
  args: string[];
  start: number;
  end?: number;
}

function recordingRunner(delayFetchMs = 0): { runner: IGitRunner; calls: Call[] } {
  const inner = new NodeGitRunner();
  const calls: Call[] = [];
  const runner = {
    defaultTimeoutMs: inner.defaultTimeoutMs,
    credentials: inner.credentials,
    run: async (cwd: string, args: string[], opts?: object) => {
      const call: Call = { cwd, args, start: performance.now() };
      calls.push(call);
      try {
        if (delayFetchMs > 0 && args.includes('fetch')) await new Promise((r) => setTimeout(r, delayFetchMs));
        return await inner.run(cwd, args, opts as never);
      } finally {
        call.end = performance.now();
      }
    },
  } as unknown as IGitRunner;
  return { runner, calls };
}

/** The repository-wide `fetch --prune origin` — the one every workspace shares. */
const repositoryFetches = (calls: Call[]) =>
  calls.filter((c) => c.args.includes('fetch') && c.args.includes('--prune') && c.args[c.args.length - 1] === 'origin');

let root: string;
let workspacesRoot: string;
let upstream: string;
let seed: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-worktrees-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', 'main', upstream]);
  seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seed, 'shared.md'), 'on main\n');
  await fs.mkdir(path.join(seed, 'Deep', 'Folder'), { recursive: true });
  await fs.writeFile(path.join(seed, 'Deep', 'Folder', 'page.md'), 'deep\n');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  for (const branch of ['alice/a', 'bob/b', 'carol/c']) {
    await git(seed, ['checkout', '-q', '-b', branch, 'main']);
    await fs.writeFile(path.join(seed, `${branch.split('/')[0]}.md`), `${branch}\n`);
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', `on ${branch}`]);
  }
  await git(seed, ['checkout', '-q', 'main']);
  await git(seed, ['push', '-q', 'origin', 'main', 'alice/a', 'bob/b', 'carol/c']);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const service = (runner: IGitRunner = new NodeGitRunner(), url = upstream, setAsideRoot?: string) =>
  newWorkspaceService(workspacesRoot, url, testKbContext(), new NodeFs(), runner, setAsideRoot);

const checkoutOf = (branch: string) => path.join(workspacesRoot, workspaceIdForBranch(branch), 'knowledge-base');

/** Every folder named `objects` under `dir` — where a clone keeps its history. */
async function objectStoresUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'objects') found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

describe('opening a branch', () => {
  it('adds a worktree at the path a clone had, on its branch, tracking origin, with the files a fresh clone has — and copies no history', async () => {
    const svc = service();
    const info = await svc.getOrCreateForBranch('alice/a');
    const checkout = checkoutOf('alice/a');

    expect(info.absolutePath).toBe(path.join(workspacesRoot, workspaceIdForBranch('alice/a')));
    expect(await workingCopyShape(checkout)).toBe('worktree');
    expect((await fs.stat(path.join(checkout, '.git'))).isFile()).toBe(true);
    expect((await git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('alice/a');
    expect((await git(checkout, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim()).toBe('origin/alice/a');

    // Byte-identical to a fresh clone of the branch: same commit, same index, same bytes.
    const fresh = path.join(root, 'fresh');
    await git(root, ['clone', '-q', '-b', 'alice/a', upstream, fresh]);
    expect(await git(checkout, ['rev-parse', 'HEAD'])).toBe(await git(fresh, ['rev-parse', 'HEAD']));
    expect(await git(checkout, ['ls-files', '-s'])).toBe(await git(fresh, ['ls-files', '-s']));
    for (const file of ['shared.md', 'alice.md', path.join('Deep', 'Folder', 'page.md')]) {
      expect(await fs.readFile(path.join(checkout, file))).toEqual(await fs.readFile(path.join(fresh, file)));
    }

    // No history under the workspaces root: the objects are the repository's,
    // and the repository is not under the root.
    expect(await objectStoresUnder(workspacesRoot)).toEqual([]);
    expect(path.relative(workspacesRoot, svc.repository.dir).startsWith('..')).toBe(true);
    expect(asGit((await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())).toBe(
      asGit(await fs.realpath(svc.repository.dir)),
    );
  });

  it("lists and reads the worktree's files and never its `.git` file", async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    const id = workspaceIdForBranch('alice/a');

    const names: string[] = [];
    const walk = (entry: { name: string; children?: unknown[] }) => {
      names.push(entry.name);
      for (const child of (entry.children ?? []) as Array<{ name: string; children?: unknown[] }>) walk(child);
    };
    walk((await svc.listFiles(id)) as never);
    expect(names).toContain('alice.md');
    expect(names).not.toContain('.git');
    const all = await svc.readAllKbFiles(id);
    expect(Object.keys(all).some((p) => p.split('/').includes('.git'))).toBe(false);
    expect(Object.keys(all).length).toBeGreaterThan(0);
  });

  it('makes and fetches the repository for the first branch, and the second reuses it', async () => {
    const { runner, calls } = recordingRunner();
    const svc = service(runner);
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');

    expect(calls.filter((c) => c.args[0] === 'init')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'clone')).toHaveLength(0);
    expect(calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toHaveLength(2);
    const listed = asGit(await git(svc.repository.dir, ['worktree', 'list', '--porcelain']));
    expect(listed).toContain(asGit(await fs.realpath(checkoutOf('alice/a'))));
    expect(listed).toContain(asGit(await fs.realpath(checkoutOf('bob/b'))));
  });

  it('is treated as unfinished and recreated when the worktree has lost its link to the repository', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    const checkout = checkoutOf('alice/a');
    // The repository's half of the link goes, as when a worktree is pruned
    // from under its folder.
    const gitdir = (await fs.readFile(path.join(checkout, '.git'), 'utf-8')).replace(/^gitdir:\s*/, '').trim();
    await fs.rm(gitdir, { recursive: true, force: true });
    expect(await workingCopyShape(checkout)).toBe('broken');

    // A process that never saw it (a restart) opens the branch.
    const after = service();
    await after.getOrCreateForBranch('alice/a');
    expect(await workingCopyShape(checkout)).toBe('worktree');
    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(upstream, ['rev-parse', 'alice/a'])).trim(),
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is not recreated when its link to the repository cannot be read (EACCES is not absence)',
    async () => {
      const svc = service();
      await svc.getOrCreateForBranch('alice/a');
      const checkout = checkoutOf('alice/a');
      await fs.writeFile(path.join(checkout, 'unsaved.md'), 'kept');
      const gitdir = (await fs.readFile(path.join(checkout, '.git'), 'utf-8')).replace(/^gitdir:\s*/, '').trim();
      const records = path.dirname(gitdir);
      await fs.chmod(records, 0o000);
      try {
        await expect(workingCopyShape(checkout)).rejects.toMatchObject({ code: 'EACCES' });
        await expect(service().getOrCreateForBranch('alice/a')).rejects.toBeDefined();
      } finally {
        await fs.chmod(records, 0o755);
      }
      expect(await fs.readFile(path.join(checkout, 'unsaved.md'), 'utf-8')).toBe('kept');
      expect(await workingCopyShape(checkout)).toBe('worktree');
    },
  );
});

describe('fetching', () => {
  it('runs ONE git fetch when three workspaces are active and a fetch is due, and every workspace sees what it brought', async () => {
    const { runner, calls } = recordingRunner();
    const svc = service(runner);
    for (const b of ['alice/a', 'bob/b', 'carol/c']) await svc.getOrCreateForBranch(b);

    // A change pushed to the remote, from outside.
    await fs.writeFile(path.join(seed, 'shared.md'), 'moved on\n');
    await git(seed, ['commit', '-qam', 'moved on']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const pushed = (await git(seed, ['rev-parse', 'HEAD'])).trim();

    // The freshness window has run out.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    const before = repositoryFetches(calls).length;
    await Promise.all(['alice/a', 'bob/b', 'carol/c'].map((b) => svc.ensureRemotesFetched(workspaceIdForBranch(b))));
    expect(repositoryFetches(calls).length - before).toBe(1);
    // And inside the window, none.
    await Promise.all(['alice/a', 'bob/b', 'carol/c'].map((b) => svc.ensureRemotesFetched(workspaceIdForBranch(b))));
    expect(repositoryFetches(calls).length - before).toBe(1);

    for (const b of ['alice/a', 'bob/b', 'carol/c']) {
      expect((await git(checkoutOf(b), ['rev-parse', 'origin/main'])).trim()).toBe(pushed);
    }
  });

  it('makes a fetch and a worktree add requested at the same time wait for one another', async () => {
    const { runner, calls } = recordingRunner(150);
    const svc = service(runner);
    await svc.getOrCreateForBranch('alice/a');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);

    await Promise.all([svc.ensureRemotesFetched(workspaceIdForBranch('alice/a')), svc.getOrCreateForBranch('bob/b')]);

    const fetch = repositoryFetches(calls).at(-1)!;
    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add' && c.args.includes('bob/b'))!;
    // One ran entirely before the other.
    expect(fetch.end! <= add.start || add.end! <= fetch.start).toBe(true);
  });
});

describe('re-pointing the repository at a new address', () => {
  it('forgets the fresh fetch from the old address, so the next one reaches the new address', async () => {
    const { runner, calls } = recordingRunner();
    const svc = service(runner);
    await svc.getOrCreateForBranch('alice/a');
    expect(await svc.repository.fetch({ maxAgeMs: 60_000, force: true })).toBe(true);
    // The same repository, moved.
    const moved = path.join(root, 'moved.git');
    await fs.cp(upstream, moved, { recursive: true });
    await svc.repository.setOriginUrl(moved);
    expect(svc.repository.lastContact()).toBeNull();

    const before = repositoryFetches(calls).length;
    expect(await svc.repository.fetch({ maxAgeMs: 60_000 })).toBe(true);
    expect(repositoryFetches(calls).length).toBe(before + 1);
  });
});

describe('deleting a branch workspace', () => {
  it('removes and prunes its worktree and nothing else', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const aliceTip = (await git(checkoutOf('alice/a'), ['rev-parse', 'HEAD'])).trim();
    const aliceCheckout = asGit(await fs.realpath(checkoutOf('alice/a')));

    await svc.deleteWorkspace(workspaceIdForBranch('alice/a'));

    await expect(fs.access(path.join(workspacesRoot, workspaceIdForBranch('alice/a')))).rejects.toThrow();
    expect(asGit(await git(svc.repository.dir, ['worktree', 'list', '--porcelain']))).not.toContain(aliceCheckout);
    // The repository keeps its objects…
    await git(svc.repository.dir, ['cat-file', '-e', `${aliceTip}^{commit}`]);
    await git(svc.repository.dir, ['fsck', '--connectivity-only', '--no-dangling']);
    // …and the other workspace answers as before.
    expect(await svc.readFile(workspaceIdForBranch('bob/b'), 'knowledge-base/bob.md')).toBe('bob/b\n');
    expect((await git(checkoutOf('bob/b'), ['status', '--porcelain'])).trim()).toBe('');
  });

  it('the orphan sweep removes the folders of branches that are gone and never the repository', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const aliceCheckout = asGit(await fs.realpath(checkoutOf('alice/a')));

    const { removed } = await svc.sweepOrphanedWorkspaces(['bob/b']);

    expect(removed).toEqual([workspaceIdForBranch('alice/a')]);
    expect(await svc.repository.exists()).toBe(true);
    expect(asGit(await git(svc.repository.dir, ['worktree', 'list', '--porcelain']))).not.toContain(aliceCheckout);
    expect(await svc.readFile(workspaceIdForBranch('bob/b'), 'knowledge-base/bob.md')).toBe('bob/b\n');
  });
});

describe('commits the remote does not have', () => {
  it('stay on the branch in the repository when a push fails, the next push carries them, and no other worktree sees them', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const alice = checkoutOf('alice/a');
    await fs.writeFile(path.join(alice, 'alice.md'), 'unpushed\n');
    await git(alice, ['commit', '-qam', 'unpushed work']);
    const commit = (await git(alice, ['rev-parse', 'HEAD'])).trim();

    // The host refuses the push.
    const hook = path.join(upstream, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(git(alice, ['push', '-q', 'origin', 'alice/a'])).rejects.toThrow();

    expect((await git(svc.repository.dir, ['rev-parse', 'refs/heads/alice/a'])).trim()).toBe(commit);
    await expect(git(checkoutOf('bob/b'), ['merge-base', '--is-ancestor', commit, 'HEAD'])).rejects.toThrow();

    await fs.rm(hook);
    await git(alice, ['push', '-q', 'origin', 'alice/a']);
    expect((await git(upstream, ['rev-parse', 'alice/a'])).trim()).toBe(commit);
  });
});

describe('the repository address changes', () => {
  it('sets the repository and all its worktrees aside together, and the new address gets a fresh repository', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const alice = checkoutOf('alice/a');
    await fs.writeFile(path.join(alice, 'alice.md'), 'never pushed\n');
    await git(alice, ['commit', '-qam', 'never pushed']);
    const unpushed = (await git(alice, ['rev-parse', 'HEAD'])).trim();

    // Another repository, with no history in common.
    const other = path.join(root, 'other.git');
    await git(root, ['init', '--bare', '-b', 'main', other]);
    const otherSeed = path.join(root, '.other-seed');
    await fs.mkdir(otherSeed);
    await git(otherSeed, ['init', '-b', 'alice/a']);
    await fs.writeFile(path.join(otherSeed, 'other.md'), 'other\n');
    await git(otherSeed, ['add', '-A']);
    await git(otherSeed, ['commit', '-m', 'other']);
    await git(otherSeed, ['push', '-q', other, 'alice/a']);

    const setAside = path.join(root, 'set-aside');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = service(new NodeGitRunner(), other, setAside);
    await moved.getOrCreateForBranch('alice/a');

    const [stamp] = await fs.readdir(setAside);
    const kept = path.join(setAside, stamp!);
    expect((await fs.readdir(kept)).sort()).toEqual(
      ['knowledge-base.git', workspaceIdForBranch('alice/a'), workspaceIdForBranch('bob/b')].sort(),
    );
    // Nothing deleted: the unpushed commit reads in the set-aside worktree,
    // which is linked to the set-aside repository, both ways.
    const keptAlice = path.join(kept, workspaceIdForBranch('alice/a'));
    expect((await git(keptAlice, ['rev-parse', 'HEAD'])).trim()).toBe(unpushed);
    expect(asGit((await git(keptAlice, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())).toBe(
      asGit(await fs.realpath(path.join(kept, 'knowledge-base.git'))),
    );
    const keptList = asGit(await git(path.join(kept, 'knowledge-base.git'), ['worktree', 'list', '--porcelain']));
    expect(keptList).toContain(asGit(await fs.realpath(keptAlice)));
    expect(keptList).not.toContain('prunable');
    // The new address has its own repository and worktree.
    expect(await fs.readFile(path.join(alice, 'other.md'), 'utf-8')).toBe('other\n');
    expect((await git(moved.repository.dir, ['config', '--get', 'remote.origin.url'])).trim()).toBe(other);
  });
});

describe('the repository address changes, with nothing of the branch on disk yet', () => {
  it('sets the repository aside before adding a worktree to it, rather than fetching from the old address', async () => {
    await service().getOrCreateForBranch('alice/a');
    const other = path.join(root, 'other.git');
    await git(root, ['init', '--bare', '-b', 'main', other]);
    const otherSeed = path.join(root, '.other-seed');
    await fs.mkdir(otherSeed);
    await git(otherSeed, ['init', '-b', 'carol/c']);
    await fs.writeFile(path.join(otherSeed, 'other.md'), 'other\n');
    await git(otherSeed, ['add', '-A']);
    await git(otherSeed, ['commit', '-m', 'other']);
    await git(otherSeed, ['push', '-q', other, 'carol/c']);

    const setAside = path.join(root, 'set-aside');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = service(new NodeGitRunner(), other, setAside);
    await moved.getOrCreateForBranch('carol/c');

    const [stamp] = await fs.readdir(setAside);
    expect((await fs.readdir(path.join(setAside, stamp!))).sort()).toEqual(
      ['knowledge-base.git', workspaceIdForBranch('alice/a')].sort(),
    );
    expect(await fs.readFile(path.join(checkoutOf('carol/c'), 'other.md'), 'utf-8')).toBe('other\n');
    expect((await git(moved.repository.dir, ['config', '--get', 'remote.origin.url'])).trim()).toBe(other);
  });

  it('sets it aside once when two absent branches are opened at once, and both get worktrees of the new one', async () => {
    await service().getOrCreateForBranch('alice/a');
    const other = path.join(root, 'other.git');
    await git(root, ['init', '--bare', '-b', 'main', other]);
    const otherSeed = path.join(root, '.other-seed');
    await fs.mkdir(otherSeed);
    await git(otherSeed, ['init', '-b', 'carol/c']);
    await fs.writeFile(path.join(otherSeed, 'other.md'), 'other\n');
    await git(otherSeed, ['add', '-A']);
    await git(otherSeed, ['commit', '-m', 'other']);
    await git(otherSeed, ['push', '-q', other, 'carol/c', 'carol/c:main']);

    const setAside = path.join(root, 'set-aside');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = service(new NodeGitRunner(), other, setAside);
    await Promise.all([moved.getOrCreateForBranch('carol/c'), moved.getOrCreateForBranch('main')]);

    // One repository set aside, with the one worktree it had; neither new
    // worktree went with a second set-aside.
    const kept: string[] = [];
    for (const stamp of await fs.readdir(setAside)) {
      for (const name of await fs.readdir(path.join(setAside, stamp))) kept.push(name);
    }
    expect(kept.sort()).toEqual(['knowledge-base.git', workspaceIdForBranch('alice/a')].sort());
    for (const branch of ['carol/c', 'main']) {
      expect(await workingCopyShape(checkoutOf(branch))).toBe('worktree');
      expect(await fs.readFile(path.join(checkoutOf(branch), 'other.md'), 'utf-8')).toBe('other\n');
    }
    expect((await git(moved.repository.dir, ['config', '--get', 'remote.origin.url'])).trim()).toBe(other);
  });
});

describe('setting the repository aside', () => {
  it('finds the worktrees when the repository is held by another spelling of its path than git wrote', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    // Windows names one folder two ways (`RUNNER~1` and `runneradmin`); a
    // link to the same folder is the portable way to get two spellings.
    const alias = path.join(os.tmpdir(), `bevel-alias-${path.basename(root)}`);
    await fs.symlink(root, alias, 'junction');
    try {
      const aliased = new KbRepository({
        dir: path.join(alias, path.relative(root, svc.repository.dir)),
        kbRepoUrl: () => upstream,
        gitRunner: new NodeGitRunner(),
      });
      // The destination too is named through the alias.
      const dest = path.join(alias, 'set-aside', 'stamp');

      const moved = await setAsideRepository(aliased, workspacesRoot, 'knowledge-base', dest);

      expect(moved.sort()).toEqual([workspaceIdForBranch('alice/a'), workspaceIdForBranch('bob/b')].sort());
      expect((await fs.readdir(dest)).sort()).toEqual(
        ['knowledge-base.git', workspaceIdForBranch('alice/a'), workspaceIdForBranch('bob/b')].sort(),
      );
      // Re-linked by the names the file system gives them, as git writes its
      // own links: `git worktree list` shows the real path, not the alias.
      const realDest = await fs.realpath(dest);
      const list = asGit(await git(path.join(dest, 'knowledge-base.git'), ['worktree', 'list', '--porcelain']));
      for (const id of [workspaceIdForBranch('alice/a'), workspaceIdForBranch('bob/b')]) {
        expect(list).toContain(`worktree ${asGit(path.join(realDest, id))}\n`);
      }
      expect(list).not.toContain('prunable');
    } finally {
      // The link only, never through it.
      await fs.unlink(alias).catch(() => fs.rmdir(alias));
    }
  });

  it('moves nothing when the reason for it no longer holds once it is the administrator', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    const dest = path.join(root, 'set-aside', 'stamp');

    expect(await setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest, async () => false)).toEqual([]);
    expect(await fs.access(dest).then(() => true, () => false)).toBe(false);
    expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('worktree');
    expect(await svc.repository.exists()).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'moves nothing when the workspaces root cannot be read, rather than the repository without its worktrees',
    async () => {
      const svc = service();
      await svc.getOrCreateForBranch('alice/a');
      const dest = path.join(root, 'set-aside', 'stamp');
      await fs.chmod(workspacesRoot, 0o000);
      try {
        await expect(setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest)).rejects.toThrow(
          /EACCES/,
        );
      } finally {
        await fs.chmod(workspacesRoot, 0o755);
      }
      expect(await svc.repository.exists()).toBe(true);
      expect(await fs.access(dest).then(() => true, () => false)).toBe(false);
      expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('worktree');
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "moves nothing when a working copy's .git cannot be read, rather than the repository without that worktree",
    async () => {
      const svc = service();
      await svc.getOrCreateForBranch('alice/a');
      await svc.getOrCreateForBranch('bob/b');
      const link = path.join(checkoutOf('alice/a'), '.git');
      const dest = path.join(root, 'set-aside', 'stamp');
      await fs.chmod(link, 0o000);
      try {
        await expect(setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest)).rejects.toThrow(
          /EACCES/,
        );
      } finally {
        await fs.chmod(link, 0o644);
      }
      expect(await fs.access(dest).then(() => true, () => false)).toBe(false);
      expect(await svc.repository.exists()).toBe(true);
      expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('worktree');
      expect(await workingCopyShape(checkoutOf('bob/b'))).toBe('worktree');
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "moves nothing when a worktree's record in the repository cannot be read, rather than guessing it is not one",
    async () => {
      const svc = service();
      await svc.getOrCreateForBranch('alice/a');
      const records = path.join(svc.repository.dir, 'worktrees');
      const dest = path.join(root, 'set-aside', 'stamp');
      await fs.chmod(records, 0o000);
      try {
        await expect(setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest)).rejects.toThrow(
          /EACCES/,
        );
      } finally {
        await fs.chmod(records, 0o755);
      }
      expect(await fs.access(dest).then(() => true, () => false)).toBe(false);
      expect(await svc.repository.exists()).toBe(true);
      expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('worktree');
    },
  );

  it('leaves both links of a worktree as they were when only one of them can be re-written', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const aliceGitfile = path.join(checkoutOf('alice/a'), '.git');
    const before = await fs.readFile(aliceGitfile, 'utf8');
    // The record behind alice's worktree cannot be written: its `gitdir` is a folder.
    const admin = (await git(checkoutOf('alice/a'), ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
    await fs.rm(path.join(admin, 'gitdir'));
    await fs.mkdir(path.join(admin, 'gitdir'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dest = path.join(root, 'set-aside', 'stamp');

    await setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest);

    // Not half re-pointed: the moved `.git` still names what it named.
    expect(await fs.readFile(path.join(dest, workspaceIdForBranch('alice/a'), '.git'), 'utf8')).toBe(before);
    // The other worktree is re-linked both ways.
    const keptBob = path.join(dest, workspaceIdForBranch('bob/b'));
    expect(asGit((await git(keptBob, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())).toBe(
      asGit(await fs.realpath(path.join(dest, 'knowledge-base.git'))),
    );
  });

  it('puts the worktrees back when the repository cannot follow them, so nothing is split', async () => {
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');
    const dest = path.join(root, 'set-aside', 'stamp');
    // Somebody's earlier set-aside already holds the repository's name there.
    await fs.mkdir(path.join(dest, 'knowledge-base.git'), { recursive: true });

    await expect(setAsideRepository(svc.repository, workspacesRoot, 'knowledge-base', dest)).rejects.toThrow(
      /already holds one/,
    );
    expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('worktree');
    expect(await workingCopyShape(checkoutOf('bob/b'))).toBe('worktree');
    expect((await fs.readdir(dest)).sort()).toEqual(['knowledge-base.git']);
    expect((await git(checkoutOf('bob/b'), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('bob/b');
  });
});

describe('a deployment of full clones from an earlier release', () => {
  it('is served as it is until the boot phase converts it', async () => {
    await fs.mkdir(path.join(workspacesRoot, workspaceIdForBranch('alice/a')), { recursive: true });
    await git(root, ['clone', '-q', '-b', 'alice/a', upstream, checkoutOf('alice/a')]);
    const svc = service();
    await svc.getOrCreateForBranch('alice/a');
    await svc.getOrCreateForBranch('bob/b');

    expect(await workingCopyShape(checkoutOf('alice/a'))).toBe('clone');
    expect(await workingCopyShape(checkoutOf('bob/b'))).toBe('worktree');
    expect(await svc.readFile(workspaceIdForBranch('alice/a'), 'knowledge-base/alice.md')).toBe('alice/a\n');
    await svc.ensureRemotesFetched(workspaceIdForBranch('alice/a'), { strict: true });
  });
});
