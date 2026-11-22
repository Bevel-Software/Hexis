import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeclaredVariableRoutes } from '../declared-variables.routes.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';
import { ConnectionScope } from '../../agent-scope/index.js';

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
  /** How the caller authenticated. `session` is a browser; anything else is a machine. */
  source?: 'session' | 'external' | 'internal';
  manuals?: ToolManualSummary[];
  secrets?: Record<string, string>;
  /** What the caller's connection loads, as the verifier resolved it; absent is Myself. */
  connection?: ConnectionScope;
  /** The person behind a connection made as a bot (`userId` is then the bot's row). */
  madeBy?: { id: string; email: string };
}): Promise<Harness & { listedFor: string[] }> {
  const userId = opts.userId ?? 'user-1';
  const source = opts.source ?? 'external';
  const secrets = opts.secrets ?? {};
  // A secret keyed `<user id>:<key>` is that identity's own; a bare key is anyone's.
  const resolve = vi.fn(async (u: string, key: string) => secrets[`${u}:${key}`] ?? secrets[key] ?? null);
  const listedFor: string[] = [];

  const toolManualService = {
    listAccessible: async (email: string) => {
      listedFor.push(email);
      return opts.manuals ?? [];
    },
  } as unknown as IToolManualService;
  const secretsVault = { resolve } as unknown as ISecretsVaultService;

  const app = express();
  app.use(express.json());
  app.use(
    createDeclaredVariableRoutes(
      toolManualService,
      secretsVault,
      (req, _res, next) => {
        if (userId) {
          req.toolAuth = {
            userId,
            source,
            scope: 'write',
            ...(opts.connection ? { connection: opts.connection } : {}),
            ...(opts.madeBy ? { madeBy: opts.madeBy } : {}),
          } as typeof req.toolAuth;
        }
        next();
      },
      async (id: string) => (id === 'u-bot' ? 'ops@agent.hexis' : 'runner@x.eu'),
    ),
  );
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, resolve, listedFor };
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

  it('returns a variable named __proto__ rather than losing it to the prototype', async () => {
    // `__proto__` is a valid `[A-Za-z0-9_]+` name. On a plain object the
    // assignment sets the prototype, and the resolved secret vanished from the
    // response with nothing to say it had.
    const proto: ToolManualSummary = { ...GIT_TOOL, variables: [{ name: '__proto__', scope: 'admin' }] };
    const { base } = await mount({ manuals: [proto], secrets: { git___proto__: 'p-secret' } });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    const body = (await res.json()) as { variables: Record<string, string>; missing: string[] };
    expect(body.variables.__proto__).toBe('p-secret');
    expect(body.missing).toEqual([]);
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

  it('releases a bot connection the bot\'s own variables, and a connection that loads nothing none', async () => {
    // Made as a usable bot: the caller IS the bot (the verifier put its row on
    // the request), so what it may read is what it is handed.
    const asBot = await mount({
      userId: 'u-bot',
      madeBy: { id: 'user-1', email: 'dana@acme.com' },
      manuals: [GIT_TOOL],
      secrets: { 'u-bot:git_GITHUB_TOKEN': 'ghp_bot_secret', 'user-1:git_GITHUB_TOKEN': 'ghp_person_secret' },
      connection: ConnectionScope.asBot({ path: 'ops@agent.hexis', name: 'ops' }, null, 'fp'),
    });
    const res = await fetch(`${asBot.base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(200);
    // The bot's own secret, read from the bot's vault and judged for the bot's
    // address — never the person's.
    expect(((await res.json()) as { variables: Record<string, string> }).variables.GITHUB_TOKEN).toBe('ghp_bot_secret');
    expect(asBot.resolve.mock.calls.every((c) => c[0] === 'u-bot')).toBe(true);
    expect(asBot.listedFor).toEqual(['ops@agent.hexis']);
    await new Promise<void>((r) => httpServer!.close(() => r()));

    // A bot that cannot be used loads nothing: as absent as an unreadable tool.
    const gone = await mount({
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_person_secret' },
      connection: ConnectionScope.unavailable({ path: 'ops', name: 'ops' }, 'It loads nothing.', 'fp'),
    });
    expect((await fetch(`${gone.base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(404);
    expect(gone.resolve).not.toHaveBeenCalled();
  });

  it('403s an unauthenticated caller', async () => {
    const { base } = await mount({ userId: '', manuals: [GIT_TOOL] });
    expect((await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(403);
  });

  it('refuses a BROWSER SESSION, even one that can read the tool', async () => {
    // `manualAuth` accepts a session JWT, which is right for manual discovery
    // and wrong here: this route hands back secret VALUES, and the Secrets page
    // is deliberately write-only — a field starts empty even when a value
    // exists. A session that could read values back would undo that for anyone
    // with mere READ access to a `.tool`.
    const { base, resolve } = await mount({
      source: 'session',
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_secret' },
    });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('ghp_secret');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows the machine callers that need it', async () => {
    for (const source of ['external', 'internal'] as const) {
      const { base } = await mount({ source, manuals: [GIT_TOOL], secrets: { git_GITHUB_TOKEN: 'x' } });
      expect((await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(200);
      if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
      httpServer = undefined;
    }
  });
});
