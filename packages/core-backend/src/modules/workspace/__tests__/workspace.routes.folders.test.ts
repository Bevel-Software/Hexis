import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
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
  grantInExtractedFile: async () => null,
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
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folders-never-vanish-'));
  const workspaceId = workspaceIdForBranch('feature-folders');
  const workspaceDir = path.join(root, workspaceId);
  // The inner `.git` lets the service accept the workspace without cloning.
  await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
  const workspaceService = new WorkspaceService(root, 'https://example.invalid/kb.git', KB, new NodeFs());
  await workspaceService.getWorkspacePath(workspaceId);

  const releaseLock = vi.fn(async () => undefined as never);
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: {} as never })),
    releaseLock,
    releaseLockNoCommit: vi.fn(async () => undefined as never),
  } as unknown as IWorkflowService;

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
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      allowAll,
      KB,
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
});
