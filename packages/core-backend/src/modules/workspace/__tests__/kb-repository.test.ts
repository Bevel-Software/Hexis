import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { KbRepository, repositoryDirFor } from '../kb-repository.js';
import { fetchInstant } from '../fetch-instant.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';
import type { IGitRunner } from '../../../shared/git.contract.js';

/**
 * The repository's own contracts, over real git: a fetch from before a
 * caller's instant is not taken for one after it, and what the worktree list
 * and the shared config are written by runs as the administrator.
 */

const execFileAsync = promisify(execFile);
const TARGET = 'current-company-state';

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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-kb-repository-'));
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
  await git(seed, ['branch', 'alice/a']);
  await git(seed, ['branch', 'bob/b']);
  await git(seed, ['push', '-q', upstream, TARGET, 'alice/a', 'bob/b']);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The repository, noting whether its administrator's section is held while git runs. */
class RecordingRepository extends KbRepository {
  depth = 0;
  override exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return super.exclusive(async () => {
      this.depth += 1;
      try { return await fn(); } finally { this.depth -= 1; }
    });
  }
}

const isOriginFetch = (args: string[]) => args.includes('fetch') && args.at(-1) === 'origin';

describe('KbRepository.fetch', () => {
  it('does not join a fetch that started before the caller\'s instant: it waits, and fetches again', async () => {
    const inner = new NodeGitRunner();
    let hold: Promise<void> | null = null;
    let fetched: (() => void) | null = null;
    let fetches = 0;
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: async (cwd: string, args: string[], opts?: object) => {
        const out = await inner.run(cwd, args, opts as never);
        if (isOriginFetch(args)) {
          fetches += 1;
          // The fetch has read the remote; it is held before it answers.
          fetched?.();
          if (hold) await hold;
        }
        return out;
      },
    } as unknown as IGitRunner;
    const repository = new KbRepository({
      dir: repositoryDirFor(workspacesRoot, 'knowledge-base'),
      kbRepoUrl: () => upstream,
      gitRunner,
    });
    await repository.ensure();
    fetches = 0;

    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    const readRemote = new Promise<void>((r) => { fetched = r; });
    const older = repository.fetch({ maxAgeMs: 0, force: true });
    await readRemote;
    hold = null;
    fetched = null;
    // Deleted on the remote after the older fetch read it.
    await git(upstream, ['update-ref', '-d', 'refs/heads/bob/b']);
    await new Promise((r) => setTimeout(r, 5));
    const since = Date.now();

    const newer = repository.fetch({ maxAgeMs: 60_000, fetchedSince: since });
    release();

    expect(await older).toBe(true);
    expect(await newer).toBe(true);
    expect(fetches).toBe(2);
    await expect(
      git(repository.dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/bob/b']),
    ).rejects.toThrow();
  });

  it('joins a fetch in flight that started after the caller\'s instant', async () => {
    const inner = new NodeGitRunner();
    let fetches = 0;
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: async (cwd: string, args: string[], opts?: object) => {
        if (isOriginFetch(args)) fetches += 1;
        return inner.run(cwd, args, opts as never);
      },
    } as unknown as IGitRunner;
    const repository = new KbRepository({
      dir: repositoryDirFor(workspacesRoot, 'knowledge-base'),
      kbRepoUrl: () => upstream,
      gitRunner,
    });
    await repository.ensure();
    fetches = 0;

    const since = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const [a, b] = await Promise.all([
      repository.fetch({ maxAgeMs: 0, force: true }),
      repository.fetch({ maxAgeMs: 60_000, fetchedSince: since }),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(fetches).toBe(1);
  });
});

describe('KbRepository.fetch, an instant in the same millisecond', () => {
  /** A repository whose fetches of origin are counted and held while `gate` is set; with `failFirst`, the first after it is made fails. */
  async function gatedRepository(failFirst = false) {
    const inner = new NodeGitRunner();
    const state = { fetches: 0, gate: null as Promise<void> | null, failFirst: false };
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: async (cwd: string, args: string[], opts?: object) => {
        if (!isOriginFetch(args)) return inner.run(cwd, args, opts as never);
        state.fetches += 1;
        const first = state.fetches === 1;
        if (state.gate) await state.gate;
        if (state.failFirst && first) throw new Error('fatal: unable to access the remote');
        return inner.run(cwd, args, opts as never);
      },
    } as unknown as IGitRunner;
    const repository = new KbRepository({
      dir: repositoryDirFor(workspacesRoot, 'knowledge-base'),
      kbRepoUrl: () => upstream,
      gitRunner,
    });
    await repository.ensure();
    state.fetches = 0;
    state.failFirst = failFirst;
    return { repository, state };
  }

  it('reads instants that never compare equal, however close together', () => {
    const readings = Array.from({ length: 1000 }, () => fetchInstant());
    for (let i = 1; i < readings.length; i++) expect(readings[i]).toBeGreaterThan(readings[i - 1]!);
  });

  it('does not join a fetch that started just before the caller\'s instant, in the same millisecond', async () => {
    const { repository, state } = await gatedRepository();
    let release!: () => void;
    state.gate = new Promise((r) => { release = r; });
    const older = repository.fetch({ maxAgeMs: 0, force: true });
    // Read right after the older fetch started: the same millisecond, as a rule.
    const since = fetchInstant();
    const newer = repository.fetch({ maxAgeMs: 60_000, fetchedSince: since });
    state.gate = null;
    release();

    expect(await older).toBe(true);
    expect(await newer).toBe(true);
    expect(state.fetches).toBe(2);
  });

  it('fetches after the instant even when the older fetch it waited for failed within the backoff', async () => {
    const { repository, state } = await gatedRepository(true);
    let release!: () => void;
    state.gate = new Promise((r) => { release = r; });
    const older = repository.fetch({ maxAgeMs: 0, force: true });
    const since = fetchInstant();
    const newer = repository.fetch({ maxAgeMs: 60_000, fetchedSince: since, failureBackoffMs: 60_000 });
    state.gate = null;
    release();

    expect(await older).toBe(false);
    expect(await newer).toBe(true);
    expect(state.fetches).toBe(2);
  });
});

