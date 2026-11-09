import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  OAuthError,
  SignInRefusedError,
  authorizeInBrowser,
  discoverAuthServer,
  establishOAuthConfig,
  exchangeForLocalToken,
  fetchAllManuals,
  fetchLocalOnlyManuals,
  oauthStorePath,
  readStoredCredentials,
  refreshAccessToken,
  writeStoredCredentials,
  type HexisMcpConfig,
} from '../index.js';

/**
 * The OAuth mode, tested against REAL local HTTP servers: one stub plays the
 * deployment AND its authorization server (which is exactly the production
 * topology — the deployment issues its own tokens), and the "browser" is an
 * injected function that does what a person's browser would: follow the
 * authorization URL's parameters back to the loopback redirect. No fetch
 * mocks — every request in these tests crosses a socket.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const s256 = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

type Answer = { status: number; body?: unknown };

interface AuthorityOptions {
  /** Answer a refresh_token grant (a promise plays a slow token endpoint). Default: 400 invalid_grant. */
  refreshGrant?: (params: URLSearchParams) => Answer | Promise<Answer>;
  /** Answer an authorization_code grant. Default: 400. */
  codeGrant?: (params: URLSearchParams) => Answer;
  /** Answer POST /api/mcp/local-token given the presented bearer. Default: 404 (a too-old deployment). */
  localToken?: (bearer: string) => Answer;
  /** Which internal tokens the REST surface accepts. Default: none. */
  restAccepts?: (bearer: string) => boolean;
  /** Status the REST surface refuses with. Default 401; a 403 plays "live sign-in, no permission". */
  restRefusal?: number;
  /** Override the AS metadata document. */
  asMetadata?: (base: string) => unknown;
  /** Override the protected-resource metadata document. */
  resourceMetadata?: (base: string) => unknown;
  /** Override the 401 challenge header; null = send no WWW-Authenticate at all. */
  challengeHeader?: (base: string) => string | null;
  /** Status for the unauthenticated MCP probe. Default 401. */
  mcpStatus?: number;
}

interface Authority {
  base: string;
  mcpUrl: string;
  record: { dcr: Record<string, unknown>[]; token: URLSearchParams[]; revoke: URLSearchParams[] };
  close: () => Promise<void>;
}

