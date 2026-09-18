import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolManualsBrowserRoutes } from '../tool-manuals.routes.js';
import type {
  IPendingToolService,
  IToolManualService,
  PendingTool,
} from '../tool-manuals.contract.js';

/**
 * `GET /api/tools/pending` — the library's review shelf for tools.
 *
 * Two things this route must get right and nothing else does for it: it is
 * declared BEFORE `/tools/:slug`, so the parameterised route cannot swallow
 * `pending` and answer "no such tool"; and the pending service is OPTIONAL, so
 * a host that composes its own service set answers with an empty shelf rather
 * than a 404 the frontend would have to special-case.
 */

const PENDING: PendingTool = {
  slug: 'weather',
  name: 'weather',
  path: 'Plugins/Ops/weather.tool',
  type: 'http',
  description: 'Forecasts for a place.',
  plugin: 'Ops',
  changeRequestNumber: 7,
  branch: 'agent/weather',
  authorName: 'Ali Raza',
  createdAt: '2026-09-06T09:00:00.000Z',
  isAuthor: true,
};

let httpServer: HttpServer | undefined;

/** Mount the browser routes behind a fake auth middleware; `email` undefined ⇒ unauthenticated. */
async function baseUrlAs(
  email: string | undefined,
  pendingTools?: IPendingToolService,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (email) req.userEmail = email;
    next();
  });
  // The detail read must never be what answers `/tools/pending`; a service that
  // throws on any slug is how this test would notice the route order breaking.
  const toolManualService = {
    getDetail: async () => {
      throw new Error('/tools/:slug should not have matched "pending"');
    },
  } as unknown as IToolManualService;
  app.use('/api', createToolManualsBrowserRoutes(toolManualService, undefined, pendingTools));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  httpServer = undefined;
});

describe('GET /api/tools/pending', () => {
  it('serves the caller their visible proposals', async () => {
    const seen: string[] = [];
    const base = await baseUrlAs('ali@bevel.software', {
      listPendingTools: async (email) => {
        seen.push(email);
        return [PENDING];
      },
    });
    const res = await fetch(`${base}/api/tools/pending`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [PENDING] });
    // The route asks on behalf of the CALLER — the whole visibility rule hangs
    // off this one argument.
    expect(seen).toEqual(['ali@bevel.software']);
  });

  it('refuses an unauthenticated caller', async () => {
    const base = await baseUrlAs(undefined, { listPendingTools: async () => [PENDING] });
    const res = await fetch(`${base}/api/tools/pending`);
    expect(res.status).toBe(401);
  });

  it('answers with an empty shelf when no pending service is composed', async () => {
    const base = await baseUrlAs('ali@bevel.software');
    const res = await fetch(`${base}/api/tools/pending`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [] });
  });
});
