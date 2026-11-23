import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { realDisk } from '../../../__tests__/real-disk.js';
import type { IGitRunner } from '../../../shared/git.contract.js';
import { NodeGitRunner } from '../../version-control/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { AccessControlService } from '../access-control.service.js';
import { HEAD_MAP_LIMITS, type HeadMapLimits, type HeadSeed, type IHeadSeedStore } from '../head-access-map.js';

const execFileAsync = promisify(execFile);
const KB = 'knowledge-base';

/**
 * A branch's reads are answered from a map of the commit its checkout stands
 * on: the rules of that commit, and the few files that declare access of
 * their own. These tests hold the map to three things.
 *
 * It answers what the checkout answers. The reference is the same service
 * over a copy of the same files that is no repository, which can only read
 * the checkout, as every workspace did before the maps.
 *
 * It opens no file to answer: a file that declares nothing is in no list.
 *
 * It follows the head by what changed: a commit that saves one file reads
 * one file version from git, and nothing from the checkout.
 */
describe('AccessControlService: reads answered from the map of the head commit', () => {
  let root: string;
  let repo: string;
  let plain: string;
  let gitLog: string[];
  let opened: string[];

  const USERS = ['admin@x.io', 'mem@x.io', 'sal@x.io', 'zoe@x.io', 'pat@x.io', 'nobody@x.io'];
  const DENY_ALL = '---\nread:\n  - deny everyone\n---\n# restricted\n';
  const FILES: Record<string, string> = {
    'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n  Member:\n    - mem@x.io\n  Sales:\n    - sal@x.io\n',
    'groups.yaml': 'groups:\n  Platform:\n    - zoe@x.io\n',
    'access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n  - Member\n---\n',
    'Top.md': '# top\n',
    'Notes.txt': 'plain text\n',
    'Team/access.md': '---\nread:\n  - Member\n  - Platform\n  - deny Sales\nwrite:\n  - Member\n---\n',
    'Team/Doc.md': '# doc\n',
    'Team/Own.md': '---\nread:\n  - deny everyone\n  - Sales\n---\n# own\n',
    'Team/Write.md': '---\nwrite:\n  - deny Member\n  - pat@x.io\n---\n# write\n',
    'Team/Unclosed.md': '---\nread:\n  - deny everyone\n',
    'Team/pic.png': `${DENY_ALL}not really a picture\n`,
    'Team/Big.transcript': `# a long file\n${'line of a transcript\n'.repeat(10_000)}`,
    'Team/Secret/access.md': '---\nread:\n  - deny everyone\n  - pat@x.io\n---\n',
    'Team/Secret/A.md': '# a\n',
    '.hidden/access.md': '---\nread:\n  - deny everyone\n---\n',
    '.hidden/In.md': '# in a dot folder\n',
    'node_modules/pkg/access.md': '---\nread:\n  - deny everyone\n---\n',
    'node_modules/pkg/In.md': '# vendored\n',
    'Plugins/Demo/plugin.json': '{ "name": "Demo" }\n',
    'Plugins/Demo/access.md': '---\nread:\n  - Sales\n  - deny everyone\n---\n',
    'Plugins/Demo/skills/s/SKILL.md': '# skill\n',
  };
  const FOLDERS = ['Team', 'Team/Secret', 'Plugins/Demo', '.hidden', 'node_modules/pkg'];

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
    return stdout.trim();
  }

  async function write(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    }
  }

  async function commit(message: string, files: Record<string, string>): Promise<void> {
    await write(repo, files);
    await git('add', '-A', '-f');
    await git('commit', '-qm', message);
  }

  /** The same files as the repository's checkout, in a folder that is no repository. */
  async function copyToPlain(): Promise<void> {
    await fs.rm(plain, { recursive: true, force: true });
    await fs.cp(repo, plain, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  }

  function service(
    limits: Partial<HeadMapLimits> = {},
    store?: IHeadSeedStore,
    /** `now`: the service's clock. `failGit`: git calls that fail, as a git that timed out does. */
    opts: { now?: () => number; failGit?: (args: string[]) => boolean } = {},
  ): AccessControlService {
    const real = new NodeGitRunner();
    const counted: IGitRunner = {
      defaultTimeoutMs: real.defaultTimeoutMs,
      credentials: real.credentials,
      run: ((cwd: string, args: string[], runOpts?: unknown) => {
        gitLog.push(args[0]!);
        if (opts.failGit?.(args)) return Promise.reject(new Error('git timed out (simulated)'));
        return (real.run as (...a: unknown[]) => unknown)(cwd, args, runOpts);
      }) as IGitRunner['run'],
    };
    const stub = {
      getWorkspacePath: async (id: string) => path.join(root, id),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    return new AccessControlService(stub, KB, realDisk(), [], counted, undefined, { now: opts.now }, undefined, undefined, {
      limits: { ...HEAD_MAP_LIMITS, ...limits },
      store,
    });
  }

  /** Every gate's answer for every person and path, as one comparable value. */
  async function answers(svc: AccessControlService, workspaceId: string, paths: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const user of USERS) {
      out[`${user} read`] = Object.fromEntries(await svc.canReadBatch(workspaceId, user, paths));
      out[`${user} write`] = Object.fromEntries(await svc.canWriteBatch(workspaceId, user, paths));
      out[`${user} download`] = Object.fromEntries(await svc.canDownloadBatch(workspaceId, user, paths));
      out[`${user} owner`] = Object.fromEntries(await svc.canOwnerBatch(workspaceId, user, paths));
      for (const p of paths) {
        out[`${user} reads ${p}`] = await svc.canRead(workspaceId, user, p);
        out[`${user} writes ${p}`] = await svc.canWrite(workspaceId, user, p);
      }
    }
    out.everyone = Object.fromEntries(await svc.canReadAsEveryoneBatch(workspaceId, paths));
    return out;
  }

  const reset = () => {
    gitLog.length = 0;
    opened.length = 0;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-head-map-'));
    repo = path.join(root, 'ws', KB);
    plain = path.join(root, 'plain', KB);
    gitLog = [];
    opened = [];
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('config', 'core.autocrlf', 'false');
    await commit('seed', FILES);
    await copyToPlain();
    // Every file of the checkout the service opens, by the two calls it reads with.
    const realOpen = fs.open.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const note = (target: unknown) => {
      const file = String(target);
      if (file.startsWith(repo) && !file.includes(`${path.sep}.git${path.sep}`)) opened.push(path.relative(repo, file));
    };
    vi.spyOn(fs, 'open').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      note(file);
      return (realOpen as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.open);
    vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      note(file);
      return (realReadFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFile);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('answers every gate as the checkout does, for every person and path', async () => {
    const paths = [...Object.keys(FILES), ...FOLDERS, 'Team/Absent.md'];
    const svc = service();
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    // And it was the map that answered: the batch gates opened no file.
    reset();
    await svc.canReadBatch('ws', 'mem@x.io', paths);
    expect(opened).toEqual([]);
  }, 120_000);

  it('opens no file and starts no git for a second batch on the same commit', async () => {
    const paths = Object.keys(FILES);
    const svc = service();
    await svc.canReadBatch('ws', 'mem@x.io', paths);
    reset();
    const again = await svc.canReadBatch('ws', 'nobody@x.io', paths);
    expect(again.get('Top.md')).toBe(true);
    expect(again.get('Team/Own.md')).toBe(false);
    expect(again.get('Team/pic.png')).toBe(false);
    expect(opened).toEqual([]);
    expect(gitLog).toEqual([]);
  });

  it('follows a head that moves by one saved file with one listing and one read of that file', async () => {
    const svc = service();
    await svc.canReadBatch('ws', 'mem@x.io', Object.keys(FILES));

    await commit('a new page', { 'Team/New.md': '# new\n' });
    reset();
    const paths = [...Object.keys(FILES), 'Team/New.md'];
    expect((await svc.canReadBatch('ws', 'mem@x.io', paths)).get('Team/New.md')).toBe(true);
    // The access files are the ones already held: only the new file is read.
    expect(gitLog).toEqual(['ls-tree', 'cat-file']);
    expect(opened).toEqual([]);

    // A commit that changes what a file declares is answered from the new version.
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(false);
    await commit('own page opened', { 'Team/Own.md': '# own, now plain\n' });
    reset();
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(true);
    expect(gitLog).toEqual(['ls-tree', 'cat-file']);
    expect(opened).toEqual([]);

    // A commit that changes an access file is read, and its rules decide.
    await commit('team closed to members', { 'Team/access.md': '---\nread:\n  - deny Member\n---\n' });
    reset();
    expect((await svc.canReadBatch('ws', 'mem@x.io', paths)).get('Team/Doc.md')).toBe(false);
    expect(opened).toEqual([]);
  }, 120_000);

  it('reads a file the commit does not hold from the checkout', async () => {
    const svc = service();
    await svc.canReadBatch('ws', 'nobody@x.io', Object.keys(FILES));
    await write(repo, { 'Team/Fresh.md': DENY_ALL });
    reset();
    const got = await svc.canReadBatch('ws', 'nobody@x.io', ['Team/Fresh.md', 'Team/Doc.md', 'Top.md']);
    expect(got.get('Team/Fresh.md')).toBe(false);
    expect(got.get('Top.md')).toBe(true);
    expect(opened).toEqual([path.join('Team', 'Fresh.md')]);
  });

  it('answers from the checkout once a workspace is reported changed, until the change is a commit', async () => {
    const svc = service();
    const read = async () => (await svc.canReadBatch('ws', 'nobody@x.io', ['Top.md'])).get('Top.md');
    expect(await read()).toBe(true);

    // On disk and in no commit, and nobody said so: the commit still answers.
    await write(repo, { 'Top.md': DENY_ALL });
    expect(await read()).toBe(true);

    // Reported: the checkout answers.
    svc.invalidate('ws');
    expect(await read()).toBe(false);

    // Committed: the map of the new commit answers, without opening the file.
    await git('commit', '-qam', 'top restricted');
    reset();
    expect(await read()).toBe(false);
    expect(opened).toEqual([]);
  });

  it('answers from the checkout while a first map is still being read, and from the map once it is', async () => {
    const paths = Object.keys(FILES);
    const svc = service({ waitBytes: 0 });
    const first = await svc.canReadBatch('ws', 'nobody@x.io', paths);
    expect(first.get('Team/Own.md')).toBe(false);
    expect(opened.length).toBeGreaterThan(0);
    await vi.waitFor(
      async () => {
        reset();
        await svc.canReadBatch('ws', 'nobody@x.io', paths);
        expect(opened).toEqual([]);
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
  }, 120_000);

  it('reads the file versions of a first map in parts no larger than the limit', async () => {
    const svc = service({ chunkBytes: 64 });
    const paths = Object.keys(FILES);
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    // One listing, one read of the access files, and many small reads of the rest.
    expect(gitLog.filter((a) => a === 'ls-tree')).toHaveLength(1);
    expect(gitLog.filter((a) => a === 'cat-file').length).toBeGreaterThan(5);
  }, 120_000);

  it('answers from the checkout when reading the file versions fails, and makes the map once git answers again', async () => {
    const paths = Object.keys(FILES);
    let clock = 1_000_000;
    let failing = true;
    // The second batched read of a build is the one for the file versions.
    let reads = 0;
    const svc = service({}, undefined, {
      now: () => clock,
      failGit: (args) => args[0] === 'cat-file' && failing && ++reads === 2,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(false);
    expect(opened.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/answering from the checkout/));

    // Not tried again on every call…
    failing = false;
    reset();
    await svc.canReadBatch('ws', 'nobody@x.io', paths);
    expect(gitLog).toEqual([]);

    // …and tried again later: the map answers, and no file is opened.
    clock += 31_000;
    await svc.canReadBatch('ws', 'nobody@x.io', paths);
    reset();
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(false);
    expect(opened).toEqual([]);
  }, 120_000);

  it('begins from a stored seed after a restart: reads the files that declare something and what changed since', async () => {
    const paths = Object.keys(FILES);
    let stored: HeadSeed | null = null;
    const store: IHeadSeedStore = {
      load: async () => stored,
      save: async (seed) => {
        stored = seed;
      },
    };
    // A first process: no seed, every file version is read, and a seed is saved.
    const first = service({}, store);
    expect(await answers(first, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    await vi.waitFor(() => expect(stored).not.toBeNull());
    expect(stored!.commit).toBe(await git('rev-parse', 'HEAD'));
    // An opening fence that is never closed is no frontmatter: that file declares nothing.
    expect(stored!.declaring.map(([p]) => p).sort()).toEqual(['Team/Own.md', 'Team/Write.md', 'Team/pic.png'].sort());

    // The branch moves on while no process runs.
    await commit('a page since', { 'Team/Since.md': DENY_ALL });
    await copyToPlain();

    // A second process begins from the seed: one read for the seed's
    // declaring files, one for the commit's access files, one for the page
    // added since. No other file version is read.
    reset();
    const second = service({}, store);
    const all = [...paths, 'Team/Since.md'];
    expect((await second.canReadBatch('ws', 'nobody@x.io', all)).get('Team/Since.md')).toBe(false);
    expect(gitLog).toEqual(['ls-tree', 'cat-file', 'ls-tree', 'cat-file', 'cat-file']);
    expect(opened).toEqual([]);
    expect(await answers(second, 'ws', all)).toEqual(await answers(service(), 'plain', all));
  }, 120_000);

  it('reads every file again when the stored seed names a commit the repository does not have', async () => {
    const store: IHeadSeedStore = {
      load: async () => ({ commit: 'f'.repeat(40), declaring: [] }),
      save: async () => undefined,
    };
    const paths = Object.keys(FILES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await answers(service({}, store), 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stored access seed was not used/));
  }, 120_000);

  it.skipIf(process.platform === 'win32')('makes no map of a commit that holds a symbolic link, and answers from the checkout', async () => {
    await fs.symlink('Doc.md', path.join(repo, 'Team', 'Link.md'));
    await git('add', '-A', '-f');
    await git('commit', '-qm', 'a link');
    await copyToPlain();
    const paths = [...Object.keys(FILES), 'Team/Link.md'];
    const svc = service();
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    // The commit was listed once, with its access files read, and remembered
    // as one without a map: no file version was read for it, then or later.
    expect(gitLog).toEqual(['ls-tree', 'cat-file']);
  }, 120_000);
});