async function stubAuthority(opts: AuthorityOptions = {}): Promise<Authority> {
  const record: Authority['record'] = { dcr: [], token: [], revoke: [] };
  let base = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      const pathname = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'POST' && pathname === '/api/mcp') {
        const header =
          opts.challengeHeader !== undefined
            ? opts.challengeHeader(base)
            : `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
        res.writeHead(opts.mcpStatus ?? 401, header === null ? {} : { 'WWW-Authenticate': header });
        res.end();
        return;
      }
      if (pathname === '/.well-known/oauth-protected-resource') {
        send(
          200,
          opts.resourceMetadata?.(base) ?? { resource: `${base}/api/mcp`, authorization_servers: [base] },
        );
        return;
      }
      if (pathname === '/.well-known/oauth-authorization-server') {
        send(
          200,
          opts.asMetadata?.(base) ?? {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            revocation_endpoint: `${base}/revoke`,
          },
        );
        return;
      }
      if (req.method === 'POST' && pathname === '/revoke') {
        record.revoke.push(new URLSearchParams(body));
        send(200, {});
        return;
      }
      if (req.method === 'POST' && pathname === '/register') {
        record.dcr.push(JSON.parse(body) as Record<string, unknown>);
        send(201, { client_id: 'dyn-client' });
        return;
      }
      if (req.method === 'POST' && pathname === '/token') {
        const params = new URLSearchParams(body);
        record.token.push(params);
        const answer =
          params.get('grant_type') === 'refresh_token'
            ? (opts.refreshGrant ?? (() => ({ status: 400, body: { error: 'invalid_grant' } })))(params)
            : (opts.codeGrant ?? (() => ({ status: 400, body: { error: 'unsupported_grant_type' } })))(params);
        void Promise.resolve(answer).then((a) => send(a.status, a.body));
        return;
      }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.method === 'POST' && pathname === '/api/mcp/local-token') {
        const answer = (opts.localToken ?? ((): Answer => ({ status: 404 })))(bearer);
        send(answer.status, answer.body);
        return;
      }
      if (pathname === '/api/agent/all-tools') {
        if (opts.restAccepts?.(bearer)) send(200, { manuals: [] });
        else send(opts.restRefusal ?? 401);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/agent/tools/list_local_tools') {
        if (opts.restAccepts?.(bearer)) send(200, { tools: [] });
        else send(opts.restRefusal ?? 401);
        return;
      }
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    mcpUrl: `${base}/api/mcp`,
    record,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * What a person's browser does, as a function: read the authorization URL's
 * parameters and land on the loopback redirect with a code. `mutateState`
 * lets a test play the attacker who answers with a state nobody issued.
 */
function fakeBrowser(code = 'code-1', mutateState?: (state: string) => string) {
  const seen: { authUrl?: URL } = {};
  const open = (url: string): void => {
    const authUrl = new URL(url);
    seen.authUrl = authUrl;
    const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', code);
    const state = authUrl.searchParams.get('state')!;
    redirect.searchParams.set('state', mutateState ? mutateState(state) : state);
    // The trailing catch matters: on a refused flow the loopback is torn down
    // while this request is in flight, and its rejection would otherwise be
    // an unhandled one failing an unrelated test.
    void fetch(redirect).then((res) => res.body?.cancel().catch(() => {})).catch(() => {});
  };
  return { open, seen };
}

/** A code grant that enforces the PKCE contract against what the fake browser saw. */
function pkceCodeGrant(
  seen: { authUrl?: URL },
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
  code = 'code-1',
) {
  return (params: URLSearchParams): Answer => {
    const challenge = seen.authUrl?.searchParams.get('code_challenge') ?? '';
    const redirectUri = seen.authUrl?.searchParams.get('redirect_uri') ?? '';
    if (
      params.get('code') !== code ||
      params.get('client_id') !== 'dyn-client' ||
      params.get('redirect_uri') !== redirectUri ||
      s256(params.get('code_verifier') ?? '') !== challenge
    ) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return { status: 200, body: tokens };
  };
}

const quiet = (): void => {};

let home = '';
let priorHexisHome: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-oauth-'));
  priorHexisHome = process.env.HEXIS_HOME;
  process.env.HEXIS_HOME = home;
});

afterEach(async () => {
  // The console spies some cases install must not outlive them.
  vi.restoreAllMocks();
  if (priorHexisHome === undefined) delete process.env.HEXIS_HOME;
  else process.env.HEXIS_HOME = priorHexisHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe('discoverAuthServer', () => {
  it('walks the standard chain: 401 challenge → resource metadata → AS metadata → endpoints', async () => {
    const authority = await stubAuthority();
    try {
      expect(await discoverAuthServer(authority.mcpUrl)).toEqual({
        authorizationEndpoint: `${authority.base}/authorize`,
        tokenEndpoint: `${authority.base}/token`,
        registrationEndpoint: `${authority.base}/register`,
        revocationEndpoint: `${authority.base}/revoke`,
      });
    } finally {
      await authority.close();
    }
  });

  it('names a missing challenge and points back at the key — a too-old deployment looks exactly like this', async () => {
    const authority = await stubAuthority({ challengeHeader: () => null });
    try {
      await expect(discoverAuthServer(authority.mcpUrl)).rejects.toThrow(/resource metadata/);
      await expect(discoverAuthServer(authority.mcpUrl)).rejects.toThrow(/--key/);
    } finally {
      await authority.close();
    }
  });

  it('refuses an MCP endpoint that does not challenge — a proxy or wrong URL, not a deployment', async () => {
    const authority = await stubAuthority({ mcpStatus: 200 });
    try {
      const err = (await discoverAuthServer(authority.mcpUrl).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.message).toMatch(/got 200/);
    } finally {
      await authority.close();
    }
  });

  it('names resource metadata that lists no authorization server', async () => {
    const authority = await stubAuthority({ resourceMetadata: (base) => ({ resource: `${base}/api/mcp` }) });
    try {
      await expect(discoverAuthServer(authority.mcpUrl)).rejects.toThrow(/no "authorization_servers"/);
    } finally {
      await authority.close();
    }
  });

  /**
   * The discovery chain's SSRF gate: every URL it walks arrived over the
   * network, and the next step either fetches it or POSTs credentials to it.
   * Plain http is tolerable only on a literal loopback host (which is exactly
   * what this suite's own stub is); anywhere else it must be refused BEFORE
   * anything is sent — with a message that says what to do about it.
   */
  it('refuses a plain-http metadata URL on a non-loopback host, with an actionable message', async () => {
    const authority = await stubAuthority({
      challengeHeader: () => 'Bearer resource_metadata="http://internal-host.corp/.well-known/oauth-protected-resource"',
    });
    try {
      const err = (await discoverAuthServer(authority.mcpUrl).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.message).toMatch(/insecure resource metadata URL/);
      expect(err.message).toMatch(/must be https/);
      expect(err.message).toMatch(/loopback/);
      expect(err.message).toMatch(/--key/);
    } finally {
      await authority.close();
    }
  });

  it('holds the same gate on every discovered AS endpoint — the token endpoint receives credentials', async () => {
    const authority = await stubAuthority({
      asMetadata: (base) => ({
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: 'http://internal-host.corp:9000/token',
        registration_endpoint: `${base}/register`,
      }),
    });
    try {
      await expect(discoverAuthServer(authority.mcpUrl)).rejects.toThrow(/insecure token endpoint/);
    } finally {
      await authority.close();
    }
  });

  it('refuses a redirecting metadata endpoint instead of following it somewhere the gate never saw', async () => {
    let base = '';
    const server = http.createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'POST' && pathname === '/api/mcp') {
        res
          .writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          })
          .end();
        return;
      }
      if (pathname === '/.well-known/oauth-protected-resource') {
        // The redirect an interposed proxy (or a hostile answer) would give:
        // following it re-aims the fetch at an address nothing validated.
        res.writeHead(302, { Location: `${base}/somewhere-else` }).end();
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(discoverAuthServer(`${base}/api/mcp`)).rejects.toThrow(
        /Could not reach the resource metadata/,
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('names each missing or unusable AS endpoint instead of failing downstream', async () => {
    const missing = await stubAuthority({
      asMetadata: (base) => ({ authorization_endpoint: `${base}/authorize`, registration_endpoint: `${base}/register` }),
    });
    const smuggled = await stubAuthority({
      asMetadata: (base) => ({
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: 'javascript:alert(1)',
        registration_endpoint: `${base}/register`,
      }),
    });
    try {
      await expect(discoverAuthServer(missing.mcpUrl)).rejects.toThrow(/names no token endpoint/);
      await expect(discoverAuthServer(smuggled.mcpUrl)).rejects.toThrow(/non-http token endpoint/);
    } finally {
      await missing.close();
      await smuggled.close();
    }
  });
});

describe('stored credentials', () => {
  const baseUrl = 'https://workspace.example';

  it('round-trips, owner-only on POSIX', async () => {
    await writeStoredCredentials(baseUrl, { clientId: 'c1', refreshToken: 'r1' });
    expect(await readStoredCredentials(baseUrl)).toEqual({ clientId: 'c1', refreshToken: 'r1' });
    // Windows has no comparable mode bits — same pass materialize.ts gives it.
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(oauthStorePath(baseUrl))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('treats a corrupt or wrong-shaped store as absent — the browser flow rebuilds it', async () => {
    const file = oauthStorePath(baseUrl);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'not json at all {');
    expect(await readStoredCredentials(baseUrl)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ clientId: 'c1' })); // no refreshToken
    expect(await readStoredCredentials(baseUrl)).toBeNull();
  });

  it('a missing store is absent, not an error', async () => {
    expect(await readStoredCredentials('https://never-signed-in.example')).toBeNull();
  });

  it('keeps one store per agent, beside the plain per-machine one', async () => {
    const claude = { name: 'claude-code' };
    const cursor = { name: 'cursor-vscode' };
    await writeStoredCredentials(baseUrl, { clientId: 'c-plain', refreshToken: 'r-plain' });
    await writeStoredCredentials(baseUrl, { clientId: 'c-claude', refreshToken: 'r-claude' }, claude);
    expect(oauthStorePath(baseUrl, claude)).not.toBe(oauthStorePath(baseUrl));
    expect(oauthStorePath(baseUrl, claude)).not.toBe(oauthStorePath(baseUrl, cursor));
    expect(await readStoredCredentials(baseUrl)).toEqual({ clientId: 'c-plain', refreshToken: 'r-plain' });
    expect(await readStoredCredentials(baseUrl, claude)).toEqual({ clientId: 'c-claude', refreshToken: 'r-claude' });
    // An agent that never signed in has no store — the plain one is not its.
    expect(await readStoredCredentials(baseUrl, cursor)).toBeNull();
  });
});

describe('the agent behind the sign-in', () => {
  it('registers under the agent\'s name on this machine, tells the person to return to it, and stores the sign-in as that agent\'s', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow' })(params),
      localToken: (bearer) => (bearer === 'a-flow' ? { status: 200, body: { token: 'int-1' } } : { status: 401 }),
    });
    try {
      const agent = { name: 'claude-code', version: '2.0.1' };
      await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: browser.open, print: quiet, agent });
      expect(String(authority.record.dcr[0]!.client_name)).toMatch(/^Claude Code · local server on .+/);
      expect(await readStoredCredentials(authority.base, agent)).toEqual({ clientId: 'dyn-client', refreshToken: 'r-flow' });
      // Nothing landed in the plain store: the sign-in is the agent's.
      expect(await readStoredCredentials(authority.base)).toBeNull();
    } finally {
      await authority.close();
    }
  });

  it('never reuses the plain per-machine sign-in for an agent, and retires it once the agent has its own', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      // A refresh WOULD succeed — if anyone presented the plain store's token.
      refreshGrant: () => ({ status: 200, body: { access_token: 'a-refreshed' } }),
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow' })(params),
      localToken: () => ({ status: 200, body: { token: 'int-1' } }),
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'old-machine-client', refreshToken: 'r-old' });
      await establishOAuthConfig(authority.base, authority.mcpUrl, {
        openBrowser: browser.open,
        print: quiet,
        agent: { name: 'cursor-vscode' },
      });
      // The browser flow ran (a registration happened) and no refresh was tried.
      expect(authority.record.dcr).toHaveLength(1);
      expect(authority.record.token.some((p) => p.get('grant_type') === 'refresh_token')).toBe(false);
      // The plain sign-in was ended at the workspace — the old refresh token,
      // under the old client — and is gone from disk, so no unused sign-in
      // stays live on the Audit log or in ~/.hexis.
      expect(authority.record.revoke).toHaveLength(1);
      expect(authority.record.revoke[0]!.get('token')).toBe('r-old');
      expect(authority.record.revoke[0]!.get('client_id')).toBe('old-machine-client');
      expect(await readStoredCredentials(authority.base)).toBeNull();
      // The agent's own sign-in is what remains.
      expect(await readStoredCredentials(authority.base, { name: 'cursor-vscode' })).toEqual({
        clientId: 'dyn-client',
        refreshToken: 'r-flow',
      });
    } finally {
      await authority.close();
    }
  });

  it('a failure to retire the plain sign-in never costs the agent its own', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow' })(params),
      localToken: () => ({ status: 200, body: { token: 'int-1' } }),
      // No revocation endpoint at all: the old sign-in can only be dropped from disk.
      asMetadata: (base) => ({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
      }),
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'old-machine-client', refreshToken: 'r-old' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, {
        openBrowser: browser.open,
        print: quiet,
        agent: { name: 'claude-code' },
      });
      expect(config.connectionKey).toBe('int-1');
      expect(authority.record.revoke).toHaveLength(0);
      expect(await readStoredCredentials(authority.base)).toBeNull();
    } finally {
      await authority.close();
    }
  });

  it('a later run of the same agent refreshes its own stored sign-in, no browser', async () => {
    const authority = await stubAuthority({
      refreshGrant: (params) =>
        params.get('refresh_token') === 'r-claude' && params.get('client_id') === 'c-claude'
          ? { status: 200, body: { access_token: 'a-claude' } }
          : { status: 400, body: { error: 'invalid_grant' } },
      localToken: (bearer) => (bearer === 'a-claude' ? { status: 200, body: { token: 'int-claude' } } : { status: 401 }),
    });
    try {
      const agent = { name: 'claude-code' };
      await writeStoredCredentials(authority.base, { clientId: 'c-claude', refreshToken: 'r-claude' }, agent);
      const openBrowser = (): void => {
        throw new Error('the browser must not open for a stored sign-in');
      };
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser, print: quiet, agent });
      expect(config.connectionKey).toBe('int-claude');
      expect(authority.record.dcr).toHaveLength(0);
    } finally {
      await authority.close();
    }
  });
});

describe('refresh path', () => {
  it('signs in without a browser when the stored refresh token still works, and rotates it', async () => {
    const authority = await stubAuthority({
      refreshGrant: (params) =>
        params.get('refresh_token') === 'r1' && params.get('client_id') === 'c1'
          ? { status: 200, body: { access_token: 'a1', refresh_token: 'r2', token_type: 'bearer' } }
          : { status: 400, body: { error: 'invalid_grant' } },
      localToken: (bearer) =>
        bearer === 'a1' ? { status: 200, body: { token: 'internal1', expiresInMs: 60_000 } } : { status: 401 },
    });
    const openBrowser = vi.fn();
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r1' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser, print: quiet });
      expect(config.connectionKey).toBe('internal1');
      expect(config.renewConnectionKey).toBeTypeOf('function');
      expect(openBrowser).not.toHaveBeenCalled();
      // The rotated refresh token is what survives on disk.
      expect(await readStoredCredentials(authority.base)).toEqual({ clientId: 'c1', refreshToken: 'r2' });
    } finally {
      await authority.close();
    }
  });

  it('falls through to the browser when the refresh is refused (400) — a dead token is a fresh sign-in, not an error', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      refreshGrant: () => ({ status: 400, body: { error: 'invalid_grant' } }),
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a2', refresh_token: 'r-new' })(params),
      localToken: (bearer) => (bearer === 'a2' ? { status: 200, body: { token: 'internal2' } } : { status: 401 }),
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'stale', refreshToken: 'dead' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, {
        openBrowser: browser.open,
        print: quiet,
      });
      expect(browser.seen.authUrl).toBeDefined();
      expect(config.connectionKey).toBe('internal2');
      // The store now belongs to the NEW registration, not the stale one.
      expect(await readStoredCredentials(authority.base)).toEqual({ clientId: 'dyn-client', refreshToken: 'r-new' });
    } finally {
      await authority.close();
    }
  });

  it('refreshAccessToken returns null on 400/401 and throws on anything else unexpected', async () => {
    const refused = await stubAuthority({ refreshGrant: () => ({ status: 401 }) });
    const broken = await stubAuthority({ refreshGrant: () => ({ status: 500 }) });
    try {
      expect(await refreshAccessToken(`${refused.base}/token`, 'c1', 'r1')).toBeNull();
      await expect(refreshAccessToken(`${broken.base}/token`, 'c1', 'r1')).rejects.toThrow(/HTTP 500/);
    } finally {
      await refused.close();
      await broken.close();
    }
  });
});

describe('browser flow', () => {
  it('registers exactly the bound redirect_uri and proves possession with the PKCE verifier', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow' })(params),
    });
    try {
      const result = await authorizeInBrowser(
        {
          authorizationEndpoint: `${authority.base}/authorize`,
          tokenEndpoint: `${authority.base}/token`,
          registrationEndpoint: `${authority.base}/register`,
        },
        { openBrowser: browser.open, print: quiet },
      );
      expect(result).toEqual({ clientId: 'dyn-client', accessToken: 'a-flow', refreshToken: 'r-flow' });

      // DCR received EXACTLY the redirect the loopback answers on — the same
      // URI (port included) the authorization URL then carried.
      const boundRedirect = browser.seen.authUrl!.searchParams.get('redirect_uri')!;
      expect(boundRedirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(authority.record.dcr).toHaveLength(1);
      expect(authority.record.dcr[0]).toMatchObject({
        redirect_uris: [boundRedirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      });
      expect(String(authority.record.dcr[0]!.client_name)).toMatch(/^Unknown agent · local server on .+/);

      // The verifier that reached the token endpoint is the challenge's preimage
      // — asserted here directly, on top of the stub's own enforcement.
      const codeExchange = authority.record.token.find((p) => p.get('grant_type') === 'authorization_code')!;
      expect(s256(codeExchange.get('code_verifier')!)).toBe(
        browser.seen.authUrl!.searchParams.get('code_challenge'),
      );
    } finally {
      await authority.close();
    }
  });

  it('hands back the access token\'s lifetime when the token endpoint gives expires_in', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) =>
        pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow', expires_in: 3600 })(params),
    });
    try {
      const result = await authorizeInBrowser(
        {
          authorizationEndpoint: `${authority.base}/authorize`,
          tokenEndpoint: `${authority.base}/token`,
          registrationEndpoint: `${authority.base}/register`,
        },
        { openBrowser: browser.open, print: quiet },
      );
      expect(result).toEqual({ clientId: 'dyn-client', accessToken: 'a-flow', refreshToken: 'r-flow', expiresInMs: HOUR });
    } finally {
      await authority.close();
    }
  });

  it('always prints the sign-in URL, for the no-display case', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) => pkceCodeGrant(browser.seen, { access_token: 'a' })(params),
    });
    const printed: string[] = [];
    try {
      await authorizeInBrowser(
        {
          authorizationEndpoint: `${authority.base}/authorize`,
          tokenEndpoint: `${authority.base}/token`,
          registrationEndpoint: `${authority.base}/register`,
        },
        { openBrowser: browser.open, print: (line) => printed.push(line) },
      );
      expect(printed.some((l) => l.includes(`${authority.base}/authorize?`))).toBe(true);
    } finally {
      await authority.close();
    }
  });

  it('refuses a callback whose state this process never issued', async () => {
    const browser = fakeBrowser('code-1', () => 'forged-state');
    const authority = await stubAuthority();
    try {
      await expect(
        authorizeInBrowser(
          {
            authorizationEndpoint: `${authority.base}/authorize`,
            tokenEndpoint: `${authority.base}/token`,
            registrationEndpoint: `${authority.base}/register`,
          },
          { openBrowser: browser.open, print: quiet },
        ),
      ).rejects.toThrow(/state this process never issued/);
      // The forged request never earned a code exchange.
      expect(authority.record.token).toHaveLength(0);
    } finally {
      await authority.close();
    }
  });

  it('surfaces the authorization server refusing the sign-in', async () => {
    const authority = await stubAuthority();
    const denyingBrowser = (url: string): void => {
      const authUrl = new URL(url);
      const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
      redirect.searchParams.set('error', 'access_denied');
      // Same as fakeBrowser: the flow rejects and closes the loopback, so the
      // in-flight fetch must not surface as an unhandled rejection.
      void fetch(redirect).then((res) => res.body?.cancel().catch(() => {})).catch(() => {});
    };
    try {
      await expect(
        authorizeInBrowser(
          {
            authorizationEndpoint: `${authority.base}/authorize`,
            tokenEndpoint: `${authority.base}/token`,
            registrationEndpoint: `${authority.base}/register`,
          },
          { openBrowser: denyingBrowser, print: quiet },
        ),
      ).rejects.toThrow(/refused the sign-in \(access_denied\)/);
    } finally {
      await authority.close();
    }
  });
});

describe('local-token exchange', () => {
  it('a 404 is named as a too-old deployment, with the key as the way forward', async () => {
    const authority = await stubAuthority(); // localToken defaults to 404
    try {
      const err = (await exchangeForLocalToken(authority.base, 'a1').catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.message).toMatch(/too old for browser sign-in/);
      expect(err.message).toMatch(/--key/);
    } finally {
      await authority.close();
    }
  });

  it('the internal token — not the OAuth access token — is what later REST calls carry', async () => {
    const authority = await stubAuthority({
      refreshGrant: () => ({ status: 200, body: { access_token: 'a1', refresh_token: 'r2' } }),
      localToken: (bearer) => (bearer === 'a1' ? { status: 200, body: { token: 'internal1' } } : { status: 401 }),
      restAccepts: (bearer) => bearer === 'internal1',
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r1' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { print: quiet });
      expect(await fetchAllManuals(config)).toEqual({ manuals: [] });
    } finally {
      await authority.close();
    }
  });
});

describe('mid-run 401', () => {
  it('one refresh → re-exchange retry recovers an expired internal token, store rotation included', async () => {
    // Stateful stub: the first internal token dies, the refresh chain mints
    // the second. r2 → (a2, r3) is the only live refresh at retry time.
    const liveRefresh = new Map([
      ['r1', { access: 'a1', next: 'r2' }],
      ['r2', { access: 'a2', next: 'r3' }],
    ]);
    const restAccepts = { current: 'internal2' }; // internal1 is ALREADY expired when the REST call happens
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        const grant = liveRefresh.get(params.get('refresh_token') ?? '');
        if (!grant) return { status: 400, body: { error: 'invalid_grant' } };
        liveRefresh.delete(params.get('refresh_token')!); // single-use, as rotation implies
        return { status: 200, body: { access_token: grant.access, refresh_token: grant.next } };
      },
      localToken: (bearer) =>
        bearer === 'a1'
          ? { status: 200, body: { token: 'internal1' } }
          : bearer === 'a2'
            ? { status: 200, body: { token: 'internal2' } }
            : { status: 401 },
      restAccepts: (bearer) => bearer === restAccepts.current,
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r1' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { print: quiet });
      expect(config.connectionKey).toBe('internal1');
      // internal1 401s → deployment.ts consults renewConnectionKey once →
      // refresh(r2) → a2 → re-exchange → internal2 → the SAME request succeeds.
      expect(await fetchAllManuals(config)).toEqual({ manuals: [] });
      // The fresh token is now the process's bearer, and the rotated refresh
      // token is on disk for the next renewal.
      expect(config.connectionKey).toBe('internal2');
      expect(await readStoredCredentials(authority.base)).toEqual({ clientId: 'c1', refreshToken: 'r3' });
    } finally {
      await authority.close();
    }
  });

  it('a second 401 propagates, naming re-authorization — no retry loops', async () => {
    const authority = await stubAuthority({ restAccepts: () => false });
    const renew = vi.fn(async () => ({ token: 'still-rejected' }));
    const config: HexisMcpConfig = {
      baseUrl: authority.base,
      connectionKey: 'expired',
      renewConnectionKey: renew,
    };
    try {
      const err = (await fetchAllManuals(config).catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/even after refreshing/);
      expect(err.message).toMatch(/Re-authorize/);
      expect(renew).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  });

  /**
   * A 403 is a PERMISSION answer about a LIVE credential: the sign-in worked
   * and refreshing it changes nothing, so the message must say "access
   * denied" and never send the person on a pointless re-authorization trip —
   * that guidance is reserved for the 401-after-renewal path above.
   */
  it('a 403 with a live sign-in reads as access denied — no renewal, no re-authorize advice', async () => {
    const authority = await stubAuthority({ restAccepts: () => false, restRefusal: 403 });
    const renew = vi.fn(async () => ({ token: 'never-consulted' }));
    const config: HexisMcpConfig = {
      baseUrl: authority.base,
      connectionKey: 'live-but-unprivileged',
      renewConnectionKey: renew,
    };
    try {
      const err = (await fetchAllManuals(config).catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/denied access \(HTTP 403\)/);
      expect(err.message).toMatch(/does not have permission/);
      expect(err.message).toMatch(/workspace admin/);
      expect(err.message).not.toMatch(/Re-authorize/);
      expect(err.message).not.toMatch(/browser/);
      // A 403 is not a credential problem, so no renewal is spent on it.
      expect(renew).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  /**
   * The rotating refresh token makes concurrent renewals actively DESTRUCTIVE:
   * the loser of the race presents a just-retired token and gets
   * `invalid_grant`, killing a healthy sign-in. Startup does exactly this —
   * `Promise.all` over two REST reads, both 401ing at once — so this test IS
   * that startup: one live refresh token, two concurrent 401s, and the
   * single-flight must spend the token exactly once for both callers.
   */
  it('concurrent 401s share ONE renewal — the rotating refresh token survives the race', async () => {
    const liveRefresh = new Map([
      ['r1', { access: 'a0', next: 'r2' }], // consumed by establishOAuthConfig
      ['r2', { access: 'a1', next: 'r3' }], // the ONLY live token at race time
    ]);
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        const grant = liveRefresh.get(params.get('refresh_token') ?? '');
        if (!grant) return { status: 400, body: { error: 'invalid_grant' } };
        liveRefresh.delete(params.get('refresh_token')!); // single-use, as rotation implies
        return { status: 200, body: { access_token: grant.access, refresh_token: grant.next } };
      },
      localToken: (bearer) =>
        bearer === 'a0'
          ? { status: 200, body: { token: 'internal-dead' } }
          : bearer === 'a1'
            ? { status: 200, body: { token: 'internal-fresh' } }
            : { status: 401 },
      // internal-dead is ALREADY expired when the two REST reads race.
      restAccepts: (bearer) => bearer === 'internal-fresh',
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r1' });
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { print: quiet });
      expect(config.connectionKey).toBe('internal-dead');
      const [manuals, locals] = await Promise.all([
        fetchAllManuals(config),
        fetchLocalOnlyManuals(config),
      ]);
      expect(manuals).toEqual({ manuals: [] });
      expect(locals.size).toBe(0);
      expect(config.connectionKey).toBe('internal-fresh');
      // Exactly two refresh grants ever ran: startup's, and ONE for the race.
      const refreshGrants = authority.record.token.filter((p) => p.get('grant_type') === 'refresh_token');
      expect(refreshGrants).toHaveLength(2);
      expect(await readStoredCredentials(authority.base)).toEqual({ clientId: 'c1', refreshToken: 'r3' });
    } finally {
      await authority.close();
    }
  });
});

/**
 * A token endpoint that rotates like the platform's, minus its reuse grace:
 * each refresh token works ONCE, and each grant mints an access token that
 * lives an hour. `refuseAll` plays a sign-in revoked on the Audit log page.
 */
function rotatingRefresh(first: string) {
  const state = { live: first, minted: 0, refuseAll: false };
  const grant = (params: URLSearchParams): Answer => {
    if (state.refuseAll || params.get('refresh_token') !== state.live) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    state.minted += 1;
    state.live = `r-${state.minted + 1}`;
    return { status: 200, body: { access_token: `a-${state.minted}`, refresh_token: state.live, expires_in: 3600 } };
  };
  return { state, grant };
}

/** The exchange: any access token not revoked becomes an internal token named after it. */
function exchangeUnless(revoked: Set<string>) {
  return (bearer: string): Answer =>
    bearer && !revoked.has(bearer) ? { status: 200, body: { token: `int-for-${bearer}` } } : { status: 401 };
}

const refreshes = (authority: Authority): URLSearchParams[] =>
  authority.record.token.filter((p) => p.get('grant_type') === 'refresh_token');

const neverOpen = (): void => {
  throw new Error('the browser must not open for a stored sign-in');
};

const HOUR = 60 * 60_000;

describe('one sign-in shared by every process of an agent', () => {
  const agent = { name: 'cursor-vscode' };

  it('keeps the access token and its expiry in the store, and still reads a store written before them', async () => {
    const baseUrl = 'https://workspace.example';
    const expiresAt = Date.now() + HOUR;
    await writeStoredCredentials(baseUrl, { clientId: 'c1', refreshToken: 'r1', accessToken: 'a1', accessExpiresAt: expiresAt });
    expect(await readStoredCredentials(baseUrl)).toEqual({
      clientId: 'c1',
      refreshToken: 'r1',
      accessToken: 'a1',
      accessExpiresAt: expiresAt,
    });
    // The old shape, as an older package wrote it: the refresh token alone.
    await fs.writeFile(oauthStorePath(baseUrl), JSON.stringify({ clientId: 'c1', refreshToken: 'r1' }));
    expect(await readStoredCredentials(baseUrl)).toEqual({ clientId: 'c1', refreshToken: 'r1' });
    // An access token with no usable expiry is dropped, never trusted.
    await fs.writeFile(oauthStorePath(baseUrl), JSON.stringify({ clientId: 'c1', refreshToken: 'r1', accessToken: 'a1' }));
    expect(await readStoredCredentials(baseUrl)).toEqual({ clientId: 'c1', refreshToken: 'r1' });
  });

  it('three servers started at the same moment all sign in on ONE refresh grant, and no browser opens', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const configs = await Promise.all(
        [1, 2, 3].map(() =>
          establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent }),
        ),
      );
      expect(configs.map((c) => c.connectionKey)).toEqual(['int-for-a-1', 'int-for-a-1', 'int-for-a-1']);
      expect(refreshes(authority)).toHaveLength(1);
      expect(authority.record.dcr).toHaveLength(0);
      expect(await readStoredCredentials(authority.base, agent)).toMatchObject({
        clientId: 'c1',
        refreshToken: 'r-2',
        accessToken: 'a-1',
      });
    } finally {
      await authority.close();
    }
  });

  it('a start that finds a live access token in the store uses it, with no refresh grant at all', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    try {
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-1', accessToken: 'a-sibling', accessExpiresAt: Date.now() + HOUR },
        agent,
      );
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(config.connectionKey).toBe('int-for-a-sibling');
      expect(refreshes(authority)).toHaveLength(0);
    } finally {
      await authority.close();
    }
  });

  it('a renewal writes the rotated refresh token, the access token and its expiry before using them, and the next start reuses them', async () => {
    const rotation = rotatingRefresh('r-1');
    // What the store held at the moment each access token was USED: the exchange.
    const storeAtExchange = new Map<string, unknown>();
    let storeFile = '';
    const exchange = exchangeUnless(new Set());
    const authority = await stubAuthority({
      refreshGrant: rotation.grant,
      localToken: (bearer) => {
        storeAtExchange.set(bearer, JSON.parse(fsSync.readFileSync(storeFile, 'utf8')));
        return exchange(bearer);
      },
    });
    storeFile = oauthStorePath(authority.base, agent);
    try {
      // Nearly spent: inside the reuse margin, so it is refreshed, not reused.
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-1', accessToken: 'a-old', accessExpiresAt: Date.now() + 30_000 },
        agent,
      );
      const before = Date.now();
      const first = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(first.connectionKey).toBe('int-for-a-1');
      // Already on disk when a-1 reached the exchange, not written afterwards.
      expect(storeAtExchange.get('a-1')).toMatchObject({ clientId: 'c1', refreshToken: 'r-2', accessToken: 'a-1' });
      expect((storeAtExchange.get('a-1') as { accessExpiresAt: number }).accessExpiresAt).toBeGreaterThanOrEqual(
        before + HOUR,
      );
      const stored = await readStoredCredentials(authority.base, agent);
      expect(stored).toMatchObject({ clientId: 'c1', refreshToken: 'r-2', accessToken: 'a-1' });
      expect(stored!.accessExpiresAt).toBeGreaterThanOrEqual(before + HOUR);

      const second = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(second.connectionKey).toBe('int-for-a-1');
      expect(refreshes(authority)).toHaveLength(1);
    } finally {
      await authority.close();
    }
  });

  it('a start waits for a sibling holding the lock, and uses what the sibling wrote', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
      await fs.writeFile(lockFile, 'sibling');
      const starting = establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The sibling finishes its refresh: writes its result, releases the lock.
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-sib', accessToken: 'a-sib', accessExpiresAt: Date.now() + HOUR },
        agent,
      );
      await fs.rm(lockFile);
      const config = await starting;
      expect(config.connectionKey).toBe('int-for-a-sib');
      expect(refreshes(authority)).toHaveLength(0);
    } finally {
      await authority.close();
    }
  });

  it('never goes ahead while a live sibling holds the lock, however long its refresh takes', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    const lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    // The sibling's heartbeat: it keeps its lock fresh while it works.
    const sibling = setInterval(() => {
      const now = new Date();
      fs.utimes(lockFile, now, now).catch(() => {});
    }, 1_000);
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      await fs.writeFile(lockFile, 'sibling');
      const starting = establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      // Past any wait a waiter could give up on, and nothing was refreshed.
      await new Promise((resolve) => setTimeout(resolve, 22_000));
      expect(refreshes(authority)).toHaveLength(0);
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-sib', accessToken: 'a-sib', accessExpiresAt: Date.now() + HOUR },
        agent,
      );
      clearInterval(sibling);
      await fs.rm(lockFile);
      const config = await starting;
      expect(config.connectionKey).toBe('int-for-a-sib');
      expect(refreshes(authority)).toHaveLength(0);
    } finally {
      clearInterval(sibling);
      await authority.close();
    }
  }, 40_000);

  it('keeps its own lock fresh while its refresh is slow, so no sibling takes it over', async () => {
    const rotation = rotatingRefresh('r-1');
    let lockAgeAtAnswer: number | null = null;
    let lockFile = '';
    const authority = await stubAuthority({
      refreshGrant: async (params) => {
        // The lock is backdated as the request arrives; the holder's heartbeat
        // must have touched it again by the time the slow answer goes back.
        const longAgo = new Date(Date.now() - 60_000);
        await fs.utimes(lockFile, longAgo, longAgo);
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        lockAgeAtAnswer = Date.now() - (await fs.stat(lockFile)).mtimeMs;
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
    });
    lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(config.connectionKey).toBe('int-for-a-1');
      expect(lockAgeAtAnswer).not.toBeNull();
      expect(lockAgeAtAnswer!).toBeLessThan(30_000);
      await expect(fs.stat(lockFile)).rejects.toThrow();
    } finally {
      await authority.close();
    }
  }, 20_000);

  it('a holder taken over while paused neither keeps the replacement lock alive nor removes it', async () => {
    const rotation = rotatingRefresh('r-1');
    let replacementAge: number | null = null;
    let lockFile = '';
    const longAgo = new Date(Date.now() - 60_000);
    const authority = await stubAuthority({
      refreshGrant: async (params) => {
        // Mid-refresh, a sibling judged this holder's lock stale, removed it
        // and took its own (backdated here, so any touch of it shows).
        await fs.rm(lockFile);
        await fs.writeFile(lockFile, 'replacement');
        await fs.utimes(lockFile, longAgo, longAgo);
        // Past a heartbeat: the holder's must have touched only its own file.
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        replacementAge = Date.now() - (await fs.stat(lockFile)).mtimeMs;
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
    });
    lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(replacementAge).not.toBeNull();
      expect(replacementAge!).toBeGreaterThanOrEqual(55_000);
      // The release left the sibling's lock where it was.
      expect(await fs.readFile(lockFile, 'utf8')).toBe('replacement');
    } finally {
      await fs.rm(lockFile, { force: true });
      await authority.close();
    }
  }, 20_000);

  it('retries a lock that briefly cannot be created, and refreshes holding it', async () => {
    const rotation = rotatingRefresh('r-1');
    let lockFile = '';
    let lockedAtRefresh: boolean | null = null;
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        lockedAtRefresh = fsSync.existsSync(lockFile);
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
    });
    lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    // Windows answers EPERM while the last holder's lock is still delete-pending.
    const open = fs.open.bind(fs);
    let refusals = 2;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file) === lockFile && refusals-- > 0) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return open(file, ...rest);
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(config.connectionKey).toBe('int-for-a-1');
      expect(refusals).toBeLessThan(0);
      expect(lockedAtRefresh).toBe(true);
    } finally {
      spy.mockRestore();
      await authority.close();
    }
  });

  it('goes ahead without the lock after 2 s when the lock file can never be created, and still refreshes once', async () => {
    const rotation = rotatingRefresh('r-1');
    let lockFile = '';
    let lockedAtRefresh: boolean | null = null;
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        lockedAtRefresh = fsSync.existsSync(lockFile);
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
    });
    lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    // An unwritable lock directory: every attempt to create the lock fails.
    const open = fs.open.bind(fs);
    let attempts = 0;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file) === lockFile) {
        attempts += 1;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return open(file, ...rest);
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const started = Date.now();
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      expect(attempts).toBeGreaterThan(1);
      expect(config.connectionKey).toBe('int-for-a-1');
      expect(lockedAtRefresh).toBe(false);
      expect(refreshes(authority)).toHaveLength(1);
      expect(await readStoredCredentials(authority.base, agent)).toMatchObject({ refreshToken: 'r-2', accessToken: 'a-1' });
    } finally {
      spy.mockRestore();
      await authority.close();
    }
  }, 15_000);

  it('a browser sign-in stores the access token and its expiry, and the next start reuses them with no refresh and no browser', async () => {
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      codeGrant: (params) =>
        pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow', expires_in: 3600 })(params),
      localToken: exchangeUnless(new Set()),
    });
    try {
      const before = Date.now();
      const first = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: browser.open, print: quiet, agent });
      expect(first.connectionKey).toBe('int-for-a-flow');
      const stored = await readStoredCredentials(authority.base, agent);
      expect(stored).toMatchObject({ clientId: 'dyn-client', refreshToken: 'r-flow', accessToken: 'a-flow' });
      expect(stored!.accessExpiresAt).toBeGreaterThanOrEqual(before + HOUR);
      expect(stored!.accessExpiresAt).toBeLessThanOrEqual(Date.now() + HOUR);

      const second = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(second.connectionKey).toBe('int-for-a-flow');
      expect(refreshes(authority)).toHaveLength(0);
      expect(authority.record.dcr).toHaveLength(1);
    } finally {
      await authority.close();
    }
  });

  it('a holder whose heartbeat lapsed near the stale window leaves the lock for the takeover, not the path', async () => {
    const rotation = rotatingRefresh('r-1');
    const realNow = Date.now.bind(Date);
    const clock: { spy?: { mockRestore: () => void } } = {};
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        // The holder froze mid-refresh: 40 s pass with no heartbeat, long
        // enough that a sibling may have judged the lock stale and taken it.
        clock.spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 40_000);
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
    });
    const lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(config.connectionKey).toBe('int-for-a-1');
      // Not removed by path: if a sibling had taken it over, that would be the sibling's lock.
      expect(fsSync.existsSync(lockFile)).toBe(true);
    } finally {
      clock.spy?.mockRestore();
      await fs.rm(lockFile, { force: true });
      await authority.close();
    }
  });

  it('takes over a lock left behind by a process that died holding it', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const lockFile = `${oauthStorePath(authority.base, agent)}.lock`;
      await fs.writeFile(lockFile, 'crashed');
      const longAgo = new Date(Date.now() - 60_000);
      await fs.utimes(lockFile, longAgo, longAgo);
      const startedAt = Date.now();
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(config.connectionKey).toBe('int-for-a-1');
      await expect(fs.stat(lockFile)).rejects.toThrow();
    } finally {
      await authority.close();
    }
  });
});

describe('renewing a shared sign-in', () => {
  const agent = { name: 'cursor-vscode' };

  it('a renewal that finds a live access token a sibling stored uses it and makes no refresh request', async () => {
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({
      refreshGrant: rotation.grant,
      localToken: exchangeUnless(new Set()),
      // The REST read's 401 is what renews: only the sibling's token is accepted.
      restAccepts: (bearer) => bearer === 'int-for-a-sib',
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      expect(refreshes(authority)).toHaveLength(1);
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-sib', accessToken: 'a-sib', accessExpiresAt: Date.now() + HOUR },
        agent,
      );
      await fetchAllManuals(config);
      expect(config.connectionKey).toBe('int-for-a-sib');
      expect(refreshes(authority)).toHaveLength(1);
    } finally {
      await authority.close();
    }
  });

  it('a renewal refused because a sibling rotated the token continues with the newer sign-in, and nothing is shown', async () => {
    const rotation = rotatingRefresh('r-1');
    let sibling: (() => void) | null = null;
    const authority = await stubAuthority({
      refreshGrant: (params) => {
        // The sibling's refresh lands between this process's read and its
        // request (it took no lock: an older hexis-mcp, or an unwritable lock
        // directory): the token presented here
        // is retired, and the store already holds the sibling's result.
        if (sibling) {
          const write = sibling;
          sibling = null;
          write();
          return { status: 400, body: { error: 'invalid_grant' } };
        }
        return rotation.grant(params);
      },
      localToken: exchangeUnless(new Set()),
      restAccepts: (bearer) => bearer === 'int-for-a-sib',
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      const ended = vi.fn();
      config.onSignInEnded = ended;
      // The stored access token is spent, so the renewal must refresh.
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-2', accessToken: 'a-1', accessExpiresAt: Date.now() - 1 },
        agent,
      );
      sibling = () =>
        fsSync.writeFileSync(
          oauthStorePath(authority.base, agent),
          JSON.stringify({ clientId: 'c1', refreshToken: 'r-sib', accessToken: 'a-sib', accessExpiresAt: Date.now() + HOUR }),
        );
      await fetchAllManuals(config);
      expect(config.connectionKey).toBe('int-for-a-sib');
      expect(ended).not.toHaveBeenCalled();
    } finally {
      await authority.close();
    }
  });

  it('a renewal refused with nothing newer stored ends renewal: the sentence once, and no further refresh request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rotation = rotatingRefresh('r-1');
    const authority = await stubAuthority({ refreshGrant: rotation.grant, localToken: exchangeUnless(new Set()) });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      const ended = vi.fn();
      config.onSignInEnded = ended;
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-2', accessToken: 'a-1', accessExpiresAt: Date.now() - 1 },
        agent,
      );
      rotation.state.refuseAll = true;
      const before = refreshes(authority).length;
      // The stub's REST surface refuses every bearer, so each read meets a 401 and renews.
      const refusal = await fetchAllManuals(config).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(SignInRefusedError);
      expect((refusal as Error).message).toMatch(/restart hexis-mcp to sign in through your browser again/);
      expect(ended).toHaveBeenCalledTimes(1);
      // A later REST 401 consults the same renewal: refused here, unasked.
      await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
      await expect(fetchLocalOnlyManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
      expect(refreshes(authority).length - before).toBe(1);
      expect(err.mock.calls.filter((c) => String(c[0]).includes('restart hexis-mcp'))).toHaveLength(1);
    } finally {
      await authority.close();
    }
  });

  it.each([401, 403])(
    'a freshly granted access token the exchange rejects (HTTP %i) ends renewal: the sentence once, and no further refresh request',
    async (status) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rotation = rotatingRefresh('r-1');
      const authority = await stubAuthority({
        refreshGrant: rotation.grant,
        // a-0 is the access token the process started on; a-1, granted by the renewal, is refused.
        localToken: (bearer) => (bearer === 'a-0' ? { status: 200, body: { token: 'int-for-a-0' } } : { status }),
      });
      try {
        await writeStoredCredentials(
          authority.base,
          { clientId: 'c1', refreshToken: 'r-1', accessToken: 'a-0', accessExpiresAt: Date.now() + HOUR },
          agent,
        );
        const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
        expect(config.connectionKey).toBe('int-for-a-0');
        const ended = vi.fn();
        config.onSignInEnded = ended;
        // a-0 has expired, so the renewal refreshes: the grant succeeds, the exchange refuses its token.
        await writeStoredCredentials(
          authority.base,
          { clientId: 'c1', refreshToken: 'r-1', accessToken: 'a-0', accessExpiresAt: Date.now() - 1 },
          agent,
        );
        const refusal = await fetchAllManuals(config).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(SignInRefusedError);
        expect((refusal as Error).message).toMatch(/restart hexis-mcp to sign in through your browser again/);
        expect(ended).toHaveBeenCalledTimes(1);
        expect(refreshes(authority)).toHaveLength(1);
        await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
        await expect(fetchLocalOnlyManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
        expect(refreshes(authority)).toHaveLength(1);
        expect(err.mock.calls.filter((c) => String(c[0]).includes('restart hexis-mcp'))).toHaveLength(1);
      } finally {
        await authority.close();
      }
    },
  );

  it('revoked on the Audit log page: one refusal per running process, and the next start opens the browser once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rotation = rotatingRefresh('r-1');
    const revoked = new Set<string>();
    const browser = fakeBrowser();
    const authority = await stubAuthority({
      refreshGrant: rotation.grant,
      codeGrant: (params) =>
        pkceCodeGrant(browser.seen, { access_token: 'a-flow', refresh_token: 'r-flow' })(params),
      localToken: exchangeUnless(revoked),
    });
    try {
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const running = await Promise.all(
        [1, 2].map(() =>
          establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent }),
        ),
      );
      // The revoke: the live access token stops exchanging, every refresh is refused.
      revoked.add('a-1');
      rotation.state.refuseAll = true;
      const before = refreshes(authority).length;
      for (const config of running) {
        // Each process meets the revoke as a REST 401, twice.
        await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
        await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
      }
      expect(refreshes(authority).length - before).toBe(2);
      expect(authority.record.dcr).toHaveLength(0);

      const restarted = await establishOAuthConfig(authority.base, authority.mcpUrl, {
        openBrowser: browser.open,
        print: quiet,
        agent,
      });
      expect(restarted.connectionKey).toBe('int-for-a-flow');
      expect(authority.record.dcr).toHaveLength(1);
      expect(await readStoredCredentials(authority.base, agent)).toMatchObject({ clientId: 'dyn-client', refreshToken: 'r-flow' });
    } finally {
      await authority.close();
    }
  });

  it('a network error or a 5xx is not a refusal: the renewal fails to be retried later, as before', async () => {
    const authority = await stubAuthority({
      refreshGrant: () => ({ status: 503 }),
      localToken: exchangeUnless(new Set()),
    });
    const busy = await stubAuthority({ refreshGrant: () => ({ status: 400, body: { error: 'temporarily_unavailable' } }) });
    try {
      await writeStoredCredentials(
        authority.base,
        { clientId: 'c1', refreshToken: 'r-1', accessToken: 'a-0', accessExpiresAt: Date.now() + HOUR },
        agent,
      );
      const config = await establishOAuthConfig(authority.base, authority.mcpUrl, { openBrowser: neverOpen, print: quiet, agent });
      await writeStoredCredentials(authority.base, { clientId: 'c1', refreshToken: 'r-1' }, agent);
      const failure = await config.renewConnectionKey!().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(OAuthError);
      expect(failure).not.toBeInstanceOf(SignInRefusedError);
      expect((failure as Error).message).toMatch(/HTTP 503/);
      await expect(refreshAccessToken(`${busy.base}/token`, 'c1', 'r1')).rejects.toThrow(/temporarily_unavailable/);
    } finally {
      await authority.close();
      await busy.close();
    }
  });
});
