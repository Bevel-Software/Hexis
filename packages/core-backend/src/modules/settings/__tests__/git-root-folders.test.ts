import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listRootFolders,
  pickListingBranch,
  rootFolderListerFor,
  type GitRunner,
} from '../git-root-folders.js';
import type { IGitRunner } from '../../../shared/git.contract.js';

const LISTING = {
  url: 'https://example.com/acme/kb.git',
  branch: 'main',
  username: 'x-access-token',
  token: 'ghp_listing_secret',
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A runner that records every call and answers each with the next scripted outcome. */
function scripted(outcomes: Array<string | Error>) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; timeout: number }> = [];
  const run: GitRunner = async (args, options) => {
    calls.push({ args, ...options });
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return { stdout: next ?? '' };
  };
  return { run, calls };
}

function fakeDirs() {
  const removed: string[] = [];
  return {
    removed,
    makeTempDir: async () => '/scratch/hexis-root-folders-abc',
    removeDir: async (dir: string) => {
      removed.push(dir);
    },
  };
}

/**
 * The listing has to stay cheap on a large repository — one commit, trees
 * only, nothing checked out — and has to hand git nothing it could read as a
 * flag or print back as a secret.
 */
describe('listRootFolders — the command git is given', () => {
  it('clones one commit without blobs or a checkout, then lists the root trees', async () => {
    const { run, calls } = scripted(['', 'KnowledgeBase\0Plugins\0skills\0']);
    const dirs = fakeDirs();
    const folders = await listRootFolders(LISTING, { run, ...dirs });

    expect(folders).toEqual(['KnowledgeBase', 'Plugins', 'skills']);
    expect(calls).toHaveLength(2);
    const clone = calls[0]!.args;
    const sub = clone.indexOf('clone');
    expect(clone.slice(sub)).toEqual([
      'clone',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-checkout',
      '--single-branch',
      '--branch=main',
      '--end-of-options',
      LISTING.url,
      '/scratch/hexis-root-folders-abc/repo',
    ]);
    // Authenticated through the helper, the token itself only in the environment.
    expect(clone.slice(0, sub).join(' ')).toContain('credential.helper=');
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(LISTING.token);
    expect(calls[0]!.env.BEVEL_PROBE_TOKEN).toBe(LISTING.token);
    expect(calls[0]!.env.GIT_TERMINAL_PROMPT).toBe('0');

    expect(calls[1]!.args).toEqual([
      '-C',
      '/scratch/hexis-root-folders-abc/repo',
      'ls-tree',
      '-d',
      '-z',
      '--name-only',
      'HEAD',
    ]);
    expect(dirs.removed).toEqual(['/scratch/hexis-root-folders-abc']);
  });

  it('falls back to a plain shallow clone when the host cannot filter', async () => {
    const { run, calls } = scripted([
      new Error('fatal: server does not support filter'),
      '',
      'Skills\0',
    ]);
    const dirs = fakeDirs();
    expect(await listRootFolders(LISTING, { run, ...dirs })).toEqual(['Skills']);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.args).toContain('--filter=blob:none');
    expect(calls[1]!.args).not.toContain('--filter=blob:none');
    expect(calls[1]!.args).toContain('--depth=1');
    // The refused attempt's leftovers first, then the whole scratch dir.
    expect(dirs.removed).toEqual([
      '/scratch/hexis-root-folders-abc/repo',
      '/scratch/hexis-root-folders-abc',
    ]);
  });

  it('answers null — never a failed connection — and still cleans up when the clone fails', async () => {
    const { run, calls } = scripted([new Error('fatal: unable to access: ghp_listing_secret')]);
    const dirs = fakeDirs();
    expect(await listRootFolders(LISTING, { run, ...dirs })).toBeNull();
    // Not a filter problem: no second clone.
    expect(calls).toHaveLength(1);
    expect(dirs.removed).toEqual(['/scratch/hexis-root-folders-abc']);
    // What reaches the log has the token scrubbed.
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(LISTING.token);
  });

  it('logs the host-supplied error text escaped, so it cannot steer the terminal', async () => {
    const { run } = scripted([new Error('fatal: remote said 31mred[0m')]);
    expect(await listRootFolders(LISTING, { run, ...fakeDirs() })).toBeNull();
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain('');
    expect(logged).not.toContain('');
    expect(logged).toContain('\\u009b31mred\\u001b[0m');
  });

  it('answers null and cleans up when the listing itself fails', async () => {
    const { run } = scripted(['', new Error('fatal: not a tree object')]);
    const dirs = fakeDirs();
    expect(await listRootFolders(LISTING, { run, ...dirs })).toBeNull();
    expect(dirs.removed).toEqual(['/scratch/hexis-root-folders-abc']);
  });

  it('answers null when there is nowhere to clone into', async () => {
    const { run, calls } = scripted([]);
    const folders = await listRootFolders(LISTING, {
      run,
      makeTempDir: async () => {
        throw new Error('ENOSPC');
      },
    });
    expect(folders).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('removes the real scratch directory it made', async () => {
    let target = '';
    const run: GitRunner = async (args) => {
      target = args[args.length - 1]!;
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'partial'), 'x');
      throw new Error('fatal: timed out');
    };
    expect(await listRootFolders(LISTING, { run })).toBeNull();
    expect(target).not.toBe('');
    expect(existsSync(path.dirname(target))).toBe(false);
  });
});

