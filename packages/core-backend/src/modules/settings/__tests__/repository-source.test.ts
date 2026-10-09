import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';
import { ManagedRepository, MANAGED_REPOSITORY_DIR } from '../managed-repository.js';
import { RepositorySource, type GitHubAppRepository } from '../repository-source.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-managed-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const reading = (values: Record<string, string>) => (key: string) => values[key] ?? '';

function source(values: Record<string, string>, extra: { fallbackToken?: string; githubApp?: GitHubAppRepository } = {}) {
  const managed = new ManagedRepository(path.join(root, 'managed-repository'));
  return {
    managed,
    source: new RepositorySource({
      read: reading(values),
      fallback: { username: 'x-access-token', token: extra.fallbackToken ?? '' },
      managed,
      ...(extra.githubApp ? { githubApp: extra.githubApp } : {}),
    }),
  };
}

const HOSTED = { kbRepoUrl: 'https://git.example.com/acme/kb.git', gitToken: 'the-token', gitUsername: 'oauth2' };

describe('RepositorySource: which way a deployment has its repository', () => {
  it('has none while nothing is configured', () => {
    const { source: s } = source({});
    expect(s.mode()).toBeNull();
    expect(s.url()).toBe('');
    expect(s.answered()).toBe(false);
    expect(s.credentials.token()).toBeNull();
  });

  it('reads a deployment configured before there was a choice as what it has: an address and a token', () => {
    const { source: s } = source(HOSTED);
    expect(s.mode()).toBe('token');
    expect(s.url()).toBe(HOSTED.kbRepoUrl);
    expect(s.credentials.token()).toBe('the-token');
    expect(s.credentials.username()).toBe('oauth2');
    expect(s.answered()).toBe(true);
  });

  it('reads a token the environment spells the old way', () => {
    const { source: s } = source({ kbRepoUrl: HOSTED.kbRepoUrl }, { fallbackToken: 'from-GITHUB_TOKEN' });
    expect(s.mode()).toBe('token');
    expect(s.credentials.token()).toBe('from-GITHUB_TOKEN');
    expect(s.answered()).toBe(true);
  });

  it('is not answered by half of an address and a token', () => {
    expect(source({ kbRepoUrl: HOSTED.kbRepoUrl }).source.answered()).toBe(false);
    expect(source({ gitToken: 'the-token' }).source.answered()).toBe(false);
  });

  it('ignores a mode it does not know, and reads what is configured', () => {
    expect(source({ ...HOSTED, gitMode: 'carrier-pigeon' }).source.mode()).toBe('token');
  });

  it('answers for the values a save would put in effect, without the save', () => {
    const { source: s, managed } = source(HOSTED);
    const after = reading({ ...HOSTED, gitMode: 'managed' });
    expect(s.mode(after)).toBe('managed');
    expect(s.url(after)).toBe(managed.path);
    // What is in effect has not moved.
    expect(s.mode()).toBe('token');
  });
});

describe('RepositorySource: a repository the deployment keeps', () => {
  it('is reached by its path, and presented nothing', () => {
    const { source: s, managed } = source({ gitMode: 'managed' });
    expect(s.url()).toBe(managed.path);
    expect(s.url()).toBe(path.join(root, 'managed-repository', MANAGED_REPOSITORY_DIR));
    expect(s.answered()).toBe(true);
    expect(s.credentials.token()).toBeNull();
  });

  /**
   * One mode's credential is never presented to another mode's repository.
   * A deployment that moved still has its old token stored, and it must not
   * ride along in the environment of every git call made against a folder.
   */
  it('is never presented the token of the repository the deployment had before', () => {
    const { source: s } = source({ ...HOSTED, gitMode: 'managed' }, { fallbackToken: 'from-the-environment' });
    expect(s.credentials.token()).toBeNull();
    expect(s.credentials.username()).toBe('x-access-token');
  });
});

