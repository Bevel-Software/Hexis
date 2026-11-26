import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { realFileLocks, realLockingVersionControl } from '../../../__tests__/real-version-control.js';
import type { VersionControlEventBus, VersionControlService } from '../../version-control/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { IChangeReadGate, ICreatorAccess } from '../../access-model/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import type { AuthService } from '../../auth/index.js';
import type { WorkspaceService } from '../workspace.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';

/**
 * QA's bug B3 on v0.35.0, over REST: a Business user holds write on
 * `QA-Edit/`, opens `QA-Edit/notes.md` and clicks Edit (the lock is taken).
 * The admin rewrites `QA-Edit/access.md` without the grant. The user saves.
 * The save used to answer 200 and commit, because the route trusted the held
 * lock and the write gate ran only at the acquire.
 *
 * The route here runs against the REAL version-control service and the real
 * lock service (over the in-memory lock table), with the access answer flipped
 * between Edit and Save, so what decides is the code that ships.
 */

const KB = 'knowledge-base';
// A protected branch in the backend test config: the write gate applies.
const WS = 'target-company-state';
const FILE = `${KB}/QA-Edit/notes.md`;
const ORIGINAL = '# Notes\nAs it was.\n';
const FROM_ARCHIVE = '# Notes\nFrom the archive.\n';
const USER: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com', name: 'Business User' };

let root: string;
let server: Server;
let baseUrl: string;
let writable: boolean;
let svc: VersionControlService;
let enqueue: ReturnType<typeof vi.fn>;
/** Runs inside the extraction, after the archive's bytes have landed. */
let afterWrite: (() => Promise<void>) | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-held-lock-revoked-'));
  await fs.mkdir(path.join(root, KB, 'QA-Edit'), { recursive: true });
  await fs.writeFile(path.join(root, FILE), ORIGINAL);
  writable = true;
  afterWrite = undefined;
  const { locks } = realFileLocks();
  enqueue = vi.fn(async () => undefined);
  const gate: IChangeReadGate = { judge: vi.fn(), assertMayChange: vi.fn(async () => undefined) };
  svc = realLockingVersionControl({
    locks,
    accessControl: {
      canWriteBatchAtRef: vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
        new Map(paths.map((p) => [p, writable])),
      ),
      eligibleWritersAtRef: vi.fn(async () => ({ roles: ['Admin'], users: [] })),
      canRestorePlatformFile: vi.fn(async () => false),
    } as unknown as IAccessControl,
    pendingCommits: { enqueue },
    kb: testKbContext({ kbDirName: KB }),
    changeGate: gate,
  });
  const workspaceService = {
    getWorkspacePath: async () => root,
    withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
    writeFile: async (_id: string, p: string, content: string) => {
      await fs.writeFile(path.join(root, p), content);
    },
    // The extraction's contract (`WorkspaceService.unzipFile`): each entry
    // meets the guard before its bytes land, and a refused entry is skipped
    // and reported, never written; a written file is reported once its
    // bytes are on disk. The archive here carries the edited file.
    unzipFile: async (
      _id: string,
      _zip: string,
      _dest: string | undefined,
      guard: (p: string) => Promise<void>,
      onWritten?: (p: string) => void,
    ) => {
      try {
        await guard(FILE);
      } catch (err) {
        return { extracted: [], skipped: [{ path: FILE, reason: (err as Error).message }] };
      }
      await fs.writeFile(path.join(root, FILE), FROM_ARCHIVE);
      onWritten?.(FILE);
      await afterWrite?.();
      return { extracted: [FILE], skipped: [] };
    },
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
      svc,
      { emit: vi.fn() } as unknown as VersionControlEventBus,
      { canRead: async () => true } as unknown as IAccessControl,
      testKbContext({ kbDirName: KB }),
      { planForCreate: async () => null, noteAccessFileWritten: () => {} } as unknown as ICreatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      realDisk(),
    ),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

