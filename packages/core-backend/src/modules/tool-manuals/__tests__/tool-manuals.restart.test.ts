import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../../plugins/discovery/kb-plugin-source.js';
import { ToolManualService } from '../tool-manuals.service.js';
import { McpOAuthDiscoveryService } from '../../secrets-vault/mcp-oauth-discovery.service.js';
import type { ISecretsVaultService, OAuthProviderConfig } from '../../secrets-vault/secrets-vault.contract.js';
import { utcpNamespacedKey } from '../../../shared/utcp-namespace.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { registerToolManualsTools } from '../tool-manuals.tools.js';

/**
 * A server restart must not cost a tool or a sign-in. Everything a registered
 * external tool is made of lives in two durable places — the default branch's
 * files and the vault's rows — and the catalog is REBUILT from them on the
 * first request after boot. This drives that path end to end: one "process"
 * declares, discovers and signs in; a second, built from scratch over the same
 * disk and the same rows (and nothing else), must list the same tools with the
 * same sign-ins, without registering a new OAuth client (a new client id would
 * orphan every stored grant).
 *
 * Reproduced on staging for hx-external-tools-survive-restart: `list_tools`,
 * `list_tool_setup` and every vault row were identical across a container
 * restart; this is the regression guard for that result.
 */

const KB_DIR = 'knowledge-base';
const USER = { id: 'user-1', email: 'user@example.com' };
const BEARER = 'bevel_user';
const REDIRECT_URI = 'https://bevel.example.com/api/secrets/oauth/callback';

const AUTO_URL = 'https://mcp.auto.example.com/mcp';
const MANUAL_URL = 'https://mcp.manual.example.com/mcp';
const AS = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
};

/**
 * The vault's durable state as plain rows — what Postgres keeps across a
 * restart — behind the slice of `ISecretsVaultService` the catalog and the
 * discovery read. Deliberately nothing process-local: each "process" gets a
 * fresh wrapper over the SAME rows.
 */
interface Row {
  userId: string | null;
  key: string;
  provider?: OAuthProviderConfig;
  accessToken?: string;
}
function vaultOver(rows: Row[]): ISecretsVaultService {
  const find = (userId: string | null, key: string) => rows.find((r) => r.userId === userId && r.key === key);
  return {
    getSharedOAuthProvider: async (key: string) => find(null, key)?.provider ?? null,
    putSharedOAuthProvider: async (input: { key: string; provider: OAuthProviderConfig }) => {
      const existing = find(null, input.key);
      if (existing) existing.provider = input.provider;
      else rows.push({ userId: null, key: input.key, provider: input.provider });
    },
    statusFor: async (userId: string, keys: string[]) =>
      keys.map((key) => {
        const own = find(userId, key);
        return {
          key,
          adminConfigured: !!find(null, key),
          userConfigured: !!own,
          userAuthorized: own ? Boolean(own.accessToken) : undefined,
        };
      }),
  } as unknown as ISecretsVaultService;
}

