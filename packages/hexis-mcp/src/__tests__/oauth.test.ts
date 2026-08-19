import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  OAuthError,
  authorizeInBrowser,
  discoverAuthServer,
  establishOAuthConfig,
  exchangeForLocalToken,
  oauthStorePath,
  readStoredCredentials,
  refreshAccessToken,
  writeStoredCredentials,
} from '../oauth.js';
import { fetchAllManuals } from '../deployment.js';
import type { HexisMcpConfig } from '../config.js';

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
  /** Answer a refresh_token grant. Default: 400 invalid_grant. */
  refreshGrant?: (params: URLSearchParams) => Answer;
  /** Answer an authorization_code grant. Default: 400. */
  codeGrant?: (params: URLSearchParams) => Answer;
  /** Answer POST /api/mcp/local-token given the presented bearer. Default: 404 (a too-old deployment). */
  localToken?: (bearer: string) => Answer;
  /** Which internal tokens the REST surface accepts. Default: none. */
  restAccepts?: (bearer: string) => boolean;
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
  record: { dcr: Record<string, unknown>[]; token: URLSearchParams[] };
  close: () => Promise<void>;
}

async function stubAuthority(opts: AuthorityOptions = {}): Promise<Authority> {
  const record: Authority['record'] = { dcr: [], token: [] };
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
          },
        );
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
        send(answer.status, answer.body);
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
        else send(401);
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
    void fetch(redirect).then((res) => res.body?.cancel().catch(() => {}));
  };
  return { open, seen };
}

/** A code grant that enforces the PKCE contract against what the fake browser saw. */
function pkceCodeGrant(
  seen: { authUrl?: URL },
  tokens: { access_token: string; refresh_token?: string },
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
      expect(String(authority.record.dcr[0]!.client_name)).toContain('hexis-mcp on ');

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
      void fetch(redirect).then((res) => res.body?.cancel().catch(() => {}));
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
      expect(await fetchAllManuals(config)).toEqual([]);
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
      expect(await fetchAllManuals(config)).toEqual([]);
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
    const renew = vi.fn(async () => 'still-rejected');
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
});
