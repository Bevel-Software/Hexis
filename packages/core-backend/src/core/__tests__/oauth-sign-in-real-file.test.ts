import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { createSecretsVaultRoutes } from '../../modules/secrets-vault/index.js';
import { KbPluginSource } from '../../modules/plugins/index.js';
import type { WorkspaceService } from '../../modules/workspace/index.js';
import type { IAccessControl } from '../../modules/access/index.js';
// The two concrete services this suite wires, it wires the way the composition
// root does (`create-core-services.ts`): their modules publish them as types
// only, and the composition root is the one place that constructs them from
// their files. This suite stands in for that root — the routes of one module
// over the real parser of another — which is why it lives beside it.
import { ToolManualService } from '../../modules/tool-manuals/tool-manuals.service.js';
import { realDisk } from '../../__tests__/real-disk.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import { testKbContext } from '../../__tests__/kb-context.js';

/**
 * The sign-in start against REAL tool files: the routes are wired to the real
 * `ToolManualService` over a workspace on disk, so what the start answers is
 * what the parser makes of the file, not what a stub says it makes of it.
 *
 * The case this exists for (Local Testing, 2026-10-27): a declaration edited to
 * `tokenUrl: http://127.0.0.1/token` is refused by the parser before the vault
 * ever validates it — and the start answered "Tool or variable not found"
 * instead of the validation's message.
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const USER = 'owner@x.com';
const AUTHORIZE = 'https://auth.crm.example/authorize';
const TOKEN = 'https://auth.crm.example/token';

let root: string;
let httpServer: HttpServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'signin-live-'));
  await mkdir(join(root, wsId, KB_DIR, 'Plugins', 'GTM'), { recursive: true });
});
afterEach(async () => {
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
  httpServer = undefined;
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const toolPath = () => join(root, wsId, KB_DIR, 'Plugins', 'crm.tool');
const writeTool = (oauth: Record<string, unknown>) =>
  writeFile(
    toolPath(),
    JSON.stringify({
      name: 'crm',
      type: 'http',
      url: 'https://api.crm.example/openapi.json',
      variables: [{ name: 'SIGNIN', scope: 'user', oauth }],
    }),
  );
const writePlugin = (oauth: Record<string, unknown>) =>
  Promise.all([
    writeFile(
      join(root, wsId, KB_DIR, 'Plugins', 'GTM', 'mcp.json'),
      JSON.stringify({ mcpServers: { hubspot: { type: 'streamable-http', url: 'https://mcp.hubspot.example/mcp' } } }),
    ),
    writeFile(
      join(root, wsId, KB_DIR, 'Plugins', 'GTM', 'plugin.json'),
      JSON.stringify({
        name: 'gtm',
        extensions: {
          'software.bevel.hexis': {
            mcpServers: {
              hubspot: {
                headers: { Authorization: 'Bearer ${HUBSPOT_TOKEN}' },
                variables: [{ name: 'HUBSPOT_TOKEN', scope: 'user', oauth }],
              },
            },
          },
        },
      }),
    ),
  ]);

async function serve() {
  const disk = realDisk();
  const kb = testKbContext({ kbDirName: KB_DIR });
  const accessControl = {
    canRead: async () => true,
    canWrite: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;
  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;
  const toolManualService = new ToolManualService(workspaceService, accessControl, kb, disk, new KbPluginSource(disk, kb));
  toolManualService.setMcpAuthDiscovery({ statusFor: async () => ({ status: 'open' as const }) });
  const beginToolOAuthByKey = vi.fn(async () => ({ id: 'row-1', url: `${AUTHORIZE}?client_id=x` }));
  const deps = {
    secretsVault: { beginToolOAuthByKey },
    toolManualService,
    accessControl,
    connectionProbe: {},
    kb: { defaultWorkspaceId: () => wsId },
    stateSecret: 'state-secret',
    publicBackendUrl: 'http://localhost:3000',
    publicFrontendUrl: 'http://localhost:5173',
  } as unknown as Parameters<typeof createSecretsVaultRoutes>[0];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    req.userEmail = USER;
    next();
  });
  app.use('/api', createSecretsVaultRoutes(deps));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/secrets/tools`;
  const start = (slug: string, varName: string) => fetch(`${base}/${slug}/vars/${varName}/oauth/start`, { method: 'POST' });
  return { toolManualService, beginToolOAuthByKey, start };
}

describe('POST …/oauth/start — through a real tool file', () => {
  it('a client id edited in the .tool after the catalog was scanned is the one handed to the vault', async () => {
    await writeTool({ clientId: 'client-A', authorizationUrl: AUTHORIZE, tokenUrl: TOKEN });
    const s = await serve();
    await s.toolManualService.listAccessible(USER); // the catalog caches client A
    await writeTool({ clientId: 'client-B', authorizationUrl: AUTHORIZE, tokenUrl: TOKEN });

    expect((await s.start('crm', 'SIGNIN')).status).toBe(200);
    expect(s.beginToolOAuthByKey.mock.calls[0][0]).toMatchObject({
      key: 'crm_SIGNIN',
      provider: { clientId: 'client-B', authorizationUrl: AUTHORIZE, tokenUrl: TOKEN, pkce: true },
    });
  });

  it.each([
    ['an http:// token endpoint', 'http://127.0.0.1/token', '`variables[0].oauth.tokenUrl` must use https'],
    ['a private token endpoint', 'https://10.0.0.5/token', '`variables[0].oauth.tokenUrl` host is not allowed'],
  ])('a .tool naming %s is refused with the validation message, sending nothing', async (_n, tokenUrl, message) => {
    await writeTool({ clientId: 'client-A', authorizationUrl: AUTHORIZE, tokenUrl: TOKEN });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await serve();
    await s.toolManualService.listAccessible(USER); // the catalog still holds the valid version
    await writeTool({ clientId: 'client-A', authorizationUrl: AUTHORIZE, tokenUrl });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await s.start('crm', 'SIGNIN');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(message);
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();
    // The one fetch is the test's own call to the route: nothing went to a provider.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a plugin.json sign-in naming an http:// token endpoint is refused with the validation message, sending nothing', async () => {
    await writePlugin({ clientId: 'owner-app', authorizationUrl: AUTHORIZE, tokenUrl: 'http://127.0.0.1/token' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await serve();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await s.start('hubspot', 'HUBSPOT_TOKEN');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('`variables[0].oauth.tokenUrl` must use https');
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a slug no file declares is still not found', async () => {
    const s = await serve();
    expect((await s.start('nothing', 'SIGNIN')).status).toBe(404);
  });
});
