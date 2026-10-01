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
import { testKbContext } from '../../../__tests__/kb-context.js';

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

// Alice's plugin holds a `.tool` the scan refused; Bob can't read that file.
const REFUSED = [
  { path: 'Plugins/Sales/broken.tool', reason: 'Nested mappings are not allowed in compact mappings (line 4, column 3)' },
];

const toolManualService = {
  listAccessible: vi.fn(async (email: string) =>
    email === ALICE.email ? CATALOG : CATALOG.filter((m) => m.slug === 'weather'),
  ),
  // Both halves out of one call — the listing has no way to ask for them
  // separately, and so no way to describe two different snapshots.
  listAccessibleCatalog: vi.fn(async (email: string) => ({
    tools: email === ALICE.email ? CATALOG : CATALOG.filter((m) => m.slug === 'weather'),
    invalid: email === ALICE.email ? REFUSED : [],
  })),
  listLocalOnly: async () => [],
  // Alice declared `crm` on her draft; nothing else is pending anywhere.
  listDeclaredOnlyOnBranch: vi.fn(async (email: string, branch: string) =>
    email === ALICE.email && branch === 'alice/add-crm'
      ? [{ name: 'crm', path: 'Plugins/Sales/mcp.json', type: 'mcp' as const }]
      : [],
  ),
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
    kb: testKbContext(),
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

const callSetup = (base: string, bearer: string, body: Record<string, unknown> = {}) =>
  fetch(`${base}/api/agent/tools/list_tool_setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
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

  it('names the `.tool` files the scan refused, resolved for the caller', async () => {
    const base = await start();

    const alice = (await (await callSetup(base, 'bevel_alice')).json()) as {
      tools: { slug: string }[];
      invalid: { path: string; reason: string }[];
    };
    // The refusal costs that file and nothing else: the catalog is whole...
    expect(alice.tools.map((t) => t.slug).sort()).toEqual(['billing', 'weather']);
    // ...and the one file that did not make it is named, with why and where.
    expect(alice.invalid).toEqual(REFUSED);
    expect(toolManualService.listAccessibleCatalog).toHaveBeenCalledWith(ALICE.email);

    // Bob can't read that file, so he is not told it exists — the same
    // default-deny the catalog itself applies.
    const bob = (await (await callSetup(base, 'bevel_bob')).json()) as { invalid: unknown[] };
    expect(bob.invalid).toEqual([]);
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

describe('list_tool_setup — a declaration that lives on a draft says so', () => {
  it('names the tools declared on the given branch that the default branch does not serve yet', async () => {
    const base = await start();
    const res = await callSetup(base, 'bevel_alice', { branch: 'alice/add-crm' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { slug: string }[];
      onBranchOnly: { name: string; path: string; branch: string }[];
      note?: string;
    };
    // Resolved for the caller, on the branch they named.
    expect(toolManualService.listDeclaredOnlyOnBranch).toHaveBeenCalledWith(ALICE.email, 'alice/add-crm');
    // The released catalog is unchanged — the draft's server is not in it...
    expect(body.tools.map((t) => t.slug)).not.toContain('crm');
    // ...and the agent is told where it is and what makes it live.
    expect(body.onBranchOnly).toEqual([
      { name: 'crm', path: 'Plugins/Sales/mcp.json', type: 'mcp', branch: 'alice/add-crm' },
    ]);
    expect(body.note).toContain('`alice/add-crm` only');
    expect(body.note).toContain('open_change_request');
  });

  it('defaults to the in-app agent’s focused branch when no branch is given', async () => {
    const base = await start();
    // The in-process agent's loopback token carries the branch its workspace is on.
    const agentToken = new InternalTokenService({ secret: 'test-secret' }).mint({
      userId: ALICE.id,
      focusedBranch: 'alice/add-crm',
    });
    const res = await callSetup(base, agentToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { onBranchOnly: { name: string; branch: string }[]; note?: string };
    expect(toolManualService.listDeclaredOnlyOnBranch).toHaveBeenCalledWith(ALICE.email, 'alice/add-crm');
    expect(body.onBranchOnly).toEqual([
      { name: 'crm', path: 'Plugins/Sales/mcp.json', type: 'mcp', branch: 'alice/add-crm' },
    ]);
    expect(body.note).toContain('`alice/add-crm` only');
  });

  it('prefers an explicit branch over the focused one', async () => {
    const base = await start();
    const agentToken = new InternalTokenService({ secret: 'test-secret' }).mint({
      userId: ALICE.id,
      focusedBranch: 'alice/other-draft',
    });
    const body = (await (await callSetup(base, agentToken, { branch: 'alice/add-crm' })).json()) as {
      onBranchOnly: { name: string }[];
    };
    expect(toolManualService.listDeclaredOnlyOnBranch).toHaveBeenCalledTimes(1);
    expect(toolManualService.listDeclaredOnlyOnBranch).toHaveBeenCalledWith(ALICE.email, 'alice/add-crm');
    expect(body.onBranchOnly.map((p) => p.name)).toEqual(['crm']);
  });

  it('carries the refused files on the branch answer too', async () => {
    const base = await start();
    const body = (await (await callSetup(base, 'bevel_alice', { branch: 'alice/add-crm' })).json()) as {
      invalid: { path: string }[];
      onBranchOnly: unknown[];
      note?: string;
    };
    // The two halves are independent: a pending draft declaration must not
    // displace the report of a file the released catalog refused.
    expect(body.invalid.map((i) => i.path)).toEqual(['Plugins/Sales/broken.tool']);
    expect(body.onBranchOnly).toHaveLength(1);
    expect(body.note).toBeTruthy();
  });

  it('reports nothing pending, and no note, without a branch', async () => {
    const base = await start();
    const body = (await (await callSetup(base, 'bevel_alice')).json()) as { onBranchOnly: unknown[]; note?: string };
    expect(body.onBranchOnly).toEqual([]);
    expect(body.note).toBeUndefined();
    expect(toolManualService.listDeclaredOnlyOnBranch).not.toHaveBeenCalled();
  });
});
