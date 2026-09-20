import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * `PATCH /workspace/:id/file` is the one door rename, move and the sidebar's
 * drag all come through, so the platform-file rule is stated once, here.
 *
 * The bug it closes: the tester moved `access.md` and `.bevelignore` out of
 * the repository root. A root with no `access.md` denies write to everyone,
 * so the move that would put it back was the move the gate refused, and
 * deleting the instance looked like the only way out.
 */

const KB = 'knowledge-base';
const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WORKSPACE_ID = 'main';

interface Harness {
  server: Server;
  baseUrl: string;
  moveEntry: ReturnType<typeof vi.fn>;
  acquireLock: ReturnType<typeof vi.fn>;
  canRestorePlatformFile: ReturnType<typeof vi.fn>;
  workspaceDir: string;
}

async function makeHarness(): Promise<Harness> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-files-'));

  const canRestorePlatformFile = vi.fn(async () => false);
  const accessControl = {
    canWrite: vi.fn(),
    canWriteBatch: vi.fn(),
    canDownload: vi.fn(),
    eligibleWriters: vi.fn(),
    eligibleWriterEmails: vi.fn(),
    invalidate: vi.fn(),
    findEmailByHash: vi.fn(),
    canWriteAtRef: vi.fn(),
    canWriteBatchAtRef: vi.fn(),
    eligibleWritersAtRef: vi.fn(),
    eligibleWritersForPathsAtRef: vi.fn(),
    canRestorePlatformFile,
  } as unknown as IAccessControl;

  const moveEntry = vi.fn(async () => undefined);
  const workspaceServiceMock: Partial<WorkspaceService> = {
    getWorkspacePath: vi.fn(async () => workspaceDir),
    withFolderTurn: async <T>(_id: string, _dir: string, op: () => Promise<T>) => op(),
    moveEntry: moveEntry as unknown as WorkspaceService['moveEntry'],
  };
  const workspaceService = workspaceServiceMock as WorkspaceService;

  const acquireLock = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const workflowServiceMock: Partial<IWorkflowService> = {
    getLock: vi.fn(async () => null),
    acquireLock: acquireLock as unknown as IWorkflowService['acquireLock'],
    releaseLock: vi.fn(async () => undefined as never),
    releaseLockNoCommit: vi.fn(async () => undefined as never),
  };
  const workflowService = workflowServiceMock as unknown as IWorkflowService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const creatorAccess: ICreatorAccess = {
    planForCreate: async () => null,
    grantInExtractedFile: async () => null,
    noteAccessFileWritten: () => {},
  };

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER_ID;
    next();
  });
  app.use('/api', createWorkspaceRoutes(
    workspaceService,
    authService,
    workflowService,
    eventBus,
    accessControl,
    KB,
    creatorAccess,
    { isAdmin: async () => false } as unknown as IAdminAccessService,
    new NodeFs(),
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    moveEntry,
    acquireLock,
    canRestorePlatformFile,
    workspaceDir,
  };
}

