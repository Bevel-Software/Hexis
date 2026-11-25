import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeclaredVariableRoutes } from '../declared-variables.routes.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../agent-scope/index.js';

/**
 * The one core route that releases secret VALUES. What is worth pinning here is
 * not the happy path but the shape of the boundary: only the local server's
 * browser sign-in is answered (never a connection key, the agent's credential),
 * the caller names a FILE, the server decides the variables, a shared value
 * goes only to a writer of the tool, unreadable means 404, and a
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
  listAccessible: ReturnType<typeof vi.fn>;
  mayWriteTool: ReturnType<typeof vi.fn>;
}

async function mount(opts: {
  userId?: string;
  /** How the caller authenticated. `session` is a browser. */
  source?: 'session' | 'external' | 'internal';
  /**
   * Whether the credential is the local server's exchanged browser sign-in.
   * Defaults to true unless `tokenId` is set: a connection key is
   * `source: external` with a `tokenId` and without the flag.
   */
  localRuntime?: boolean;
  /** A connection key's id: set, the caller is a key. */
  tokenId?: string;
  /** Whether the caller may write the tool (and so be handed its shared values). Default true. */
  mayWrite?: boolean;
  manuals?: ToolManualSummary[];
  secrets?: Record<string, string>;
  /** The `.agent` file the caller's connection was made as; absent is Everything. */
  agentPath?: string;
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>;
}): Promise<Harness> {
  const userId = opts.userId ?? 'user-1';
  const source = opts.source ?? 'external';
  const secrets = opts.secrets ?? {};
  const resolve = vi.fn(async (_u: string, key: string) => secrets[key] ?? null);

  const toolManualService = {
    listAccessible: vi.fn(async () => opts.manuals ?? []),
  } as unknown as IToolManualService;
  const mayWriteTool = vi.fn(async () => opts.mayWrite ?? true);
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
            ...((opts.localRuntime ?? !opts.tokenId) ? { localRuntime: true } : {}),
            ...(opts.tokenId ? { tokenId: opts.tokenId } : {}),
            ...(opts.agentPath ? { agentPath: opts.agentPath } : {}),
          } as typeof req.toolAuth;
        }
        next();
      },
      async () => 'runner@x.eu',
      mayWriteTool,
      opts.agentScope,
    ),
  );
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    resolve,
    listAccessible: toolManualService.listAccessible as unknown as ReturnType<typeof vi.fn>,
    mayWriteTool,
  };
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
      withheld: [],
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

  it("releases only the variables of a connector the connection's .agent file loads", async () => {
    const agent = { path: 'Agents/ops.agent', name: 'Ops' };
    const loading = (connectors: string[]) => ({
      resolve: async () => ConnectionScope.narrowed(agent, { skills: [], connectors, platformTools: null }, 'fp'),
    });
    // A folder entry over the tool's plugin loads it.
    const inScope = await mount({
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_secret' },
      agentPath: agent.path,
      agentScope: loading(['Plugins/Engineering']),
    });
    expect((await fetch(`${inScope.base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(200);
    await new Promise<void>((r) => httpServer!.close(() => r()));

    // A readable tool the file does not load is as absent as an unreadable one.
    const outOfScope = await mount({
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_secret' },
      agentPath: agent.path,
      agentScope: loading(['Plugins/billing.tool']),
    });
    expect((await fetch(`${outOfScope.base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(404);
    expect(outOfScope.resolve).not.toHaveBeenCalled();
    await new Promise<void>((r) => httpServer!.close(() => r()));

    // A narrowed connection with no resolver wired loads nothing.
    const unwired = await mount({ manuals: [GIT_TOOL], agentPath: agent.path });
    expect((await fetch(`${unwired.base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(404);
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

  it("refuses a read-only Business user's connection key on a shared local tool, with no value", async () => {
    // The QA reproduction (v0.35.0, bug B2): an admin-scope secret on a
    // `remote: false` tool in a plugin everyone reads, asked for with a
    // reader's connection key. The key is the credential an agent holds.
    const { base, resolve, listAccessible } = await mount({
      source: 'external',
      tokenId: 'key-business',
      mayWrite: false,
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_shared_admin_marker' },
    });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('ghp_shared_admin_marker');
    expect(text).not.toContain('GITHUB_TOKEN');
    expect(resolve).not.toHaveBeenCalled();
    // Refused before the manual is looked up: the answer says nothing about which tools exist.
    expect(listAccessible).not.toHaveBeenCalled();
  });

  it("refuses a writer's connection key too: no key receives a value", async () => {
    const { base, resolve } = await mount({
      source: 'external',
      tokenId: 'key-admin',
      mayWrite: true,
      manuals: [GIT_TOOL],
      secrets: { git_GITHUB_TOKEN: 'ghp_shared_admin_marker' },
    });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('ghp_shared_admin_marker');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses every credential but the local sign-in: an agent token, a hosted loopback token', async () => {
    for (const source of ['internal', 'external'] as const) {
      const { base, resolve } = await mount({
        source,
        localRuntime: false,
        manuals: [GIT_TOOL],
        secrets: { git_GITHUB_TOKEN: 'ghp_secret' },
      });
      const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('ghp_secret');
      expect(resolve).not.toHaveBeenCalled();
      await new Promise<void>((r) => httpServer!.close(() => r()));
      httpServer = undefined;
    }
  });

  it('does not take a local-runtime flag on an internal token as the local sign-in', async () => {
    // Only the verifier's external-proxy branch sets the flag; a token that
    // somehow carried it with another source is still refused.
    const { base, resolve } = await mount({ source: 'internal', localRuntime: true, manuals: [GIT_TOOL] });
    expect((await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('withholds a shared value from a reader of the tool, and still hands them their own', async () => {
    const mixed: ToolManualSummary = {
      ...GIT_TOOL,
      variables: [
        { name: 'GITHUB_TOKEN', scope: 'admin' },
        { name: 'MY_TOKEN', scope: 'user' },
      ],
    };
    const { base, resolve, mayWriteTool } = await mount({
      mayWrite: false,
      manuals: [mixed],
      secrets: { git_GITHUB_TOKEN: 'ghp_shared_admin_marker', git_MY_TOKEN: 'mine' },
    });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('ghp_shared_admin_marker');
    expect(JSON.parse(text)).toEqual({ name: 'git', variables: { MY_TOKEN: 'mine' }, missing: [], withheld: ['GITHUB_TOKEN'] });
    // The shared value is never even resolved for them.
    expect(resolve.mock.calls.map((c) => c[1])).toEqual(['git_MY_TOKEN']);
    expect(mayWriteTool).toHaveBeenCalledWith('runner@x.eu', GIT_TOOL.path);
  });

  it("releases a shared value to the local sign-in of the tool's writer", async () => {
    const { base } = await mount({ mayWrite: true, manuals: [GIT_TOOL], secrets: { git_GITHUB_TOKEN: 'ghp_secret' } });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { variables: Record<string, string> }).variables).toEqual({ GITHUB_TOKEN: 'ghp_secret' });
  });

  it('does not ask for the write verdict when a tool declares only personal values', async () => {
    const personal: ToolManualSummary = { ...GIT_TOOL, variables: [{ name: 'MY_TOKEN', scope: 'user' }] };
    const { base, mayWriteTool } = await mount({ manuals: [personal], secrets: { git_MY_TOKEN: 'mine' } });
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mayWriteTool).not.toHaveBeenCalled();
  });

  it('answers 500, never a value or a refusal that blames the caller, when the write verdict fails', async () => {
    const { base, resolve, mayWriteTool } = await mount({ manuals: [GIT_TOOL], secrets: { git_GITHUB_TOKEN: 'ghp_secret' } });
    mayWriteTool.mockRejectedValueOnce(new Error('access tree unreadable'));
    const res = await fetch(`${base}/agent/local-tools/git/variables`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('ghp_secret');
    expect(resolve).not.toHaveBeenCalled();
  });
});
