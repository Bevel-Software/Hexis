import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbStartupRunner } from '../kb-startup-runner.js';
import { workingCopyShape } from '../../kb-repository.js';
import { NodeGitRunner } from '../../../workflow/git/node-git-runner.js';
import { gitCredentials, type IGitRunner } from '../../../../shared/git.contract.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * The startup phase on a knowledge base of WORKTREES: it opens every branch as
 * a worktree of one repository, converts the full clones an earlier release
 * left behind — one at a time, without losing a commit — and sets the
 * repository aside with every worktree of it when the address changes.
 * Real git throughout.
 */

const execFileAsync = promisify(execFile);
const credentials = gitCredentials('x-access-token', () => null);

const DEFAULT_BRANCH = 'current-company-state';
const PROTECTED = [DEFAULT_BRANCH, 'target-company-state'];
const DRAFTS = ['alice/a', 'bob/b', 'carol/c'];

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
let seed: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-startup-worktrees-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, upstream]);
  seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', DEFAULT_BRANCH]);
  await fs.writeFile(path.join(seed, 'marker.txt'), 'seeded', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['branch', PROTECTED[1]!]);
  for (const draft of DRAFTS) {
    await git(seed, ['checkout', '-q', '-b', draft, DEFAULT_BRANCH]);
    await fs.writeFile(path.join(seed, 'draft.md'), draft, 'utf8');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', `on ${draft}`]);
  }
  await git(seed, ['checkout', '-q', DEFAULT_BRANCH]);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await git(seed, ['push', '-q', 'origin', ...PROTECTED, ...DRAFTS]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function step(name: string, run: (ctx: ServerStartContext) => Promise<StepResult>): OnServerStart {
  return { name, run };
}

/** Opens every remote branch, as the boot phase of a deployment does. */
const touchAll = step('touch-all', async (ctx) => {
  for (const h of await ctx.allBranches()) await h.repoDir();
  return { outcome: 'ok' };
});
const touchDefault = step('touch', async (ctx) => {
  await (await ctx.defaultBranch()).repoDir();
  return { outcome: 'ok' };
});

function makeRunner(steps: OnServerStart[], overrides: Record<string, unknown> = {}) {
  return new KbStartupRunner({
    gitRunner: new NodeGitRunner(undefined, credentials),
    kbRepoUrl: () => upstream,
    workspacesRoot,
    setAsideRoot: path.join(root, 'set-aside'),
    kbDirName: 'knowledge-base',
    templateDir: path.join(root, 'template'),
    defaultBranch: () => DEFAULT_BRANCH,
    protectedBranches: () => PROTECTED,
    seedAdminEmails: ['admin@example.com'],
    unfinishedCloneQuietMs: 0,
    steps,
    buildSeedTree: async () => [],
    ...overrides,
  });
}

const checkoutOf = (branch: string) => path.join(workspacesRoot, encodeURIComponent(branch), 'knowledge-base');
const repositoryDir = () => path.join(`${workspacesRoot}.repository`, 'knowledge-base.git');
const upstreamTip = async (branch: string) => (await git(upstream, ['rev-parse', branch])).trim();

/** A full clone of `branch` at its workspace path — what a release before worktrees left there. */
async function legacyClone(branch: string): Promise<string> {
  const dir = checkoutOf(branch);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(root, ['clone', '-q', '-b', branch, upstream, dir]);
  return dir;
}

async function commitIn(dir: string, file: string, content: string): Promise<string> {
  await fs.writeFile(path.join(dir, file), content, 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', `wrote ${file}`]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

async function objectStoresUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'objects') found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

describe('a boot that opens every remote branch', () => {
  it('opens each as a worktree of one repository, holds the history once, and fetches the repository once', async () => {
    const inner = new NodeGitRunner(undefined, credentials);
    const calls: string[][] = [];
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: (cwd: string, args: string[], opts?: object) => {
        calls.push(args);
        return inner.run(cwd, args, opts as never);
      },
    } as unknown as IGitRunner;

    await makeRunner([touchAll], { gitRunner }).runAll();

    for (const branch of [...PROTECTED, ...DRAFTS]) {
      expect(await workingCopyShape(checkoutOf(branch))).toBe('worktree');
      expect((await git(checkoutOf(branch), ['rev-parse', 'HEAD'])).trim()).toBe(await upstreamTip(branch));
    }
    expect(calls.filter((args) => args.includes('clone'))).toEqual([]);
    // The whole-remote fetch ran once — when the repository was made; every
    // branch after that was within its window.
    expect(calls.filter((args) => args.includes('fetch') && args.at(-1) === 'origin')).toHaveLength(1);
    // And no branch asked the remote for itself on top of it.
    expect(calls.filter((args) => args.includes('fetch') && args.some((a) => a.startsWith('+refs/heads/')))).toEqual([]);
    // The history is in the repository, once; the workspaces root holds checkouts.
    expect(await objectStoresUnder(workspacesRoot)).toEqual([]);
    expect(await sizeOf(workspacesRoot)).toBeLessThan(await sizeOf(path.join(repositoryDir(), 'objects')));
  });

  it('starts again over its own worktrees without converting or re-adding anything', async () => {
    await makeRunner([touchAll]).runAll();
    const log = vi.spyOn(console, 'log');
    await makeRunner([touchAll]).runAll();
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/converted|Added the/);
    for (const branch of [...PROTECTED, ...DRAFTS]) expect(await workingCopyShape(checkoutOf(branch))).toBe('worktree');
  });

  it('goes on when a branch is deleted on the remote after the boot listed it, and neither moves it nor brings it back', async () => {
    await makeRunner([touchAll]).runAll();
    const bobTip = await commitIn(checkoutOf('bob/b'), 'unpushed.md', 'kept');
    // Deleted on the host between the boot's branch listing and the
    // repository's fetch, which prunes its remote-tracking ref.
    const deleteBobThenTouchAll = step('delete-then-touch-all', async (ctx) => {
      await git(upstream, ['update-ref', '-d', 'refs/heads/bob/b']);
      for (const h of await ctx.allBranches()) {
        await h.repoDir();
        h.write('maintained.md', 'by the boot');
      }
      return { outcome: 'ok' };
    });

    await makeRunner([deleteBobThenTouchAll]).runAll();

    // Its worktree is as it was, the unpushed commit included.
    expect(await workingCopyShape(checkoutOf('bob/b'))).toBe('worktree');
    expect((await git(checkoutOf('bob/b'), ['rev-parse', 'HEAD'])).trim()).toBe(bobTip);
    // The phase pushed nothing to it: the branch stays deleted.
    expect((await git(upstream, ['branch', '--list', 'bob/b'])).trim()).toBe('');
    // Every other branch was maintained as usual.
    for (const branch of [...PROTECTED, 'alice/a', 'carol/c']) {
      expect(await git(upstream, ['show', `${branch}:maintained.md`])).toBe('by the boot');
    }
  });
});

