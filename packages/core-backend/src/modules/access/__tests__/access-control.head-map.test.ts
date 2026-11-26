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
import { AccessControlService, type AccessModel } from '../access-control.service.js';
import { HEAD_MAP_LIMITS, HeadMaps, type HeadMapLimits, type HeadSeed, type IHeadSeedStore } from '../head-access-map.js';
import { TreeIndexer } from '../tree-index.js';

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
  /** What each `git cat-file --batch` was asked for, one line per object. */
  let catFiled: string[];

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

  /**
   * Make git's stat cache vouch for `rel` as it is on disk now, with the attributes that hold now: dated in the
   * past, so git never reads it again to check.
   */
  async function vouchedFor(rel: string): Promise<void> {
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(repo, rel), past, past);
    await git('update-index', '-q', '--refresh');
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
    opts: {
      now?: () => number;
      failGit?: (args: string[]) => boolean;
      /** Runs before a git call is made, and is waited for. */
      beforeGit?: (args: string[]) => Promise<void>;
    } = {},
  ): AccessControlService {
    const real = new NodeGitRunner();
    const counted: IGitRunner = {
      defaultTimeoutMs: real.defaultTimeoutMs,
      credentials: real.credentials,
      run: (async (cwd: string, args: string[], runOpts?: unknown) => {
        gitLog.push(args[0]!);
        if (args[0] === 'cat-file') {
          catFiled.push(...String((runOpts as { input?: unknown } | undefined)?.input ?? '').split('\n').filter(Boolean));
        }
        await opts.beforeGit?.(args);
        if (opts.failGit?.(args)) throw new Error('git timed out (simulated)');
        return (real.run as (...a: unknown[]) => unknown)(cwd, args, runOpts);
      }) as IGitRunner['run'],
    };
    const stub = {
      getWorkspacePath: async (id: string) => path.join(root, id),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    // The head maps, made as the composition root makes them.
    const headMaps = new HeadMaps<AccessModel>(counted, new TreeIndexer(), { ...HEAD_MAP_LIMITS, ...limits }, store, opts.now);
    return new AccessControlService(stub, KB, realDisk(), [], counted, undefined, { now: opts.now }, undefined, undefined, headMaps);
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
    catFiled.length = 0;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-head-map-'));
    repo = path.join(root, 'ws', KB);
    plain = path.join(root, 'plain', KB);
    gitLog = [];
    opened = [];
    catFiled = [];
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
    // The access files are the ones already held: only the new file is read, from the checkout, which git's stat
    // cache does not say differs and whose bytes hash to the commit's version.
    expect(gitLog).toEqual(['ls-tree', 'diff-index']);
    expect(opened).toEqual([path.join('Team', 'New.md')]);

    // A commit that changes what a file declares is answered from the new version.
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(false);
    await commit('own page opened', { 'Team/Own.md': '# own, now plain\n' });
    reset();
    expect((await svc.canReadBatch('ws', 'nobody@x.io', paths)).get('Team/Own.md')).toBe(true);
    expect(gitLog).toEqual(['ls-tree', 'diff-index']);
    expect(opened).toEqual([path.join('Team', 'Own.md')]);

    // A commit that changes an access file is read, and its rules decide. An `access.md` is read through git, never
    // from the checkout: its body decides what it declares, so its start alone would not do.
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

    // Committed: the map of the new commit answers, reading the one changed file's start.
    await git('commit', '-qam', 'top restricted');
    reset();
    expect(await read()).toBe(false);
    expect(opened).toEqual(['Top.md']);
  });

  it('answers a batch from one commit when a commit lands while the batch is being answered', async () => {
    // At the first commit the page restricts itself. The second moves that
    // restriction to the page's folder. The rules of the first with the
    // page's own entries of the second would hold neither, and admit anyone.
    await commit('page restricts itself', { 'Move/X.md': DENY_ALL });
    let landed = false;
    const svc = service({}, undefined, {
      beforeGit: async (args) => {
        // The first listing is the map of the first commit being made, after
        // the head was read: the second commit lands now.
        if (args[0] !== 'ls-tree' || landed) return;
        landed = true;
        await commit('restriction moves to the folder', {
          'Move/X.md': '# x\n',
          'Move/access.md': '---\nread:\n  - deny everyone\n---\n',
        });
      },
    });
    const read = async () => (await svc.canReadBatch('ws', 'nobody@x.io', ['Move/X.md'])).get('Move/X.md');
    expect(await read()).toBe(false);
    expect(landed).toBe(true);
    // And the next batch, from the second commit, refuses by the folder.
    expect(await read()).toBe(false);
  });

  it('reads nothing for the paths of a group the model does not know', async () => {
    const paths = Object.keys(FILES);
    const sources = /(^|[\\/])(access\.md|roles\.yaml|groups\.yaml|synced-groups\.yaml|plugin\.json)$/;
    // Answered from the checkout (the workspace is reported changed), where
    // reading for a path means opening it.
    const svc = service();
    svc.invalidate('ws');
    expect(await svc.canReadAsGroupBatch('ws', 'No Such Group', paths)).toBeNull();
    expect(opened.filter((p) => !sources.test(p))).toEqual([]);
    // A group it knows is answered for every path.
    const known = await svc.canReadAsGroupBatch('ws', 'Platform', paths);
    expect(known?.get('Team/Doc.md')).toBe(true);
    expect(known?.get('Team/Own.md')).toBe(false);
  });

  it('stops answering a reported change from the checkout after ten seconds when no commit follows', async () => {
    let clock = 1_000_000;
    const svc = service({}, undefined, { now: () => clock });
    const read = async () => (await svc.canReadBatch('ws', 'nobody@x.io', ['Top.md'])).get('Top.md');
    expect(await read()).toBe(true);
    await write(repo, { 'Top.md': DENY_ALL });
    svc.invalidate('ws');
    expect(await read()).toBe(false);
    clock += 9_000;
    expect(await read()).toBe(false);
    // Still on disk and in no commit: past the wait, the commit answers again.
    clock += 2_000;
    expect(await read()).toBe(true);
  });

  it('takes no rule from an access file git does not track, where the checkout alone would', async () => {
    const loose = { 'Team/Loose/access.md': '---\nread:\n  - deny everyone\n---\n', 'Team/Loose/A.md': '# a\n' };
    const svc = service();
    await svc.canReadBatch('ws', 'mem@x.io', Object.keys(FILES));
    // Written and never committed, and nothing reports it.
    await write(repo, loose);
    await copyToPlain();
    const asked = ['Team/Loose/A.md', 'Team/Doc.md'];
    expect(Object.fromEntries(await svc.canReadBatch('ws', 'mem@x.io', asked))).toEqual({
      'Team/Loose/A.md': true,
      'Team/Doc.md': true,
    });
    // The same files read as a checkout only: the loose rule counts there.
    expect(Object.fromEntries(await service().canReadBatch('plain', 'mem@x.io', asked))).toEqual({
      'Team/Loose/A.md': false,
      'Team/Doc.md': true,
    });
    // Committed, it is a rule for the map too.
    await git('add', '-A', '-f');
    await git('commit', '-qm', 'loose rule committed');
    expect((await svc.canReadBatch('ws', 'mem@x.io', asked)).get('Team/Loose/A.md')).toBe(false);
  }, 120_000);

  it('answers from the checkout for a commit that holds a submodule, keeping every denial', async () => {
    // A gitlink: what the checkout holds at that path is not what the commit holds, so the commit gets no map.
    await git('update-index', '--add', '--cacheinfo', `160000,${await git('rev-parse', 'HEAD')},Vendor/sub`);
    await git('commit', '-qm', 'a submodule');
    // A rule written on disk and never committed: the checkout takes it, a map of the commit would not (see the
    // test above), so it shows which of the two answers.
    await write(repo, { 'Team/Loose/access.md': '---\nread:\n  - deny everyone\n---\n', 'Team/Loose/A.md': '# a\n' });
    const asked = ['Team/Own.md', 'Team/Secret/A.md', 'Team/Loose/A.md', 'Team/Doc.md', 'Top.md'];
    expect(Object.fromEntries(await service().canReadBatch('ws', 'mem@x.io', asked))).toEqual({
      'Team/Own.md': false,
      'Team/Secret/A.md': false,
      'Team/Loose/A.md': false,
      'Team/Doc.md': true,
      'Top.md': true,
    });
  }, 120_000);

  it('never remembers what a file changed on disk and not committed declares as its commit version', async () => {
    // A restriction on disk that no commit holds.
    await write(repo, { 'Team/Doc.md': DENY_ALL });
    const svc = service();
    // The map holds the commit's version: the page is open to members.
    expect((await svc.canReadBatch('ws', 'mem@x.io', ['Team/Doc.md'])).get('Team/Doc.md')).toBe(true);
    // Another checkout of the same commit shares what versions declare: it must find the commit's version
    // remembered, not the disk's.
    await execFileAsync('git', ['clone', '-q', repo, path.join(root, 'ws2', KB)]);
    reset();
    expect((await svc.canReadBatch('ws2', 'mem@x.io', ['Team/Doc.md', 'Team/Own.md']))).toEqual(
      new Map([
        ['Team/Doc.md', true],
        ['Team/Own.md', false],
      ]),
    );
  }, 120_000);

  // Git calls a file the same on disk as in the commit after its filters, end-of-line conversion and encoding have
  // run, under the attributes and configuration of the day it was written out, so the bytes on disk can be other
  // than the version's; what they declare is then no fact about the version. Only the bytes' hash proves them.
  it('keeps a page restricted whose bytes on disk a filter wrote, though its filter attribute is gone', async () => {
    // A filter that hides the page's frontmatter on disk, and puts it back for git: git calls the file unchanged.
    await git('config', 'filter.fence.smudge', "sed -e 's/^---$/+++/'");
    await git('config', 'filter.fence.clean', "sed -e 's/^+++$/---/'");
    await commit('own page filtered', { '.gitattributes': 'Team/Own.md filter=fence\n' });
    await fs.rm(path.join(repo, 'Team', 'Own.md'));
    await git('checkout', '--', 'Team/Own.md');
    await vouchedFor('Team/Own.md');
    // The attribute goes, then the driver; the page keeps the bytes the filter wrote, of the version's size.
    await write(repo, { '.gitattributes': '# no attributes\n' });
    await git('add', '--', '.gitattributes');
    await git('commit', '-qm', 'filter attribute removed');
    await git('config', '--unset', 'filter.fence.smudge');
    await git('config', '--unset', 'filter.fence.clean');
    expect(await git('check-attr', 'filter', '--', 'Team/Own.md')).toBe('Team/Own.md: filter: unspecified');
    expect(await fs.readFile(path.join(repo, 'Team', 'Own.md'), 'utf-8')).toMatch(/^\+\+\+\n/);
    expect(await git('diff-index', '--name-only', 'HEAD', '--')).toBe('');
    reset();

    // The commit's page denies everyone but Sales, though the page on disk declares nothing.
    expect(await service().canReadBatch('ws', 'mem@x.io', ['Team/Own.md', 'Top.md'])).toEqual(
      new Map([
        ['Team/Own.md', false],
        ['Top.md', true],
      ]),
    );
    // The page was read through git; a file whose bytes are its version's was read from the checkout.
    expect(gitLog).toContain('cat-file');
    expect(opened).toContain('Top.md');
  }, 120_000);

  it('keeps a page restricted whose bytes on disk an encoding wrote, though its working-tree-encoding is gone', async () => {
    // EBCDIC: one byte for each, so the page on disk is its version's size, and no `---` opens it.
    // Only the attributes are committed: `add -A` would read the page on disk as EBCDIC and commit that.
    await write(repo, { '.gitattributes': 'Team/Own.md working-tree-encoding=IBM037\n' });
    await git('add', '--', '.gitattributes');
    await git('commit', '-qm', 'own page encoded');
    await fs.rm(path.join(repo, 'Team', 'Own.md'));
    await git('checkout', '--', 'Team/Own.md');
    await vouchedFor('Team/Own.md');
    await write(repo, { '.gitattributes': '# no attributes\n' });
    await git('add', '--', '.gitattributes');
    await git('commit', '-qm', 'encoding removed');
    const onDisk = await fs.readFile(path.join(repo, 'Team', 'Own.md'));
    expect(onDisk.length).toBe(Buffer.byteLength(FILES['Team/Own.md']!));
    expect(onDisk.toString('latin1').startsWith('---')).toBe(false);
    expect(await git('diff-index', '--name-only', 'HEAD', '--')).toBe('');
    reset();

    expect(await service().canReadBatch('ws', 'mem@x.io', ['Team/Own.md', 'Top.md'])).toEqual(
      new Map([
        ['Team/Own.md', false],
        ['Top.md', true],
      ]),
    );
    expect(gitLog).toContain('cat-file');
  }, 120_000);

  it('reads through git a file an end-of-line conversion wrote out, without opening it', async () => {
    await commit('notes converted', { '.gitattributes': 'Notes.txt text eol=crlf\n' });
    await fs.rm(path.join(repo, 'Notes.txt'));
    await git('checkout', '--', 'Notes.txt');
    expect(await fs.readFile(path.join(repo, 'Notes.txt'), 'utf-8')).toBe('plain text\r\n');
    expect(await git('diff-index', '--name-only', 'HEAD', '--')).toBe('');
    reset();

    expect(await service().canReadBatch('ws', 'mem@x.io', ['Notes.txt', 'Top.md'])).toEqual(
      new Map([
        ['Notes.txt', true],
        ['Top.md', true],
      ]),
    );
    // Not its version's size: not worth reading from the checkout.
    expect(opened).not.toContain('Notes.txt');
    expect(opened).toContain('Top.md');
  }, 120_000);

  it('hashes a SHA-256 repository with SHA-256: a copy that is its version is taken, another is read through git', async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', repo]);
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await commit('seed', FILES);
    expect(await git('rev-parse', 'HEAD')).toHaveLength(64);
    // The page on disk opened, at its version's size, and git told to take the file as it is without reading it.
    await fs.writeFile(path.join(repo, 'Team', 'Own.md'), FILES['Team/Own.md']!.replace(/^---$/gm, '+++'));
    await git('update-index', '--assume-unchanged', '--', 'Team/Own.md');
    expect(await git('diff-index', '--name-only', 'HEAD', '--')).toBe('');
    const [top, own] = [await git('rev-parse', 'HEAD:Top.md'), await git('rev-parse', 'HEAD:Team/Own.md')];
    reset();

    expect(await service().canReadBatch('ws', 'mem@x.io', ['Team/Own.md', 'Top.md'])).toEqual(
      new Map([
        ['Team/Own.md', false],
        ['Top.md', true],
      ]),
    );
    // The page went through git; the file whose bytes hash to its version was taken from the checkout.
    expect(catFiled).toContain(own);
    expect(catFiled).not.toContain(top);
    expect(opened).toContain('Top.md');
  }, 120_000);

  it('reads through git a file written while it is read, and remembers what the version declares, not what was read', async () => {
    // Same size, its frontmatter opened: written after git's stat cache was asked and the file opened, before
    // a byte of it is read.
    const openPage = FILES['Team/Own.md']!.replace(/^---$/gm, '+++');
    const page = path.join(repo, 'Team', 'Own.md');
    // The files of the second checkout opened, by either call the service reads with (git's own files aside, as
    // for the first checkout).
    const second = path.join(root, 'ws2', KB);
    const secondOpened: string[] = [];
    const noteSecond = (file: unknown) => {
      const f = String(file);
      if (f.startsWith(second + path.sep) && !f.includes(`${path.sep}.git${path.sep}`)) secondOpened.push(path.relative(second, f));
    };
    const reading = vi.mocked(fs.readFile).getMockImplementation()!;
    vi.mocked(fs.readFile).mockImplementation(((file: unknown, ...rest: unknown[]) => {
      noteSecond(file);
      return (reading as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFile);
    const opening = vi.mocked(fs.open).getMockImplementation()!;
    let written = false;
    vi.mocked(fs.open).mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      noteSecond(file);
      const handle = await (opening as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
      if (!written && String(file) === page) {
        written = true;
        await fs.writeFile(page, openPage);
      }
      return handle;
    }) as typeof fs.open);
    const svc = service();
    expect((await svc.canReadBatch('ws', 'mem@x.io', ['Team/Own.md'])).get('Team/Own.md')).toBe(false);
    expect(written).toBe(true);

    // Another checkout of the same commit, whose page is the version, finds the version remembered: it opens no
    // file of its own.
    await execFileAsync('git', ['clone', '-q', repo, second]);
    expect((await svc.canReadBatch('ws2', 'mem@x.io', ['Team/Own.md'])).get('Team/Own.md')).toBe(false);
    expect(secondOpened).toEqual([]);
    // A service that remembers nothing reads that checkout's page: the count above would have seen it.
    expect((await service().canReadBatch('ws2', 'mem@x.io', ['Team/Own.md'])).get('Team/Own.md')).toBe(false);
    expect(secondOpened).toContain(path.join('Team', 'Own.md'));
  }, 120_000);

  it('counts each version at its whole size against the wait budget: a map of more is read in the background', async () => {
    const paths = Object.keys(FILES);
    // The versions a first map reads (every file but the roles file), whole, and as the old estimate counted them:
    // a file's start, at most 64 KB, and an `access.md` whole.
    const sizes = Object.entries(FILES)
      .filter(([p]) => p !== 'roles.yaml')
      .map(([p, text]) => [p, Buffer.byteLength(text)] as const);
    const whole = sizes.reduce((n, [, s]) => n + s, 0);
    const starts = sizes.reduce((n, [p, s]) => n + (p.endsWith('access.md') ? s : Math.min(s, 64 * 1024)), 0);
    const waitBytes = Math.floor((starts + whole) / 2);
    expect(starts).toBeLessThan(waitBytes);
    expect(whole).toBeGreaterThan(waitBytes);
    // Reading the versions waits on this gate: a map the first caller waited for would hold its answer back.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = service({ waitBytes }, undefined, { beforeGit: (args) => (args[0] === 'diff-index' ? gate : Promise.resolve()) });
    const first = await Promise.race([
      svc.canReadBatch('ws', 'nobody@x.io', paths),
      new Promise<'held back'>((resolve) => setTimeout(() => resolve('held back'), 5_000)),
    ]);
    expect(first).not.toBe('held back');
    expect((first as Map<string, boolean>).get('Team/Own.md')).toBe(false);

    release();
    await vi.waitFor(
      async () => {
        reset();
        await svc.canReadBatch('ws', 'nobody@x.io', paths);
        expect(opened).toEqual([]);
      },
      { timeout: 30_000, interval: 100 },
    );
  }, 120_000);

  it('takes no member from a roles or groups file changed on disk and not committed, where the checkout alone would', async () => {
    await commit('a page for the platform group', { 'Team/Plat.md': '---\nread:\n  - deny everyone\n  - Platform\n---\n# plat\n' });
    const svc = service();
    const writes = async (s: AccessControlService, ws: string) => (await s.canWriteBatch(ws, 'nobody@x.io', ['Top.md'])).get('Top.md');
    const reads = async (s: AccessControlService, ws: string, who: string) =>
      (await s.canReadBatch(ws, who, ['Team/Plat.md'])).get('Team/Plat.md');
    expect(await writes(svc, 'ws')).toBe(false);
    expect(await reads(svc, 'ws', 'zoe@x.io')).toBe(true);

    // On disk only, and nothing reports it: `roles.yaml` names a new Admin,
    // and a synced groups file git has never seen replaces the committed
    // groups file and moves the Platform group to someone else.
    await write(repo, {
      'roles.yaml':
        'roles:\n  Admin:\n    - admin@x.io\n    - nobody@x.io\n  Member:\n    - mem@x.io\n  Sales:\n    - sal@x.io\n',
      'synced-groups.yaml': 'groups:\n  Platform:\n    - nobody@x.io\n',
    });
    await copyToPlain();
    // The commit still answers for the workspace.
    expect(await writes(svc, 'ws')).toBe(false);
    expect(await reads(svc, 'ws', 'zoe@x.io')).toBe(true);
    expect(await reads(svc, 'ws', 'nobody@x.io')).toBe(false);
    // The same files read as a checkout only: both changes count there.
    const checkout = service();
    expect(await writes(checkout, 'plain')).toBe(true);
    expect(await reads(checkout, 'plain', 'zoe@x.io')).toBe(false);
    expect(await reads(checkout, 'plain', 'nobody@x.io')).toBe(true);

    // Committed, they count for the map too.
    await git('add', '-A', '-f');
    await git('commit', '-qm', 'roles and synced groups committed');
    expect(await writes(svc, 'ws')).toBe(true);
    expect(await reads(svc, 'ws', 'zoe@x.io')).toBe(false);
    expect(await reads(svc, 'ws', 'nobody@x.io')).toBe(true);
  }, 120_000);

  it('answers from the checkout when the commit holds no roles file, with the roles file that is on disk', async () => {
    // `roles.yaml` stays in the checkout and leaves the commit.
    await git('rm', '-q', '--cached', 'roles.yaml');
    await git('commit', '-qm', 'roles no longer tracked');
    await copyToPlain();
    const paths = Object.keys(FILES);
    // A first batch on a fresh service: the commit is listed and asked for
    // its access files, which shows it has no roles file. No file version is
    // read from git, and the checkout is what answers.
    const svc = service();
    reset();
    await svc.canReadBatch('ws', 'mem@x.io', paths);
    expect(gitLog).toEqual(['ls-tree', 'cat-file']);
    expect(opened.length).toBeGreaterThan(0);
    // The next batch does not try the commit again.
    reset();
    await svc.canReadBatch('ws', 'mem@x.io', paths);
    expect(gitLog).toEqual([]);
    expect(opened.length).toBeGreaterThan(0);
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
  }, 120_000);

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

  it('reads the file versions git cannot vouch for on disk through git, in parts no larger than the limit', async () => {
    // Every file touched: git's stat cache no longer vouches that the checkout holds the commit's version, though
    // the bytes are the same, so each version is read through git.
    const later = new Date(Date.now() + 60_000);
    for (const rel of Object.keys(FILES)) await fs.utimes(path.join(repo, rel), later, later);
    const svc = service({ chunkBytes: 64 });
    const paths = Object.keys(FILES);
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
    // One listing, one read of the access files, and many small reads of the rest.
    expect(gitLog.filter((a) => a === 'ls-tree')).toHaveLength(1);
    expect(gitLog.filter((a) => a === 'cat-file').length).toBeGreaterThan(5);
  }, 120_000);

  it('reads the start of each file from the checkout where git vouches for it, and only the access.md files through git', async () => {
    const svc = service();
    const paths = Object.keys(FILES);
    await svc.canReadBatch('ws', 'nobody@x.io', paths);
    // Two batched reads through git: the model's of the access files, and the access.md files' own declarations
    // (their body decides). Every other file is read from the checkout.
    expect(gitLog.filter((a) => a === 'cat-file')).toHaveLength(2);
    expect(opened.some((p) => p.endsWith('access.md'))).toBe(false);
    expect(opened).toEqual(expect.arrayContaining([path.join('Team', 'Big.transcript'), path.join('Team', 'pic.png')]));
    expect(await answers(svc, 'ws', paths)).toEqual(await answers(service(), 'plain', paths));
  }, 120_000);

  it('answers from the checkout when reading the file versions fails, and makes the map once git answers again', async () => {
    const paths = Object.keys(FILES);
    let clock = 1_000_000;
    let failing = true;
    // Asking git which files it can vouch for on disk is the first step of reading the file versions.
    const svc = service({}, undefined, {
      now: () => clock,
      failGit: (args) => args[0] === 'diff-index' && failing,
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
    // declaring files, one for the commit's access files, and the page added
    // since, read from the checkout git vouches for. No other file is read.
    reset();
    const second = service({}, store);
    const all = [...paths, 'Team/Since.md'];
    expect((await second.canReadBatch('ws', 'nobody@x.io', all)).get('Team/Since.md')).toBe(false);
    expect(gitLog).toEqual(['ls-tree', 'cat-file', 'ls-tree', 'cat-file', 'diff-index']);
    expect(opened).toEqual([path.join('Team', 'Since.md')]);
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
