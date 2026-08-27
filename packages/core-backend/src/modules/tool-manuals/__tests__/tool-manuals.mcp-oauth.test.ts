import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { ToolManualService, type McpAuthDiscoveryPort } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const BARE_MCP_TOOL = JSON.stringify({
  name: 'notion',
  type: 'mcp',
  url: 'https://mcp.example.com/mcp',
});

const KEYED_MCP_TOOL = JSON.stringify({
  name: 'jira',
  type: 'mcp',
  url: 'https://mcp.jira.example.com/mcp',
  headers: { Authorization: 'Bearer ${JIRA_KEY}' },
});

const OAUTH_PROVIDER = {
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'dcr-client-1',
  scopes: ['mcp.read'],
};

describe('ToolManualService — MCP OAuth auto-discovery decoration', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const allowAll: IAccessControl = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tools-oauth-'));
    const toolsDir = join(root, wsId, KB_DIR, 'Plugins');
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, 'notion.tool'), BARE_MCP_TOOL);
    await writeFile(join(toolsDir, 'jira.tool'), KEYED_MCP_TOOL);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function svcWith(discovery: McpAuthDiscoveryPort) {
    const svc = new ToolManualService(workspaceService, allowAll, KB_DIR);
    svc.setMcpAuthDiscovery(discovery);
    return svc;
  }

  test('a bare mcp tool whose server demands OAuth gains the synthetic sign-in var + header', async () => {
    const discovery: McpAuthDiscoveryPort = {
      statusFor: vi.fn(async () => ({ status: 'oauth' as const, provider: OAUTH_PROVIDER })),
    };
    const svc = svcWith(discovery);

    // The synthetic variable is user-scoped + oauth-backed, so /connect and the
    // MCP proxy's readiness checks pick it up with no further wiring.
    const manuals = await svc.listAccessible('user@example.com');
    const notion = manuals.find((m) => m.name === 'notion')!;
    expect(notion.variables).toEqual([
      expect.objectContaining({
        name: 'MCP_OAUTH',
        scope: 'user',
        oauth: expect.objectContaining({ clientId: 'dcr-client-1' }),
      }),
    ]);

    const keys = await svc.userScopedKeysForManual('notion');
    expect(keys).toEqual([
      expect.objectContaining({ key: 'notion_MCP_OAUTH', oauth: true }),
    ]);
    await expect(svc.scopeOfVariable('notion_MCP_OAUTH')).resolves.toBe('user');

    // The served call template carries the header the variable loader will fill.
    const templates = await svc.toManualCallTemplates('user@example.com');
    const notionTemplate = templates.find((t) => t.name === 'notion') as any;
    expect(notionTemplate.config.mcpServers.notion.headers).toEqual({
      Authorization: 'Bearer ${MCP_OAUTH}',
    });
  });

  test('explicitly-configured auth wins: a tool with its own Authorization header is never probed', async () => {
    const statusFor = vi.fn(async () => ({ status: 'oauth' as const, provider: OAUTH_PROVIDER }));
    const svc = svcWith({ statusFor });

    await svc.listAccessible('user@example.com');

    expect(statusFor).toHaveBeenCalledTimes(1);
    expect(statusFor).toHaveBeenCalledWith('notion', 'https://mcp.example.com/mcp'); // never 'jira'
    const manuals = await svc.listAccessible('user@example.com');
    const jira = manuals.find((m) => m.name === 'jira')!;
    // No synthetic sign-in — but its referenced key still auto-surfaces as an admin var.
    expect(jira.variables).toEqual([{ name: 'JIRA_KEY', scope: 'admin' }]);
  });

  test('referenced-but-undeclared ${VAR}s are auto-surfaced as admin keys (any tool type)', async () => {
    const toolsDir = join(root, wsId, KB_DIR, 'Plugins');
    await writeFile(
      join(toolsDir, 'billing.tool'),
      JSON.stringify({
        name: 'billing',
        type: 'http',
        url: 'https://api.example.com/utcp',
        headers: { Authorization: 'Bearer ${BILLING_KEY}' },
      }),
    );
    await writeFile(
      join(toolsDir, 'weather.tool'),
      JSON.stringify({
        name: 'weather',
        type: 'inline',
        // Declared user var + an extra undeclared ref in the embedded tool.
        variables: [{ name: 'WEATHER_KEY', scope: 'user' }],
        tools: [
          {
            name: 'forecast',
            description: 'forecast',
            inputs: { type: 'object', properties: {} },
            outputs: { type: 'object', properties: {} },
            tool_call_template: {
              call_template_type: 'http',
              http_method: 'GET',
              url: 'https://api.example.com/forecast?region=${REGION}',
              headers: { Authorization: 'Bearer ${WEATHER_KEY}' },
            },
          },
        ],
      }),
    );
    const svc = svcWith({ statusFor: async () => ({ status: 'open' as const }) });

    const manuals = await svc.listAccessible('user@example.com');
    const billing = manuals.find((m) => m.name === 'billing')!;
    expect(billing.variables).toEqual([{ name: 'BILLING_KEY', scope: 'admin' }]);

    const weather = manuals.find((m) => m.name === 'weather')!;
    // The declared entry keeps its metadata; only the genuinely-undeclared ref
    // is added, and never the proxy-seeded API_URL / CONNECTION_KEY.
    expect(weather.variables).toEqual([
      expect.objectContaining({ name: 'WEATHER_KEY', scope: 'user' }),
      { name: 'REGION', scope: 'admin' },
    ]);
    // Scope resolution matches: undeclared → admin, declared → as written.
    await expect(svc.scopeOfVariable('billing_BILLING_KEY')).resolves.toBe('admin');
    await expect(svc.scopeOfVariable('weather_WEATHER_KEY')).resolves.toBe('user');
  });

  test('setup requirement is recorded per discovery outcome (open / oauth / oauth-manual)', async () => {
    const oauthSvc = svcWith({ statusFor: async () => ({ status: 'oauth' as const, provider: OAUTH_PROVIDER }) });
    const oauth = (await oauthSvc.listAccessible('user@example.com')).find((m) => m.name === 'notion')!;
    expect(oauth.setup).toEqual({ kind: 'oauth-auto' });

    const openSvc = svcWith({ statusFor: async () => ({ status: 'open' as const }) });
    const open = (await openSvc.listAccessible('user@example.com')).find((m) => m.name === 'notion')!;
    expect(open.setup).toEqual({ kind: 'open' });

    // The `unsupported` case (e.g. Google — no dynamic client registration) is
    // the one that must reach the admin UI rather than only the server logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manualSvc = svcWith({
      statusFor: async () => ({ status: 'unsupported' as const, reason: 'no dynamic client registration' }),
    });
    const manual = (await manualSvc.listAccessible('user@example.com')).find((m) => m.name === 'notion')!;
    expect(manual.setup).toEqual({ kind: 'oauth-manual', reason: 'no dynamic client registration' });
    // Still bare — the admin declares the provider; we don't inject a sign-in var.
    expect(manual.variables ?? []).toEqual([]);
    warn.mockRestore();
  });

  test('an open server leaves the tool untouched; a discovery failure never breaks the catalog', async () => {
    const openSvc = svcWith({ statusFor: async () => ({ status: 'open' as const }) });
    const open = await openSvc.listAccessible('user@example.com');
    expect(open.find((m) => m.name === 'notion')!.variables ?? []).toEqual([]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingSvc = svcWith({
      statusFor: async () => {
        throw new Error('network exploded');
      },
    });
    const survived = await throwingSvc.listAccessible('user@example.com');
    expect(survived.map((m) => m.name).sort()).toEqual(['jira', 'notion']);
    warn.mockRestore();
  });

  /** An mcp.json server whose plugin.json declares a sign-in by client id alone. */
  async function writeDeclaredServer(oauth: Record<string, unknown>) {
    const pluginDir = join(root, wsId, KB_DIR, 'Plugins', 'GTM');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { hubspot: { type: 'streamable-http', url: 'https://mcp.hubspot.example/mcp' } } }),
    );
    await writeFile(
      join(pluginDir, 'plugin.json'),
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
    );
  }

  test('a declared client id without endpoints is completed from the server metadata; a miss lands in setup.reason', async () => {
    await writeDeclaredServer({ clientId: 'owner-app' });
    const statusFor = vi.fn(async () => ({ status: 'open' as const }));
    const providerForDeclaredClient = vi.fn(async () => ({
      status: 'oauth' as const,
      provider: {
        authorizationUrl: 'https://auth.hubspot.example/authorize',
        tokenUrl: 'https://auth.hubspot.example/token',
        clientId: 'owner-app',
        pkce: true,
        resource: 'https://mcp.hubspot.example/mcp',
      },
    }));
    const svc = svcWith({ statusFor, providerForDeclaredClient });
    const hubspot = (await svc.listAccessible('user@example.com')).find((m) => m.name === 'hubspot')!;
    // Explicit wins: a declared server is never probed for registration…
    expect(statusFor).not.toHaveBeenCalledWith('hubspot', expect.anything());
    expect(providerForDeclaredClient).toHaveBeenCalledWith('hubspot', 'https://mcp.hubspot.example/mcp', 'owner-app');
    // …its declaration is completed in place — an owner-registered sign-in
    // with nothing left to explain, so no `reason`.
    expect(hubspot.setup).toEqual({ kind: 'oauth-manual' });
    expect(hubspot.variables?.[0].oauth).toEqual({
      clientId: 'owner-app',
      authorizationUrl: 'https://auth.hubspot.example/authorize',
      tokenUrl: 'https://auth.hubspot.example/token',
      resource: 'https://mcp.hubspot.example/mcp',
    });

    // When the metadata can't be had, the declaration stays incomplete and the
    // reason travels with the tool — to the UI banner and to `list_tool_setup`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = svcWith({
      statusFor,
      providerForDeclaredClient: async () => ({
        status: 'unsupported' as const,
        reason: 'no authorization-server metadata at https://mcp.hubspot.example',
      }),
    });
    const stuck = (await missing.listAccessible('user@example.com')).find((m) => m.name === 'hubspot')!;
    expect(stuck.setup).toEqual({
      kind: 'oauth-manual',
      reason: 'no authorization-server metadata at https://mcp.hubspot.example',
    });
    expect(stuck.variables?.[0].oauth).toEqual({ clientId: 'owner-app' });
    // A port without the declared-client path says so rather than pretending.
    const legacy = svcWith({ statusFor });
    const unsupported = (await legacy.listAccessible('user@example.com')).find((m) => m.name === 'hubspot')!;
    expect(unsupported.setup?.reason).toContain('discovery is unavailable');
    warn.mockRestore();
  });

  test('a fully declared sign-in is oauth-manual with no reason, and is never probed', async () => {
    await writeDeclaredServer({
      clientId: 'owner-app',
      authorizationUrl: 'https://auth.hubspot.example/authorize',
      tokenUrl: 'https://auth.hubspot.example/token',
      pkce: false,
    });
    const statusFor = vi.fn(async () => ({ status: 'open' as const }));
    const providerForDeclaredClient = vi.fn();
    const svc = svcWith({ statusFor, providerForDeclaredClient });
    const hubspot = (await svc.listAccessible('user@example.com')).find((m) => m.name === 'hubspot')!;
    expect(hubspot.setup).toEqual({ kind: 'oauth-manual' });
    expect(providerForDeclaredClient).not.toHaveBeenCalled();
    expect(statusFor).not.toHaveBeenCalledWith('hubspot', expect.anything());
    // The declaration is carried verbatim, opt-out included.
    expect(hubspot.variables?.[0].oauth).toMatchObject({ clientId: 'owner-app', pkce: false });
  });
});
