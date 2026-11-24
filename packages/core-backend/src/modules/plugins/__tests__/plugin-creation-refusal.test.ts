import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPluginCreationRoutes } from '../plugins.routes.js';

/**
 * The plugin creation doors answer a credential that may not act with its
 * own sentence, as a tool call does: a connection made as a bot whose maker
 * cannot be loaded is told why, not a bare "Unauthenticated", and nothing is
 * provisioned. With no identity at all the answer stays "Unauthenticated".
 */

const REFUSED = 'The person who made this connection is no longer available, so it loads nothing.';

describe('the plugin creation doors, for a caller that may not act', () => {
  const provision = { createPlugin: vi.fn(), ensurePersonalPlugin: vi.fn() };
  let server: HttpServer;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPluginCreationRoutes(provision as never, async (req) =>
        req.headers['x-caller'] === 'refused' ? { refused: REFUSED } : null,
      ),
    );
    server = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (path: string, caller?: string) =>
    fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(caller ? { 'x-caller': caller } : {}) },
      body: JSON.stringify({ name: 'GTM' }),
    });

  it('answers the refusal sentence on both doors and provisions nothing', async () => {
    for (const path of ['/plugins', '/plugins/personal']) {
      const res = await post(path, 'refused');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: REFUSED });
    }
    expect(provision.createPlugin).not.toHaveBeenCalled();
    expect(provision.ensurePersonalPlugin).not.toHaveBeenCalled();
  });

  it('answers "Unauthenticated" when there is no identity at all', async () => {
    const res = await post('/plugins');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthenticated' });
  });
});