async function move(h: Harness, oldPath: string, newPath: string) {
  const res = await fetch(`${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  return { status: res.status, body: await res.json() as { error?: string; status?: string } };
}

describe('a platform file stays in its folder', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    await fs.rm(h.workspaceDir, { recursive: true, force: true });
  });

  // Each of the four, at a place the platform reads it from. `access.md` and
  // `.bevelignore` are read wherever they sit; `roles.yaml` and `AGENTS.md`
  // are read from the repository root only.
  const PLATFORM_FILES = [
    { name: 'access.md', at: `${KB}/Sales/access.md` },
    { name: '.bevelignore', at: `${KB}/Sales/.bevelignore` },
    { name: 'roles.yaml', at: `${KB}/roles.yaml` },
    { name: 'AGENTS.md', at: `${KB}/AGENTS.md` },
  ];

  it.each(PLATFORM_FILES)('refuses a rename of $name with the sentence', async ({ name, at }) => {
    const renamed = `${at.slice(0, at.lastIndexOf('/'))}/renamed-${name}`;
    const res = await move(h, at, renamed);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`${name} is a platform file and stays in its folder.`);
    expect(h.moveEntry).not.toHaveBeenCalled();
    expect(h.acquireLock).not.toHaveBeenCalled();
  });

  it.each(PLATFORM_FILES)('refuses a move of $name into another folder with the sentence', async ({ name, at }) => {
    const res = await move(h, at, `${KB}/Elsewhere/${name}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`${name} is a platform file and stays in its folder.`);
    expect(h.moveEntry).not.toHaveBeenCalled();
  });

  // A drag is a move: the sidebar's drop sends this same call with the
  // dropped-on folder as the destination, so it meets the same rule rather
  // than one of its own. What the drop adds is the destination the drag
  // makes easy to reach — the repository root — where a caller who is not an
  // admin gets the refusal like anywhere else. (The sidebar's own refusal,
  // before the call, is covered in `FileExplorer.test.tsx`.)
  it.each(PLATFORM_FILES.filter((f) => f.at !== `${KB}/${f.name}`))(
    'refuses a drop of $name onto the repository root with the sentence',
    async ({ name, at }) => {
      const res = await move(h, at, `${KB}/${name}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(`${name} is a platform file and stays in its folder.`);
      expect(h.moveEntry).not.toHaveBeenCalled();
    },
  );

  it.each(PLATFORM_FILES.filter((f) => f.at === `${KB}/${f.name}`))(
    'refuses a drop of the root $name onto a folder with the sentence',
    async ({ name, at }) => {
      const res = await move(h, at, `${KB}/Archive/${name}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(`${name} is a platform file and stays in its folder.`);
      expect(h.moveEntry).not.toHaveBeenCalled();
    },
  );

  // The recovery move, for each of the four, from the place a misplaced copy
  // is actually found to the place the platform reads it.
  const RESTORES = [
    { name: 'access.md', from: `${KB}/Misplaced/access.md`, to: `${KB}/access.md`, dest: 'access.md' },
    { name: '.bevelignore', from: `${KB}/Misplaced/.bevelignore`, to: `${KB}/.bevelignore`, dest: '.bevelignore' },
    { name: 'roles.yaml', from: `${KB}/Misplaced/roles.yaml`, to: `${KB}/roles.yaml`, dest: 'roles.yaml' },
    { name: 'AGENTS.md', from: `${KB}/Misplaced/AGENTS.md`, to: `${KB}/AGENTS.md`, dest: 'AGENTS.md' },
  ];

  it.each(RESTORES)(
    'an admin restores a misplaced $name, and only the destination carries the claim',
    async ({ from, to, dest }) => {
      h.canRestorePlatformFile.mockResolvedValue(true);
      const res = await move(h, from, to);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'moved' });
      expect(h.moveEntry).toHaveBeenCalledWith(WORKSPACE_ID, from, to);
      // Asked about where the move LANDS, repo-relative — never about what it
      // takes away. (What it takes away is the source, which the claim names
      // so the write gate can check it without trusting this route.)
      expect(h.canRestorePlatformFile).toHaveBeenCalledWith(WORKSPACE_ID, USER.email, dest);
      // The source side is an ordinary write the caller must already hold; only
      // the destination lock may present the restore claim to the write gate.
      const claims = new Map(
        h.acquireLock.mock.calls.map(
          (c) => [c[2] as string, (c[4] as { platformRestore?: { source: string } })?.platformRestore],
        ),
      );
      expect(claims.get(to)).toEqual({ source: from });
      expect(claims.get(from)).toBeUndefined();
    },
  );

  it.each(RESTORES)('a non-admin never gets the restore for $name', async ({ name, from, to }) => {
    h.canRestorePlatformFile.mockResolvedValue(false);
    const res = await move(h, from, to);
    expect(h.canRestorePlatformFile).toHaveBeenCalledWith(WORKSPACE_ID, USER.email, name);
    expect(res.status).toBe(409);
    // Two sentences, because two different things are wrong. `access.md` and
    // `.bevelignore` are read wherever they sit, so the misplaced copy is
    // itself a platform file and the refusal is about MOVING one. A nested
    // `roles.yaml` / `AGENTS.md` is ordinary content, so nothing is being
    // moved out of place — what is refused is the file the destination would
    // BECOME, which is the root's own `roles.yaml`, written by someone the
    // access module just said may not restore it.
    expect(res.body.error).toBe(
      name === 'access.md' || name === '.bevelignore'
        ? `${name} is a platform file and stays in its folder.`
        : `${name} is a platform file name; a move cannot create a platform file.`,
    );
    expect(h.moveEntry).not.toHaveBeenCalled();
    expect(h.acquireLock).not.toHaveBeenCalled();
  });

  it('an ordinary file cannot BECOME a platform file, at a free destination or an occupied one', async () => {
    // `moveEntry` is a rename, so this is the only thing standing between a
    // note and the rules of the folder it is renamed into. Nothing on the
    // SOURCE side has anything to say about it: `Sales/deal.md` is content.
    const created = await move(h, `${KB}/Sales/deal.md`, `${KB}/access.md`);
    expect(created.status).toBe(409);
    expect(created.body.error).toBe('access.md is a platform file name; a move cannot create a platform file.');

    const renamedInPlace = await move(h, `${KB}/Sales/deal.md`, `${KB}/Sales/access.md`);
    expect(renamedInPlace.status).toBe(409);
    expect(renamedInPlace.body.error).toBe('access.md is a platform file name; a move cannot create a platform file.');

    // The same answer with the file already there — the destination is a
    // platform path either way, and the restore is the only move that lands
    // on one.
    await fs.mkdir(path.join(h.workspaceDir, KB), { recursive: true });
    await fs.writeFile(path.join(h.workspaceDir, KB, '.bevelignore'), '*.tmp\n');
    const onto = await move(h, `${KB}/Sales/deal.md`, `${KB}/.bevelignore`);
    expect(onto.status).toBe(409);
    expect(onto.body.error).toBe('.bevelignore is a platform file name; a move cannot create a platform file.');

    expect(h.moveEntry).not.toHaveBeenCalled();
    expect(h.acquireLock).not.toHaveBeenCalled();
  });

  it('a destination that fills up after the access check is caught under the lock', async () => {
    // The access module answers on the disk it saw: `canRestorePlatformFile`
    // said yes because the root had no `access.md` when it looked. Here it
    // says yes and the file IS there — the state a racing writer leaves — and
    // the move refuses rather than renaming over the rules it came to bring
    // back. Both locks are held by then, so this is the last place the answer
    // can change.
    h.canRestorePlatformFile.mockResolvedValue(true);
    await fs.mkdir(path.join(h.workspaceDir, KB), { recursive: true });
    await fs.writeFile(path.join(h.workspaceDir, KB, 'access.md'), '---\nread: everyone\n---\n');

    const res = await move(h, `${KB}/Misplaced/access.md`, `${KB}/access.md`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('access.md is a platform file and stays in its folder.');
    expect(h.moveEntry).not.toHaveBeenCalled();
    // It got as far as the locks — that is the point of the second look.
    expect(h.acquireLock).toHaveBeenCalled();
  });

  it('a restore must keep the name: a misplaced access.md may not arrive as something else', async () => {
    h.canRestorePlatformFile.mockResolvedValue(true);
    const res = await move(h, `${KB}/Misplaced/access.md`, `${KB}/rules.md`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('access.md is a platform file and stays in its folder.');
    expect(h.moveEntry).not.toHaveBeenCalled();
  });

  it("the root's own access.md is never a restore, however willing the access module is", async () => {
    // Otherwise the rescue would describe the bug it repairs: "move the root's
    // access.md into a folder that has none" is exactly how the root loses it.
    h.canRestorePlatformFile.mockResolvedValue(true);
    const res = await move(h, `${KB}/access.md`, `${KB}/Sales/access.md`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('access.md is a platform file and stays in its folder.');
    expect(h.moveEntry).not.toHaveBeenCalled();
    expect(h.canRestorePlatformFile).not.toHaveBeenCalled();
  });

  it('an ordinary file is unaffected — renamed and moved, with no restore claim anywhere', async () => {
    const renamed = await move(h, `${KB}/Sales/deal.md`, `${KB}/Sales/contract.md`);
    expect(renamed.status).toBe(200);
    const moved = await move(h, `${KB}/Sales/contract.md`, `${KB}/Legal/contract.md`);
    expect(moved.status).toBe(200);
    expect(h.moveEntry).toHaveBeenCalledTimes(2);
    expect(h.canRestorePlatformFile).not.toHaveBeenCalled();
    for (const call of h.acquireLock.mock.calls) {
      expect((call[4] as { platformRestore?: unknown })?.platformRestore).toBeUndefined();
    }
  });

  it('a nested roles.yaml or AGENTS.md is ordinary content and moves freely', async () => {
    // They are read from the root and nowhere else, so a nested file of
    // either name carries no platform meaning to protect.
    expect((await move(h, `${KB}/Sales/roles.yaml`, `${KB}/Sales/old-roles.yaml`)).status).toBe(200);
    expect((await move(h, `${KB}/Sales/AGENTS.md`, `${KB}/Legal/AGENTS.md`)).status).toBe(200);
    expect(h.moveEntry).toHaveBeenCalledTimes(2);
  });
});
