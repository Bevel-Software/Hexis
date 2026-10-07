import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { WorkspaceService } from '../workspace.service.js';

/**
 * The folder download over the REAL resolver and the REAL zip builder.
 *
 * `download` on a folder let the caller ask for its zip, and the zip then
 * packed every file under the folder: no file was judged against its own
 * rules, so a caller got files whose frontmatter denied them `download`, files
 * whose frontmatter denied them `read`, and whole sub-folders a nested
 * access.md closed to them — files the per-file route refused and the file
 * tree never showed (found 2026-10-07). The four cases below are the ones
 * that were verified leaking; each must now be absent from the archive, and
 * the one the caller may download must still be in it.
 */

const KB = 'knowledge-base';
const WORKSPACE_ID = 'target-company-state';

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

let caller = { id: 'user-1', email: 'ana@x.io', name: 'Ana' };

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
`;

/** The folder Ana may download, with the files the rules below decide over. */
const FILES: Record<string, string> = {
  'Shared/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
  'Shared/Open.md': '# open\n',
  'Shared/Node-Deny-Download.md': '---\ndownload:\n  - deny Ana <ana@x.io>\n---\n# no save\n',
  'Shared/Node-Deny-Read.md': '---\nread:\n  - deny Ana <ana@x.io>\n---\n# hidden\n',
  'Shared/Inner/access.md': '---\n---\nread:\n  - deny Ana <ana@x.io>\ndownload:\n  - deny Ana <ana@x.io>\n',
  'Shared/Inner/Plan.md': '# hidden plan\n',
};

interface Harness {
  server: Server;
  baseUrl: string;
}

describe('GET /folder/zip judges every file it packs (real resolver, real zip)', () => {
  let root: string;
  let h: Harness | null = null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-zip-access-'));
    caller = { id: 'user-1', email: 'ana@x.io', name: 'Ana' };
  });

  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve, reject) => h!.server.close((e) => (e ? reject(e) : resolve())));
      h = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeHarness(files: Record<string, string>): Promise<Harness> {
    const workspaceDir = path.join(root, WORKSPACE_ID);
    const repo = path.join(workspaceDir, KB);
    // A `.git` folder is what makes the service adopt the clone without cloning.
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    for (const [rel, contents] of Object.entries({ 'roles.yaml': ROLES_YAML, ...files })) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }

    const workspaceService = new WorkspaceService(
      root,
      'https://example.invalid/kb.git',
      testKbContext({ kbDirName: KB }),
      new NodeFs(),
    );
    const accessControl = new AccessControlService(workspaceService, KB, new NodeFs());
    const authService = { getUserById: async () => caller } as unknown as AuthService;

    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = caller.id;
      next();
    });
    app.use(
      '/api',
      createWorkspaceRoutes(
        workspaceService,
        authService,
        {} as unknown as IWorkflowService,
        {} as unknown as WorkflowEventBus,
        accessControl,
        testKbContext({ kbDirName: KB }),
        stubCreatorAccess,
        { isAdmin: async () => false } as unknown as IAdminAccessService,
        new NodeFs(),
      ),
    );
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  const zipOf = (base: string, folder: string) =>
    fetch(`${base}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent(folder)}&download=1`);

  const entriesOf = async (res: Response) =>
    new AdmZip(Buffer.from(await res.arrayBuffer()))
      .getEntries()
      .map((e) => e.entryName)
      .sort();

  it('packs the file the caller may download, and none of the ones their own rules withhold', async () => {
    h = await makeHarness(FILES);

    const res = await zipOf(h.baseUrl, `${KB}/Shared`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(await entriesOf(res)).toEqual(['Shared/Open.md', 'Shared/access.md']);
    // One file Ana can see but not save is counted; the two she cannot see
    // and the closed folder are not — the count says nothing the tree does not.
    expect(res.headers.get('x-withheld-files')).toBe('1');
  });

  it('the per-file route agrees on every one of them', async () => {
    h = await makeHarness(FILES);
    const raw = (p: string) =>
      fetch(`${h!.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent(`${KB}/${p}`)}&download=1`);

    expect((await raw('Shared/Open.md')).status).toBe(200);
    expect((await raw('Shared/Node-Deny-Download.md')).status).toBe(403);
    expect((await raw('Shared/Node-Deny-Read.md')).status).toBe(403);
    expect((await raw('Shared/Inner/Plan.md')).status).toBe(403);
  });

  it('still refuses the folder itself to someone with no download grant', async () => {
    h = await makeHarness(FILES);
    caller = { id: 'user-2', email: 'mallory@x.io', name: 'Mallory' };

    const res = await zipOf(h.baseUrl, `${KB}/Shared`);

    expect(res.status).toBe(403);
  });

  it('answers an empty archive, not an error, when every file inside is withheld', async () => {
    h = await makeHarness({
      'Shared/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
      'Shared/Only.md': '---\ndownload:\n  - deny Ana <ana@x.io>\n---\n# no save\n',
    });

    const res = await zipOf(h.baseUrl, `${KB}/Shared`);

    expect(res.status).toBe(200);
    expect(await entriesOf(res)).toEqual(['Shared/access.md']);
    expect(res.headers.get('x-withheld-files')).toBe('1');
  });
});
