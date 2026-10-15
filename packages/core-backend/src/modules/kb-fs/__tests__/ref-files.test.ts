import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { readRefSha, readRevSha } from '../index.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
  return stdout.trim();
}

/**
 * The ref files are read exactly as git reads them, so every answer is
 * checked against `git rev-parse` on the same repository: a loose ref, a
 * packed one, a loose one shadowing a packed one, a symbolic ref, a
 * worktree's own HEAD beside the refs it shares, and the three answers the
 * reader gives when it cannot or must not decide.
 */
describe('readRefSha', () => {
  let root: string;
  let origin: string;
  let clone: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ref-files-'));
    origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    await execFileAsync('git', ['init', '--bare', '-b', 'main', origin]);
    await fs.mkdir(seed);
    await git(seed, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(seed, 'a.md'), 'a\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', 'one');
    await git(seed, 'checkout', '-qb', 'feature');
    await fs.writeFile(path.join(seed, 'b.md'), 'b\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', 'two');
    await git(seed, 'tag', '-a', 'v1', '-m', 'v1');
    await git(seed, 'tag', 'light');
    await git(seed, 'checkout', '-q', 'main');
    await git(seed, 'remote', 'add', 'origin', origin);
    await git(seed, 'push', '-q', 'origin', 'main', 'feature', 'v1', 'light');
    clone = path.join(root, 'clone');
    await execFileAsync('git', ['clone', '-q', origin, clone]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const expectSha = async (repo: string, ref: string) =>
    expect(await readRefSha(repo, ref)).toEqual({ sha: await git(repo, 'rev-parse', '--verify', `${ref}^{commit}`) });

  it('reads a loose ref, a remote-tracking ref and HEAD as git resolves them', async () => {
    await expectSha(clone, 'refs/heads/main');
    await expectSha(clone, 'refs/remotes/origin/feature');
    await expectSha(clone, 'HEAD');
  });

  it('follows a symbolic ref', async () => {
    // A clone writes `refs/remotes/origin/HEAD` as `ref: refs/remotes/origin/main`.
    await expectSha(clone, 'refs/remotes/origin/HEAD');
  });

  it('reads a packed ref, and lets a newer loose ref shadow the packed one', async () => {
    await git(clone, 'pack-refs', '--all');
    await expect(fs.access(path.join(clone, '.git/refs/heads/main'))).rejects.toThrow();
    await expectSha(clone, 'refs/heads/main');
    await expectSha(clone, 'refs/remotes/origin/feature');
    // A commit on main writes the loose file again; packed-refs still holds
    // the old tip, and git reads the loose one first.
    await fs.writeFile(path.join(clone, 'c.md'), 'c\n');
    await git(clone, 'add', '-A');
    await git(clone, 'commit', '-qm', 'three');
    await expectSha(clone, 'refs/heads/main');
  });

  it("never decides a tag, loose or packed: what it peels to is git's to say", async () => {
    // A clone packs the refs it fetched (with a peel line for the annotated
    // tag); a tag made here is loose and its file holds the tag object's id.
    // Neither is read: a tag may peel to a tree or a blob, which `^{commit}`
    // refuses, and only git applies that rule.
    expect(await readRefSha(clone, 'refs/tags/v1')).toBe('unreadable');
    expect(await readRefSha(clone, 'refs/tags/light')).toBe('unreadable');
    await git(clone, 'tag', '-a', 'v2', '-m', 'v2');
    expect(await readRefSha(clone, 'refs/tags/v2')).toBe('unreadable');
    await git(clone, 'pack-refs', '--all');
    expect(await readRefSha(clone, 'refs/tags/v2')).toBe('unreadable');
    expect(await readRevSha(clone, 'v1')).toBe('unreadable');
  });

  it('declines a repository whose refs live in a reftable', async () => {
    // Git 2.45+ with `extensions.refStorage = reftable` keeps refs under
    // `.git/reftable/`, not in files this reader understands: every name
    // would read as missing. Both marks of that layout decline, so the
    // caller asks git. Laid out by hand, so the check does not depend on
    // the git on this machine knowing the format.
    await fs.mkdir(path.join(clone, '.git/reftable'));
    expect(await readRefSha(clone, 'refs/heads/main')).toBe('unreadable');
    expect(await readRevSha(clone, 'main')).toBe('unreadable');
    await fs.rm(path.join(clone, '.git/reftable'), { recursive: true });
    await expectSha(clone, 'refs/heads/main');
    await fs.appendFile(path.join(clone, '.git/config'), '[extensions]\n\trefStorage = reftable\n');
    expect(await readRefSha(clone, 'refs/heads/main')).toBe('unreadable');
  });

  it('answers for a worktree: its own HEAD, and the refs it shares with the repository', async () => {
    const wt = path.join(root, 'wt');
    await git(clone, 'worktree', 'add', '-q', wt, 'feature');
    const dotGit = await fs.stat(path.join(wt, '.git'));
    expect(dotGit.isFile()).toBe(true);
    await expectSha(wt, 'HEAD');
    await expectSha(wt, 'refs/heads/feature');
    await expectSha(wt, 'refs/heads/main');
    await expectSha(wt, 'refs/remotes/origin/main');
    expect(await readRefSha(wt, 'HEAD')).not.toEqual(await readRefSha(clone, 'HEAD'));
  });

  it('says missing for a ref no file holds, before and after packing', async () => {
    expect(await readRefSha(clone, 'refs/heads/nope')).toBe('missing');
    expect(await readRefSha(clone, 'refs/remotes/origin/nope')).toBe('missing');
    await git(clone, 'pack-refs', '--all');
    expect(await readRefSha(clone, 'refs/heads/nope')).toBe('missing');
  });

  it('says unreadable where it cannot decide: not a repository, a corrupt file, a name it will not turn into a path', async () => {
    expect(await readRefSha(path.join(root, 'nowhere'), 'refs/heads/main')).toBe('unreadable');
    await fs.writeFile(path.join(clone, '.git/refs/heads/main'), 'not a sha\n');
    expect(await readRefSha(clone, 'refs/heads/main')).toBe('unreadable');
    expect(await readRefSha(clone, 'refs/../config')).toBe('unreadable');
    expect(await readRefSha(clone, 'main')).toBe('unreadable');
    expect(await readRefSha(clone, 'refs/heads/a\\b')).toBe('unreadable');
  });
});

describe('readRevSha', () => {
  let root: string;
  let clone: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ref-rev-'));
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    await execFileAsync('git', ['init', '--bare', '-b', 'main', origin]);
    await fs.mkdir(seed);
    await git(seed, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(seed, 'a.md'), 'a\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', 'one');
    await git(seed, 'checkout', '-qb', 'feature');
    await fs.writeFile(path.join(seed, 'b.md'), 'b\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', 'two');
    await git(seed, 'checkout', '-q', 'main');
    await git(seed, 'remote', 'add', 'origin', origin);
    await git(seed, 'push', '-q', 'origin', 'main', 'feature');
    clone = path.join(root, 'clone');
    await execFileAsync('git', ['clone', '-q', origin, clone]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("takes the candidates in git's order when real refs compete for a name", async () => {
    const want = async (rev: string) => ({ sha: await git(clone, 'rev-parse', '--verify', `${rev}^{commit}`) });
    const first = await git(clone, 'rev-parse', 'origin/main');
    const second = await git(clone, 'rev-parse', 'origin/feature');
    // A local branch literally named `origin/main`, beside the remote-tracking
    // ref: git takes refs/heads before refs/remotes, and so does the reader.
    await git(clone, 'branch', 'origin/main', second);
    expect(await readRevSha(clone, 'origin/main')).toEqual(await want('origin/main'));
    expect(await readRevSha(clone, 'origin/main')).toEqual({ sha: second });
    // A ref directly under refs/ comes before every namespace.
    await git(clone, 'update-ref', 'refs/main', second);
    expect(await readRevSha(clone, 'main')).toEqual(await want('main'));
    expect(await readRevSha(clone, 'main')).toEqual({ sha: second });
    expect(first).not.toBe(second);
    // A tag named like a branch comes before the branch — and a tag is git's
    // to peel, so the reader steps aside rather than answer the branch.
    await git(clone, 'tag', 'feature', first);
    await git(clone, 'branch', 'feature', second);
    expect(await readRevSha(clone, 'feature')).toBe('unreadable');
  });

  it('resolves the names a gate holds the way rev-parse does', async () => {
    const want = async (rev: string) => ({ sha: await git(clone, 'rev-parse', '--verify', `${rev}^{commit}`) });
    expect(await readRevSha(clone, 'main')).toEqual(await want('main'));
    expect(await readRevSha(clone, 'origin/main')).toEqual(await want('origin/main'));
    expect(await readRevSha(clone, 'origin/feature')).toEqual(await want('origin/feature'));
    expect(await readRevSha(clone, 'HEAD')).toEqual(await want('HEAD'));
    expect(await readRevSha(clone, 'refs/remotes/origin/feature')).toEqual(await want('refs/remotes/origin/feature'));
  });

  it('is missing only when every candidate is, which is what rev-parse answers nothing for', async () => {
    // `feature` exists on origin but not as a local branch in this clone:
    // git's own answer for the bare name is "no such rev".
    await expect(git(clone, 'rev-parse', '--verify', '--quiet', 'feature^{commit}')).rejects.toThrow();
    expect(await readRevSha(clone, 'feature')).toBe('missing');
    expect(await readRevSha(clone, 'nope')).toBe('missing');
  });

  it('starts where git starts, at $GIT_DIR/<name>', async () => {
    const sha = await git(clone, 'rev-parse', 'origin/feature');
    await fs.writeFile(path.join(clone, '.git/MERGE_HEAD'), `${sha}\n`);
    expect(await readRevSha(clone, 'MERGE_HEAD')).toEqual({
      sha: await git(clone, 'rev-parse', '--verify', 'MERGE_HEAD^{commit}'),
    });
    // FETCH_HEAD's lines carry more than an id: not decided here, git's call.
    await fs.writeFile(path.join(clone, '.git/FETCH_HEAD'), `${sha}\t\tbranch 'feature' of origin\n`);
    expect(await readRevSha(clone, 'FETCH_HEAD')).toBe('unreadable');
    // A name with no such file goes on to the refs/ candidates as before.
    expect(await readRevSha(clone, 'ORIG_HEAD')).toBe('missing');
  });

  it('hands git what it does not resolve itself', async () => {
    for (const rev of ['', '-x', 'main^{commit}', 'HEAD~1', 'main@{1}', 'abc1234', 'a'.repeat(40), 'a b']) {
      expect(await readRevSha(clone, rev)).toBe('unreadable');
    }
    expect(await readRevSha(path.join(root, 'nowhere'), 'main')).toBe('unreadable');
  });
});