/**
 * The mocked runner pins the argv; this pins that git ACCEPTS it and that
 * `ls-tree` on a blob-less, checkout-less clone answers with folders only.
 */
describe('listRootFolders — against a real repository', () => {
  let origin = '';
  afterEach(() => {
    if (origin) rmSync(origin, { recursive: true, force: true });
    origin = '';
  });

  it('lists the top-level folders of the named branch, and not its files', async () => {
    origin = mkdtempSync(path.join(tmpdir(), 'hexis-root-folders-origin-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: origin,
        stdio: 'pipe',
      });
    git('init', '--quiet', '-b', 'main');
    git('config', 'uploadpack.allowFilter', 'true');
    for (const dir of ['KnowledgeBase/Team', 'skills/deploy', 'Plugins/GTM']) {
      mkdirSync(path.join(origin, dir), { recursive: true });
    }
    writeFileSync(path.join(origin, 'KnowledgeBase/Team/a.md'), '# a\n');
    writeFileSync(path.join(origin, 'skills/deploy/SKILL.md'), '# deploy\n');
    writeFileSync(path.join(origin, 'Plugins/GTM/plugin.json'), '{}\n');
    writeFileSync(path.join(origin, 'README.md'), '# kb\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'seed');

    const folders = await listRootFolders({
      url: pathToFileURL(origin).href,
      branch: 'main',
      username: 'x-access-token',
      token: '',
    });
    expect(folders).toEqual(['KnowledgeBase', 'Plugins', 'skills']);
  });
});

describe('pickListingBranch', () => {
  it('prefers what the remote calls its trunk', () => {
    expect(pickListingBranch('trunk', 'main', ['main', 'trunk'])).toBe('trunk');
  });
  it('then the configured branch, when the remote has it', () => {
    expect(pickListingBranch(null, 'release', ['main', 'release'])).toBe('release');
    expect(pickListingBranch(null, 'gone', ['develop', 'master'])).toBe('master');
  });
  it('then the first branch, and nothing for an empty remote', () => {
    expect(pickListingBranch(null, null, ['production', 'staging'])).toBe('production');
    expect(pickListingBranch(null, null, [])).toBeNull();
  });
});

describe('rootFolderListerFor — the listing runs through the deployment git port', () => {
  it('hands every git call to the port with the listing deadline, the token only in the environment', async () => {
    const calls: Array<{ cwd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } }> = [];
    const outcomes = ['', 'KnowledgeBase\0Plugins\0'];
    const port: IGitRunner = {
      defaultTimeoutMs: 1000,
      run: (async (cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) => {
        calls.push({ cwd, args, opts });
        return { stdout: outcomes.shift() ?? '', stderr: '' };
      }) as IGitRunner['run'],
    };
    const dirs = fakeDirs();

    const folders = await rootFolderListerFor(port)(LISTING, dirs);

    expect(folders).toEqual(['KnowledgeBase', 'Plugins']);
    expect(calls.map((c) => c.args[c.args.indexOf('clone') === -1 ? 2 : c.args.indexOf('clone')])).toEqual(['clone', 'ls-tree']);
    for (const c of calls) {
      // The port's deadline, not a bare execFile timeout that kills git alone.
      expect(c.opts.timeoutMs).toBe(30_000);
      expect(c.opts.env?.BEVEL_PROBE_TOKEN).toBe(LISTING.token);
      expect(JSON.stringify(c.args)).not.toContain(LISTING.token);
    }
  });
});