describe('KbRepository.forgetWorktrees', () => {
  it('prunes and deletes the branches as the administrator, and keeps the objects', async () => {
    const inner = new NodeGitRunner();
    const calls: { args: string[]; held: boolean }[] = [];
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: (cwd: string, args: string[], opts?: object) => {
        // `repository` is read at call time, once it exists below.
        calls.push({ args, held: repository.depth > 0 });
        return inner.run(cwd, args, opts as never);
      },
    } as unknown as IGitRunner;
    const repository: RecordingRepository = new RecordingRepository({
      dir: repositoryDirFor(workspacesRoot, 'knowledge-base'),
      kbRepoUrl: () => upstream,
      gitRunner,
    });
    const checkout = (branch: string) => path.join(workspacesRoot, encodeURIComponent(branch), 'knowledge-base');
    await repository.addWorktree('alice/a', checkout('alice/a'));
    await repository.addWorktree('bob/b', checkout('bob/b'));
    const aliceTip = (await git(repository.dir, ['rev-parse', 'refs/heads/alice/a'])).trim();
    // Deleted by hand, as the orphan sweep deletes it.
    await fs.rm(path.dirname(checkout('alice/a')), { recursive: true, force: true });
    calls.length = 0;

    await repository.forgetWorktrees(['alice/a']);

    const written = calls.filter(({ args }) =>
      (args.includes('worktree') && args.includes('prune')) || (args.includes('branch') && args.includes('-D')));
    expect(written.map(({ args }) => args.filter((a) => a === 'prune' || a === '-D'))).toEqual([['prune'], ['-D']]);
    for (const c of written) expect(c.held, c.args.join(' ')).toBe(true);
    await expect(git(repository.dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/alice/a'])).rejects.toThrow();
    expect((await git(repository.dir, ['cat-file', '-t', aliceTip])).trim()).toBe('commit');
    expect((await git(checkout('bob/b'), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('bob/b');
  });
});
