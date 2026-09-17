import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * Contract test for the creator read-grant hooks on the creation routes:
 * PUT /file (frontmatter transform + subtree seed), POST /directory (subtree
 * seed before the .gitkeep cycle), POST /unzip (in-place grant per extracted
 * file). The planner itself is unit-tested in creator-access.test.ts — here
 * it's mocked to return canned plans and the assertion is on what the route
 * writes, locks, and invalidates.
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WS = 'feat-branch';
const KB = 'knowledge-base';

interface Harness {
  server: Server;
  baseUrl: string;
  writes: Array<{ path: string; content: string }>;
  /** The exact bytes each binary write (POST /upload) handed the service. */
  binaryWrites: Array<{ path: string; bytes: Buffer }>;
  lockedPaths: string[];
  writeFileMock: ReturnType<typeof vi.fn>;
  creatorAccess: {
    planForCreate: ReturnType<typeof vi.fn>;
    grantInExtractedFile: ReturnType<typeof vi.fn>;
    noteAccessFileWritten: ReturnType<typeof vi.fn>;
  };
}

async function makeHarness(opts: { extracted?: string[] } = {}): Promise<Harness> {
  const writes: Array<{ path: string; content: string }> = [];
  const lockedPaths: string[] = [];
  const binaryWrites: Array<{ path: string; bytes: Buffer }> = [];

  const writeFileMock = vi.fn(async (_id: string, p: string, content: string) => {
    writes.push({ path: p, content });
  });
  const workspaceService = {
    writeFile: writeFileMock,
    writeFileBinary: vi.fn(async (_id: string, p: string, data: Uint8Array) => {
      writes.push({ path: p, content: Buffer.from(data).toString('utf8') });
      binaryWrites.push({ path: p, bytes: Buffer.from(data) });
    }),
    createDirectory: vi.fn(async () => undefined),
    unzipFile: vi.fn(async () => ({ extracted: opts.extracted ?? [] })),
    // `PUT /file` runs its precondition, plan and write inside one turn for
    // the target path. Straight through here: what this file asserts is the
    // ORDER of the plan's writes and locks, which the real turn preserves.
    withPathTurn: vi.fn(async (_id: string, _p: string, op: () => Promise<unknown>) => op()),
  } as unknown as WorkspaceService;

  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async (_w: string, _b: string, p: string) => {
      lockedPaths.push(p);
      return { acquired: true, lock: { holderUserId: USER_ID, holderName: 'Alice' } };
    }),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
  } as unknown as IWorkflowService;

  const creatorAccess = {
    planForCreate: vi.fn(async () => null),
    grantInExtractedFile: vi.fn(async () => null),
    noteAccessFileWritten: vi.fn(),
  };

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER_ID;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      authService,
      workflowService,
      eventBus,
      {} as unknown as IAccessControl,
      KB,
        creatorAccess as unknown as ICreatorAccess,
      // Not exercised here — only `.bevelignore`'s tree visibility consults it.
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      new NodeFs(),
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    writes,
    binaryWrites,
    lockedPaths,
    writeFileMock,
    creatorAccess,
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('creator read-grant hooks on the creation routes', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  it('PUT /file with a frontmatter plan writes the transformed content in ONE write', async () => {
    h = await makeHarness();
    h.creatorAccess.planForCreate.mockResolvedValue({
      kind: 'frontmatter',
      apply: (c: string) => `---\nread: Alice <alice@example.com>\n---\n${c}`,
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(`${KB}/KnowledgeBase/new.md`)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '# New\n' }) },
    );
    expect(res.status).toBe(200);
    expect(h.creatorAccess.planForCreate).toHaveBeenCalledWith(
      WS, USER, `${KB}/KnowledgeBase/new.md`, 'file',
    );
    expect(h.writes).toEqual([
      { path: `${KB}/KnowledgeBase/new.md`, content: '---\nread: Alice <alice@example.com>\n---\n# New\n' },
    ]);
  });

  it('PUT /file with a seed plan writes the access.md under its own lock BEFORE the file', async () => {
    h = await makeHarness();
    const seedPath = `${KB}/KnowledgeBase/Mine/access.md`;
    h.creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const filePath = `${KB}/KnowledgeBase/Mine/doc.md`;
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'body' }) },
    );
    expect(res.status).toBe(200);
    expect(h.writes.map((w) => w.path)).toEqual([seedPath, filePath]);
    // The file content is untouched — the grant lives in the seeded access.md.
    expect(h.writes[1].content).toBe('body');
    expect(h.lockedPaths).toEqual([seedPath, filePath]);
    expect(h.creatorAccess.noteAccessFileWritten).toHaveBeenCalledWith(WS);
  });

  it('a failing seed never fails the creation itself', async () => {
    h = await makeHarness();
    h.creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: `${KB}/KnowledgeBase/Mine/access.md`,
      apply: () => 'seed',
    });
    // Only the seed write blows up; the file write succeeds.
    h.writeFileMock.mockImplementation(async (_id: string, p: string, content: string) => {
      if (p.endsWith('/access.md')) throw new Error('boom');
      h!.writes.push({ path: p, content });
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(`${KB}/KnowledgeBase/Mine/doc.md`)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'body' }) },
    );
    expect(res.status).toBe(200);
    expect(h.writes).toEqual([{ path: `${KB}/KnowledgeBase/Mine/doc.md`, content: 'body' }]);
  });

  it('POST /directory seeds the new folder access.md before the .gitkeep cycle', async () => {
    h = await makeHarness();
    const seedPath = `${KB}/KnowledgeBase/Projects/access.md`;
    h.creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const res = await fetch(`${h.baseUrl}/api/workspace/${WS}/directory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${KB}/KnowledgeBase/Projects` }),
    });
    expect(res.status).toBe(200);
    expect(h.creatorAccess.planForCreate).toHaveBeenCalledWith(
      WS, USER, `${KB}/KnowledgeBase/Projects`, 'dir',
    );
    // Seed written (and locked) before the .gitkeep lock cycle.
    expect(h.writes.map((w) => w.path)).toEqual([seedPath]);
    expect(h.lockedPaths[0]).toBe(seedPath);
    expect(h.lockedPaths[1]).toBe(`${KB}/KnowledgeBase/Projects/.gitkeep`);
  });

  it('POST /unzip splices the creator grant into extracted files that need one', async () => {
    const extracted = [`${KB}/KnowledgeBase/a.md`, `${KB}/KnowledgeBase/b.md`];
    h = await makeHarness({ extracted });
    h.creatorAccess.grantInExtractedFile.mockImplementation(
      async (_w: string, _u: unknown, p: string) =>
        p.endsWith('a.md') ? 'GRANTED CONTENT' : null,
    );
    const res = await fetch(`${h.baseUrl}/api/workspace/${WS}/unzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${KB}/KnowledgeBase/drop.zip` }),
    });
    expect(res.status).toBe(200);
    // a.md got rewritten with the granted content; b.md untouched.
    expect(h.writes).toEqual([{ path: `${KB}/KnowledgeBase/a.md`, content: 'GRANTED CONTENT' }]);
  });

  it('POST /upload transforms an uploaded .md through the frontmatter plan', async () => {
    h = await makeHarness();
    h.creatorAccess.planForCreate.mockResolvedValue({
      kind: 'frontmatter',
      apply: (c: string) => `---\nread: Alice <alice@example.com>\n---\n${c}`,
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WS}/upload?path=${encodeURIComponent(`${KB}/KnowledgeBase/up.md`)}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: '# Uploaded\n' },
    );
    expect(res.status).toBe(200);
    expect(h.writes).toEqual([
      { path: `${KB}/KnowledgeBase/up.md`, content: '---\nread: Alice <alice@example.com>\n---\n# Uploaded\n' },
    ]);
  });
});

describe('POST /upload is where new bytes of any kind arrive', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  it('lands a text file, a document, an image and a zip byte-for-byte', async () => {
    h = await makeHarness();
    const files = [
      { name: 'notes.md', bytes: Buffer.from('# Notes\n') },
      // A zip container with a NUL and a high byte: what a .pptx looks like on the wire.
      { name: 'deck.pptx', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]) },
      { name: 'logo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe]) },
      { name: 'bundle.zip', bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0xc3, 0x28]) },
    ];
    for (const f of files) {
      const path = `${KB}/KnowledgeBase/${f.name}`;
      const res = await fetch(`${h.baseUrl}/api/workspace/${WS}/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: f.bytes,
      });
      expect(res.status, f.name).toBe(200);
    }
    expect(h.binaryWrites.map((w) => w.path)).toEqual(files.map((f) => `${KB}/KnowledgeBase/${f.name}`));
    for (const [i, f] of files.entries()) {
      // Never decoded as text on the way: invalid UTF-8 would not survive a round trip.
      expect(h.binaryWrites[i].bytes.equals(f.bytes), f.name).toBe(true);
    }
  });
});