function save(content: string): Promise<Response> {
  return fetch(`${baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(FILE)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

const onDisk = () => fs.readFile(path.join(root, FILE), 'utf8');

describe('PUT /file by the holder of the editor lock', () => {
  it('lands while the holder may still write, and leaves the lock for the editor to release', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);

    const res = await save('# Notes\nEdited.\n');

    expect(res.status).toBe(200);
    expect(await onDisk()).toBe('# Notes\nEdited.\n');
    expect((await svc.getLock(WS, WS, FILE))?.holderUserId).toBe(USER.id);
  });

  it('is refused with the same 403 as a non-writer once write is revoked, writes nothing, and loses the lock', async () => {
    // A non-writer who never held the lock: the refusal to match.
    writable = false;
    const nonWriter = await save('# Notes\nNever.\n');
    const nonWriterBody = await nonWriter.json();
    expect(nonWriter.status).toBe(403);

    // Edit and save while granted, then the admin removes the grant.
    writable = true;
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);
    expect((await save('# Notes\nSaved while granted.\n')).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    writable = false;

    const res = await save('# Notes\nTyped after the revoke.\n');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(nonWriterBody);
    // The bytes saved while the grant stood stay, and are queued to commit
    // under the holder's name; the bytes typed after the revoke never land.
    expect(await onDisk()).toBe('# Notes\nSaved while granted.\n');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: FILE, authorEmail: USER.email }));
    expect(await svc.getLock(WS, WS, FILE)).toBeNull();

    // And again, now holding nothing: the plain non-writer refusal.
    const again = await save('# Notes\nStill no.\n');
    expect(again.status).toBe(403);
    expect(await onDisk()).toBe('# Notes\nSaved while granted.\n');
  });
});

describe('an archive extracted over a file the caller holds the editor lock on', () => {
  function unzip(): Promise<Response> {
    return fetch(`${baseUrl}/api/workspace/${WS}/unzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${KB}/QA-Edit/drop.zip` }),
    });
  }

  it('skips that file once write is revoked: its bytes never land, and the lock goes with only what was there', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);
    writable = false;

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ extracted: [], skipped: [{ path: FILE }] });
    // Asked BEFORE the extraction: the archive's text is not what the release
    // publishes under the holder's name.
    expect(await onDisk()).toBe(ORIGINAL);
    expect(await svc.getLock(WS, WS, FILE)).toBeNull();
  });

  it('extracts it while the holder may still write, and leaves the lock for the editor', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await onDisk()).toBe(FROM_ARCHIVE);
    expect((await svc.getLock(WS, WS, FILE))?.holderUserId).toBe(USER.id);
  });

  // Any other lock on the entry would meet the sweep's strict acquire (409)
  // only after its bytes were written: the entry is skipped before that.
  it('skips that file under the caller own coordination hold: its bytes never land and the hold stays', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER, { coordination: true })).acquired).toBe(true);

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ extracted: [], skipped: [{ path: FILE, reason: expect.stringContaining('is being edited by') }] });
    expect(await onDisk()).toBe(ORIGINAL);
    expect((await svc.getLock(WS, WS, FILE))?.mode).toBe('coordination');
    expect(enqueue).not.toHaveBeenCalled();
  });

  // With no lock at all the entry meets the acquire before its bytes land, so
  // a reader who may not write never overwrites it and then gets refused.
  it('skips that file for a reader who may not write and holds no lock: its bytes never land', async () => {
    writable = false;

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ extracted: [], skipped: [{ path: FILE, reason: expect.stringContaining('permission to write') }] });
    expect(await onDisk()).toBe(ORIGINAL);
    expect(await svc.getLock(WS, WS, FILE)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('extracts and commits it for a writer who holds no lock, under the lock taken before the write', async () => {
    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await onDisk()).toBe(FROM_ARCHIVE);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: FILE, authorEmail: USER.email }));
    expect(await svc.getLock(WS, WS, FILE)).toBeNull();
  });

  // A file written before the extraction fails part-way is still committed,
  // not handed back untouched and left outside every commit.
  it('commits the file written before the extraction failed part-way', async () => {
    afterWrite = async () => {
      throw new Error('the archive is truncated');
    };

    const res = await unzip();

    expect(res.status).toBe(500);
    expect(await onDisk()).toBe(FROM_ARCHIVE);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: FILE, authorEmail: USER.email }));
    expect(await svc.getLock(WS, WS, FILE)).toBeNull();
  });

  // A long archive can outlast the lease of a lock it took. A lock on the
  // entry taken anew by then, here by the same person's editor, is not this
  // call's: it is neither released nor committed under it.
  it('leaves a lock taken anew during the extraction alone, even by the same user', async () => {
    afterWrite = async () => {
      await svc.releaseLockUntouched(WS, WS, FILE, USER);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);
    };

    const res = await unzip();

    expect(res.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await svc.getLock(WS, WS, FILE))?.holderUserId).toBe(USER.id);
  });

  it('skips that file under somebody else lock: its bytes never land and their lock stays', async () => {
    const other: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.com', name: 'Other Editor' };
    expect((await svc.acquireLock(WS, WS, FILE, other)).acquired).toBe(true);

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ extracted: [], skipped: [{ path: FILE, reason: expect.stringContaining('Other Editor') }] });
    expect(await onDisk()).toBe(ORIGINAL);
    expect((await svc.getLock(WS, WS, FILE))?.holderUserId).toBe(other.id);
  });
});

describe('PUT /file under the caller own coordination hold', () => {
  // A coordination hold serialises an agent's writes and grants no write
  // authority, so it is not the editor's lock: the save goes to the acquire,
  // which is strict and refuses a live lock even to its own holder.
  it('is refused as contended and writes nothing', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER, { coordination: true })).acquired).toBe(true);

    const res = await save('# Notes\nThrough a coordination hold.\n');

    expect(res.status).toBe(409);
    expect(await onDisk()).toBe(ORIGINAL);
    expect((await svc.getLock(WS, WS, FILE))?.mode).toBe('coordination');
  });
});
