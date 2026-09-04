import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';

import { MarketplaceRepoService, type MarketplaceCompiler } from '../marketplace-repo.service.js';
import { createMarketplaceGitRoutes } from '../git-http.routes.js';
import type { VirtualTree } from '../../plugins/compile/compile-marketplace.js';

const execFileAsync = promisify(execFile);
// No credential helper and no prompt: a 401 must FAIL the command, not open
// the OS credential manager (which would hang the test on Windows). No
// autocrlf either, so the bytes the server sent are the bytes we read back.
const git = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileAsync('git', ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...opts.env },
  });

/**
 * The marketplace as a git remote, driven the way a client drives it: real
 * `git clone` and `git pull` over HTTP against the express router, with a
 * stub compiler standing in for the knowledge base. What is under test is
 * the namespace isolation, the fast-forward contract, the auth, and the
 * read-only guarantee — not the compiler.
 */

const users: Record<string, AuthUser> = {
  'bevel_alice': { id: 'user-alice', email: 'alice@x.io', name: 'Alice' } as AuthUser,
  'bevel_bob': { id: 'user-bob', email: 'bob@x.io', name: 'Bob' } as AuthUser,
};

function tree(files: Record<string, string>, sourceCommit: string): VirtualTree & { sourceCommit: string } {
  return {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    warnings: [],
    plugins: [],
    sourceCommit,
  };
}

describe('marketplace git endpoint', () => {
  let root: string;
  let repo: MarketplaceRepoService;
  let server: http.Server;
  let base: string;
  /** What the "knowledge base" currently is, per user. */
  let source = 'aaa111';
  let trees: Record<string, Record<string, string>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-mp-'));
    source = 'aaa111';
    trees = {
      'alice@x.io': { 'README.md': 'alice v1\n', 'plugins/gtm/skills/deploy/SKILL.md': '---\n---\nship\n' },
      'bob@x.io': { 'README.md': 'bob v1\n' },
    };
    const compiler: MarketplaceCompiler = {
      sourceCommit: async () => source,
      compileFor: async ({ userEmail }) => tree(trees[userEmail] ?? {}, source),
    };
    repo = new MarketplaceRepoService(path.join(root, 'data', 'marketplace.git'), compiler);
    const app = express();
    app.use(
      '/git',
      createMarketplaceGitRoutes({
        repo,
        keys: {
          looksLikeExternalApiKey: (t) => t.startsWith('bevel_'),
          verifyAndLoadToken: async (t) => (users[t] ? { tokenId: `tok-${t}`, user: users[t] } : null),
        },
        mountPath: '/git',
      }),
    );
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}/git/marketplace.git`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const withKey = (key: string) => base.replace('http://', `http://key:${key}@`);
  const clone = async (key: string, dir: string) => git(['clone', '--quiet', withKey(key), dir]);
  const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf-8');

  it('clones each caller their own tree, and nothing of anyone else\'s', async () => {
    const a = path.join(root, 'alice');
    const b = path.join(root, 'bob');
    await clone('bevel_alice', a);
    await clone('bevel_bob', b);
    expect(await read(a, 'README.md')).toBe('alice v1\n');
    expect(await read(a, 'plugins/gtm/skills/deploy/SKILL.md')).toContain('ship');
    expect(await read(b, 'README.md')).toBe('bob v1\n');
    await expect(read(b, 'plugins/gtm/skills/deploy/SKILL.md')).rejects.toThrow();
    // One object store underneath: both namespaces live in the same bare repo.
    const { stdout } = await git(['-C', repo.repoDir, 'for-each-ref', '--format=%(refname)', 'refs/namespaces/']);
    // Each namespace carries a HEAD symref beside its branch; the branches are the point.
    expect(stdout.split('\n').filter((r) => r.endsWith('/refs/heads/main')).sort()).toEqual([
      'refs/namespaces/u-user-alice/refs/heads/main',
      'refs/namespaces/u-user-bob/refs/heads/main',
    ]);
  });

  it('pulls fast-forward after the knowledge base moves, and does not recompile when it has not', async () => {
    const a = path.join(root, 'alice');
    await clone('bevel_alice', a);
    const first = (await git(['-C', a, 'rev-parse', 'HEAD'])).stdout.trim();

    // Same source: a pull is a no-op with the same head.
    expect((await repo.ensureCompiled({ id: 'user-alice', email: 'alice@x.io' })).compiled).toBe(false);
    await git(['-C', a, 'pull', '--quiet', '--ff-only']);
    expect((await git(['-C', a, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(first);

    // The KB moves and access is withdrawn from the skill: one new commit,
    // the file is gone, and the pull is still a fast-forward.
    source = 'bbb222';
    trees['alice@x.io'] = { 'README.md': 'alice v2\n' };
    await git(['-C', a, 'pull', '--quiet', '--ff-only']);
    expect(await read(a, 'README.md')).toBe('alice v2\n');
    await expect(read(a, 'plugins/gtm/skills/deploy/SKILL.md')).rejects.toThrow();
    const log = (await git(['-C', a, 'log', '--format=%s'])).stdout.trim().split('\n');
    expect(log).toEqual(['Compile marketplace from bbb222', 'Compile marketplace from aaa111']);
  });

  it('a moved source with an identical tree writes no new commit', async () => {
    const a = path.join(root, 'alice');
    await clone('bevel_alice', a);
    source = 'ccc333';
    const r = await repo.ensureCompiled({ id: 'user-alice', email: 'alice@x.io' });
    expect(r.compiled).toBe(false);
    await git(['-C', a, 'pull', '--quiet', '--ff-only']);
    expect((await git(['-C', a, 'log', '--format=%s'])).stdout.trim().split('\n')).toHaveLength(1);
  });

  it('refuses a missing or unknown key with a Basic challenge, and refuses pushes', { timeout: 60_000 }, async () => {
    await expect(git(['clone', '--quiet', base, path.join(root, 'anon')])).rejects.toThrow();
    await expect(git(['clone', '--quiet', withKey('bevel_nobody'), path.join(root, 'bad')])).rejects.toThrow();
    const res = await fetch(`${base}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');

    const a = path.join(root, 'alice');
    await clone('bevel_alice', a);
    await fs.writeFile(path.join(a, 'evil.md'), 'no');
    await git(['-C', a, 'add', 'evil.md']);
    await git(['-C', a, 'commit', '--quiet', '-m', 'push attempt'], {
      env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' },
    });
    await expect(git(['-C', a, 'push', '--quiet', 'origin', 'HEAD:main'])).rejects.toThrow();
    const push = await fetch(`${base}/info/refs?service=git-receive-pack`, {
      headers: { authorization: `Basic ${Buffer.from('key:bevel_alice').toString('base64')}` },
    });
    expect(push.status).toBe(403);
  });
});
