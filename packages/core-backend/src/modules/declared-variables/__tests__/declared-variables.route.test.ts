import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeclaredVariableRoutes } from '../declared-variables.routes.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';

/**
 * The one core route that releases secret VALUES. What is worth pinning here is
 * not the happy path but the shape of the boundary: the caller names a FILE,
 * the server decides the variables, unreadable means 404, and a
 * platform-executed tool never releases anything.
 */

const GIT_TOOL: ToolManualSummary = {
  slug: 'git',
  name: 'git',
  path: 'Plugins/Engineering/software.bevel.hexis/tools/git.tool',
  type: 'inline',
  remote: false,
  variables: [
    { name: 'GITHUB_TOKEN', scope: 'admin' },
    { name: 'OPTIONAL_TOKEN', scope: 'admin' },
  ],
};

const REMOTE_TOOL: ToolManualSummary = {
  slug: 'billing',
  name: 'billing',
  path: 'Plugins/billing.tool',
  type: 'http',
  remote: true,
  variables: [{ name: 'BILLING_KEY', scope: 'admin' }],
};

let httpServer: HttpServer | undefined;

interface Harness {
  base: string;
  resolve: ReturnType<typeof vi.fn>;
}

async function mount(opts: {
  userId?: string;
  manuals?: ToolManualSummary[];
  secrets?: Record<string, string>;
}): Promise<Harness> {
  const userId = opts.userId ?? 'user-1';
  const secrets = opts.secrets ?? {};
  const resolve = vi.fn(async (_u: string, key: string) => secrets[key] ?? null);

  const toolManualService = {
    listAccessible: async () => opts.manuals ?? [],
  } as unknown as IToolManualService;
  const secretsVault = { resolve } as unknown as ISecretsVaultService;

  const app = express();
  app.use(express.json());
  app.use(
    createDeclaredVariableRoutes(
      toolManualService,
      secretsVault,
      (req, _res, next) => {
        if (userId) req.toolAuth = { userId } as typeof req.toolAuth;
        next();
      },
      async () => 'runner@x.eu',
    ),
  );
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, resolve };
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

describe('POST /agent/local-tools/:slug/variables', () => {
  it('resolves exactly what the manual declares, and reports the rest as missing', async () => {
    const { base, resolve } = await mount({
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_secret' },
    });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'git',
      variables: { GITHUB_TOKEN: 'ghp_secret' },
      missing: ['OPTIONAL_TOKEN'],
    });
    // The keys asked of the vault come from the FILE, namespaced per manual.
    expect(resolve.mock.calls.map((c) => c[1])).toEqual(['git_GITHUB_TOKEN', 'git_OPTIONAL_TOKEN']);
  });

  it('never caches a response carrying a secret', async () => {
    const { base } = await mount({ manuals: [GIT_TOOL], secrets: { git_GITHUB_TOKEN: 'x' } });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a tool the platform itself executes', async () => {
    // A remote-capable tool's credentials are used server-side; releasing them
    // would egress a secret that had no reason to leave.
    const { base, resolve } = await mount({ manuals: [REMOTE_TOOL], secrets: { billing_BILLING_KEY: 'k' } });
    const res = await fetch(`${base}/agent/local-tools/billing/variables`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('404s a manual the caller cannot read', async () => {
    const { base, resolve } = await mount({ manuals: [] });
    expect((await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('403s an unauthenticated caller', async () => {
    const { base } = await mount({ userId: '', manuals: [GIT_TOOL] });
    expect((await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(403);
  });
});