/** The remote servers: both publish OAuth metadata; the AS allows dynamic registration. */
function remoteServers() {
  let registrations = 0;
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const routes: Record<string, () => Response> = {
    [AUTO_URL]: () =>
      json({}, 401, {
        'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.auto.example.com/.well-known/oauth-protected-resource"',
      }),
    'https://mcp.auto.example.com/.well-known/oauth-protected-resource': () =>
      json({ resource: AUTO_URL, authorization_servers: [AS.issuer] }),
    [MANUAL_URL]: () =>
      json({}, 401, {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.manual.example.com/.well-known/oauth-protected-resource"',
      }),
    'https://mcp.manual.example.com/.well-known/oauth-protected-resource': () =>
      json({ resource: MANUAL_URL, authorization_servers: [AS.issuer] }),
    'https://auth.example.com/.well-known/oauth-authorization-server': () => json(AS),
    [AS.registration_endpoint]: () => json({ client_id: `dcr-client-${++registrations}` }, 201),
  };
  const fetchFn = (async (url: unknown) => {
    const handler = routes[String(url)];
    return handler ? handler() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, registrations: () => registrations };
}

describe('external tools and their sign-ins across a restart', () => {
  let root: string;
  const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
  const DRAFT = 'user/add-notes';
  const disk = new NodeFs();
  const allowAll = {
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
    canWrite: async () => true,
  } as unknown as IAccessControl;
  const servers: HttpServer[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tools-restart-'));
    // Both servers committed to the default branch in one plugin: one bare
    // (zero-config OAuth), one naming an owner-registered client id.
    const plugin = join(root, wsId, KB_DIR, 'Plugins', 'Sales');
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          auto_crm: { type: 'streamable-http', url: AUTO_URL },
          manual_crm: { type: 'streamable-http', url: MANUAL_URL },
        },
      }),
    );
    await writeFile(
      join(plugin, 'plugin.json'),
      JSON.stringify({
        name: 'sales',
        extensions: {
          'software.bevel.hexis': {
            mcpServers: {
              manual_crm: {
                headers: { Authorization: 'Bearer ${CRM_TOKEN}' },
                variables: [{ name: 'CRM_TOKEN', scope: 'user', oauth: { clientId: 'owner-registered' } }],
              },
            },
          },
        },
      }),
    );
    // The tester's shape: a third server the agent declared on its own draft
    // and never merged. It is not live before the restart and must not become
    // (or stop being reported as) anything else after it.
    const draftPlugin = join(root, workspaceIdForBranch(DRAFT), KB_DIR, 'Plugins', 'Notes');
    await mkdir(join(draftPlugin, '..', '..', '.git'), { recursive: true });
    await mkdir(draftPlugin, { recursive: true });
    await writeFile(join(draftPlugin, 'mcp.json'), JSON.stringify({ mcpServers: { notes: { type: 'streamable-http', url: 'https://notes.example.com/mcp' } } }));
    await writeFile(join(draftPlugin, 'plugin.json'), JSON.stringify({ name: 'notes' }));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await rm(root, { recursive: true, force: true });
  });

  /**
   * One server process: every service constructed from scratch, sharing only
   * the disk and the rows, with `list_tool_setup` mounted through the
   * production registration and auth/handler machinery and called over HTTP.
   */
  async function boot(rows: Row[], fetchFn: typeof fetch) {
    const workspaceService = {
      getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch) }),
      getWorkspacePath: async (id: string) => join(root, id),
      // Read from disk, as the real one falls back to after a restart: the
      // in-process clone map is empty in a fresh process.
      hasBootstrappedWorkspace: async (id: string) =>
        access(join(root, id, KB_DIR, '.git')).then(
          () => true,
          () => false,
        ),
    } as unknown as WorkspaceService;
    const vault = vaultOver(rows);
    const catalog = new ToolManualService(workspaceService, allowAll, KB_DIR, disk, new KbPluginSource(disk));
    catalog.setMcpAuthDiscovery(new McpOAuthDiscoveryService({ secretsVault: vault, redirectUri: REDIRECT_URI, fetchFn }));

    const internalToken = new InternalTokenService({ secret: 'test-secret' });
    const apiKeys = {
      looksLikeExternalApiKey: (t: string) => t === BEARER,
      verifyAndLoadToken: async (t: string) => (t === BEARER ? { user: { ...USER, name: 'User' }, tokenId: 'tok' } : null),
    } as never;
    const toolHandler = createToolHandlerFactory(
      createToolContextResolver({
        authService: { getUserById: async (id: string) => (id === USER.id ? { ...USER, name: 'User' } : null) } as never,
        workspaceService: { getWorkspacePath: async () => root } as never,
        workflowService: {} as never,
        events: {} as never,
        kbDirName: KB_DIR,
        creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
      }),
    );
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerToolManualsTools(new ToolRegistry(), router, createToolAuthMiddleware(apiKeys, internalToken), toolHandler, catalog, {
      accessControl: allowAll,
      variableStatus: vault,
    });
    app.use('/api', router);
    const server = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    /** `list_tool_setup` as the agent calls it, reduced to what a restart could cost. */
    const setup = async () => {
      const res = await fetch(`${base}/api/agent/tools/list_tool_setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
        body: JSON.stringify({ branch: DRAFT }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tools: { name: string; setup: { kind: string } | null; variables: { name: string; authorized: boolean | null }[] }[];
        onBranchOnly: { name: string; branch: string }[];
      };
      return {
        tools: body.tools.map((t) => ({
          name: t.name,
          setup: t.setup?.kind ?? null,
          variables: t.variables.map((v) => ({ key: utcpNamespacedKey(t.name, v.name), authorized: v.authorized })),
        })),
        onBranchOnly: body.onBranchOnly.map((p) => ({ name: p.name, branch: p.branch })),
      };
    };
    return { catalog, setup };
  }

  test('every server, its vault keys and the sign-ins are unchanged after a restart', async () => {
    const rows: Row[] = [];
    const remote = remoteServers();

    // ── Before the restart: discover, set up, sign in. ──
    const first = await boot(rows, remote.fetchFn);
    const discovered = (await first.setup()).tools;
    const autoKey = discovered.find((t) => t.name === 'auto_crm')!.variables[0].key;
    const manualKey = discovered.find((t) => t.name === 'manual_crm')!.variables[0].key;
    // The owner saved the client secret for the declared client; the user
    // completed both sign-ins (a token on their own row under each key).
    rows.push({ userId: null, key: manualKey, provider: { authorizationUrl: AS.authorization_endpoint, tokenUrl: AS.token_endpoint, clientId: 'owner-registered' } });
    rows.push({ userId: USER.id, key: autoKey, accessToken: 'tok-auto' });
    rows.push({ userId: USER.id, key: manualKey, accessToken: 'tok-manual' });
    const before = await first.setup();
    expect(before).toEqual({
      tools: [
        { name: 'auto_crm', setup: 'oauth-auto', variables: [{ key: autoKey, authorized: true }] },
        { name: 'manual_crm', setup: 'oauth-manual', variables: [{ key: manualKey, authorized: true }] },
      ],
      onBranchOnly: [{ name: 'notes', branch: DRAFT }],
    });
    expect(remote.registrations()).toBe(1);
    const rowsBefore = structuredClone(rows);

    // ── Restart: nothing in memory survives; a new process boots over the same disk and rows. ──
    const second = await boot(rows, remote.fetchFn);
    expect(await second.setup()).toEqual(before);
    // Same call templates too — what `list_tools` registers per request.
    expect((await second.catalog.toManualCallTemplates(USER.email)).map((t) => t.name).sort()).toEqual([
      'auto_crm',
      'manual_crm',
    ]);
    // The grant stays keyed by what it was keyed by: the stored client is
    // reused, never re-registered, and no row was rewritten.
    expect(remote.registrations()).toBe(1);
    expect(rows).toEqual(rowsBefore);
  });
});
