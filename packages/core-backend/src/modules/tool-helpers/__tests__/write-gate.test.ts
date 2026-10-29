import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { READ_ONLY_CODE, type IWriteAccess } from '../../write-access/index.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import type { ResolveToolContext } from '../tool-context.js';

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

describe('the tool layer', () => {
  /**
   * One tool, mounted the way the server mounts it and called over HTTP: a
   * parsed body, then an auth step that does not wait for anything, then the
   * handler. A request closes once its body has been read, so only a real
   * request shows what the handler makes of that.
   */
  async function mounted(writeAccess: IWriteAccess, write: boolean) {
    const resolve = (async () => ({})) as unknown as ResolveToolContext;
    const handler = vi.fn(async () => ({ done: true }));
    const closed = { count: 0 };
    const app = express();
    app.use(express.json());
    app.use((req: Request, res: Response, next) => {
      req.toolAuth = { source: 'external', userId: 'u1', scope: 'write' } as Request['toolAuth'];
      res.on('close', () => {
        closed.count += 1;
      });
      next();
    });
    app.post('/api/agent/tools/a_tool', createToolHandlerFactory(resolve, writeAccess)(handler as never, { write }));
    const url = `${await listen(app)}/api/agent/tools/a_tool`;
    const post = (signal?: AbortSignal) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal });
    return { post, handler, closed };
  }

  it('refuses a write tool while the deployment is read-only', async () => {
    const { post, handler } = await mounted(readOnly, true);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_MESSAGE, code: READ_ONLY_CODE });
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * The verdict is awaited, and by then the request has closed: its body was
   * read. Taken for the client leaving, that left every write tool on a
   * deployment with a port unanswered, for as long as the caller would wait.
   */
  it('answers a write tool the port allows, with the client still there', async () => {
    const { post, handler } = await mounted({ canWrite: async () => ({ ok: true }) }, true);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not run a write tool whose client left while the verdict was awaited', async () => {
    const asked = { count: 0 };
    let allow: () => void = () => undefined;
    const { post, handler, closed } = await mounted(
      {
        canWrite: () => {
          asked.count += 1;
          return new Promise((resolve) => {
            allow = () => resolve({ ok: true });
          });
        },
      },
      true,
    );
    const leaving = new AbortController();
    const call = post(leaving.signal).catch(() => undefined);
    await vi.waitFor(() => expect(asked.count).toBe(1));
    leaving.abort();
    await call;
    await vi.waitFor(() => expect(closed.count).toBe(1));
    allow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
  });

  it('still runs a read tool', async () => {
    const { post, handler } = await mounted(readOnly, false);
    expect((await post()).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
