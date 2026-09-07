import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';

import { MarketplaceRepoService, type MarketplaceCompiler } from '../marketplace-repo.service.js';
import {
  ClaudeBridgeCredentialsService,
  ClaudeMarketplaceBridge,
  MemoryClaudeBridgeCredentialsStore,
  CLAUDE_CLIENT_NAME,
  CLAUDE_LINK_KEY_LABEL,
  CLAUDE_LINK_KEY_PREFIX,
  createClaudeBridgeAdminRoutes,
  createClaudeBridgeRoutes,
} from '../claude-bridge/index.js';
import { createOAuthConsentRoutes } from '../../mcp/oauth/oauth-consent.routes.js';
import type { BevelOAuthProvider } from '../../mcp/oauth/bevel-oauth-provider.js';
import type { VirtualTree } from '../../plugins/compile/compile-marketplace.js';

/**
 * The GitHub-shaped surface, driven exactly as claude.ai drove the facade
 * that recorded the contract: the authorize redirect, the consent finish,
 * the code exchange with our client id and secret, then — with the token
 * that came back — repository, head commit, zipball. Two people, two trees,
 * and a token that reads only its own.
 */

const CALLBACK = 'https://claude.ai/connect/github/callback';
const FRONTEND = 'http://app.test';
const PUBLIC = 'https://kb.acme.com';
const STATE_SECRET = 'state-secret';

const users: Record<string, AuthUser> = {
  alice: { id: 'user-alice', email: 'alice@x.io', name: 'Alice' } as AuthUser,
  bob: { id: 'user-bob', email: 'bob@x.io', name: 'Bob' } as AuthUser,
};

function tree(files: Record<string, string>, sourceCommit: string): VirtualTree & { sourceCommit: string } {
  return {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    warnings: [],
    plugins: [],
    sourceCommit,
  };
}

