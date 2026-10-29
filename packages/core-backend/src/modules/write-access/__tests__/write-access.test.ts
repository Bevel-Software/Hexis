import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  alwaysWritable,
  createWriteAccessRoutes,
  createWriteGateMiddleware,
  isAlwaysWritable,
  READ_ONLY_CODE,
  type IWriteAccess,
} from '../write-access.js';

const READ_ONLY_MESSAGE = 'This workspace has 5 people switched on and room for 3.';
const readOnly: IWriteAccess = { canWrite: async () => ({ ok: false, message: READ_ONLY_MESSAGE }) };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('isAlwaysWritable', () => {
  it.each([
    ['GET', '/api/workspace/w1/file'],
    ['HEAD', '/api/workspace/w1/file'],
    ['POST', '/health'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/mcp'],
    ['POST', '/api/mcp/external-api-keys'],
    ['POST', '/api/agent/tools/write_file'],
    ['POST', '/api/admin/accounts'],
    ['POST', '/api/admin/accounts/u1/deactivate'],
    ['DELETE', '/api/admin/accounts/u1'],
    ['POST', '/api/invitations'],
    ['POST', '/api/sync'],
    ['POST', '/api/setup/settings'],
    ['POST', '/api/workspace/w1/access/batch'],
    ['POST', '/api/workspace/w1/workflow/locks/heartbeat'],
    ['POST', '/api/events/s1/focus'],
    // The Atlassian connector's VIEW mint: it signs a token, changes nothing.
    ['POST', '/api/embed/token'],
    // The embed's lock signals, like the app's heartbeat: a held lock kept
    // or let go, no content changed.
    ['POST', '/api/embed/heartbeat'],
    ['POST', '/api/embed/cancel'],
  ])('lets %s %s through', (method, path) => {
    expect(isAlwaysWritable(method, path)).toBe(true);
  });

  it.each([
    ['PUT', '/api/workspace/w1/file'],
    ['DELETE', '/api/workspace/w1/file'],
    ['POST', '/api/workspace/w1/workflow/changes'],
    ['POST', '/api/workflow/change-requests/7/merge'],
    ['POST', '/api/workspace/w1/workflow/locks'],
    ['POST', '/api/plugins'],
    ['POST', '/api/admin/groups'],
    // The embed's own edits stay refused like every other write — taking the
    // lock included, since it is the first step of a save.
    ['POST', '/api/embed/save'],
    ['POST', '/api/embed/propose'],
    ['POST', '/api/embed/lock'],
    ['POST', '/api/embed/token/extra'],
    ['POST', '/api/embed/heartbeat/extra'],
    // A look-alike of an allowed path is not that path.
    ['POST', '/api/admin/accountsx'],
    ['POST', '/api/invitationsx'],
    ['POST', '/api/workspace/w1/access/batch/extra'],
    // A route nobody listed is refused by default.
    ['POST', '/api/some-new-route'],
    // The API root is inside the gated namespace too.
    ['POST', '/api'],
  ])('holds %s %s for the port', (method, path) => {
    expect(isAlwaysWritable(method, path)).toBe(false);
  });

  it("lets the host's own paths through", () => {
    expect(isAlwaysWritable('PUT', '/api/cloud/workspace/billing/seats', ['/api/cloud/workspace/billing'])).toBe(true);
    expect(isAlwaysWritable('PUT', '/api/cloud/workspace/sign-in/domains', ['/api/cloud/workspace/billing'])).toBe(false);
  });
});

describe('createWriteGateMiddleware', () => {
  function appWith(writeAccess: IWriteAccess) {
    const app = express();
    app.use(createWriteGateMiddleware(writeAccess));
    app.all('/{*any}', (_req, res) => {
      res.json({ reached: true });
    });
    return app;
  }

  it("refuses a change with the port's words and a code the app recognises", async () => {
    const base = await listen(appWith(readOnly));
    const res = await fetch(`${base}/api/workspace/w1/file`, { method: 'PUT' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_MESSAGE, code: READ_ONLY_CODE });
  });

  /**
   * The router matches a path whatever its letter case, so the gate has to
   * read it the same way: here the route is mounted as the server mounts
   * its own, under `/api`, and a spelling the gate did not recognise as
   * that namespace would reach it.
   */
  it('refuses a change however the path is cased, since the router matches it either way', async () => {
    const app = express();
    app.use(createWriteGateMiddleware(readOnly));
    const routes = express.Router();
    const wrote = vi.fn();
    routes.put('/workspace/:id/file', (_req, res) => {
      wrote();
      res.json({ wrote: true });
    });
    app.use('/api', routes);
    const base = await listen(app);
    for (const path of ['/api/workspace/w1/file', '/API/workspace/w1/file', '/Api/Workspace/w1/File']) {
      const res = await fetch(`${base}${path}`, { method: 'PUT' });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect(wrote).not.toHaveBeenCalled();
  });

  it('keeps an open route open however it is cased', async () => {
    const base = await listen(appWith(readOnly));
    expect((await fetch(`${base}/API/Auth/login`, { method: 'POST' })).status).toBe(200);
  });

  it('still serves reads, and the routes that sign people in and manage accounts', async () => {
    const base = await listen(appWith(readOnly));
    expect((await fetch(`${base}/api/workspace/w1/file`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/login`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/api/admin/accounts/u1/deactivate`, { method: 'POST' })).status).toBe(200);
  });

  it('does not ask the port about a request it lets through anyway', async () => {
    const canWrite = vi.fn(readOnly.canWrite);
    const base = await listen(appWith({ canWrite }));
    await fetch(`${base}/api/workspace/w1/file`);
    await fetch(`${base}/api/auth/login`, { method: 'POST' });
    expect(canWrite).not.toHaveBeenCalled();
  });

  it('lets a change through while the port says yes', async () => {
    const base = await listen(appWith({ canWrite: async () => ({ ok: true }) }));
    expect((await fetch(`${base}/api/workspace/w1/file`, { method: 'PUT' })).status).toBe(200);
  });

  it('lets a change through when the port itself fails, rather than freezing the workspace', async () => {
    const base = await listen(appWith({ canWrite: async () => Promise.reject(new Error('billing down')) }));
    expect((await fetch(`${base}/api/workspace/w1/file`, { method: 'PUT' })).status).toBe(200);
  });

  it('is a no-op on core, which is always writable', async () => {
    const base = await listen(appWith(alwaysWritable));
    expect((await fetch(`${base}/api/workspace/w1/file`, { method: 'PUT' })).status).toBe(200);
  });
});

describe('GET /write-access', () => {
  it("says whether the deployment can be changed, and the port's words when not", async () => {
    const app = express();
    app.use('/api', createWriteAccessRoutes(readOnly));
    const base = await listen(app);
    expect(await (await fetch(`${base}/api/write-access`)).json()).toEqual({ writable: false, message: READ_ONLY_MESSAGE });

    const open = express();
    open.use('/api', createWriteAccessRoutes(alwaysWritable));
    const openBase = await listen(open);
    expect(await (await fetch(`${openBase}/api/write-access`)).json()).toEqual({ writable: true });
  });
});
