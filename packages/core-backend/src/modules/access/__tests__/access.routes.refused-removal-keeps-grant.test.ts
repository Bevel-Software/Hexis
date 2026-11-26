import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { AuthService } from '../../auth/index.js';
import type { VersionControlService, VersionControlEventBus } from '../../version-control/index.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';

/**
 * A refused access removal never discards an earlier grant on the same
 * `access.md`.
 *
 * The bug: a grant answers 200 once its bytes are on disk; its commit runs
 * later, out of band. A removal refused UNDER the edit lock (stale-ancestor,
 * admin-root-write) released with `releaseLockNoCommit`, which resets the
 * path to HEAD, so the grant that had answered 200 was gone.
 *
 * The workspace here is a real git repository. The version-control double
 * keeps the real release semantics: `releaseLock` queues the path for the
 * commit worker (drained by hand, so the grant is provably still queued when
 * the refusal runs), `releaseLockNoCommit` resets the path to HEAD as
 * `GitService.discardPath` does, `releaseLockUntouched` only drops the lock.
 */

const exec = promisify(execFile);
const KB = 'knowledge-base';
const WS = 'alice/feature';
const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const BOB = { kind: 'user' as const, email: 'bob@bevel.software', displayName: 'Bob' };

describe('a refused removal keeps an earlier, still-queued grant on the same access.md', () => {
  let repo: string;
  let server: Server;
  let baseUrl: string;
  let queued: string[];
  let writeFile: ReturnType<typeof vi.fn>;
  let releaseLockNoCommit: ReturnType<typeof vi.fn>;
  let releaseLockUntouched: ReturnType<typeof vi.fn>;

  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout;
  const disk = (rel: string) => fs.readFile(path.join(repo, KB, rel), 'utf-8');
  const committed = (rel: string) => git('show', `HEAD:${KB}/${rel}`);
  /** What the pending-commits worker does with each queued path. */
  const drainCommitWorker = async () => {
    for (const p of queued.splice(0)) {
      await git('add', '--', p);
      await git('commit', '-q', '-m', `edit ${p}`);
    }
  };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refused-removal-'));
    await git('init', '-q');
    await git('config', 'user.email', 'test@bevel.software');
    await git('config', 'user.name', 'Test');
    await fs.mkdir(path.join(repo, KB, 'Sales', 'Child'), { recursive: true });
    await fs.writeFile(path.join(repo, KB, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, KB, 'Sales', 'access.md'), '---\nwrite:\n  - Carol <carol@bevel.software>\n---\n');
    await fs.writeFile(path.join(repo, KB, 'Sales', 'Child', 'Note.md'), '# Note\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'seed');

    queued = [];
    writeFile = vi.fn(async (_id: string, wsRel: string, content: string) =>
      fs.writeFile(path.join(repo, wsRel), content, 'utf-8'),
    );
    const workspaceService = {
      withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
      getOrCreateForBranch: async () => ({ id: WS, name: WS, kbDirName: KB }),
      readFile: async (_id: string, wsRel: string) => fs.readFile(path.join(repo, wsRel), 'utf-8'),
      readFileBinary: async (_id: string, wsRel: string) => fs.readFile(path.join(repo, wsRel)),
      writeFile,
    } as unknown as WorkspaceService;

    const accessControl = {
      canRead: async () => true,
      canWrite: async () => true,
      canDownload: async () => false,
      canOwner: async () => true,
      // Nobody is inherited from anywhere: every remove-from-parent is stale.
      grantSources: async () => ({}),
      invalidate: () => undefined,
      kbPrincipals: async () => ({ roles: [], groups: [], people: [] }),
      eligibleWriters: async () => ({ roles: [], users: [] }),
      eligibleReaders: async () => ({ restricted: true, roles: [], users: [] }),
      eligibleOwners: async () => ({ roles: [], users: [] }),
      eligibleDownloaders: async () => ({ roles: [], users: [] }),
    } as unknown as IAccessControl;

    const locks = new Set<string>();
    const drop = (p: string) => void locks.delete(p);
    releaseLockNoCommit = vi.fn(async (_ws: string, _b: string, p: string) => {
      drop(p);
      // GitService.discardPath: a path tracked at HEAD goes back to HEAD.
      await git('checkout', 'HEAD', '--', p);
    });
    releaseLockUntouched = vi.fn(async (_ws: string, _b: string, p: string) => drop(p));
    const versionControlService = {
      getLock: async () => null,
      acquireLock: async (_ws: string, _b: string, p: string) => {
        if (locks.has(p)) return { acquired: false, lock: { holderName: 'someone' } };
        locks.add(p);
        return { acquired: true, lock: {} };
      },
      releaseLock: async (_ws: string, _b: string, p: string) => {
        drop(p);
        queued.push(p);
      },
      releaseLockNoCommit,
      releaseLockUntouched,
    } as unknown as VersionControlService;

    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = USER.id;
      next();
    });
    app.use(
      '/api',
      createAccessRoutes(
        accessControl,
        workspaceService,
        { getUserById: async () => USER } as unknown as AuthService,
        { whileSwitchedOn: async (_email: string, write: () => Promise<void>) => write() },
        versionControlService,
        { emit: () => undefined } as unknown as VersionControlEventBus,
        usersDbDouble(),
        testKbContext({ kbDirName: KB }),
        new NodeFs(),
      ),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(repo, { recursive: true, force: true });
  });

  const post = (route: 'grant' | 'revoke', body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const REFUSALS = [
    {
      name: 'stale-ancestor (409)',
      folder: 'Sales',
      status: 409,
      kind: 'stale-ancestor',
      revoke: {
        path: `${KB}/Sales/Child`,
        kind: 'folder',
        principal: BOB,
        mode: 'remove-from-parent',
        ancestor: `${KB}/Sales`,
      },
    },
    {
      name: 'admin-root-write (403)',
      folder: '',
      status: 403,
      kind: 'admin-root-write',
      revoke: { path: KB, kind: 'folder', principal: { kind: 'role', role: 'Admin' }, verb: 'write' },
    },
  ] as const;

  for (const r of REFUSALS) {
    const accessMd = r.folder ? `${r.folder}/access.md` : 'access.md';

    it(`grant, then an immediately refused ${r.name}: the grant stays on disk and commits`, async () => {
      const grant = await post('grant', {
        path: r.folder ? `${KB}/${r.folder}` : KB,
        kind: 'folder',
        verb: 'read',
        principal: BOB,
      });
      expect(grant.status).toBe(200);
      expect(await disk(accessMd)).toContain('bob@bevel.software');
      // The grant's commit is still queued when the removal runs.
      expect(queued).toEqual([`${KB}/${accessMd}`]);

      const refused = await post('revoke', r.revoke);
      expect(refused.status).toBe(r.status);
      expect(((await refused.json()) as { kind?: string }).kind).toBe(r.kind);

      expect(releaseLockNoCommit).not.toHaveBeenCalled();
      expect(releaseLockUntouched).toHaveBeenCalledWith(WS, expect.any(String), `${KB}/${accessMd}`, expect.anything());
      expect(await disk(accessMd)).toContain('bob@bevel.software');

      await drainCommitWorker();
      expect(await committed(accessMd)).toContain('bob@bevel.software');
      expect(await git('status', '--porcelain')).toBe('');
    });

    it(`a ${r.name} on its own leaves the file byte-identical and queues no commit`, async () => {
      const before = await disk(accessMd);
      const refused = await post('revoke', r.revoke);
      expect(refused.status).toBe(r.status);
      expect(await disk(accessMd)).toBe(before);
      expect(queued).toEqual([]);
      expect(writeFile).not.toHaveBeenCalled();
    });
  }

  it('a failure that left changed bytes behind still discards them, so partial state never commits', async () => {
    // The write lands, then fails: the bytes on disk are not what the op found.
    writeFile.mockImplementationOnce(async (_id: string, wsRel: string, content: string) => {
      await fs.writeFile(path.join(repo, wsRel), content, 'utf-8');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const res = await post('grant', { path: `${KB}/Sales`, kind: 'folder', verb: 'read', principal: BOB });
    expect(res.status).toBe(500);
    expect(releaseLockUntouched).not.toHaveBeenCalled();
    expect(releaseLockNoCommit).toHaveBeenCalledTimes(1);
    expect(await disk('Sales/access.md')).not.toContain('bob@bevel.software');
    expect(queued).toEqual([]);
    expect(await git('status', '--porcelain')).toBe('');
  });
});