describe('a deployment upgraded over full clones', () => {
  it('converts every clone to a worktree, keeps the commits the remote lacks, and removes the clones', async () => {
    for (const branch of [...PROTECTED, ...DRAFTS]) await legacyClone(branch);
    // Two commits a failed push left on one branch.
    const alice = checkoutOf('alice/a');
    await commitIn(alice, 'one.md', 'first unpushed');
    const aliceTip = await commitIn(alice, 'two.md', 'second unpushed');
    // And a branch that moved on the remote after its clone was made.
    await git(seed, ['checkout', '-q', 'bob/b']);
    await commitIn(seed, 'later.md', 'pushed later');
    await git(seed, ['push', '-q', 'origin', 'bob/b']);

    await makeRunner([touchAll]).runAll();

    for (const branch of [...PROTECTED, ...DRAFTS]) {
      expect(await workingCopyShape(checkoutOf(branch))).toBe('worktree');
      await expect(fs.access(path.join(path.dirname(checkoutOf(branch)), '.knowledge-base.converting'))).rejects.toThrow();
    }
    // The branch with local commits is at its own tip, both commits on it.
    expect((await git(alice, ['rev-parse', 'HEAD'])).trim()).toBe(aliceTip);
    expect((await git(alice, ['rev-list', '--count', 'origin/alice/a..HEAD'])).trim()).toBe('2');
    expect(await fs.readFile(path.join(alice, 'one.md'), 'utf8')).toBe('first unpushed');
    // Every other branch is at the remote's tip.
    for (const branch of [...PROTECTED, 'bob/b', 'carol/c']) {
      expect((await git(checkoutOf(branch), ['rev-parse', 'HEAD'])).trim()).toBe(await upstreamTip(branch));
    }
    // The clones' own histories are gone from the workspaces root.
    expect(await objectStoresUnder(workspacesRoot)).toEqual([]);
  });

  it('keeps a clone it cannot convert working as a clone, says which branch, converts the rest, and tries again at the next boot', async () => {
    for (const branch of [DEFAULT_BRANCH, 'alice/a', 'bob/b']) await legacyClone(branch);
    const alice = checkoutOf('alice/a');
    // Work in the working tree, not yet in a commit: not the conversion's to discard.
    await fs.writeFile(path.join(alice, 'draft.md'), 'being edited', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await makeRunner([touchDefault]).runAll();

    expect(await workingCopyShape(alice)).toBe('clone');
    expect(await fs.readFile(path.join(alice, 'draft.md'), 'utf8')).toBe('being edited');
    expect(warn.mock.calls.flat().join('\n')).toMatch(/"alice\/a" working copy is still a full clone/);
    expect(await workingCopyShape(checkoutOf('bob/b'))).toBe('worktree');
    expect(await workingCopyShape(checkoutOf(DEFAULT_BRANCH))).toBe('worktree');

    // Committed since: the next boot converts it, commit and all.
    const tip = await commitIn(alice, 'draft.md', 'being edited');
    await makeRunner([touchDefault]).runAll();
    expect(await workingCopyShape(alice)).toBe('worktree');
    expect((await git(alice, ['rev-parse', 'HEAD'])).trim()).toBe(tip);
  });

  it('leaves a clone whose objects cannot be read in place, and the boot goes on', async () => {
    for (const branch of [DEFAULT_BRANCH, 'alice/a']) await legacyClone(branch);
    const alice = checkoutOf('alice/a');
    const tip = await commitIn(alice, 'lost.md', 'unreadable');
    // The commit's own object is gone: nothing can read the branch's tip.
    await fs.rm(path.join(alice, '.git', 'objects', tip.slice(0, 2), tip.slice(2)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await makeRunner([touchDefault]).runAll();

    expect(await workingCopyShape(alice)).toBe('clone');
    expect((await git(alice, ['rev-parse', 'refs/heads/alice/a'])).trim()).toBe(tip);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/"alice\/a" working copy is still a full clone/);
    expect(await workingCopyShape(checkoutOf(DEFAULT_BRANCH))).toBe('worktree');
  });

  it('finishes a conversion a crash cut short, with the clone moved aside and no worktree yet', async () => {
    const alice = await legacyClone('alice/a');
    const tip = await commitIn(alice, 'unpushed.md', 'kept');
    await fs.rename(alice, path.join(path.dirname(alice), '.knowledge-base.converting'));

    await makeRunner([touchDefault]).runAll();

    expect(await workingCopyShape(alice)).toBe('worktree');
    expect((await git(alice, ['rev-parse', 'HEAD'])).trim()).toBe(tip);
    await expect(fs.access(path.join(path.dirname(alice), '.knowledge-base.converting'))).rejects.toThrow();
  });
});

describe('the repository address changes', () => {
  it('sets the repository and all its worktrees aside together, and the new address gets a fresh repository and worktrees', async () => {
    await makeRunner([touchAll]).runAll();
    const unpushed = await commitIn(checkoutOf(DEFAULT_BRANCH), 'unpushed.md', 'the only copy');

    // An unrelated repository with the same branch names.
    const replacement = path.join(root, 'replacement.git');
    await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, replacement]);
    const other = path.join(root, '.seed-replacement');
    await fs.mkdir(other);
    await git(other, ['init', '-b', DEFAULT_BRANCH]);
    await fs.writeFile(path.join(other, 'marker.txt'), 'replacement', 'utf8');
    await git(other, ['add', '-A']);
    await git(other, ['commit', '-m', 'init']);
    await git(other, ['branch', PROTECTED[1]!]);
    await git(other, ['push', '-q', replacement, ...PROTECTED]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const discarded: string[] = [];

    await makeRunner([touchDefault], {
      kbRepoUrl: () => replacement,
      onCloneDiscarded: (id: string) => void discarded.push(id),
    }).runAll();

    const [stamp] = await fs.readdir(path.join(root, 'set-aside'));
    const kept = path.join(root, 'set-aside', stamp!);
    expect((await fs.readdir(kept)).sort()).toEqual(
      ['knowledge-base.git', ...[...PROTECTED, ...DRAFTS].map((b) => encodeURIComponent(b))].sort(),
    );
    expect(discarded.sort()).toEqual([...PROTECTED, ...DRAFTS].map((b) => encodeURIComponent(b)).sort());
    // Nothing deleted: the set-aside worktree still reads its unpushed commit.
    const keptDefault = path.join(kept, encodeURIComponent(DEFAULT_BRANCH));
    expect((await git(keptDefault, ['rev-parse', 'HEAD'])).trim()).toBe(unpushed);
    // The configured address has a fresh repository and worktree.
    expect(await fs.readFile(path.join(checkoutOf(DEFAULT_BRANCH), 'marker.txt'), 'utf8')).toBe('replacement');
    expect((await git(repositoryDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(replacement);
  });

  it('sets the repository aside even when the workspaces root is gone, so no later worktree fetches from the old address', async () => {
    await makeRunner([touchDefault]).runAll();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
    const replacement = path.join(root, 'replacement.git');
    await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, replacement]);
    const other = path.join(root, '.seed-replacement');
    await fs.mkdir(other);
    await git(other, ['init', '-b', DEFAULT_BRANCH]);
    await fs.writeFile(path.join(other, 'marker.txt'), 'replacement', 'utf8');
    await git(other, ['add', '-A']);
    await git(other, ['commit', '-m', 'init']);
    await git(other, ['branch', PROTECTED[1]!]);
    await git(other, ['push', '-q', replacement, ...PROTECTED]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await makeRunner([], { kbRepoUrl: () => replacement }).runAll();

    const [stamp] = await fs.readdir(path.join(root, 'set-aside'));
    expect(await fs.readdir(path.join(root, 'set-aside', stamp!))).toEqual(['knowledge-base.git']);
    const origin = await git(repositoryDir(), ['config', '--get', 'remote.origin.url']).catch(() => null);
    expect(origin === null || origin.trim() === replacement).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'moves nothing when the workspaces root cannot be read, rather than the repository without its worktrees',
    async () => {
      await makeRunner([touchDefault]).runAll();
      const replacement = path.join(root, 'replacement.git');
      await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, replacement]);
      const other = path.join(root, '.seed-replacement');
      await fs.mkdir(other);
      await git(other, ['init', '-b', DEFAULT_BRANCH]);
      await fs.writeFile(path.join(other, 'marker.txt'), 'replacement', 'utf8');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'init']);
      await git(other, ['branch', PROTECTED[1]!]);
      await git(other, ['push', '-q', replacement, ...PROTECTED]);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await fs.chmod(workspacesRoot, 0o000);
      try {
        await makeRunner([], { kbRepoUrl: () => replacement })
          .runAll()
          .catch(() => {});
      } finally {
        await fs.chmod(workspacesRoot, 0o755);
      }

      expect(await fs.access(path.join(root, 'set-aside')).then(() => true, () => false)).toBe(false);
      expect((await git(repositoryDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(upstream);
      expect((await git(checkoutOf(DEFAULT_BRANCH), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(DEFAULT_BRANCH);
    },
  );
});
