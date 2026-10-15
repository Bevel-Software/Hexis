import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { AccessUnreadableError } from '../../access-model/access-errors.js';

/**
 * Every git subprocess the service spawns through the git port (`spawn`) and
 * this file's own fixture helpers run through `execFile`, by argv. The
 * service builds its at-ref model with exactly one `git ls-tree -r` per
 * build, so counting `ls-tree` argv entries counts model builds — measured at
 * the process boundary, which is the cost this cache exists to remove.
 * `injected.failNext` makes ONE matching spawn fail the way a transient git
 * error does, so the cache's behaviour under a failed read can be pinned
 * without a flaky fixture. `injected.rewriteNext` lets ONE matching spawn
 * run for real and rewrites what it printed before the service reads it,
 * for replies a healthy git cannot be made to give.
 */
const { spawnLog, injected } = vi.hoisted(() => ({
  spawnLog: [] as string[][],
  injected: {
    failNext: null as null | ((argv: string[]) => boolean),
    rewriteNext: null as null | ((argv: string[]) => null | ((stdout: Buffer, stdin: string) => Buffer)),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { promisify: p } = await import('node:util');
  const original = actual.execFile as unknown as ((...a: unknown[]) => unknown) & {
    [p.custom]: (...a: unknown[]) => unknown;
  };
  const execFile = ((...args: unknown[]) => {
    spawnLog.push((args[1] as string[]) ?? []);
    return original(...args);
  }) as unknown as typeof actual.execFile;
  // `promisify(execFile)` returns `execFile[promisify.custom]`, so the
  // promisified path the fixtures use has to be wrapped too.
  Object.defineProperty(execFile, p.custom, {
    value: (...args: unknown[]) => {
      spawnLog.push((args[1] as string[]) ?? []);
      return original[p.custom](...args);
    },
  });
  /** A child that exits 128 with the stderr a transient object read failure prints. */
  const failing = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      exitCode: null as number | null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    process.nextTick(() => {
      child.stderr.end('fatal: unable to read object (simulated)\n');
      child.stdout.end();
      child.exitCode = 128;
      child.emit('close', 128, null);
    });
    return child as unknown as ReturnType<typeof actual.spawn>;
  };
  type Child = ReturnType<typeof actual.spawn>;
  const realSpawn = actual.spawn as unknown as (...a: unknown[]) => Child;
  /**
   * The real child, with what it was fed on stdin recorded and its stdout
   * handed to `fn` whole, once it has exited, before the service sees it.
   */
  const rewriting = (file: string, args: string[], options: unknown, fn: (stdout: Buffer, stdin: string) => Buffer) => {
    const real = realSpawn(file, args, options);
    const fed: Buffer[] = [];
    const out: Buffer[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: real.pid,
      exitCode: null as number | null,
      signalCode: null,
      stdin: Object.assign(new EventEmitter(), {
        write: (chunk: string | Buffer) => {
          fed.push(Buffer.from(chunk));
          return real.stdin!.write(chunk);
        },
        end: () => real.stdin!.end(),
      }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal?: NodeJS.Signals | number) => real.kill(signal),
    });
    real.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    real.stderr!.pipe(child.stderr);
    real.on('error', (err) => child.emit('error', err));
    real.on('close', (code, signal) => {
      child.stdout.end(fn(Buffer.concat(out), Buffer.concat(fed).toString('utf-8')));
      child.exitCode = code;
      child.emit('close', code, signal);
    });
    return child as unknown as Child;
  };
  const spawn = ((file: string, args: string[], options: unknown) => {
    if (file === 'git') {
      spawnLog.push(args ?? []);
      if (injected.failNext?.(args)) {
        injected.failNext = null;
        return failing();
      }
      const rewrite = injected.rewriteNext?.(args);
      if (rewrite) {
        injected.rewriteNext = null;
        return rewriting(file, args, options, rewrite);
      }
    }
    return realSpawn(file, args, options);
  }) as unknown as typeof actual.spawn;
  return { ...actual, execFile, spawn };
});

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

function lsTreeBuilds(): number {
  return spawnLog.filter((argv) => argv.includes('ls-tree')).length;
}

