import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualRoutes, type IToolRegistry } from '../index.js';

/**
 * `GET /agent/utcp` answers with the reader it is handed: the composition root
 * hands the route the reader it also gives the hosted MCP endpoint, so the two
 * answer from one reader.
 */
describe('createManualRoutes', () => {
  let server: HttpServer | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('answers GET /agent/utcp with the reader it is handed, for the caller its auth resolved', async () => {
    const asked: unknown[] = [];
    const manual = { utcp_version: '1.1.0', manual_version: '1.0.0', tools: [{ name: 'from-the-shared-reader' }] };
    const reader = async (caller: { userId?: string; agentPath?: string }) => {
      asked.push(caller);
      return manual as never;
    };
    // A registry the route never asks: the handed reader is the only source.
    const registry = {} as IToolRegistry;
    const app = express();
    app.use(
      createManualRoutes(
        registry,
        (req, _res, next) => {
          req.toolAuth = { source: 'external', scope: 'read', userId: 'ada', agentPath: 'Agents/a.agent' };
          next();
        },
        undefined,
        undefined,
        undefined,
        reader,
      ),
    );
    server = await new Promise<HttpServer>((res) => {
      const s = app.listen(0, () => res(s));
    });
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/agent/utcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(manual);
    expect(asked).toEqual([{ userId: 'ada', agentPath: 'Agents/a.agent' }]);
  });
});
