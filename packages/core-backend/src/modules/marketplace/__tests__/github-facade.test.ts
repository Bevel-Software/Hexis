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
  GitHubFacadeCredentialsService,
  GitHubFacade,
  MemoryGitHubFacadeCodeStore,
  MemoryGitHubFacadeCredentialsStore,
  CLAUDE_CONSUMER,
  GITHUB_LINK_KEY_KIND,
  GITHUB_LINK_KEY_PREFIX,
  createGitHubFacadeAdminRoutes,
  createGitHubFacadeRoutes,
} from '../github-facade/index.js';
import { createOAuthConsentRoutes } from '../../mcp/oauth/oauth-consent.routes.js';
import type { BevelOAuthProvider } from '../../mcp/oauth/bevel-oauth-provider.js';
import type { VirtualTree } from '../../plugins/compile/compile-marketplace.js';

/**
 * The GitHub-shaped surface, driven exactly as claude.ai drove the facade
 * that recorded the contract: the authorize redirect, the consent finish,
 * the code exchange with our client id and secret, then — with the token
 * that came back — repository, head commit, zipball. Two people, two trees,
 * a token that reads only its own — and two REPLICAS over one store, since
 * the replica that issued a code is not the one asked to exchange it.
 */

const CALLBACK = 'https://claude.ai/connect/github/callback';
const FRONTEND = 'http://app.test';
const PUBLIC = 'https://ops:hunter2@kb.acme.com/some/path';
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
  const byToken = new Map<string, { tokenId: string; user: AuthUser; label: string; kind: string }>();
  const kinds: Record<string, string> = { key: 'bevel_', [GITHUB_LINK_KEY_KIND]: GITHUB_LINK_KEY_PREFIX };
  return {
    byToken,
    looksLikeExternalApiKey: (t: string) => Object.values(kinds).some((p) => t.startsWith(p)),
    verifyAndLoadToken: async (t: string) => {
      const hit = byToken.get(t);
      return hit ? { tokenId: hit.tokenId, user: hit.user } : null;
    },
    mint: async (userId: string, label: string, options: { kind?: string } = {}) => {
      const kind = options.kind ?? 'key';
      const prefix = kinds[kind];
      if (!prefix) throw new Error(`Unknown key kind "${kind}"`);
      const user = Object.values(users).find((u) => u.id === userId)!;
      const plaintext = prefix + randomBytes(16).toString('base64url');
      byToken.set(plaintext, { tokenId: `tok-${byToken.size + 1}`, user, label, kind });
      return {
        plaintext,
        summary: { id: `tok-${byToken.size}`, label, kind, createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
      };
    },
  };
}

