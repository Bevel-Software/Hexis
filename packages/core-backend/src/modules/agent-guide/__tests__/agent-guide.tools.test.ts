import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { GUIDE_FIRST_SENTENCE } from '../../tool-registry/guide-first.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { GET_AGENT_GUIDE_TOOL, registerAgentGuideTool } from '../agent-guide.tools.js';
import type { RenderedGuideSection } from '../agent-guide.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const SECTIONS: RenderedGuideSection[] = [
  { id: 'introduction', title: 'Knowledge base', body: '# Knowledge base\n\nRead me.' },
  { id: 'access-control', title: 'Access control', body: '## Access control\n\nWho may do what.' },
  { id: 'knowledge-graph', title: 'Knowledge graph', body: '## Knowledge graph\n\nA distribution added this one.' },
];

describe('get_agent_guide', () => {
  async function serve() {
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
    let reads = 0;
    registerAgentGuideTool(registry, router, auth, createToolHandlerFactory(resolve), async () => {
      reads += 1;
      return SECTIONS;
    });
    // Another tool beside it, to see what the catalog does to each.
    registry.registerExternalTool(
      toolDef({ name: 'read_file', description: 'Read a file.', path: '/api/agent/tools/read_file', inputs: { type: 'object', properties: {} }, tags: [] }),
    );

    const web = express();
    web.use(express.json());
    web.use('/api', router);
    server = await new Promise<Server>((resolve) => {
      const s = web.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const call = async (body: Record<string, unknown> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agent/tools/${GET_AGENT_GUIDE_TOOL}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { registry, call, reads: () => reads };
  }

  it('is on both surfaces, says to call it first, and lists the sections the guide has now', async () => {
    const { registry } = await serve();
    for (const list of [registry.listExternal(), registry.listInternal()]) {
      const def = (await list).find((t) => t.name === GET_AGENT_GUIDE_TOOL);
      expect(def).toBeDefined();
      expect(def!.description).toContain('ALWAYS call this first and read the guide before you do anything else');
      expect(def!.description).toContain("`read_file` on `AGENTS.md` at the KB root");
      // The sections, a distribution's own included, by id and title.
      expect(def!.description).toContain(
        'Sections: `introduction` (Knowledge base), `access-control` (Access control), `knowledge-graph` (Knowledge graph).',
      );
      // The one tool that does not open with "call get_agent_guide first".
      expect(def!.description.startsWith(GUIDE_FIRST_SENTENCE)).toBe(false);
      // The def wraps a tool's inputs as its request `body`; this one takes `section` and nothing else.
      const body = (def!.inputs as { properties: { body: { properties?: Record<string, unknown> } } }).properties.body;
      expect(Object.keys(body.properties ?? {})).toEqual(['section']);
    }
  });

  it('puts the guide-first sentence at the front of every other tool the catalog lists', async () => {
    const { registry } = await serve();
    const read = (await registry.listExternal()).find((t) => t.name === 'read_file')!;
    expect(read.description).toBe(`${GUIDE_FIRST_SENTENCE} Read a file.`);
  });

  it('returns the whole guide, or one section by id, composed when asked', async () => {
    const { call, reads } = await serve();
    expect(await call()).toEqual({
      status: 200,
      body: { guide: '# Knowledge base\n\nRead me.\n\n## Access control\n\nWho may do what.\n\n## Knowledge graph\n\nA distribution added this one.\n' },
    });
    expect(await call({ section: 'access-control' })).toEqual({
      status: 200,
      body: { guide: '## Access control\n\nWho may do what.', section: 'access-control', title: 'Access control' },
    });
    // A section the guide does not have is refused with the ones it has.
    const unknown = await call({ section: 'nope' });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toContain('The guide has no section "nope". Sections: `introduction`, `access-control`, `knowledge-graph`.');
    // Composed per call, never cached here: a layout applied later is seen.
    expect(reads()).toBe(3);
  });
});
