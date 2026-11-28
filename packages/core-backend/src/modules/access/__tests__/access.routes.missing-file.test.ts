import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { VersionControlService } from '../../version-control/version-control.service.js';
import type { VersionControlEventBus } from '../../version-control/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';

/**
 * An access change aimed at a file that does not exist answers 404, not 500.
 *
 * The bug: grant, revoke and deny-here on a missing file target let the raw
 * ENOENT of the frontmatter read escape, and the route rendered it as
 * "Internal error.". Each now answers the shared 404 `not_found` naming the
 * path, with the next step, before any lock is taken or byte written. A caller
 * the write gate refuses still gets the gate's 403, the same for a missing
 * file as for an existing one, so the 404 discloses nothing to them.
 *
 * The workspace is a real temp directory, so a write shows up as a file on
 * disk, not just a spy call.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature';
const KB = 'knowledge-base';
const BOB = { kind: 'user' as const, email: 'bob@bevel.software', displayName: 'Bob' };

const MUTATIONS = [
  { name: 'grant', route: 'grant', extra: { verb: 'read' } },
  { name: 'revoke', route: 'revoke', extra: {} },
  { name: 'deny-here', route: 'revoke', extra: { mode: 'deny-here' } },
] as const;

const DEAL = '---\nnodeType: process\n---\n# Deal\n';

const notFoundBody =(p: string) => ({
  error: `There is no file or directory at "${p}" in this workspace. Check the path with list_files.`,
  kind: 'not_found',
  path: p,
});

describe('access mutations on a file that does not exist', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let writeFile: ReturnType<typeof vi.fn>;
  let acquireLock: ReturnType<typeof vi.fn>;
  let releaseLockNoCommit: ReturnType<typeof vi.fn>;
  let releaseLockUntouched: ReturnType<typeof vi.fn>;
  let canRead: ReturnType<typeof vi.fn>;
  let canWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-missing-file-'));
    await fs.mkdir(path.join(root, KB, 'Sales'), { recursive: true });
    await fs.writeFile(path.join(root, KB, 'Sales/Deal.md'), DEAL);

    writeFile = vi.fn(async (_id: string, wsRel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(root, wsRel)), { recursive: true });
      return fs.writeFile(path.join(root, wsRel), content, 'utf-8');
    });
    const workspaceService = {
      withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
      getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
      readFile: vi.fn(async (_id: string, wsRel: string) => fs.readFile(path.join(root, wsRel), 'utf-8')),
      readFileBinary: vi.fn(async (_id: string, wsRel: string) => fs.readFile(path.join(root, wsRel))),
      writeFile,
    } as unknown as WorkspaceService;

    canRead = vi.fn(async () => true);
    canWrite = vi.fn(async () => true);
    const accessControl = {
      canRead,
      canWrite,
      canDownload: vi.fn(async () => false),
      canOwner: vi.fn(async () => false),
      grantSources: vi.fn(async () => ({})),
      invalidate: vi.fn(),
      holdsAdminRootWrite: vi.fn(async () => false),
      kbPrincipals: vi.fn(async () => ({ roles: [], groups: [], people: [] })),
      eligibleWriters: vi.fn(async () => ({ roles: ['Admin'], users: [] })),
      eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: [] })),
      eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
      eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
    } as unknown as IAccessControl;

    acquireLock = vi.fn(async () => ({ acquired: true, lock: {} }));
    // Models the real release-without-commit: it discards the path's
    // working-tree changes, which would undo a delete whose commit is queued.
    releaseLockNoCommit = vi.fn(async () => undefined);
    releaseLockUntouched = vi.fn(async () => undefined);
    const versionControlService = {
      getLock: vi.fn(async () => null),
      acquireLock,
      releaseLock: vi.fn(async () => undefined),
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
        { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
        { whileSwitchedOn: async (_email: string, write: () => Promise<void>) => write() },
        versionControlService,
        { emit: vi.fn() } as unknown as VersionControlEventBus,
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
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await fs.rm(root, { recursive: true, force: true });
  });

  const post = (route: 'grant' | 'revoke', body: unknown) =>
    fetch(`${baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const exists = (rel: string) =>
    fs.access(path.join(root, KB, rel)).then(
      () => true,
      () => false,
    );

  // A missing name in an existing folder, one in a missing folder, and one
  // under a FILE (ENOTDIR): each is "nothing is there".
  const MISSING = ['Sales/missing.md', 'Sales/Sub/missing.md', 'Sales/Deal.md/inner.md'];

  for (const rel of MISSING) {
    for (const m of MUTATIONS) {
      it(`${m.name} on ${rel} → 404 not_found naming the path, never locked or written`, async () => {
        const res = await post(m.route, { path: `${KB}/${rel}`, kind: 'file', principal: BOB, ...m.extra });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(notFoundBody(rel));
        expect(acquireLock).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        // The disk is checked at the path this iteration sent, plus what a
        // write there would have created or clobbered on the way.
        expect(await exists(rel)).toBe(false);
        expect(await exists('Sales/Sub')).toBe(false);
        expect(await fs.readFile(path.join(root, KB, 'Sales/Deal.md'), 'utf-8')).toBe(DEAL);
      });
    }
  }

  it('the path in the answer is sanitized: a control character never reaches the message', async () => {
    const rel = 'Sales/bad\u0007name.md';
    const res = await post('grant', { path: `${KB}/${rel}`, kind: 'file', verb: 'read', principal: BOB });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.kind).toBe('not_found');
    expect(body.path).not.toContain('\u0007');
    expect(body.error).not.toContain('\u0007');
    expect(body.error).toContain('Check the path with list_files.');
  });

  for (const m of MUTATIONS) {
    it(`${m.name}: a caller who may not read or write answers 403, the same for a missing file as for an existing one`, async () => {
      canRead.mockResolvedValue(false);
      canWrite.mockResolvedValue(false);

      const missing = await post(m.route, { path: `${KB}/Sales/missing.md`, kind: 'file', principal: BOB, ...m.extra });
      const present = await post(m.route, { path: `${KB}/Sales/Deal.md`, kind: 'file', principal: BOB, ...m.extra });

      expect(missing.status).toBe(403);
      expect(present.status).toBe(403);
      const missingBody = JSON.stringify(await missing.json()).replaceAll('Sales/missing.md', '<p>');
      const presentBody = JSON.stringify(await present.json()).replaceAll('Sales/Deal.md', '<p>');
      expect(missingBody).toBe(presentBody);
      expect(missingBody).not.toContain('not_found');
      expect(acquireLock).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });
  }

  for (const m of MUTATIONS) {
    it(`${m.name}: a file deleted after the pre-lock check answers 404 under the lock, and the release leaves the disk alone`, async () => {
      // The race: the pre-lock check sees the note, a delete lands, and the
      // mutation reads under the lock. The refusal wrote nothing, so it must
      // not reach the discarding release, which would undo the queued delete.
      await fs.writeFile(path.join(root, KB, 'Sales/Gone.md'), '# Gone soon\n');
      acquireLock.mockImplementationOnce(async () => {
        await fs.rm(path.join(root, KB, 'Sales/Gone.md'));
        return { acquired: true, lock: {} };
      });

      const res = await post(m.route, { path: `${KB}/Sales/Gone.md`, kind: 'file', principal: BOB, ...m.extra });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(notFoundBody('Sales/Gone.md'));
      expect(acquireLock).toHaveBeenCalled();
      expect(releaseLockUntouched).toHaveBeenCalled();
      expect(releaseLockNoCommit).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(await exists('Sales/Gone.md')).toBe(false);
    });
  }

  it('a folder target with no access.md yet is still a grant, not a 404', async () => {
    await fs.mkdir(path.join(root, KB, 'Empty'));
    const res = await post('grant', { path: `${KB}/Empty`, kind: 'folder', verb: 'read', principal: BOB });

    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(root, KB, 'Empty/access.md'), 'utf-8')).toContain('bob@bevel.software');
  });
});
