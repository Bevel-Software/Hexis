import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInlineManualReader,
  createToolManualsAgentRoutes,
  type IToolManualService,
} from '../index.js';
// The refusal is the module's own: only its routes and this suite name it.
import { InlineManualRefusedError } from '../tool-manuals.routes.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../agent-scope/index.js';

/**
 * `createInlineManualReader` answers what `GET /tools/:slug/manual` answers,
 * for the same caller. The hosted MCP endpoint calls the reader where it used
 * to send that request, so each case here asks both, over one manual catalog.
 */
const AGENT = 'Agents/narrow.agent';
const ACME = { utcp_version: '1.1.0', manual_version: '1.0.0', tools: [{ name: 'ping' }] };

let server: HttpServer | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** `ada` reads the manual at `Plugins/Acme/acme.tool`; `bob` does not; `carol` has no account. */
async function start() {
  const asked: { email: string; slug: string; narrowed: boolean }[] = [];
  const toolManuals = {
    resolveInlineManual: async (email: string, slug: string, opts?: { within?: (path: string) => boolean }) => {
      asked.push({ email, slug, narrowed: opts?.within !== undefined });
      if (slug !== 'acme' || email !== 'ada@example.com') return null;
      if (opts?.within && !opts.within('Plugins/Acme/acme.tool')) return null;
      return ACME;
    },
  } as unknown as IToolManualService;
  const resolveUserEmail = async (userId: string) => (userId === 'carol' ? undefined : `${userId}@example.com`);
  /** One agent that loads the Acme connector, one that loads another. */
  const agentScope: Pick<IAgentScopeResolver, 'resolve'> = {
    async resolve(_email, agentPath) {
      if (!agentPath) return ConnectionScope.everything();
      const connectors = agentPath === AGENT ? ['Plugins/Acme'] : ['Plugins/Other'];
      return ConnectionScope.narrowed({ path: agentPath, name: 'narrow' }, { skills: [], connectors, platformTools: null }, 'fp');
    },
  };

  let caller: { userId: string; agentPath?: string } = { userId: 'ada' };
  const app = express();
  app.use(
    createToolManualsAgentRoutes(
      toolManuals,
      (req, _res, next) => {
        req.toolAuth = { source: 'external', scope: 'write', ...caller };
        next();
      },
      resolveUserEmail,
      undefined,
      agentScope,
    ),
  );
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = createInlineManualReader({ toolManuals, resolveUserEmail, agentScope });

  /** The route's answer and the reader's, for one caller and slug, each as a status and a body. */
  const both = async (as: { userId: string; agentPath?: string }, slug: string) => {
    caller = as;
    const res = await fetch(`${base}/tools/${slug}/manual`);
    const route = { status: res.status, body: (await res.json()) as unknown };
    const inProcess = await read(as, slug).then(
      (manual) => ({ status: 200, body: manual as unknown }),
      (err: unknown) => {
        if (!(err instanceof InlineManualRefusedError)) throw err;
        return { status: err.status, body: { error: err.message } as unknown };
      },
    );
    return { route, inProcess };
  };
  return { asked, both };
}

describe('createInlineManualReader', () => {
  it('serves the manual to the person who may read it, as its route does', async () => {
    const { both } = await start();
    const { route, inProcess } = await both({ userId: 'ada' }, 'acme');
    expect(route).toEqual({ status: 200, body: ACME });
    expect(inProcess).toEqual(route);
  });

  it('answers a manual the person may not read, and one that does not exist, as not found: one answer for both', async () => {
    const { both } = await start();
    for (const [userId, slug] of [['bob', 'acme'], ['ada', 'no-such-manual']] as const) {
      const { route, inProcess } = await both({ userId }, slug);
      expect(route, `${userId} ${slug}`).toEqual({ status: 404, body: { error: 'Not found' } });
      expect(inProcess, `${userId} ${slug}`).toEqual(route);
    }
  });

  it('refuses a caller with no account before the catalog is asked anything', async () => {
    const { asked, both } = await start();
    const { route, inProcess } = await both({ userId: 'carol' }, 'acme');
    expect(route).toEqual({ status: 403, body: { error: 'Forbidden' } });
    expect(inProcess).toEqual(route);
    expect(asked).toEqual([]);
  });

  it('narrows to the connectors the connection loads: served to an agent that loads it, not found to one that does not', async () => {
    const { asked, both } = await start();
    const loads = await both({ userId: 'ada', agentPath: AGENT }, 'acme');
    expect(loads.route.status).toBe(200);
    expect(loads.inProcess).toEqual(loads.route);
    const loadsAnother = await both({ userId: 'ada', agentPath: 'Agents/other.agent' }, 'acme');
    expect(loadsAnother.route.status).toBe(404);
    expect(loadsAnother.inProcess).toEqual(loadsAnother.route);
    // The route and the reader asked the catalog the same four questions.
    expect(asked).toEqual([
      { email: 'ada@example.com', slug: 'acme', narrowed: true },
      { email: 'ada@example.com', slug: 'acme', narrowed: true },
      { email: 'ada@example.com', slug: 'acme', narrowed: true },
      { email: 'ada@example.com', slug: 'acme', narrowed: true },
    ]);
  });
});
