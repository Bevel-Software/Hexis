import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretsVaultRoutes, InvalidSecretError, SecretOAuthError } from '../index.js';
import type { ToolManualSummary, ToolVariable } from '../../tool-manuals/index.js';

/**
 * The tool-scoped sign-in start follows the tool file as it reads NOW
 * (`liveDeclaration`), not the catalog's cached scan and not the copy the
 * owner's client-secret save stored. A client the platform registered itself
 * (oauth-auto) is described by no file and still starts from its stored row.
 *
 * The incident: the GTM plugin's HubSpot connector was replaced, the file got
 * the new client id, the new secret was saved — and every sign-in still asked
 * for consent under the old client id.
 */

const USER = 'owner@x.com';
const ENDPOINTS = {
  authorizationUrl: 'https://app.hubspot.example/oauth/authorize',
  tokenUrl: 'https://api.hubspot.example/oauth/v1/token',
};

const manual = (variables: ToolVariable[], setup?: ToolManualSummary['setup']): ToolManualSummary => ({
  slug: 'hubspot',
  name: 'hubspot',
  path: 'Plugins/GTM/.claude-plugin/plugin.json',
  type: 'mcp',
  variables,
  ...(setup ? { setup } : {}),
});
const signIn = (oauth?: ToolVariable['oauth']): ToolVariable => ({
  name: 'HUBSPOT_TOKEN',
  scope: 'user',
  ...(oauth ? { oauth } : {}),
});

let httpServer: HttpServer | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
  httpServer = undefined;
});

/** One server whose catalog says `catalog` and whose file says `live`. */
async function serve(opts: {
  catalog: ToolManualSummary[];
  live: { manual: ToolManualSummary; variable?: ToolVariable } | null;
  begin?: (input: Record<string, unknown>) => Promise<{ id: string; url: string }>;
  canWrite?: boolean;
  varName?: string;
  /** The live read fails outright (the workspace cannot be opened) instead of answering. */
  liveError?: Error;
}) {
  const beginToolOAuthByKey = vi.fn(
    opts.begin ?? (async () => ({ id: 'row-1', url: 'https://app.hubspot.example/oauth/authorize?client_id=x' })),
  );
  const putSharedOAuthClientSecret = vi.fn(async () => {});
  const liveDeclaration = vi.fn(async () => {
    if (opts.liveError) throw opts.liveError;
    return opts.live;
  });
  const deps = {
    secretsVault: { beginToolOAuthByKey, putSharedOAuthClientSecret },
    toolManualService: { listAccessible: async () => opts.catalog, liveDeclaration },
    accessControl: { canRead: async () => true, canWrite: async () => opts.canWrite ?? false },
    connectionProbe: {},
    kb: { defaultWorkspaceId: () => 'main' },
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
  const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/secrets/tools/hubspot/vars/${opts.varName ?? 'HUBSPOT_TOKEN'}`;
  return {
    beginToolOAuthByKey,
    putSharedOAuthClientSecret,
    liveDeclaration,
    start: () => fetch(`${base}/oauth/start`, { method: 'POST' }),
    saveSecret: () =>
      fetch(`${base}/oauth/admin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientSecret: 'cs' }),
      }),
  };
}

