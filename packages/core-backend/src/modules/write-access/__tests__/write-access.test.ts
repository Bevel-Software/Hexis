import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import {
  alwaysWritable,
  createWriteAccessRoutes,
  createWriteGateMiddleware,
  isAlwaysWritable,
  READ_ONLY_CODE,
  type IWriteAccess,
} from '../write-access.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ResolveToolContext } from '../../tool-helpers/tool-context.js';

const READ_ONLY_MESSAGE = 'This workspace has 5 people switched on and room for 3.';
const readOnly: IWriteAccess = { canWrite: async () => ({ ok: false, message: READ_ONLY_MESSAGE }) };

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
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
    ['POST', '/api/sync'],
    ['POST', '/api/setup/settings'],
    ['POST', '/api/workspace/w1/access/batch'],
    ['POST', '/api/workspace/w1/workflow/locks/heartbeat'],
    ['POST', '/api/events/s1/focus'],
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
    // A look-alike of an allowed path is not that path.
    ['POST', '/api/admin/accountsx'],
    ['POST', '/api/workspace/w1/access/batch/extra'],
    // A route nobody listed is refused by default.
    ['POST', '/api/some-new-route'],
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

describe('the tool layer', () => {
  function call(writeAccess: IWriteAccess, write: boolean) {
    const resolve = vi.fn(async () => ({})) as unknown as ResolveToolContext;
    const handler = vi.fn(async () => ({ done: true }));
    const toolHandler = createToolHandlerFactory(resolve, writeAccess);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const req = {
      toolAuth: { source: 'external', userId: 'u1', scope: 'write' },
      body: {},
      on: vi.fn(),
    } as unknown as Request;
    const res = { status, json, writableEnded: false } as unknown as Response;
    return { run: toolHandler(handler as never, { write })(req, res), handler, status, json };
  }

  it('refuses a write tool while the deployment is read-only', async () => {
    const { run, handler, status, json } = call(readOnly, true);
    await run;
    expect(handler).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: READ_ONLY_MESSAGE, code: READ_ONLY_CODE });
  });

  it('still runs a read tool', async () => {
    const { run, handler } = call(readOnly, false);
    await run;
    expect(handler).toHaveBeenCalledTimes(1);
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