/** Ref resolutions through git: none, since the ref files answer. */
function revParses(): number {
  return spawnLog.filter((argv) => argv.includes('rev-parse')).length;
}

/** Batched reads of a commit's access tree: one per build. */
function catFileBatches(): number {
  return spawnLog.filter((argv) => argv.includes('cat-file')).length;
}

/**
 * Single-file reads of the MODEL's files at a ref (roles, groups, any
 * access.md, any plugin manifest): none, since the build reads them in one
 * batch. The one `show` a single-path gate makes afterwards, for the asked
 * file's own frontmatter, is not the model's and is not counted.
 */
function fileShows(): number {
  return spawnLog.filter(
    (argv) =>
      argv.includes('show') &&
      argv.some((a) => /:(roles\.yaml|groups\.yaml|synced-groups\.yaml|(.*\/)?access\.md|.*\/plugin\.json)$/.test(a)),
  ).length;
}

/**
 * Rewrite ONE record of a `git cat-file --batch` reply — the one answering
 * the stdin spec `which` matches — as `<spec> missing`, or as the same
 * object reported with type `tree`. The reply is index-aligned with the
 * specs fed on stdin, each record `<oid> <type> <size>\n<size bytes>\n` or
 * `<spec> missing\n`, so the records are walked by the specs.
 */
function rewriteBatchRecord(which: RegExp, as: 'missing' | 'tree') {
  return (stdout: Buffer, stdin: string): Buffer => {
    const parts: Buffer[] = [];
    let off = 0;
    for (const spec of stdin.split('\n').filter(Boolean)) {
      const nl = stdout.indexOf(0x0a, off);
      const header = stdout.subarray(off, nl).toString('utf-8');
      const end = header.endsWith(' missing') ? nl + 1 : nl + 1 + Number(header.split(' ')[2]) + 1;
      if (!which.test(spec)) parts.push(stdout.subarray(off, end));
      else if (as === 'missing') parts.push(Buffer.from(`${spec} missing\n`));
      else parts.push(Buffer.from(header.replace(' blob ', ' tree ')), stdout.subarray(nl, end));
      off = end;
    }
    return Buffer.concat(parts);
  };
}

/**
 * The at-ref access model — `canWriteAtRef` / `canWriteBatchAtRef` /
 * `eligibleWritersForPathsAtRef`, the gates every change-request read and
 * every approval click run — is a pure function of the tree at the commit
 * the ref resolves to. Building it costs two git calls, one `ls-tree` plus
 * one `cat-file --batch` for every file the model reads, so it must be built
 * ONCE per commit and shared by every gate call that lands on that commit,
 * while a push that moves the ref is still seen on the very next call, and a
 * build that saw a git read fail is never pinned.
 *
 * Every test seeds its own bare origin, workspace clone, and second clone
 * (`other`, standing in for another user's push), so each one holds alone.
 */