describe('POST …/oauth/start — a declared sign-in follows the live declaration', () => {
  it('hands the vault the file’s client id, endpoints, PKCE and resource, even when the catalog still says otherwise', async () => {
    const stale = manual([signIn({ clientId: 'client-A', ...ENDPOINTS })], { kind: 'oauth-manual' });
    const fresh = manual([signIn({ clientId: 'client-B', ...ENDPOINTS, scopes: ['crm.read'], resource: 'https://mcp.hubspot.example/' })], {
      kind: 'oauth-manual',
    });
    const s = await serve({ catalog: [stale], live: { manual: fresh, variable: fresh.variables![0] } });

    const res = await s.start();
    expect(res.status).toBe(200);
    expect(s.liveDeclaration).toHaveBeenCalledWith(USER, 'hubspot', 'HUBSPOT_TOKEN');
    expect(s.beginToolOAuthByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'hubspot_HUBSPOT_TOKEN',
        scopes: ['crm.read'],
        provider: {
          ...ENDPOINTS,
          clientId: 'client-B',
          scopes: ['crm.read'],
          authParams: undefined,
          pkce: true,
          resource: 'https://mcp.hubspot.example/',
        },
      }),
    );
  });

  it('a declaration opting out of PKCE is handed over as such', async () => {
    const fresh = manual([signIn({ clientId: 'client-B', ...ENDPOINTS, pkce: false })]);
    const s = await serve({ catalog: [fresh], live: { manual: fresh, variable: fresh.variables![0] } });
    expect((await s.start()).status).toBe(200);
    expect(s.beginToolOAuthByKey.mock.calls[0][0]).toMatchObject({ provider: { pkce: false } });
  });

  it('refuses a declaration whose endpoints could not be discovered with the discovery reason — the save’s own wording', async () => {
    const reason = 'no authorization-server metadata at https://mcp.hubspot.example';
    const stuck = manual([signIn({ clientId: 'client-B' })], { kind: 'oauth-manual', reason });
    const s = await serve({ catalog: [stuck], live: { manual: stuck, variable: stuck.variables![0] }, canWrite: true });

    const res = await s.start();
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe(`The sign-in endpoints for this server aren't known yet: ${reason}.`);
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();

    const saved = await s.saveSecret();
    expect(saved.status).toBe(422);
    expect(((await saved.json()) as { error: string }).error).toBe(error);
  });

  it('refuses with "owner hasn’t finished" when the oauth block was removed from the file, never using the stored row', async () => {
    const stale = manual([signIn({ clientId: 'client-A', ...ENDPOINTS })], { kind: 'oauth-manual' });
    const fresh = manual([signIn()]);
    const s = await serve({ catalog: [stale], live: { manual: fresh, variable: fresh.variables![0] } });

    const res = await s.start();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("This tool's owner hasn't finished setting this up");
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();
  });

  it('passes on the vault’s refusals: a missing secret, and an endpoint that fails validation', async () => {
    const fresh = manual([signIn({ clientId: 'client-B', ...ENDPOINTS, tokenUrl: 'http://127.0.0.1/token' })]);
    const refusing = await serve({
      catalog: [fresh],
      live: { manual: fresh, variable: fresh.variables![0] },
      begin: async () => {
        throw new InvalidSecretError('tokenUrl must use https');
      },
    });
    const invalid = await refusing.start();
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: string }).error).toBe('tokenUrl must use https');
    await new Promise<void>((r) => httpServer!.close(() => r()));

    const unset = await serve({
      catalog: [fresh],
      live: { manual: fresh, variable: fresh.variables![0] },
      begin: async () => {
        throw new SecretOAuthError("This tool's owner hasn't finished setting this up");
      },
    });
    const res = await unset.start();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("This tool's owner hasn't finished setting this up");
  });

  it('a platform-registered sign-in (oauth-auto) starts from its stored row: no provider is handed over', async () => {
    const auto = manual(
      [{ name: 'MCP_OAUTH', scope: 'user', oauth: { clientId: 'dcr-1', ...ENDPOINTS } }],
      { kind: 'oauth-auto' },
    );
    // The file declares no such variable: the catalog's discovery synthesised it.
    const s = await serve({ catalog: [auto], live: { manual: manual([]) }, varName: 'MCP_OAUTH' });
    expect((await s.start()).status).toBe(200);
    const input = s.beginToolOAuthByKey.mock.calls[0][0];
    expect(input).toMatchObject({ key: 'hubspot_MCP_OAUTH' });
    expect(input.provider).toBeUndefined();
  });

  it('answers 404 when neither the file nor the catalog knows the tool', async () => {
    const s = await serve({ catalog: [], live: null });
    expect((await s.start()).status).toBe(404);
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();
  });

  it('answers 500 when the tool files cannot be read, never a misconfiguration verdict from the catalog', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The catalog still holds a declared sign-in; a live read that fails must
    // not fall back to it and answer "owner hasn't finished" (409) or "not
    // found" (404) for what is a server fault.
    const stale = manual([signIn({ clientId: 'client-A', ...ENDPOINTS })], { kind: 'oauth-manual' });
    const s = await serve({ catalog: [stale], live: null, liveError: new Error('workspace unavailable') });

    const res = await s.start();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Internal error');
    expect(s.beginToolOAuthByKey).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
