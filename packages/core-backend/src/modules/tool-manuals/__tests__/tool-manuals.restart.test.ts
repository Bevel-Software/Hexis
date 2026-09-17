import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
  const disk = new NodeFs();
  const allowAll = {
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

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
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** One server process: every service constructed from scratch, sharing only the disk and the rows. */
  function boot(rows: Row[], fetchFn: typeof fetch) {
    const workspaceService = {
      getOrCreateForBranch: async () => ({ id: wsId }),
      getWorkspacePath: async (id: string) => join(root, id),
    } as unknown as WorkspaceService;
    const vault = vaultOver(rows);
    const catalog = new ToolManualService(workspaceService, allowAll, KB_DIR, disk, new KbPluginSource(disk));
    catalog.setMcpAuthDiscovery(new McpOAuthDiscoveryService({ secretsVault: vault, redirectUri: REDIRECT_URI, fetchFn }));
    /** What `list_tool_setup` reports: the accessible catalog joined with the caller's vault status. */
    const setup = async () => {
      const manuals = await catalog.listAccessible(USER.email);
      const keys = manuals.flatMap((m) => (m.variables ?? []).map((v) => utcpNamespacedKey(m.name, v.name)));
      const status = new Map((await vault.statusFor(USER.id, keys)).map((s) => [s.key, s]));
      return manuals.map((m) => ({
        name: m.name,
        setup: m.setup?.kind ?? null,
        variables: (m.variables ?? []).map((v) => {
          const key = utcpNamespacedKey(m.name, v.name);
          return { key, authorized: v.oauth ? (status.get(key)?.userAuthorized ?? false) : null };
        }),
      }));
    };
    return { catalog, setup };
  }

  test('both servers, their vault keys and the sign-ins are unchanged after a restart', async () => {
    const rows: Row[] = [];
    const remote = remoteServers();

    // ── Before the restart: discover, set up, sign in. ──
    const first = boot(rows, remote.fetchFn);
    const discovered = await first.setup();
    const autoKey = discovered.find((t) => t.name === 'auto_crm')!.variables[0].key;
    const manualKey = discovered.find((t) => t.name === 'manual_crm')!.variables[0].key;
    // The owner saved the client secret for the declared client; the user
    // completed both sign-ins (a token on their own row under each key).
    rows.push({ userId: null, key: manualKey, provider: { authorizationUrl: AS.authorization_endpoint, tokenUrl: AS.token_endpoint, clientId: 'owner-registered' } });
    rows.push({ userId: USER.id, key: autoKey, accessToken: 'tok-auto' });
    rows.push({ userId: USER.id, key: manualKey, accessToken: 'tok-manual' });
    const before = await first.setup();
    expect(before).toEqual([
      { name: 'auto_crm', setup: 'oauth-auto', variables: [{ key: autoKey, authorized: true }] },
      { name: 'manual_crm', setup: 'oauth-manual', variables: [{ key: manualKey, authorized: true }] },
    ]);
    expect(remote.registrations()).toBe(1);
    const rowsBefore = structuredClone(rows);

    // ── Restart: nothing in memory survives; a new process boots over the same disk and rows. ──
    const second = boot(rows, remote.fetchFn);
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
