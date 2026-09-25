import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { FileTreeEntry, IWorkflowService } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * A folder exists until someone deletes it, and its placeholder is never shown
 * as content — the UI routes' half. The routes run over a REAL WorkspaceService
 * on a temp workspace (the disk effect is what is under test); only the lock
 * service is mocked, and a successful `releaseLock` on a path IS that path's
 * commit (it enqueues the commit-on-release), so it stands in for "committed".
 */

const KB = 'knowledge-base';
const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  noteAccessFileWritten: () => {},
};

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

interface Harness {
  server: Server;
  baseUrl: string;
  root: string;
  workspaceId: string;
  kbDir: string;
  releaseLock: ReturnType<typeof vi.fn>;
  acquireLock: ReturnType<typeof vi.fn>;
  workspaceService: WorkspaceService;
  emit: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folders-never-vanish-'));
  const workspaceId = workspaceIdForBranch('feature-folders');
  const workspaceDir = path.join(root, workspaceId);
  // The inner `.git` lets the service accept the workspace without cloning.
  await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
  const workspaceService = new WorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), new NodeFs());
  await workspaceService.getWorkspacePath(workspaceId);

  const releaseLock = vi.fn<(...args: unknown[]) => Promise<never>>(async () => undefined as never);
  const acquireLock = vi.fn<(...args: unknown[]) => Promise<{ acquired: boolean; lock: never }>>(async () => ({
    acquired: true,
    lock: {} as never,
  }));
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock,
    releaseLock,
    releaseLockNoCommit: vi.fn(async () => undefined as never),
  } as unknown as IWorkflowService;

  const emit = vi.fn();
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
      workflowService,
      { emit } as unknown as WorkflowEventBus,
      allowAll,
      testKbContext({ kbDirName: KB }),
      stubCreatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      new NodeFs(),
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    root,
    workspaceId,
    kbDir: path.join(workspaceDir, KB),
    releaseLock,
    acquireLock,
    workspaceService,
    emit,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The tree node at a workspace-relative path, or undefined. */
function nodeAt(tree: FileTreeEntry, relPath: string): FileTreeEntry | undefined {
  let node: FileTreeEntry | undefined = tree;
  for (const part of relPath.split('/')) {
    node = node?.children?.find((c) => c.name === part);
  }
  return node;
}

/** Every name anywhere in the tree. */
function allNames(tree: FileTreeEntry): string[] {
  return [tree.name, ...(tree.children ?? []).flatMap(allNames)];
}

