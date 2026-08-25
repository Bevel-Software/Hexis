import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

/**
 * Every git subprocess the service (and this file's own fixture helpers)
 * spawn through `execFile`, by argv. The service builds its at-ref model
 * with exactly one `git ls-tree -r` per build, so counting `ls-tree` argv
 * entries counts model builds — measured at the process boundary, which is
 * the cost this cache exists to remove.
 */
const { spawnLog } = vi.hoisted(() => ({ spawnLog: [] as string[][] }));

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
      spawnLog.push((args[1] as string[]) ?? []);
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

/**
 * The at-ref access model — `canWriteAtRef` / `canWriteBatchAtRef` /
 * `eligibleWritersForPathsAtRef`, the gates every change-request read and
 * every approval click run — is a pure function of the tree at the commit
 * the ref resolves to. Building it costs one `ls-tree` plus one `git show`
 * per `access.md`, so it must be built ONCE per commit and shared by every
 * gate call that lands on that commit, while a push that moves the ref is
 * still seen on the very next call.
 */
describe('AccessControlService — at-ref model cache', () => {
  let root: string;
  let workspaceDir: string;
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

  async function seed(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(dir, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n');
    await fs.writeFile(path.join(dir, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(dir, 'Team/access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(dir, DOC), '# doc\n');
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-atref-cache-'));
    workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, PROCESS_MAP_DIR);
    const origin = path.join(root, 'origin.git');
    other = path.join(root, 'other');

    await execFileAsync('git', ['init', '--bare', '-b', 'main', origin]);
    await fs.mkdir(repo, { recursive: true });
    await seed(repo);
    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'seed');
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'push', '-u', 'origin', 'main');

    // A second clone stands in for "another user pushed to the base branch".
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
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds the model once for the six gate calls an approval click makes', async () => {
    spawnLog.length = 0;
    // The approve route's exact sequence: detail (eligibility + viewer batch +
    // roles.yaml bypass check), then the gate, then the response's detail.
    const verdicts = await Promise.all([
      svc.eligibleWritersForPathsAtRef(workspaceId, 'origin/main', [DOC]),
      svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC]),
      svc.canWriteAtRef(workspaceId, 'origin/main', admin, 'roles.yaml'),
    ].map((p) => p));
    const gate = await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC);
    const again = await svc.eligibleWritersForPathsAtRef(workspaceId, 'origin/main', [DOC]);
    const batchAgain = await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC]);

    expect(verdicts[0]!.get(DOC)!.roles).toContain('Admin');
    expect(verdicts[1]!.get(DOC)).toBe(true);
    expect(verdicts[2]).toBe(true);
    expect(gate).toBe(true);
    expect(again!.get(DOC)!.roles).toContain('Admin');
    expect(batchAgain!.get(DOC)).toBe(true);

    expect(lsTreeBuilds()).toBe(1);
  });

  it('sees a push that moves the base ref on the next call, and caches the new tip', async () => {
    // Revoke razvan on origin/main from the other clone: roles.yaml is part
    // of the MODEL (not the per-file own-entries read), so a stale cache
    // would keep answering true.
    await fs.writeFile(path.join(other, 'roles.yaml'), 'roles:\n  Admin:\n    - someone-else@bevel.software\n');
    await git(other, 'commit', '-am', 'revoke razvan');
    await git(other, 'push', '-q', 'origin', 'main');

    spawnLog.length = 0;
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', admin, DOC)).toBe(false);
    expect(lsTreeBuilds()).toBe(1);

    // The new tip is cached like the old one was.
    expect(await svc.canWriteBatchAtRef(workspaceId, 'origin/main', admin, [DOC])).toEqual(
      new Map([[DOC, false]]),
    );
    expect(await svc.canWriteAtRef(workspaceId, 'origin/main', 'someone-else@bevel.software', DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(1);
  });

  it('keeps the short-ref fallthrough: a local branch without roles.yaml defers to origin/<branch>', async () => {
    // `feature` on origin carries roles.yaml; the LOCAL `feature` has it
    // deleted (not pushed). Asking for `feature` must fall through to
    // `origin/feature` exactly as before the cache existed.
    await git(repo, 'fetch', '-q', 'origin');
    await git(repo, 'checkout', '-q', '-b', 'feature', 'origin/main');
    // A commit of its own, so origin/feature is not the main tip the previous
    // test already cached.
    await fs.writeFile(path.join(repo, 'Team/Other.md'), '# other\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'feature work');
    await git(repo, 'push', '-q', '-u', 'origin', 'feature');
    await git(repo, 'rm', '-q', 'roles.yaml');
    await git(repo, 'commit', '-q', '-m', 'drop roles locally');

    spawnLog.length = 0;
    const map = await svc.eligibleWritersForPathsAtRef(workspaceId, 'feature', [DOC]);
    expect(map).not.toBeNull();
    expect(map!.get(DOC)!.roles).toContain('Admin');
    expect(lsTreeBuilds()).toBe(1);
    // ...and the fallthrough result is cached under origin/feature's commit.
    expect(await svc.canWriteAtRef(workspaceId, 'feature', 'someone-else@bevel.software', DOC)).toBe(true);
    expect(lsTreeBuilds()).toBe(1);
  });
});
