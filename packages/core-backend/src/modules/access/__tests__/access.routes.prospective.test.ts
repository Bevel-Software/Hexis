import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl, ProspectiveHolders } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { createAccessRoutes } from '../access.routes.js';
import { WorkflowDomainError } from '../../../shared/domain-errors.js';

/**
 * HTTP contract for `GET /access/prospective` — what the move confirmation
 * asks so it can name who loses and who gains access. The route's own job is
 * to derive the destination PATH from the destination FOLDER, gate on read of
 * the file being moved, and flatten the resolver's holder lists into named
 * principals. The resolution itself is the service's.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';

/** Engineering reads and writes Legal; Product reads Sales, and Ali is on it by name. */
const HOLDERS: ProspectiveHolders = {
  before: {
    read: { principals: [{ name: 'Engineering', kind: 'group' }], roles: ['Engineering'], users: [] },
    write: { principals: [{ name: 'Engineering', kind: 'group' }], roles: ['Engineering'], users: [] },
  },
  after: {
    read: {
      principals: [{ name: 'Product', kind: 'group' }],
      roles: ['Product'],
      users: [{ name: 'Ali Raza', email: 'ali@bevel.software' }],
    },
    write: { principals: [], roles: [], users: [] },
  },
};

interface Harness {
  server: Server;
  baseUrl: string;
  canRead: ReturnType<typeof vi.fn>;
  prospectiveHolders: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: { canRead?: boolean } = {}): Promise<Harness> {
  const canRead = vi.fn(async () => opts.canRead ?? true);
  const prospectiveHolders = vi.fn(async () => HOLDERS);
  const accessControl = { canRead, prospectiveHolders } as unknown as IAccessControl;

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
      {} as unknown as WorkspaceService,
      { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
      {} as unknown as WorkflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      {} as unknown as Database,
      KB,
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, canRead, prospectiveHolders };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('GET /access/prospective', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const get = (query: string) =>
    fetch(`${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/prospective?${query}`);

  it('resolves the file where it is and where the destination folder would put it', async () => {
    h = await makeHarness();

    const res = await get(
      `from=${encodeURIComponent('Knowledge/Legal/contract.md')}&toDir=${encodeURIComponent('Knowledge/Sales')}`,
    );

    expect(res.status).toBe(200);
    // The destination PATH is the route's own derivation — the file keeps its
    // name, so the caller never gets to name the path it resolves against.
    expect(h.prospectiveHolders).toHaveBeenCalledWith(
      WS,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );
    expect(await res.json()).toEqual({
      before: {
        read: [{ kind: 'group', name: 'Engineering' }],
        write: [{ kind: 'group', name: 'Engineering' }],
      },
      after: {
        read: [
          { kind: 'group', name: 'Product' },
          { kind: 'person', name: 'Ali Raza', email: 'ali@bevel.software' },
        ],
        write: [],
      },
    });
  });

  it('strips the workspace-relative kb prefix from both ends', async () => {
    h = await makeHarness();

    await get(
      `from=${encodeURIComponent(`${KB}/Knowledge/Legal/contract.md`)}&toDir=${encodeURIComponent(`${KB}/Knowledge/Sales`)}`,
    );

    expect(h.prospectiveHolders).toHaveBeenCalledWith(
      WS,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );
  });

  it('treats an empty destination as the repo root, not a missing parameter', async () => {
    h = await makeHarness();

    const res = await get(`from=${encodeURIComponent('Knowledge/Legal/contract.md')}&toDir=`);

    expect(res.status).toBe(200);
    expect(h.prospectiveHolders).toHaveBeenCalledWith(WS, 'Knowledge/Legal/contract.md', 'contract.md');
  });

  it('refuses a caller who cannot read the file being moved, resolving nothing', async () => {
    h = await makeHarness({ canRead: false });

    const res = await get(`from=${encodeURIComponent('Knowledge/Legal/contract.md')}&toDir=Knowledge`);

    expect(res.status).toBe(403);
    expect(h.prospectiveHolders).not.toHaveBeenCalled();
  });

  it('400s a missing `from` or `toDir`', async () => {
    h = await makeHarness();

    expect((await get('toDir=Knowledge')).status).toBe(400);
    expect((await get('from=&toDir=Knowledge')).status).toBe(400);
    expect((await get(`from=${encodeURIComponent('Knowledge/a.md')}`)).status).toBe(400);
    expect(h.prospectiveHolders).not.toHaveBeenCalled();
  });

  it('refuses a path that would escape the KB repo', async () => {
    h = await makeHarness();

    for (const query of [
      `from=${encodeURIComponent('../secrets.md')}&toDir=Knowledge`,
      `from=${encodeURIComponent('Knowledge/a.md')}&toDir=${encodeURIComponent('../elsewhere')}`,
      `from=${encodeURIComponent('/etc/passwd')}&toDir=Knowledge`,
    ]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(h.prospectiveHolders).not.toHaveBeenCalled();
  });

  it('answers a failed resolver with a clean 500 and no internals', async () => {
    h = await makeHarness();
    h.prospectiveHolders.mockRejectedValueOnce(new Error('resolver exploded reading /srv/kb/roles.yaml'));

    const res = await get(`from=${encodeURIComponent('Knowledge/a.md')}&toDir=Knowledge`);

    // The dialog's fallback — the one-sentence form plus "Couldn't work out
    // the access change." with Move still enabled — rests on the request
    // FINISHING when the resolver fails. A handler that threw past its catch
    // would hang the fetch until the 2s budget instead, and a raw message
    // would leak a server path to a caller who asked about one file.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error.' });
  });

  it('refuses a folder source the way the resolver does, without guessing', async () => {
    h = await makeHarness();
    h.prospectiveHolders.mockRejectedValueOnce(
      new WorkflowDomainError('prospective access answers for a file, not a folder', 400),
    );

    const res = await get(`from=${encodeURIComponent('Knowledge/Legal')}&toDir=Knowledge`);

    expect(res.status).toBe(400);
  });

  it('falls back to the name-only roles list when the resolver omits kinds', async () => {
    h = await makeHarness();
    h.prospectiveHolders.mockResolvedValueOnce({
      before: { read: { roles: ['Engineering'], users: [] }, write: { roles: [], users: [] } },
      after: { read: { roles: [], users: [] }, write: { roles: [], users: [] } },
    });

    const res = await get(`from=${encodeURIComponent('Knowledge/a.md')}&toDir=Knowledge`);

    expect((await res.json()).before.read).toEqual([{ kind: 'role', name: 'Engineering' }]);
  });
});