describe('workspace routes — folders never vanish', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve) => h!.server.close(() => resolve()));
      await fs.rm(h.root, { recursive: true, force: true });
    }
    h = null;
  });

  const call = (method: string, route: string, body?: unknown) =>
    fetch(`${h!.baseUrl}/api/workspace/${h!.workspaceId}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const tree = async () => (await (await call('GET', '/files')).json()) as FileTreeEntry;
  const committed = (p: string) => h!.releaseLock.mock.calls.some((c) => c[2] === p);

  it('the sidebar tree never shows a placeholder, at any depth', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'Docs/Empty'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'Docs/Empty/.gitkeep'), '');
    await fs.writeFile(path.join(h.kbDir, 'Docs/.gitkeep'), '');
    await fs.writeFile(path.join(h.kbDir, 'Docs/note.md'), 'hi');

    const t = await tree();
    expect(allNames(t)).not.toContain('.gitkeep');
    expect(nodeAt(t, `${KB}/Docs/Empty`)).toMatchObject({ type: 'directory', children: [] });
    expect(nodeAt(t, `${KB}/Docs`)?.children?.map((c) => c.name)).toEqual(['Empty', 'note.md']);
  });

  it('deleting the last file of a folder keeps the folder, with a committed placeholder', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'nested/level-two'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'nested/level-two/notes.md'), 'x');

    const res = await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/nested/level-two/notes.md`)}`);
    expect(res.status).toBe(200);

    expect(await exists(path.join(h.kbDir, 'nested/level-two/notes.md'))).toBe(false);
    expect(await fs.readdir(path.join(h.kbDir, 'nested/level-two'))).toEqual(['.gitkeep']);
    expect(committed(`${KB}/nested/level-two/notes.md`)).toBe(true);
    expect(committed(`${KB}/nested/level-two/.gitkeep`)).toBe(true);
    expect(nodeAt(await tree(), `${KB}/nested/level-two`)).toMatchObject({ type: 'directory', children: [] });
  });

  it('deleting a file that has siblings writes no placeholder', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'full'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'full/a.md'), 'a');
    await fs.writeFile(path.join(h.kbDir, 'full/b.md'), 'b');

    expect((await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/full/a.md`)}`)).status).toBe(200);
    expect(await fs.readdir(path.join(h.kbDir, 'full'))).toEqual(['b.md']);
  });

  it('moving the last file out keeps the source folder', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'from'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'from/a.md'), 'a');

    const res = await call('PATCH', '/file', { oldPath: `${KB}/from/a.md`, newPath: `${KB}/to/a.md` });
    expect(res.status).toBe(200);

    expect(await fs.readdir(path.join(h.kbDir, 'from'))).toEqual(['.gitkeep']);
    expect(committed(`${KB}/from/.gitkeep`)).toBe(true);
  });

  it('an explicit folder delete removes the folder and its placeholder, and keeps the parent', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'parent/doomed/deeper'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'parent/doomed/.gitkeep'), '');
    await fs.writeFile(path.join(h.kbDir, 'parent/doomed/deeper/.gitkeep'), '');

    const res = await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/parent/doomed`)}`);
    expect(res.status).toBe(200);

    expect(await exists(path.join(h.kbDir, 'parent/doomed'))).toBe(false);
    // The placeholders' deletions are committed like any file's.
    expect(committed(`${KB}/parent/doomed/.gitkeep`)).toBe(true);
    expect(committed(`${KB}/parent/doomed/deeper/.gitkeep`)).toBe(true);
    // `parent` was not asked to go: it stays, now kept by its own placeholder.
    expect(await fs.readdir(path.join(h.kbDir, 'parent'))).toEqual(['.gitkeep']);
    expect(committed(`${KB}/parent/.gitkeep`)).toBe(true);
  });

  it('a folder made in the UI and one made by a nested write list the same way', async () => {
    h = await makeHarness();
    expect((await call('POST', '/directory', { path: `${KB}/Reports` })).status).toBe(200);
    expect((await call('PUT', `/file?path=${encodeURIComponent(`${KB}/Nested/Inner/n.md`)}`, { content: 'n' })).status).toBe(200);

    let t = await tree();
    expect(nodeAt(t, `${KB}/Reports`)).toMatchObject({ type: 'directory', children: [] });
    expect(nodeAt(t, `${KB}/Nested/Inner`)).toMatchObject({ type: 'directory' });

    // Emptied, the nested folder converges on the UI-made one.
    expect((await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/Nested/Inner/n.md`)}`)).status).toBe(200);
    t = await tree();
    expect(nodeAt(t, `${KB}/Nested/Inner`)).toEqual({ ...nodeAt(t, `${KB}/Reports`), name: 'Inner', relativePath: `${KB}/Nested/Inner` });
    expect(await fs.readdir(path.join(h.kbDir, 'Reports'))).toEqual(await fs.readdir(path.join(h.kbDir, 'Nested/Inner')));
  });

  it('a file delete racing an explicit delete of its folder does not bring the folder back', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'doomed/sub'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'doomed/first.md'), 'f');

    // Hold the folder delete inside its turn, right after it deleted the one
    // file it enumerated.
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.releaseLock.mockImplementation(async (...args: unknown[]) => {
      if (args[2] === `${KB}/doomed/first.md`) {
        reached();
        await gate;
      }
      return undefined as never;
    });
    const folderDelete = call('DELETE', `/file?path=${encodeURIComponent(`${KB}/doomed`)}`);
    await atGate;

    // A file that landed after the enumeration is deleted meanwhile: its
    // folder is empty, and keeping it must wait for the folder delete.
    await fs.writeFile(path.join(h.kbDir, 'doomed/sub/late.md'), 'l');
    const fileDelete = call('DELETE', `/file?path=${encodeURIComponent(`${KB}/doomed/sub/late.md`)}`);
    for (let i = 0; i < 200 && (await exists(path.join(h.kbDir, 'doomed/sub/late.md'))); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 20));
    const keptTooEarly = await exists(path.join(h.kbDir, 'doomed/sub/.gitkeep'));

    open();
    expect(keptTooEarly).toBe(false);
    expect((await folderDelete).status).toBe(200);
    expect((await fileDelete).status).toBe(200);
    expect(await exists(path.join(h.kbDir, 'doomed'))).toBe(false);
    expect(committed(`${KB}/doomed/sub/.gitkeep`)).toBe(false);
  });

  it('a delete whose placeholder lock is held elsewhere keeps the 409, with the context', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'busy'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'busy/only.md'), 'x');
    h.acquireLock.mockImplementation(async (...args: unknown[]) =>
      args[2] === `${KB}/busy/.gitkeep`
        ? { acquired: false, lock: { holderName: 'Bob' } as never }
        : { acquired: true, lock: {} as never },
    );

    const res = await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/busy/only.md`)}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      `"${KB}/busy/only.md" was removed, but its folder "${KB}/busy" could not be kept: "${KB}/busy/.gitkeep" is being edited by Bob. Try again in a moment.`,
    );
  });

  it('a folder delete whose parent cannot be kept still refreshes the tree', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'holder/gone'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'holder/gone/a.md'), 'a');
    h.acquireLock.mockImplementation(async (...args: unknown[]) => {
      if (args[2] === `${KB}/holder/.gitkeep`) throw new Error('lock store down');
      return { acquired: true, lock: {} as never };
    });

    const res = await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/holder/gone`)}`);
    expect(res.status).toBe(500);
    expect(await exists(path.join(h.kbDir, 'holder/gone'))).toBe(false);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fs-tree-changed' }));
  });

  it('a delete whose folder cannot be kept fails, and says the file itself is gone', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.kbDir, 'kept'), { recursive: true });
    await fs.writeFile(path.join(h.kbDir, 'kept/only.md'), 'x');
    h.acquireLock.mockImplementation(async (...args: unknown[]) => {
      if (args[2] === `${KB}/kept/.gitkeep`) throw new Error('lock store down');
      return { acquired: true, lock: {} as never };
    });

    const res = await call('DELETE', `/file?path=${encodeURIComponent(`${KB}/kept/only.md`)}`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      `"${KB}/kept/only.md" was removed, but its folder "${KB}/kept" could not be kept: lock store down`,
    );
    expect(await exists(path.join(h.kbDir, 'kept/only.md'))).toBe(false);
  });
});

