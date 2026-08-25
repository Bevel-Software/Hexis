import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { AccessUnreadableError } from '../../access-model/access-errors.js';

/**
 * Every git subprocess the service (and this file's own fixture helpers)
 * spawn through `execFile`, by argv. The service builds its at-ref model
 * with exactly one `git ls-tree -r` per build, so counting `ls-tree` argv
 * entries counts model builds — measured at the process boundary, which is
 * the cost this cache exists to remove. `injected.failNext` makes ONE
 * matching spawn fail the way a transient git error does, so the cache's
 * behaviour under a failed read can be pinned without a flaky fixture.
 */
const { spawnLog, injected } = vi.hoisted(() => ({
  spawnLog: [] as string[][],
  injected: { failNext: null as null | ((argv: string[]) => boolean) },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify: p } = await import('node:util');
  const original = actual.execFile as unknown as ((...a: unknown[]) => unknown) & {
    [p.custom]: (...a: unknown[]) => unknown;
  };
  const wrapped = ((...args: unknown[]) => {
    spawnLog.push((args[1] as string[]) ?? []);
    return original(...args);
  }) as unknown as typeof actual.execFile;
  // `promisify(execFile)` returns `execFile[promisify.custom]`, so the
  // promisified path the service uses has to be wrapped too.
  Object.defineProperty(wrapped, p.custom, {
    value: (...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? [];
      spawnLog.push(argv);
      if (injected.failNext?.(argv)) {
        injected.failNext = null;
        return Promise.reject(
          Object.assign(new Error('simulated transient git failure'), {
            stderr: 'fatal: unable to read object (simulated)',
          }),
        );
      }
      return original[p.custom](...args);
    },
  });
  return { ...actual, execFile: wrapped };
});

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

function lsTreeBuilds(): number {
  return spawnLog.filter((argv) => argv.includes('ls-tree')).length;
}

function rolesReads(): number {
  return spawnLog.filter((argv) => argv.includes('show') && argv.some((a) => a.endsWith(':roles.yaml')))
    .length;
}

/**
 * The at-ref access model — `canWriteAtRef` / `canWriteBatchAtRef` /
 * `eligibleWritersForPathsAtRef`, the gates every change-request read and
 * every approval click run — is a pure function of the tree at the commit
 * the ref resolves to. Building it costs one `ls-tree` plus one `git show`
 * per `access.md`, so it must be built ONCE per commit and shared by every
 * gate call that lands on that commit, while a push that moves the ref is
 * still seen on the very next call, and a build that saw a git read fail
 * is never pinned.
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
    svc = new AccessControlService(stub, PROCESS_MAP_DIR);
    spawnLog.length = 0;
    injected.failNext = null;
  });

  afterEach(async () => {
    injected.failNext = null;
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
    expect(lsTreeBuilds()).toBe(1);
    // ...and the fallthrough result is cached under origin/feature's commit.
    expect(await svc.canWriteAtRef(workspaceId, 'feature', admin, DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(1);
  });

  it('refuses to decide from a build that lost a git read, and never caches it', async () => {
    // A nearer access.md that DENIES the admin: reading it is what stands
    // between razvan and a write he must not have.
    await pushFromOther('deny Admin in Team', () =>
      fs.writeFile(path.join(other, 'Team/access.md'), '---\nwrite:\n  - deny Admin\n---\n'),
    );

    // Lose exactly that read, once, to a simulated transient failure. The
    // gate must not answer from the partial tree (which would grant what the
    // lost file denies): it fails closed with an AccessUnreadableError...
    injected.failNext = (argv) => argv.includes('show') && argv.some((a) => a.endsWith(':Team/access.md'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).rejects.toBeInstanceOf(
      AccessUnreadableError,
    );
    expect(injected.failNext).toBeNull();
    expect(lsTreeBuilds()).toBe(1);
    // ...and says so in the logs, naming the read it lost.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Team\/access\.md failed; refusing to decide/));

    // Nothing was pinned: the next call rebuilds, answers correctly, and
    // that healthy build is the one that gets cached.
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(2);
  });

  it('does not cache a commit with no roles.yaml, and keeps answering null for it', async () => {
    await git(other, 'checkout', '-qb', 'bare');
    await git(other, 'rm', '-q', 'roles.yaml');
    await git(other, 'commit', '-qm', 'no roles here');
    await git(other, 'push', '-q', '-u', 'origin', 'bare');

    spawnLog.length = 0;
    expect(await svc.canWriteAtRef(workspaceId, 'origin/bare', admin, DOC)).toBeNull();
    expect(await svc.canWriteAtRef(workspaceId, 'origin/bare', admin, DOC)).toBeNull();
    // Each call went back to git for roles.yaml (nothing was remembered),
    // and neither ever got as far as walking the tree.
    expect(rolesReads()).toBe(2);
    expect(lsTreeBuilds()).toBe(0);
  });
});
