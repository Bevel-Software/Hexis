import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { RoutineWritePolicyService } from '../../workspace/routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../../workspace/spill-store.js';

const WS = 'target-company-state';
let recorded: unknown[][] = [];

const externalApiKeyService = { verifyAndLoadToken: async () => null } as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: WS }),
  getWorkspacePath: async () => '/tmp/ws',
  unzipFile: async (ws: string, p: string, d?: string) => {
    recorded.push(['unzip', ws, p, d]);
    return { extracted: [p], skipped: [] };
  },
  readFile: async () => {
    throw new Error('no such file');
  },
} as never;
const workflowService = {} as never;
const events = {} as never;
const accessControl = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
} as never;

const internalToken = new InternalTokenService({ secret: 's' });
let httpServer: HttpServer | undefined;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({ authService, workspaceService, workflowService, events, kbDirName: 'knowledge-base', creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} } });
  const th = createToolHandlerFactory(resolve);
  const router = express.Router();
  // NOTE (core split): this suite used to register the search, feedback and
  // kb (citation) tools alongside the workspace tools. Those registrations —
  // and their web_search / submit_feedback / cite_kb_node cases — moved to
  // the enterprise repo with their modules; core registers only core tools.
  registerWorkspaceTools(registry, router, toolAuth, th, new SpillStore('/tmp/bevel-test-spills'), accessControl, 'knowledge-base', {
    service: {} as never,
    enabled: false, // ontology boundary not under test here
    kbDirName: 'knowledge-base',
    recoveryBotEmail: 'recovery-bot@bevel.local',
    hooks: new WorkflowHooks(),
  }, new RoutineWritePolicyService(), {} as never /* sessionSink — start_session not exercised here */);
  router.use(createManualRoutes(registry, toolAuth));

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const tok = () => internalToken.mint({ userId: 'user-A' });
const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok()}` }, body: JSON.stringify(body) });

beforeEach(() => {
  recorded = [];
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

describe('Phase 4 tools (core subset)', () => {
  it('unzip calls workspaceService.unzipFile with the context workspace', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/unzip`, { path: 'a.zip', branch: WS });
    expect(res.status).toBe(200);
    expect(recorded).toContainEqual(['unzip', WS, 'a.zip', undefined]);
  });

  it('the registered core tool appears in the internal manual', async () => {
    const base = await start();
    const m = (await (await fetch(`${base}/api/agent/internal/utcp`, { headers: { authorization: `Bearer ${tok()}` } })).json()) as { tools: { name: string }[] };
    const names = m.tools.map((t) => t.name);
    expect(names).toContain('unzip');
  });
});