describe('WorkspaceService.writeFolderPlaceholder', () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  async function service() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-placeholder-'));
    const workspaceId = workspaceIdForBranch('placeholders');
    const kbDir = path.join(root, workspaceId, KB);
    await fs.mkdir(path.join(kbDir, '.git'), { recursive: true });
    return { svc: new WorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), new NodeFs()), workspaceId, kbDir };
  }

  it('writes into an empty folder, and leaves a full or a vanished one alone', async () => {
    const { svc, workspaceId, kbDir } = await service();
    await fs.mkdir(path.join(kbDir, 'empty'));
    await fs.mkdir(path.join(kbDir, 'full'));
    await fs.writeFile(path.join(kbDir, 'full/a.md'), 'a');

    await expect(svc.writeFolderPlaceholder(workspaceId, `${KB}/empty`)).resolves.toBe(true);
    await expect(svc.writeFolderPlaceholder(workspaceId, `${KB}/full`)).resolves.toBe(false);
    await expect(svc.writeFolderPlaceholder(workspaceId, `${KB}/gone`)).resolves.toBe(false);

    expect(await fs.readdir(path.join(kbDir, 'empty'))).toEqual(['.gitkeep']);
    expect(await fs.readdir(path.join(kbDir, 'full'))).toEqual(['a.md']);
    expect(await exists(path.join(kbDir, 'gone'))).toBe(false);
  });

  it('never writes through a folder that is a link out of the workspace', async () => {
    const { svc, workspaceId, kbDir } = await service();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-placeholder-outside-'));
    try {
      await fs.symlink(outside, path.join(kbDir, 'linked'), 'dir');

      await expect(svc.writeFolderPlaceholder(workspaceId, `${KB}/linked`)).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceService.withFolderTurn', () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it('serializes a folder with the folders inside it, and never folders side by side', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-turn-'));
    const workspaceId = workspaceIdForBranch('turns');
    await fs.mkdir(path.join(root, workspaceId, KB, '.git'), { recursive: true });
    const svc = new WorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), new NodeFs());

    const events: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const holdingA = new Promise<void>((r) => (started = r));
    const outer = svc.withFolderTurn(workspaceId, `${KB}/A`, async () => {
      events.push('A start');
      started();
      await gate;
      events.push('A end');
    });
    // `A` holds its turn before the others ask for theirs.
    await holdingA;
    const inner = svc.withFolderTurn(workspaceId, `${KB}/A/B`, async () => {
      events.push('A/B');
    });
    const sibling = svc.withFolderTurn(workspaceId, `${KB}/AB`, async () => {
      events.push('AB');
    });
    await sibling;
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['A start', 'AB']);

    open();
    await Promise.all([outer, inner]);
    expect(events).toEqual(['A start', 'AB', 'A end', 'A/B']);
  });
});
