import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { registerToolManualsTools } from '../tool-manuals.tools.js';
import type { IToolManualService } from '../tool-manuals.contract.js';

/**
 * `list_tool_setup` MUST respect the same access controls as every other tool
 * surface, resolved for THE CALLER:
 *
 *  - the catalog is read-gated: a `.tool` the caller can't READ is absent
 *    (via `listAccessible(callerEmail)` — default-deny, per email);
 *  - `canWrite` is the PER-FILE verdict (`canWrite(email, path)`), not a role;
 *  - configuration status is the caller's own (`statusFor(callerUserId, …)`).
 *
 * Exercised over a real express app with the real tool auth + handler
 * machinery, as two different users, so a caller-mixup (leaking another user's
 * catalog or status) can't slip through the composition.
 */

const ALICE = { id: 'user-alice', email: 'alice@x.com', name: 'Alice' };
const BOB = { id: 'user-bob', email: 'bob@x.com', name: 'Bob' };

// Alice reads both tools and may write weather; Bob reads only weather, writes nothing.
const CATALOG = [
  {
    slug: 'weather',
    name: 'weather',
    path: 'Plugins/weather.tool',
    type: 'mcp' as const,
    setup: { kind: 'oauth-manual' as const, reason: 'no dynamic client registration' },
    variables: [{ name: 'SHARED_KEY', scope: 'admin' as const, label: null }],
  },
  {
    slug: 'billing',
    name: 'billing',
    path: 'Plugins/billing.tool',
    type: 'http' as const,
    variables: [{ name: 'ORG_KEY', scope: 'admin' as const, label: null }],
  },
];

const toolManualService = {
  listAccessible: vi.fn(async (email: string) =>
    email === ALICE.email ? CATALOG : CATALOG.filter((m) => m.slug === 'weather'),
  ),
  listLocalOnly: async () => [],
} as unknown as IToolManualService;

const accessControl = {
  canWrite: vi.fn(
    async (_ws: string, email: string, path: string) => email === ALICE.email && path === 'Plugins/weather.tool',
  ),
} as never;

const statusFor = vi.fn(async (userId: string, keys: string[]) =>
  keys.map((key) => ({
    key,
    // Only Alice has configured anything — Bob's view must not inherit it.
    adminConfigured: true,
    userConfigured: userId === ALICE.id,
  })),
);

let httpServer: HttpServer | undefined;

const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_alice' ? { user: ALICE, tokenId: 'tok-a' } : t === 'bevel_bob' ? { user: BOB, tokenId: 'tok-b' } : null,
} as never;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const internalToken = new InternalTokenService({ secret: 'test-secret' });
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({
    authService: {
      getUserById: async (id: string) => (id === ALICE.id ? ALICE : id === BOB.id ? BOB : null),
    } as never,
    workspaceService: { getWorkspacePath: async () => '/tmp/ws' } as never,
    workflowService: {} as never,
    events: {} as never,
    kbDirName: 'knowledge-base',
    creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
  });
  const toolHandler = createToolHandlerFactory(resolve);

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerToolManualsTools(registry, router, toolAuth, toolHandler, toolManualService, {
    accessControl,
    variableStatus: { statusFor },
  });
  app.use('/api', router);

  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.clearAllMocks();
});

const callSetup = (base: string, bearer: string) =>
  fetch(`${base}/api/agent/tools/list_tool_setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({}),
  });

describe('list_tool_setup — access controls resolved for the caller', () => {
  it('shows each caller only the tools THEY can read, with THEIR per-file canWrite', async () => {
    const base = await start();

    const aliceRes = await callSetup(base, 'bevel_alice');
    expect(aliceRes.status).toBe(200);
    const alice = (await aliceRes.json()) as { tools: { slug: string; canWrite: boolean }[] };
    expect(alice.tools.map((t) => t.slug).sort()).toEqual(['billing', 'weather']);
    expect(alice.tools.find((t) => t.slug === 'weather')!.canWrite).toBe(true);
    expect(alice.tools.find((t) => t.slug === 'billing')!.canWrite).toBe(false);

    const bobRes = await callSetup(base, 'bevel_bob');
    expect(bobRes.status).toBe(200);
    const bob = (await bobRes.json()) as {
      tools: { slug: string; canWrite: boolean; variables: { userConfigured: boolean }[] }[];
    };
    // Bob can't read billing — it must be absent, not just canWrite=false.
    expect(bob.tools.map((t) => t.slug)).toEqual(['weather']);
    expect(bob.tools[0].canWrite).toBe(false);
    // Status was resolved for BOB's user id, not leaked from Alice's.
    expect(statusFor).toHaveBeenLastCalledWith(BOB.id, ['weather_SHARED_KEY']);
    expect(bob.tools[0].variables[0].userConfigured).toBe(false);
  });

  it('rejects an unauthenticated call outright', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/agent/tools/list_tool_setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
