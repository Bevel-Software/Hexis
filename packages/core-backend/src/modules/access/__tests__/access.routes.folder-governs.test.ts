import { createHash } from 'node:crypto';
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
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { createAccessRoutes } from '../access.routes.js';
import { AccessMutationError, AccessMutationService } from '../access-mutation.service.js';

/**
 * A file that cannot carry frontmatter is never written by an access mutation.
 *
 * The bug: a file-level grant spliced a YAML block into whatever the file was,
 * so sharing a PDF or a deck corrupted it (blank preview) and the grant never
 * resolved. Grant, revoke and deny-here now answer 422 `folder-governs-access`
 * naming the folder, and the file's bytes on disk are untouched — asserted by
 * hash, against a workspace backed by a real temp directory so a write would
 * show up as changed bytes, not just a spy call.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature';
const KB = 'knowledge-base';
const ALICE = { kind: 'user' as const, email: 'bob@bevel.software', displayName: 'Bob' };

/** Bytes shaped like each kind, each with non-UTF-8 content a text round-trip would mangle. */
const BINARIES: Record<string, Buffer> = {
  'Sales/Report.pdf': Buffer.concat([
    Buffer.from('%PDF-1.7\n%'),
    Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]),
    Buffer.from('\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
    Buffer.from([0x00, 0xff, 0xfe, 0x80]),
    Buffer.from('\n%%EOF\n'),
  ]),
  'Sales/Deck.pptx': Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
    Buffer.from('[Content_Types].xml'),
    Buffer.from([0x00, 0x9c, 0xff, 0x8b, 0x00, 0x00]),
  ]),
  'Sales/Logo.png': Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xd8,
  ]),
  'Sales/blob': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81]),
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('access mutations on a file that cannot carry frontmatter', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let readFile: ReturnType<typeof vi.fn>;
  let writeFile: ReturnType<typeof vi.fn>;
  let acquireLock: ReturnType<typeof vi.fn>;
  let mutation: AccessMutationService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-folder-governs-'));
    for (const [rel, bytes] of Object.entries(BINARIES)) {
      const abs = path.join(root, KB, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
    }
    await fs.writeFile(path.join(root, KB, 'Sales/Deal.md'), '---\nnodeType: process\n---\n# Deal\n');

    readFile = vi.fn(async (_id: string, wsRel: string) => fs.readFile(path.join(root, wsRel), 'utf-8'));
    writeFile = vi.fn(async (_id: string, wsRel: string, content: string) =>
      fs.writeFile(path.join(root, wsRel), content, 'utf-8'),
    );
    const workspaceService = {
      getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
      readFile,
      writeFile,
    } as unknown as WorkspaceService;

    const accessControl = {
      canRead: vi.fn(async () => true),
      canWrite: vi.fn(async () => true),
      canDownload: vi.fn(async () => false),
      canOwner: vi.fn(async () => true),
      grantSources: vi.fn(async () => ({})),
      invalidate: vi.fn(),
      kbPrincipals: vi.fn(async () => ({ roles: [], groups: [], people: [] })),
      eligibleWriters: vi.fn(async () => ({ roles: [], users: [] })),
      eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: [] })),
      eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
      eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
    } as unknown as IAccessControl;
    mutation = new AccessMutationService(workspaceService, accessControl, KB);

    acquireLock = vi.fn(async () => ({ acquired: true, lock: {} }));
    const workflowService = {
      getLock: vi.fn(async () => null),
      acquireLock,
      releaseLock: vi.fn(async () => undefined),
      releaseLockNoCommit: vi.fn(async () => undefined),
    } as unknown as WorkflowService;

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
        workflowService,
        { emit: vi.fn() } as unknown as WorkflowEventBus,
        {} as unknown as Database,
        KB,
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

  const MUTATIONS = [
    { name: 'grant', route: 'grant', extra: { verb: 'download' } },
    { name: 'revoke', route: 'revoke', extra: {} },
    { name: 'deny-here', route: 'revoke', extra: { mode: 'deny-here', verb: 'read' } },
  ] as const;

  for (const rel of Object.keys(BINARIES)) {
    for (const m of MUTATIONS) {
      it(`${m.name} on ${rel} → 422 folder-governs-access, bytes unchanged, never read, locked or written`, async () => {
        const abs = path.join(root, KB, rel);
        const before = sha(await fs.readFile(abs));

        const res = await post(m.route, { path: `${KB}/${rel}`, kind: 'file', principal: ALICE, ...m.extra });

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
          error: "This file's access comes from its folder. Manage access on Sales instead.",
          kind: 'folder-governs-access',
          folder: 'Sales',
        });
        expect(sha(await fs.readFile(abs))).toBe(before);
        expect(readFile).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(acquireLock).not.toHaveBeenCalled();
      });

      it(`the mutation service itself refuses ${m.name} on ${rel} without opening it`, async () => {
        const abs = path.join(root, KB, rel);
        const before = sha(await fs.readFile(abs));
        const call =
          m.name === 'grant'
            ? mutation.grant(WS, 'file', rel, 'download', ALICE)
            : m.name === 'revoke'
              ? mutation.revoke(WS, 'file', rel, ALICE, USER.email)
              : mutation.denyHere(WS, 'file', rel, ALICE, 'read');

        const err = await call.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AccessMutationError);
        expect((err as AccessMutationError).status).toBe(422);
        expect((err as AccessMutationError).payload).toEqual({ kind: 'folder-governs-access', folder: 'Sales' });
        expect(sha(await fs.readFile(abs))).toBe(before);
        expect(readFile).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
      });
    }
  }

  it('a file at the repo root names the whole workspace', async () => {
    await fs.writeFile(path.join(root, KB, 'Root.pdf'), BINARIES['Sales/Report.pdf']);
    const res = await post('grant', { path: `${KB}/Root.pdf`, kind: 'file', verb: 'read', principal: ALICE });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "This file's access comes from its folder. Manage access on the whole workspace instead.",
      kind: 'folder-governs-access',
      folder: '',
    });
  });

  it('the read view names the governing folder for a binary, and not for a note', async () => {
    const get = (rel: string) =>
      fetch(`${baseUrl}/api/workspace/${encodeURIComponent(WS)}/access?path=${encodeURIComponent(`${KB}/${rel}`)}&kind=file`);
    const binary = await (await get('Sales/Deck.pptx')).json();
    expect(binary.governedByFolder).toBe('Sales');
    expect(binary.readers).toBeDefined();
    const note = await (await get('Sales/Deal.md')).json();
    expect(note).not.toHaveProperty('governedByFolder');
  });

  it('a Markdown note still takes a file-level grant (the harness does see writes)', async () => {
    const res = await post('grant', {
      path: `${KB}/Sales/Deal.md`,
      kind: 'file',
      verb: 'read',
      principal: ALICE,
    });
    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(root, KB, 'Sales/Deal.md'), 'utf-8')).toContain('bob@bevel.software');
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it('a folder target is unaffected by the file predicate', async () => {
    const res = await post('grant', { path: `${KB}/Sales`, kind: 'folder', verb: 'read', principal: ALICE });
    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(root, KB, 'Sales/access.md'), 'utf-8')).toContain('bob@bevel.software');
  });
});