/** Connection keys, in memory: what the service does minus the database. */
function makeKeys() {
  const byToken = new Map<string, { tokenId: string; user: AuthUser; label: string }>();
  const prefixes = ['bevel_', CLAUDE_LINK_KEY_PREFIX];
  return {
    byToken,
    looksLikeExternalApiKey: (t: string) => prefixes.some((p) => t.startsWith(p)),
    verifyAndLoadToken: async (t: string) => {
      const hit = byToken.get(t);
      return hit ? { tokenId: hit.tokenId, user: hit.user } : null;
    },
    mint: async (userId: string, label: string, options: { prefix?: string } = {}) => {
      const prefix = options.prefix ?? 'bevel_';
      if (!prefixes.includes(prefix)) throw new Error(`Unknown key prefix "${prefix}"`);
      const user = Object.values(users).find((u) => u.id === userId)!;
      const plaintext = prefix + randomBytes(16).toString('base64url');
      byToken.set(plaintext, { tokenId: `tok-${byToken.size + 1}`, user, label });
      return {
        plaintext,
        summary: { id: `tok-${byToken.size}`, label, createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
      };
    },
  };
}

describe('the Claude marketplace bridge', () => {
  let root: string;
  let server: http.Server;
  let base: string;
  let keys: ReturnType<typeof makeKeys>;
  let credentials: ClaudeBridgeCredentialsService;
  let repo: MarketplaceRepoService;
  const admins = new Set(['alice@x.io']);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bridge-'));
    const trees: Record<string, Record<string, string>> = {
      'alice@x.io': { 'README.md': 'alice\n', '.claude-plugin/marketplace.json': '{"name":"hexis"}\n', 'plugins/gtm/skills/deploy/SKILL.md': 'ship\n' },
      'bob@x.io': { 'README.md': 'bob\n', '.claude-plugin/marketplace.json': '{"name":"hexis"}\n' },
    };
    const compiler: MarketplaceCompiler = {
      sourceCommit: async () => 'aaa111',
      compileFor: async ({ userEmail }) => tree(trees[userEmail] ?? {}, 'aaa111'),
    };
    repo = new MarketplaceRepoService(path.join(root, 'marketplace.git'), compiler);
    keys = makeKeys();
    credentials = new ClaudeBridgeCredentialsService(new MemoryClaudeBridgeCredentialsStore());
    const bridge = new ClaudeMarketplaceBridge({
      credentials,
      keys,
      stateSecret: STATE_SECRET,
      publicFrontendUrl: FRONTEND,
    });

    const app = express();
    app.use(
      createClaudeBridgeRoutes({ bridge, keys, repo, owner: 'git', repoName: 'marketplace', publicUrl: PUBLIC }),
    );
    // The consent routes as the SPA reaches them: behind a session. The
    // session here is a header naming the person.
    const session: express.RequestHandler = (req, _res, next) => {
      const who = req.header('x-test-user');
      if (who && users[who]) {
        req.userId = users[who].id;
        req.userEmail = users[who].email;
      }
      next();
    };
    const provider = {
      clientsStore: { getClient: async () => undefined },
      issueAuthCode: async () => {
        throw new Error('the SDK code path must not be reached for a Claude link');
      },
    } as unknown as BevelOAuthProvider;
    app.use(
      '/api',
      session,
      express.json(),
      createOAuthConsentRoutes({
        provider,
        stateSecret: STATE_SECRET,
        bridge: {
          isBridgeRequest: (st) => bridge.isBridgeRequest(st),
          clientName: CLAUDE_CLIENT_NAME,
          completeConsent: (userId, st) => bridge.completeConsent(userId, st),
        },
      }),
      createClaudeBridgeAdminRoutes({
        credentials,
        isAdmin: async (email) => admins.has(email ?? ''),
        publicUrl: PUBLIC,
        marketplaceUrl: `${PUBLIC}/git/marketplace.git`,
      }),
    );
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The whole connect flow for one person, as the browser and Anthropic's backend run it. */
  async function connect(who: string): Promise<string> {
    const creds = await credentials.ensure();
    const authorize = await fetch(
      `${base}/login/oauth/authorize?client_id=${encodeURIComponent(creds.clientId)}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=claude-state`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${FRONTEND}/connect`);
    const state = location.searchParams.get('oauth')!;

    const request = await fetch(`${base}/api/mcp/oauth/request?state=${encodeURIComponent(state)}`, {
      headers: { 'x-test-user': who },
    });
    expect(await request.json()).toEqual({ clientName: 'Claude', scope: null, resource: null });

    const complete = await fetch(`${base}/api/mcp/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': who },
      body: JSON.stringify({ state }),
    });
    expect(complete.status).toBe(200);
    const redirectTo = new URL(((await complete.json()) as { redirectTo: string }).redirectTo);
    expect(redirectTo.origin + redirectTo.pathname).toBe(CALLBACK);
    expect(redirectTo.searchParams.get('state')).toBe('claude-state');
    const code = redirectTo.searchParams.get('code')!;

    const token = await fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/vnd.github+json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; token_type: string; scope: string };
    expect(body.token_type).toBe('bearer');
    expect(body.access_token.startsWith(CLAUDE_LINK_KEY_PREFIX)).toBe(true);
    return body.access_token;
  }

  const api = (token: string, p: string) =>
    fetch(`${base}/api/v3${p}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });

  it('connects a person and mints them a Claude-shaped connection key', async () => {
    const token = await connect('alice');
    const minted = keys.byToken.get(token)!;
    expect(minted.user.id).toBe('user-alice');
    expect(minted.label).toBe(CLAUDE_LINK_KEY_LABEL);
  });

  it('serves the repository, the head commit and the zipball of that person’s own tree', async () => {
    const token = await connect('alice');

    const repoRes = await api(token, '/repos/git/marketplace');
    expect(repoRes.status).toBe(200);
    const repoBody = (await repoRes.json()) as { full_name: string; private: boolean; default_branch: string };
    expect(repoBody).toMatchObject({ full_name: 'git/marketplace', private: true, default_branch: 'main' });

    const commits = await api(token, '/repos/git/marketplace/commits?per_page=1');
    expect(commits.status).toBe(200);
    const [head] = (await commits.json()) as { sha: string; commit: { message: string } }[];
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(head.commit.message).toContain('aaa111');

    const zip = await api(token, `/repos/git/marketplace/zipball/${head.sha}`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const names = bytes.toString('latin1');
    const prefix = `git-marketplace-${head.sha.slice(0, 7)}/`;
    expect(names).toContain(`${prefix}README.md`);
    expect(names).toContain(`${prefix}plugins/gtm/skills/deploy/SKILL.md`);
  });

  it('keeps every person to their own tree: a foreign sha is not found', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const aliceHead = ((await (await api(alice, '/repos/git/marketplace/commits?per_page=1')).json()) as { sha: string }[])[0].sha;
    const bobHead = ((await (await api(bob, '/repos/git/marketplace/commits?per_page=1')).json()) as { sha: string }[])[0].sha;
    expect(aliceHead).not.toBe(bobHead);
    expect((await api(bob, `/repos/git/marketplace/zipball/${aliceHead}`)).status).toBe(404);
    const bobZip = Buffer.from(await (await api(bob, `/repos/git/marketplace/zipball/${bobHead}`)).arrayBuffer()).toString('latin1');
    expect(bobZip).not.toContain('plugins/gtm');
  });

  it('refuses what it should: bad secret, replayed code, wrong redirect, no token, other repos', async () => {
    const creds = await credentials.ensure();
    // A redirect anywhere but claude.ai never gets a code.
    const elsewhere = await fetch(
      `${base}/login/oauth/authorize?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      { redirect: 'manual' },
    );
    expect(elsewhere.status).toBe(400);
    // The wrong client id is unknown.
    const wrongClient = await fetch(
      `${base}/login/oauth/authorize?client_id=Iv1.nope&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    );
    expect(wrongClient.status).toBe(400);

    const token = await connect('alice');
    // A code is consumed by its exchange; the same code again is refused.
    const state = new URL((await fetch(
      `${base}/login/oauth/authorize?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    )).headers.get('location')!).searchParams.get('oauth')!;
    const complete = await fetch(`${base}/api/mcp/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ state }),
    });
    const code = new URL(((await complete.json()) as { redirectTo: string }).redirectTo).searchParams.get('code')!;
    const badSecret = await fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: 'not-it', code }),
    });
    expect(badSecret.status).toBe(401);
    expect(((await badSecret.json()) as { error: string }).error).toBe('incorrect_client_credentials');
    const first = await fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
    });
    expect(first.status).toBe(200);
    const replay = await fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('bad_verification_code');

    // The REST surface: no token, a revoked-looking token, another repository.
    const noToken = await fetch(`${base}/api/v3/repos/git/marketplace`);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toContain('Bearer');
    expect((await api('gho_unknown', '/repos/git/marketplace')).status).toBe(401);
    expect((await api(token, '/repos/someone/else')).status).toBe(404);
    expect((await api(token, '/user')).status).toBe(404);
    expect((await api(token, '/repos/git/marketplace/zipball/main..HEAD')).status).toBe(404);
  });

  it('a consent finish that is not a Claude link still goes to the SDK', async () => {
    // A state without `gh` is an MCP client's; the bridge must not claim it.
    const { signAuthRequest } = await import('../../mcp/oauth/oauth-state.js');
    const state = signAuthRequest(STATE_SECRET, { c: 'mcp-client', r: 'http://localhost/cb', cc: 'challenge' });
    const complete = await fetch(`${base}/api/mcp/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ state }),
    });
    expect(complete.status).toBe(500); // the stub SDK path throws — proving it was the one asked
  });

  it('hands an admin the registration fields, and rotating replaces every one of them', async () => {
    const forbidden = await fetch(`${base}/api/admin/claude-bridge`, { headers: { 'x-test-user': 'bob' } });
    expect(forbidden.status).toBe(403);
    const shown = await fetch(`${base}/api/admin/claude-bridge`, { headers: { 'x-test-user': 'alice' } });
    expect(shown.status).toBe(200);
    const before = (await shown.json()) as Record<string, string>;
    expect(before.host).toBe('kb.acme.com');
    expect(before.marketplaceUrl).toBe(`${PUBLIC}/git/marketplace.git`);
    expect(before.clientId).toMatch(/^Iv1\.[0-9a-f]{16}$/);
    expect(before.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(before.appId).toMatch(/^\d{6}$/);

    const rotated = await fetch(`${base}/api/admin/claude-bridge/rotate`, { method: 'POST', headers: { 'x-test-user': 'alice' } });
    const after = (await rotated.json()) as Record<string, string>;
    for (const field of ['appId', 'clientId', 'clientSecret', 'webhookSecret', 'privateKeyPem']) {
      expect(after[field]).not.toBe(before[field]);
    }
    // The old client id no longer authorizes.
    const stale = await fetch(
      `${base}/login/oauth/authorize?client_id=${before.clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    );
    expect(stale.status).toBe(400);
  });
});
