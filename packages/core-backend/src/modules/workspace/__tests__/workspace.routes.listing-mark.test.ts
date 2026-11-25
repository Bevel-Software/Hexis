import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/index.js';
import type { ICreatorAccess } from '../../access-model/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { AuthService } from '../../auth/index.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * What `PUT /file` says about the tree in the events it emits.
 *
 * Every write emits `fs-tree-changed`, and every open file explorer answers
 * that event by asking for the whole tree. A save that only edited a file
 * that was already there cannot have changed the tree, and says so
 * (`listingUnchanged`); anything that can have changed it says nothing.
 */

const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';
const PAGE = '---\nread: [Sales]\n---\n\n# Name\nA page\n';

describe('PUT /workspace/:id/file — what its events say about the tree', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let emitted: { kind: string; listingUnchanged?: true; path?: string }[];
  let heldBy: string | null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-listing-mark-'));
    await fs.mkdir(path.join(root, KB, 'Data'), { recursive: true });
    await fs.writeFile(path.join(root, KB, 'Data', 'page.md'), PAGE);
    await fs.writeFile(path.join(root, KB, 'Data', 'access.md'), 'read: [Sales]\n');
    await fs.writeFile(path.join(root, KB, 'Data', 'table.csv'), 'a,b\n');
    await fs.writeFile(path.join(root, KB, 'Data', 'notes.txt'), '---\nread: [Sales]\n---\nA note\n');
    emitted = [];
    heldBy = null;
    const workspaceService = {
      getWorkspacePath: async () => root,
      withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
      writeFile: async (_id: string, p: string, content: string) => {
        await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
        await fs.writeFile(path.join(root, p), content);
      },
      // An archive of two files, one of them already there: both are written
      // before the route locks either, as the real extraction does.
      unzipFile: async () => {
        await fs.writeFile(path.join(root, KB, 'Data', 'page.md'), `${PAGE}\nFrom the archive.\n`);
        await fs.writeFile(path.join(root, KB, 'Data', 'unpacked.md'), '# Name\nUnpacked\n');
        return { extracted: [`${KB}/Data/page.md`, `${KB}/Data/unpacked.md`], skipped: [] };
      },
    } as unknown as WorkspaceService;
    const versionControlService = {
      getLock: vi.fn(async () => (heldBy ? { holderUserId: heldBy } : null)),
      acquireLock: vi.fn(async () => ({ acquired: true, lock: { holderUserId: USER.id, holderName: 'Alice' } })),
      releaseLock: vi.fn(async () => null),
      releaseLockNoCommit: vi.fn(async () => undefined),
      releaseLockUntouched: vi.fn(async () => undefined),
    } as unknown as IVersionControlService;
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
        versionControlService,
        { emit: (e: { kind: string }) => void emitted.push(e) } as unknown as VersionControlEventBus,
        { canRead: async () => true, canReadBatch: async (_w: string, _e: string, ps: string[]) => new Map(ps.map((p) => [p, true])) } as unknown as IAccessControl,
        testKbContext({ kbDirName: KB }),
        { planForCreate: async () => null, noteAccessFileWritten: () => {} } as unknown as ICreatorAccess,
        { isAdmin: async () => true } as unknown as IAdminAccessService,
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
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function save(file: string, content: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(`${KB}/${file}`)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
  }
  const treeEvents = () => emitted.filter((e) => e.kind === 'fs-tree-changed');
  /** The one tree event of a save, when it says nothing about the listing. */
  const expectOneUnmarked = () => {
    expect(treeEvents()).toHaveLength(1);
    expect(treeEvents()[0]).not.toHaveProperty('listingUnchanged');
  };

  it('an unzip, whose files are on disk before their locks, says nothing: the tree is asked for', async () => {
    // The archive's entries replace nothing here, yet by the time each file
    // meets its lock it is on disk, so "the same before and after" would hold.
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/unzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${KB}/Data/pack.zip` }),
    });
    expect(res.status).toBe(200);
    expect(treeEvents().length).toBeGreaterThan(0);
    for (const event of treeEvents()) expect(event).not.toHaveProperty('listingUnchanged');
  });

  it('a save of the body of an existing page says the listing is unchanged', async () => {
    await save('Data/page.md', `${PAGE}\nMore.\n`);
    expect(treeEvents()).toEqual([expect.objectContaining({ listingUnchanged: true })]);
  });

  it('a save of an existing file of another kind says so too', async () => {
    await save('Data/table.csv', 'a,b\n1,2\n');
    expect(treeEvents()).toEqual([expect.objectContaining({ listingUnchanged: true })]);
  });

  it('a save of the body of a file of another kind with its own access entries says the listing is unchanged', async () => {
    await save('Data/notes.txt', '---\nread: [Sales]\n---\nA note, longer\n');
    expect(treeEvents()).toEqual([expect.objectContaining({ listingUnchanged: true })]);
  });

  // The access gate reads a file's own entries whatever its kind: a .txt whose `---` block
  // changes may now be hidden from someone who could read it, so the tree must be asked for.
  it('a save that changed the own access entries of a file of another kind says nothing', async () => {
    await save('Data/notes.txt', '---\nread: [Finance]\n---\nA note\n');
    expectOneUnmarked();
  });

  it('a new file says nothing, so the tree is asked for', async () => {
    await save('Data/new.md', '# Name\nNew\n');
    expectOneUnmarked();
  });

  it('a save that changed the page\'s own access entries says nothing', async () => {
    await save('Data/page.md', PAGE.replace('[Sales]', '[Sales, Finance]'));
    expectOneUnmarked();
  });

  it('a save that changed an entry behind a padded fence says nothing', async () => {
    const padded = '--- \nread: [Sales]\n--- \n\n# Name\nA page\n';
    await fs.writeFile(path.join(root, KB, 'Data', 'page.md'), padded);
    await save('Data/page.md', padded.replace('[Sales]', '[Finance]'));
    expectOneUnmarked();
  });

  it('a save of an access.md says nothing', async () => {
    await save('Data/access.md', 'read: [Finance]\n');
    expectOneUnmarked();
  });

  it('an editor that holds the lock saves to disk: both events carry the same answer', async () => {
    heldBy = USER.id;
    await save('Data/page.md', `${PAGE}\nMore.\n`);
    expect(emitted.map((e) => [e.kind, e.listingUnchanged])).toEqual([
      ['file-changed', true],
      ['fs-tree-changed', true],
    ]);
    emitted.length = 0;
    await save('Data/brand-new.md', '# Name\nNew\n');
    expect(emitted.map((e) => [e.kind, e.listingUnchanged])).toEqual([
      ['file-changed', undefined],
      ['fs-tree-changed', undefined],
    ]);
  });
});