/** One replica: its own bridge over the SHARED stores, its own HTTP listener. */
async function replica(shared: {
  credentials: MemoryGitHubFacadeCredentialsStore;
  codes: MemoryGitHubFacadeCodeStore;
  keys: ReturnType<typeof makeKeys>;
  repo: MarketplaceRepoService;
  admins: Set<string>;
}) {
  const credentials = new GitHubFacadeCredentialsService(shared.credentials);
  const facade = new GitHubFacade({
    credentials,
    codes: shared.codes,
    keys: shared.keys,
    consumers: [CLAUDE_CONSUMER],
    stateSecret: STATE_SECRET,
    publicFrontendUrl: FRONTEND,
  });
  const app = express();
  app.use(
    createGitHubFacadeRoutes({ facade, keys: shared.keys, repo: shared.repo, owner: 'git', repoName: 'marketplace', publicUrl: PUBLIC }),
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
      facade: {
        isFacadeRequest: (st) => facade.isFacadeRequest(st),
        clientNameFor: (st) => facade.clientNameFor(st),
        completeConsent: (userId, st) => facade.completeConsent(userId, st),
      },
    }),
    createGitHubFacadeAdminRoutes({
      credentials,
      isAdmin: async (email) => shared.admins.has(email ?? ''),
      publicUrl: PUBLIC,
      marketplaceUrl: 'https://kb.acme.com/git/marketplace.git',
    }),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return { credentials, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('the GitHub facade', () => {
  let root: string;
  let shared: Parameters<typeof replica>[0];
  let a: Awaited<ReturnType<typeof replica>>;
  let b: Awaited<ReturnType<typeof replica>>;

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
    shared = {
      credentials: new MemoryGitHubFacadeCredentialsStore(),
      codes: new MemoryGitHubFacadeCodeStore(),
      keys: makeKeys(),
      repo: new MarketplaceRepoService(path.join(root, 'marketplace.git'), compiler),
      admins: new Set(['alice@x.io']),
    };
    a = await replica(shared);
    b = await replica(shared);
  });
  afterEach(async () => {
    await a.close();
    await b.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The browser's half: authorize on one replica, approve, and come back with a code. */
  async function approve(base: string, who: string, state = 'claude-state'): Promise<string> {
    const creds = await a.credentials.ensure();
    const authorize = await fetch(
      `${base}/login/oauth/authorize?client_id=${encodeURIComponent(creds.clientId)}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=${state}`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${FRONTEND}/connect`);
    const signed = location.searchParams.get('oauth')!;

    const request = await fetch(`${base}/api/mcp/oauth/request?state=${encodeURIComponent(signed)}`, {
      headers: { 'x-test-user': who },
    });
    expect(await request.json()).toEqual({ clientName: 'Claude', scope: null, resource: null });

    const complete = await fetch(`${base}/api/mcp/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': who },
      body: JSON.stringify({ state: signed }),
    });
    expect(complete.status).toBe(200);
    const redirectTo = new URL(((await complete.json()) as { redirectTo: string }).redirectTo);
    expect(redirectTo.origin + redirectTo.pathname).toBe(CALLBACK);
    expect(redirectTo.searchParams.get('state')).toBe(state);
    return redirectTo.searchParams.get('code')!;
  }

  /** Anthropic's half: the exchange, on whichever replica the load balancer picked. */
  async function exchange(base: string, body: Record<string, string>, accept = 'application/vnd.github+json') {
    return fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept },
      body: JSON.stringify(body),
    });
  }

  async function connect(who: string): Promise<string> {
    const creds = await a.credentials.ensure();
    const code = await approve(a.base, who);
    // The exchange lands on the OTHER replica.
    const token = await exchange(b.base, { client_id: creds.clientId, client_secret: creds.clientSecret, code });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; token_type: string; scope: string };
    expect(body.token_type).toBe('bearer');
    expect(body.access_token.startsWith(GITHUB_LINK_KEY_PREFIX)).toBe(true);
    return body.access_token;
  }

  const api = (base: string, token: string, p: string) =>
    fetch(`${base}/api/v3${p}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });

  it('connects a person across replicas and mints them a Claude-link key', async () => {
    const token = await connect('alice');
    const minted = shared.keys.byToken.get(token)!;
    expect(minted.user.id).toBe('user-alice');
    expect(minted.kind).toBe(GITHUB_LINK_KEY_KIND);
    expect(minted.label).toBe(CLAUDE_CONSUMER.keyLabel);
  });

  it('serves the repository, the head commit and the zipball of that person’s own tree — from the origin, never the configured userinfo', async () => {
    const token = await connect('alice');

    const repoRes = await api(b.base, token, '/repos/git/marketplace');
    expect(repoRes.status).toBe(200);
    const repoBody = (await repoRes.json()) as { full_name: string; private: boolean; default_branch: string; clone_url: string; url: string };
    expect(repoBody).toMatchObject({ full_name: 'git/marketplace', private: true, default_branch: 'main' });
    expect(repoBody.clone_url).toBe('https://kb.acme.com/git/marketplace.git');
    expect(JSON.stringify(repoBody)).not.toContain('hunter2');
    expect(JSON.stringify(repoBody)).not.toContain('/some/path');

    const commits = await api(a.base, token, '/repos/git/marketplace/commits?per_page=1');
    expect(commits.status).toBe(200);
    const [head] = (await commits.json()) as { sha: string; commit: { message: string }; url: string }[];
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(head.commit.message).toContain('aaa111');
    expect(head.url).toContain('https://kb.acme.com/api/v3/');

    const zip = await api(b.base, token, `/repos/git/marketplace/zipball/${head.sha}`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const names = bytes.toString('latin1');
    const prefix = `git-marketplace-${head.sha.slice(0, 7)}/`;
    expect(names).toContain(`${prefix}README.md`);
    expect(names).toContain(`${prefix}plugins/gtm/skills/deploy/SKILL.md`);
  });

  it('keeps every person to their own tree: a foreign sha and an unknown sha are not found', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const aliceHead = ((await (await api(a.base, alice, '/repos/git/marketplace/commits?per_page=1')).json()) as { sha: string }[])[0].sha;
    const bobHead = ((await (await api(a.base, bob, '/repos/git/marketplace/commits?per_page=1')).json()) as { sha: string }[])[0].sha;
    expect(aliceHead).not.toBe(bobHead);
    expect((await api(a.base, bob, `/repos/git/marketplace/zipball/${aliceHead}`)).status).toBe(404);
    expect((await api(a.base, bob, `/repos/git/marketplace/zipball/${'0'.repeat(40)}`)).status).toBe(404);
    const bobZip = Buffer.from(await (await api(a.base, bob, `/repos/git/marketplace/zipball/${bobHead}`)).arrayBuffer()).toString('latin1');
    expect(bobZip).not.toContain('plugins/gtm');
  });

  it('spends a code exactly once across replicas, and only after every other check passed', async () => {
    const creds = await a.credentials.ensure();
    const code = await approve(a.base, 'alice');
    const good = { client_id: creds.clientId, client_secret: creds.clientSecret, code };

    // Wrong about something else: the code survives to be retried.
    const badRedirect = await exchange(b.base, { ...good, redirect_uri: 'https://claude.ai/elsewhere' });
    expect(badRedirect.status).toBe(400);
    expect(((await badRedirect.json()) as { error: string }).error).toBe('redirect_uri_mismatch');
    const badSecret = await exchange(b.base, { ...good, client_secret: 'not-it' });
    expect(badSecret.status).toBe(401);

    // Then the first correct exchange wins, on either replica, and the code is spent for both.
    expect((await exchange(b.base, good)).status).toBe(200);
    const replayHere = await exchange(a.base, good);
    expect(replayHere.status).toBe(400);
    expect(((await replayHere.json()) as { error: string }).error).toBe('bad_verification_code');
    expect((await exchange(b.base, good)).status).toBe(400);
  });

  it('keeps at most one live code per person: mashing Finish never grows the store, even concurrently', async () => {
    for (let i = 0; i < 5; i++) await approve(a.base, 'alice', `s${i}`);
    await approve(b.base, 'bob');
    expect(shared.codes.size).toBe(2);
    // Finishes racing each other on two replicas still leave ONE row, and
    // only the code that landed last is live.
    const codes = await Promise.all([approve(a.base, 'alice', 'x'), approve(b.base, 'alice', 'y'), approve(a.base, 'alice', 'z')]);
    expect(shared.codes.size).toBe(2);
    const creds = await a.credentials.ensure();
    const results = await Promise.all(
      codes.map((code) => exchange(b.base, { client_id: creds.clientId, client_secret: creds.clientSecret, code })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    // Nor does a rotated client id strand a row under the old one: the
    // person's row is the person's, whatever client it was last issued for.
    await a.credentials.rotate();
    await approve(a.base, 'alice', 'after-rotation');
    expect(shared.codes.size).toBe(2);
  });

  it('two exchanges of one code at the same instant mint exactly one token', async () => {
    const creds = await a.credentials.ensure();
    const code = await approve(a.base, 'alice');
    const body = { client_id: creds.clientId, client_secret: creds.clientSecret, code };
    const before = shared.keys.byToken.size;
    const results = await Promise.all([exchange(a.base, body), exchange(b.base, body), exchange(a.base, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(shared.keys.byToken.size).toBe(before + 1);
  });

  it('a rotation returns what is stored, so two admins rotating at once are shown the same set', async () => {
    const [x, y] = await Promise.all([a.credentials.rotate(), b.credentials.rotate()]);
    const stored = await shared.credentials.load();
    expect(x.clientId).toBe(stored!.clientId);
    expect(y.clientId).toBe(stored!.clientId);
  });

  it('answers the token endpoint in the encoding the client negotiated, failures included', async () => {
    const creds = await a.credentials.ensure();
    const form = 'application/x-www-form-urlencoded';
    const failed = await exchange(a.base, { client_id: creds.clientId, client_secret: creds.clientSecret, code: 'nope' }, form);
    expect(failed.status).toBe(400);
    expect(failed.headers.get('content-type')).toContain(form);
    expect(new URLSearchParams(await failed.text()).get('error')).toBe('bad_verification_code');
    const code = await approve(a.base, 'alice');
    const ok = await exchange(b.base, { client_id: creds.clientId, client_secret: creds.clientSecret, code }, form);
    expect(ok.headers.get('content-type')).toContain(form);
    expect(new URLSearchParams(await ok.text()).get('token_type')).toBe('bearer');
  });

  it('refuses what it should: wrong redirect host, unknown client, no token, other repos', async () => {
    const creds = await a.credentials.ensure();
    const elsewhere = await fetch(
      `${a.base}/login/oauth/authorize?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      { redirect: 'manual' },
    );
    expect(elsewhere.status).toBe(400);
    const wrongClient = await fetch(
      `${a.base}/login/oauth/authorize?client_id=Iv1.nope&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    );
    expect(wrongClient.status).toBe(400);

    const token = await connect('alice');
    const noToken = await fetch(`${a.base}/api/v3/repos/git/marketplace`);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toContain('Bearer');
    expect((await api(a.base, 'gho_unknown', '/repos/git/marketplace')).status).toBe(401);
    expect((await api(a.base, token, '/repos/someone/else')).status).toBe(404);
    expect((await api(a.base, token, '/user')).status).toBe(404);
    expect((await api(a.base, token, '/repos/git/marketplace/zipball/main..HEAD')).status).toBe(404);
  });

  it('a consent finish that is not a Claude link still goes to the SDK, and a Claude link without a bridge is a client error', async () => {
    const { signAuthRequest } = await import('../../mcp/oauth/oauth-state.js');
    const mcpState = signAuthRequest(STATE_SECRET, { c: 'mcp-client', r: 'http://localhost/cb', cc: 'challenge' });
    const complete = await fetch(`${a.base}/api/mcp/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ state: mcpState }),
    });
    expect(complete.status).toBe(500); // the stub SDK path throws — proving it was the one asked

    // A deployment whose consent routes were built without the bridge.
    const bare = express();
    bare.use('/api', (req, _res, next) => { req.userId = 'user-alice'; next(); }, express.json(), createOAuthConsentRoutes({
      provider: { clientsStore: { getClient: async () => undefined } } as unknown as BevelOAuthProvider,
      stateSecret: STATE_SECRET,
    }));
    const server = await new Promise<http.Server>((resolve) => { const s = bare.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = server.address() as { port: number };
    const ghState = signAuthRequest(STATE_SECRET, { c: 'Iv1.x', r: CALLBACK, gh: true });
    try {
      const request = await fetch(`http://127.0.0.1:${port}/api/mcp/oauth/request?state=${encodeURIComponent(ghState)}`);
      expect(request.status).toBe(400);
      const finish = await fetch(`http://127.0.0.1:${port}/api/mcp/oauth/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: ghState }),
      });
      expect(finish.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('hands an admin the registration fields uncached, and a rotation on one replica is what the other checks', async () => {
    const forbidden = await fetch(`${a.base}/api/admin/github-facade`, { headers: { 'x-test-user': 'bob' } });
    expect(forbidden.status).toBe(403);
    const shown = await fetch(`${a.base}/api/admin/github-facade`, { headers: { 'x-test-user': 'alice' } });
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    const before = (await shown.json()) as Record<string, string>;
    expect(before.host).toBe('kb.acme.com');
    expect(before.marketplaceUrl).toBe('https://kb.acme.com/git/marketplace.git');
    expect(before.clientId).toMatch(/^Iv1\.[0-9a-f]{16}$/);
    expect(before.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(before.appId).toMatch(/^\d{6}$/);

    // Rotate on replica B…
    const rotated = await fetch(`${b.base}/api/admin/github-facade/rotate`, { method: 'POST', headers: { 'x-test-user': 'alice' } });
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    const after = (await rotated.json()) as Record<string, string>;
    for (const field of ['appId', 'clientId', 'clientSecret', 'webhookSecret', 'privateKeyPem']) {
      expect(after[field]).not.toBe(before[field]);
    }
    // …and replica A, which served the old set a moment ago, now refuses it and accepts the new.
    const stale = await fetch(
      `${a.base}/login/oauth/authorize?client_id=${before.clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    );
    expect(stale.status).toBe(400);
    const fresh = await fetch(
      `${a.base}/login/oauth/authorize?client_id=${after.clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
      { redirect: 'manual' },
    );
    expect(fresh.status).toBe(302);
  });

  it('initialises once even when two replicas race for the first credentials', async () => {
    const [x, y] = await Promise.all([a.credentials.ensure(), b.credentials.ensure()]);
    expect(x.clientId).toBe(y.clientId);
  });
});