describe('RepositorySource: a repository reached through a GitHub App', () => {
  const app = (overrides: Partial<GitHubAppRepository> = {}): GitHubAppRepository => ({
    url: () => 'https://github.com/acme/kb.git',
    token: () => 'an-installation-token',
    prepare: async () => undefined,
    answered: () => true,
    ...overrides,
  });

  it('asks the app for the address and the token', () => {
    const { source: s } = source({ gitMode: 'github-app', gitToken: 'a-leftover' }, { githubApp: app() });
    expect(s.url()).toBe('https://github.com/acme/kb.git');
    expect(s.credentials.token()).toBe('an-installation-token');
    expect(s.credentials.username()).toBe('x-access-token');
    expect(s.answered()).toBe(true);
  });

  it('renews the token before git is run, and only in this mode', async () => {
    let renewed = 0;
    const githubApp = app({ prepare: async () => void (renewed += 1) });
    await source({ gitMode: 'github-app' }, { githubApp }).source.credentials.prepare?.();
    await source(HOSTED, { githubApp }).source.credentials.prepare?.();
    await source({ gitMode: 'managed' }, { githubApp }).source.credentials.prepare?.();
    expect(renewed).toBe(1);
  });

  it("hands the app the runner's word that the host refused the token", async () => {
    const seen: unknown[] = [];
    const githubApp = app({ prepare: async (opts) => void seen.push(opts) });
    const { source: s } = source({ gitMode: 'github-app' }, { githubApp });
    await s.credentials.prepare?.({ refused: true });
    await s.credentials.prepare?.();
    expect(seen).toEqual([{ refused: true }, undefined]);
  });

  it('is unanswered on a deployment that has no such app', () => {
    const { source: s } = source({ gitMode: 'github-app' });
    expect(s.answered()).toBe(false);
    expect(s.url()).toBe('');
    expect(s.credentials.token()).toBeNull();
  });
});

describe('ManagedRepository', () => {
  const runner = new NodeGitRunner(30_000);
  const git = async (cwd: string, ...args: string[]) => (await runner.run(cwd, args)).stdout.trim();

  it('is created empty, bare, on the branch it is given', async () => {
    const managed = new ManagedRepository(path.join(root, 'managed-repository'));
    expect(await managed.exists()).toBe(false);
    await managed.ensure(runner, 'trunk');
    expect(await managed.exists()).toBe(true);
    expect(await git(managed.path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(await git(managed.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/trunk');
    expect(await git(managed.path, 'for-each-ref')).toBe('');
  });

  it('is cloned from, pushed to and fetched from like any remote', async () => {
    const managed = new ManagedRepository(path.join(root, 'managed-repository'));
    await managed.ensure(runner);
    const one = path.join(root, 'one');
    await fs.mkdir(one);
    await git(one, 'init', '--initial-branch=main');
    await fs.writeFile(path.join(one, 'README.md'), 'hello\n');
    await git(one, 'add', '.');
    await git(one, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'first');
    await git(one, 'push', managed.path, 'main');

    const two = path.join(root, 'two');
    await git(root, 'clone', '-b', 'main', managed.path, two);
    // Whatever this machine's git makes of line endings on checkout.
    expect((await fs.readFile(path.join(two, 'README.md'), 'utf8')).replace(/\r\n/g, '\n')).toBe('hello\n');
    expect(await git(two, 'config', '--get', 'remote.origin.url')).toBe(managed.path);
  });

  it('is left exactly as it is when it already exists', async () => {
    const managed = new ManagedRepository(path.join(root, 'managed-repository'));
    await managed.ensure(runner);
    const work = path.join(root, 'work');
    await fs.mkdir(work);
    await git(work, 'init', '--initial-branch=main');
    await fs.writeFile(path.join(work, 'a.md'), 'a\n');
    await git(work, 'add', '.');
    await git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'first');
    await git(work, 'push', managed.path, 'main');
    const before = await git(managed.path, 'for-each-ref');

    await managed.ensure(runner, 'another-branch');
    expect(await git(managed.path, 'for-each-ref')).toBe(before);
    expect(await git(managed.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  it('refuses a folder that holds something that is not a repository', async () => {
    const managed = new ManagedRepository(path.join(root, 'managed-repository'));
    await fs.mkdir(managed.path, { recursive: true });
    await fs.writeFile(path.join(managed.path, 'somebody.txt'), 'theirs');
    await expect(managed.ensure(runner)).rejects.toThrow(/is not a git repository/);
    expect(await fs.readFile(path.join(managed.path, 'somebody.txt'), 'utf8')).toBe('theirs');
  });
});