describe('AccessControlService — at-ref model cache', () => {
  let root: string;
  let repo: string;
  let other: string;
  let svc: AccessControlService;
  const workspaceId = 'ws-atref-cache';
  const admin = 'razvan@bevel.software';
  const DOC = 'Team/Doc.md';
  const QUOTED_DIR = 'Équipe';
  const QUOTED_DOC = `${QUOTED_DIR}/Doc.md`;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
    return stdout.trim();
  }

  /** Commit + push a change to origin/main from the OTHER clone. */
  async function pushFromOther(message: string, write: () => Promise<void>): Promise<void> {
    await write();
    await git(other, 'add', '-A');
    await git(other, 'commit', '-qm', message);
    await git(other, 'push', '-q', 'origin', 'HEAD');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-atref-cache-'));
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, PROCESS_MAP_DIR);
    const origin = path.join(root, 'origin.git');
    other = path.join(root, 'other');

    await execFileAsync('git', ['init', '--bare', '-b', 'main', origin]);
    await fs.mkdir(path.join(repo, 'Team'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n');
    await fs.writeFile(path.join(repo, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, 'Team/access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, DOC), '# doc\n');
    // A folder git would C-quote in its default listing, with an access.md
    // that DENIES the admin: read as it is, or the denial is missed.
    await fs.mkdir(path.join(repo, QUOTED_DIR), { recursive: true });
    await fs.writeFile(path.join(repo, QUOTED_DIR, 'access.md'), '---\nwrite:\n  - deny Admin\n---\n');
    await fs.writeFile(path.join(repo, QUOTED_DOC), '# doc\n');
    // A plugin, whose manifest the model reads too.
    await fs.mkdir(path.join(repo, 'Plugins/Demo'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Plugins/Demo/plugin.json'), '{ "name": "Demo" }\n');
    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'seed');
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');

    await execFileAsync('git', ['clone', '-q', origin, other]);
    await git(other, 'config', 'user.email', 'other@example.com');
    await git(other, 'config', 'user.name', 'Other');

    const stub = {
      getWorkspacePath: async () => workspaceDir,
      // The real service TTLs this at 30s; the stub always fetches so a push
      // from `other` is visible on the next gate call.
      ensureRemotesFetched: async () => {
        await git(repo, 'fetch', '-q', 'origin');
      },
    } as unknown as WorkspaceService;
    svc = new AccessControlService(stub, PROCESS_MAP_DIR, new NodeFs());
    spawnLog.length = 0;
    injected.failNext = null;
    injected.rewriteNext = null;
  });

  afterEach(async () => {
    injected.failNext = null;
    injected.rewriteNext = null;
    // Spies are restored here, not at the end of the test that made them:
    // a failing assertion would otherwise leave a console.warn mock in place
    // for every test after it (this config sets no `restoreMocks`).
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds the model once for the six gate calls an approval click makes', async () => {
    // The approve route's exact sequence: detail (eligibility + viewer batch +
    // roles.yaml bypass check, concurrently), then the gate, then the
    // response's detail.
    const [eligible, batch, bypass] = await Promise.all([
      svc.eligibleWritersForPathsAtRef(workspaceId, 'origin/main', [DOC]),
      svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC]),
      svc.canWriteAtRef(workspaceId, 'origin/main', admin, 'roles.yaml'),
    ]);
    const gate = await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC);
    const again = await svc.eligibleWritersForPathsAtRef(workspaceId, 'origin/main', [DOC]);
    const batchAgain = await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC]);

    expect(eligible!.get(DOC)!.roles).toContain('Admin');
    expect(batch!.get(DOC)).toBe(true);
    expect(bypass).toBe(true);
    expect(gate).toBe(true);
    expect(again!.get(DOC)!.roles).toContain('Admin');
    expect(batchAgain!.get(DOC)).toBe(true);

    expect(lsTreeBuilds()).toBe(1);
  });

  it('sees a push that moves the base ref on the next call, and caches the new tip', async () => {
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(1);

    // Revoke razvan on origin/main from the other clone: roles.yaml is part
    // of the MODEL (not the per-file own-entries read), so a stale cache
    // would keep answering true.
    await pushFromOther('revoke razvan', () =>
      fs.writeFile(path.join(other, 'roles.yaml'), 'roles:\n  Admin:\n    - someone-else@bevel.software\n'),
    );

    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);

    // The new tip is cached like the old one was.
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC])).toEqual(
      new Map([[DOC, false]]),
    );
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', 'someone-else@bevel.software', DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(2);
  });

  it('keeps the short-ref fallthrough: a local branch without roles.yaml defers to origin/<branch>', async () => {
    // `feature` on origin carries roles.yaml (and a commit of its own, so it
    // is not the main tip); the LOCAL `feature` has roles.yaml deleted, not
    // pushed. Asking for `feature` must fall through to `origin/feature`
    // exactly as before the cache existed.
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repo, 'Team/Other.md'), '# other\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'feature work');
    await git(repo, 'push', '-q', '-u', 'origin', 'feature');
    await git(repo, 'rm', '-q', 'roles.yaml');
    await git(repo, 'commit', '-qm', 'drop roles locally');

    spawnLog.length = 0;
    const map = await svc.eligibleWritersForPathsAtRef(workspaceId, 'feature', [DOC]);
    expect(map).not.toBeNull();
    expect(map!.get(DOC)!.roles).toContain('Admin');
    // Two commits were read: the local tip, found to carry no roles.yaml,
    // then origin/feature's.
    expect(lsTreeBuilds()).toBe(2);
    // ...and both answers are remembered: the fallthrough result under
    // origin/feature's commit, the local tip as a commit with no roles.
    expect(await svc.canWriteAtRef(workspaceId, 'feature', admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(2);
  });

  it('refuses to decide from a build that lost a git read, and never caches it', async () => {
    // A nearer access.md that DENIES the admin: reading it is what stands
    // between razvan and a write he must not have.
    await pushFromOther('deny Admin in Team', () =>
      fs.writeFile(path.join(other, 'Team/access.md'), '---\nwrite:\n  - deny Admin\n---\n'),
    );

    // Lose the batched read of the tree, once, to a simulated transient
    // failure. The gate must not answer from a partial tree (which would
    // grant what the lost file denies): it fails closed with an
    // AccessUnreadableError...
    injected.failNext = (argv) => argv.includes('cat-file');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).rejects.toBeInstanceOf(
      AccessUnreadableError,
    );
    expect(injected.failNext).toBeNull();
    expect(lsTreeBuilds()).toBe(1);
    // ...and says so in the logs.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/access tree failed; refusing to decide/));

    // Nothing was pinned: the next call rebuilds, answers correctly, and
    // that healthy build is the one that gets cached.
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);
  });

  it('remembers a commit with no roles.yaml, and keeps answering null for it without another read', async () => {
    await git(other, 'checkout', '-qb', 'bare');
    await git(other, 'rm', '-q', 'roles.yaml');
    await git(other, 'commit', '-qm', 'no roles here');
    await git(other, 'push', '-q', '-u', 'origin', 'bare');

    spawnLog.length = 0;
    expect(await svc.canWriteAtRef(workspaceId, 'origin/bare', admin, DOC)).toBeNull();
    expect(await svc.canWriteAtRef(workspaceId, 'origin/bare', admin, DOC)).toBeNull();
    // Git said "missing" for roles.yaml at that commit once, which is as
    // final as the commit; the second call read nothing.
    expect(lsTreeBuilds()).toBe(1);
    expect(catFileBatches()).toBe(1);
    expect(fileShows()).toBe(0);
  });

  it('reads the whole access tree at a commit in two git calls, never one per file', async () => {
    // The seed holds roles.yaml and two access.md files; a read per file was
    // what the build used to cost, and what a server forking a large heap
    // cannot afford.
    // One listing and one batch build the model; a second batch reads the
    // asked path's own entries, once per commit and path (see the memo test).
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(1);
    expect(catFileBatches()).toBe(2);
    expect(fileShows()).toBe(0);
    // Both access files were read through the batch: Team's denial is seen.
    await pushFromOther('deny Admin in Team', () =>
      fs.writeFile(path.join(other, 'Team/access.md'), '---\nwrite:\n  - deny Admin\n---\n'),
    );
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);
    expect(catFileBatches()).toBe(4);
    expect(fileShows()).toBe(0);
  });

  it('honours an access.md under a folder git would quote in its listing', async () => {
    // `git ls-tree` prints "\303\211quipe/access.md" unless told `-z`; read
    // under that spelling nothing comes back, and a denial would be missed.
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, QUOTED_DOC)).toBe(false);
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [QUOTED_DOC, DOC])).toEqual(
      new Map([
        [QUOTED_DOC, false],
        [DOC, true],
      ]),
    );
    expect(lsTreeBuilds()).toBe(1);
    expect(fileShows()).toBe(0);
  });

  it('answers null for a ref whose roles.yaml is a directory, and never falls through to origin for it', async () => {
    // `feature` on origin grants the admin; the LOCAL `feature` replaced
    // roles.yaml with a directory of that name. That is malformed config, as
    // a roles file that does not parse is: the gate answers null for the
    // ref, rather than reading the next candidate and granting from it.
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await git(repo, 'push', '-q', '-u', 'origin', 'feature');
    await git(repo, 'rm', '-q', 'roles.yaml');
    await fs.mkdir(path.join(repo, 'roles.yaml'));
    await fs.writeFile(path.join(repo, 'roles.yaml/README.md'), 'not roles\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'roles.yaml is a folder now');

    spawnLog.length = 0;
    expect(await svc.canWriteAtRef(workspaceId, 'feature', admin, DOC)).toBeNull();
    expect(lsTreeBuilds()).toBe(1);
  });

  it('refuses to decide, twice, for a ref whose roles.yaml blob is lost, and never falls through to a granting origin', async () => {
    // `feature` on origin carries a roles.yaml that grants the admin. The
    // LOCAL `feature` is one commit ahead, with a roles.yaml of its own
    // whose blob is then lost from the object store (real git: the loose
    // object file removed). The tree still names roles.yaml, so the batch's
    // "missing" is an unreadable file, not an absent one: the build must
    // fail closed on both attempts, remember nothing for the commit, and
    // never read the next candidate, origin/feature, which would grant.
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n# on origin\n');
    await git(repo, 'commit', '-qam', 'roles on origin/feature');
    await git(repo, 'push', '-q', '-u', 'origin', 'feature');
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n# local only\n');
    await git(repo, 'commit', '-qam', 'roles on the local feature tip');
    const lost = await git(repo, 'rev-parse', 'HEAD:roles.yaml');
    await fs.rm(path.join(repo, '.git/objects', lost.slice(0, 2), lost.slice(2)));

    spawnLog.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const attempt of [1, 2]) {
      await expect(svc.canWriteAtRef(workspaceId, 'feature', admin, DOC)).rejects.toBeInstanceOf(
        AccessUnreadableError,
      );
      // One listing per attempt: the local tip, and never origin/feature.
      expect(lsTreeBuilds()).toBe(attempt);
      expect(catFileBatches()).toBe(attempt);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/roles\.yaml is in the tree but its blob could not be read/));
  });

  it.each(['synced-groups.yaml', 'groups.yaml'])(
    'refuses to decide, twice, for a ref whose %s blob is lost, and never reads it as absent',
    async (file) => {
      // The groups source the model reads at origin/main — the synced file,
      // which supersedes a manual one still naming a retired team, or the
      // manual file alone — has its blob lost from the workspace's object
      // store (real git: the loose object file removed after the fetch).
      // The tree still names it, so the batch's "missing" is an unreadable
      // file, not an absent one: the build fails closed on both attempts and
      // remembers nothing. Reading the synced file as absent would revive
      // the manual groups; reading the manual one as absent would drop what
      // it grants.
      await pushFromOther(`${file} on main`, async () => {
        if (file === 'synced-groups.yaml') {
          await fs.writeFile(path.join(other, 'synced-groups.yaml'), 'groups:\n  Platform:\n    - zoe@x.io\n');
        }
        await fs.writeFile(path.join(other, 'groups.yaml'), 'groups:\n  Retired Team:\n    - ghost@x.io\n');
      });
      await git(repo, 'fetch', '-q', 'origin');
      const lost = await git(repo, 'rev-parse', `origin/main:${file}`);
      await fs.rm(path.join(repo, '.git/objects', lost.slice(0, 2), lost.slice(2)));

      spawnLog.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const attempt of [1, 2]) {
        await expect(svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).rejects.toBeInstanceOf(
          AccessUnreadableError,
        );
        expect(lsTreeBuilds()).toBe(attempt);
        expect(catFileBatches()).toBe(attempt);
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${file.replaceAll('.', '\\.')} is in the tree but its blob could not be read`)),
      );
    },
  );

  it('refuses to decide when a groups source is a directory rather than a file', async () => {
    await pushFromOther('groups.yaml as a folder', async () => {
      await fs.mkdir(path.join(other, 'groups.yaml'));
      await fs.writeFile(path.join(other, 'groups.yaml/README.md'), 'not groups\n');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).rejects.toBeInstanceOf(
      AccessUnreadableError,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/groups\.yaml is a tree, not a file; refusing to decide/));
  });

  it.each([
    ['access.md', 'missing', /:Team\/access\.md$/, /Team\/access\.md is in the tree but its blob could not be read/],
    ['access.md', 'a tree', /:Team\/access\.md$/, /Team\/access\.md is a tree, not a file/],
    ['plugin manifest', 'missing', /:Plugins\/Demo\/plugin\.json$/, /Plugins\/Demo\/plugin\.json is in the tree but its blob could not be read/],
    ['plugin manifest', 'a tree', /:Plugins\/Demo\/plugin\.json$/, /Plugins\/Demo\/plugin\.json is a tree, not a file/],
  ])('refuses to decide when a listed %s comes back %s from the batch, and never caches it', async (_what, how, spec, warned) => {
    // A healthy git cannot be made to answer this: the listing names blobs
    // only, and a commit's objects do not change between two reads of it.
    // The batch's reply is rewritten at the process boundary instead, so the
    // build's refusal of a listed path it could not read is pinned all the
    // same: a model missing that file could grant what the file denies.
    injected.rewriteNext = (argv) =>
      argv.includes('cat-file') ? rewriteBatchRecord(spec, how === 'missing' ? 'missing' : 'tree') : null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const batchesBefore = catFileBatches();
    await expect(svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).rejects.toBeInstanceOf(
      AccessUnreadableError,
    );
    expect(injected.rewriteNext).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(warned));
    // ...and nothing was pinned: the next call, with git answering in full,
    // builds again and answers.
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(true);
    // Three batches: the refused build, then the build that answered and the
    // asked path's own entries.
    expect(catFileBatches()).toBe(batchesBefore + 3);
  });

  it('resolves refs from the ref files and remembers own entries at a commit: a repeated gate call starts no git', async () => {
    // First call at this commit: the model is built (two git calls) and the
    // asked path's own entries are read (one batch). The refs themselves —
    // `origin/main`, and the candidates a short name tries — come from the
    // ref files, so no `rev-parse` runs at all.
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC])).toEqual(new Map([[DOC, true]]));
    expect(revParses()).toBe(0);
    expect(lsTreeBuilds()).toBe(1);
    expect(catFileBatches()).toBe(2);

    // The same gate again, and the single-path gate for the same path: the
    // model and the own entries are both remembered, so apart from the
    // fixture's own fetch nothing is started.
    spawnLog.length = 0;
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC])).toEqual(new Map([[DOC, true]]));
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(true);
    expect(await svc.canWriteAtRef(workspaceId, 'main', admin, DOC)).toBe(true);
    expect(spawnLog.filter((argv) => !argv.includes('fetch'))).toEqual([]);

    // A path not asked before at this commit is read, and only that path.
    spawnLog.length = 0;
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC, QUOTED_DOC])).toEqual(
      new Map([
        [DOC, true],
        [QUOTED_DOC, false],
      ]),
    );
    expect(catFileBatches()).toBe(1);
    expect(revParses()).toBe(0);
  });

  it('holds the models of far more commits than one listing resolves', async () => {
    // A listing resolves access at every open change request's two refs: a
    // knowledge base with a hundred open requests spans a hundred commits.
    // Under the old bound of 64 that evicted in a cycle, so every listing
    // rebuilt every model. Each commit here is a distinct tip; after seventy
    // of them, past that old bound, the first is still held.
    const shas: string[] = [];
    for (let i = 0; i < 70; i++) {
      await fs.writeFile(path.join(other, 'Team/Doc.md'), `# doc ${i}\n`);
      await git(other, 'add', '-A');
      await git(other, 'commit', '-qm', `edit ${i}`);
      shas.push(await git(other, 'rev-parse', 'HEAD'));
    }
    await git(other, 'push', '-q', 'origin', 'HEAD');
    await git(repo, 'fetch', '-q', 'origin');
    spawnLog.length = 0;
    for (const sha of shas) expect(await svc.canWriteAtRef(workspaceId, sha, admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(70);
    expect(await svc.canWriteAtRef(workspaceId, shas[0]!, admin, DOC)).toBe(true);
    expect(await svc.canWriteAtRef(workspaceId, shas[35]!, admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(70);
  }, 120_000);
});
