import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/index.js';
import type { ICreatorAccess } from '../../access-model/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { AuthService } from '../../auth/index.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ArchiveLanding, ArchiveLandingFor, WorkspaceService } from '../workspace.service.js';

/**
 * `POST /unzip` lands an archive through the landing it is handed.
 *
 * The route used to construct the lock-aware filesystem itself. The
 * composition root makes it now and hands the route a factory, so what an
 * extraction lands through is decided in one place. What the landing then does
 * with the files is `unzip-lands-as-one-commit.test.ts`'s to pin.
 */

const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';

describe('POST /workspace/:id/unzip takes its landing from the composition root', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function mount(archiveLandingFor?: ArchiveLandingFor) {
    const unzipFile = vi.fn(async () => ({ destination: `${KB}/Data`, extracted: [], skipped: [] }));
    const workspaceService = { unzipFile } as unknown as WorkspaceService;
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
        {} as unknown as IVersionControlService,
        { emit: vi.fn() } as unknown as VersionControlEventBus,
        { canRead: async () => true } as unknown as IAccessControl,
        testKbContext({ kbDirName: KB }),
        { planForCreate: async () => null, noteAccessFileWritten: () => {} } as unknown as ICreatorAccess,
        { isAdmin: async () => true } as unknown as IAdminAccessService,
        realDisk(),
        undefined,
        undefined,
        archiveLandingFor,
      ),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const unzip = () =>
      fetch(`${baseUrl}/api/workspace/${WS}/unzip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `${KB}/Data/a.zip` }),
      });
    return { unzip, unzipFile };
  }

  it('hands the extraction the landing made for this person on this workspace', async () => {
    const landing: ArchiveLanding = { writeFiles: vi.fn(async () => null) };
    const made = vi.fn<ArchiveLandingFor>(async () => landing);
    const { unzip, unzipFile } = await mount(made);

    const res = await unzip();

    expect(res.status).toBe(200);
    expect(made).toHaveBeenCalledTimes(1);
    expect(made).toHaveBeenCalledWith(WS, WS, USER);
    expect(unzipFile).toHaveBeenCalledTimes(1);
    expect((unzipFile.mock.calls[0] as unknown[])[4]).toBe(landing);
  });

  it('answers 501 and extracts nothing when it was handed no landing', async () => {
    const { unzip, unzipFile } = await mount(undefined);

    const res = await unzip();

    expect(res.status).toBe(501);
    expect(unzipFile).not.toHaveBeenCalled();
  });
});
