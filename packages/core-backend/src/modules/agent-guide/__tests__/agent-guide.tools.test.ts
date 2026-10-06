import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import { GET_AGENT_GUIDE_TOOL, registerAgentGuideTool } from '../agent-guide.tools.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('get_agent_guide', () => {
  it('is on both surfaces, takes nothing, and answers with the guide composed when asked', async () => {
    const registry = new ToolRegistry();
    const router = express.Router();
    // Stands in for the connection-key auth: the caller is a signed-in reader.
    const auth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.toolAuth = { source: 'internal', userId: 'u', scope: 'read' };
      next();
    };
    const resolve = async (): Promise<ToolContext> =>
      ({
        user: { id: 'u', email: 'a@x.io', name: 'A' },
        scope: 'read',
        source: 'internal',
        abortSignal: new AbortController().signal,
        workspaceService: {} as never,
        workflowService: {} as never,
        events: {} as never,
        getFilesystem: async () => {
          throw new Error('the guide reads no file');
        },
      }) as unknown as ToolContext;
    let calls = 0;
    registerAgentGuideTool(registry, router, auth, createToolHandlerFactory(resolve), async () => `guide #${++calls}`);
    for (const list of [registry.listExternal(), registry.listInternal()]) {
      const def = (await list).find((t) => t.name === GET_AGENT_GUIDE_TOOL);
      expect(def).toBeDefined();
      // The def wraps a tool's inputs as its request `body`; this one declares none.
      const body = (def!.inputs as { properties: { body: { properties?: Record<string, unknown> } } }).properties.body;
      expect(Object.keys(body.properties ?? {})).toEqual([]);
      expect(def!.description).toContain('Read it before your first read or change');
      expect(def!.description).toContain("`read_file` on the guide's name at the KB root (`AGENTS.md`, or the name this deployment gave the guide)");
    }

    const web = express();
    web.use(express.json());
    web.use('/api', router);
    server = await new Promise<Server>((resolve) => {
      const s = web.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const call = () =>
      fetch(`http://127.0.0.1:${port}/api/agent/tools/${GET_AGENT_GUIDE_TOOL}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: '{}',
      });
    expect(await (await call()).json()).toEqual({ guide: 'guide #1' });
    // Composed per call, never cached here: a layout applied later is seen.
    expect(await (await call()).json()).toEqual({ guide: 'guide #2' });
  });
});
