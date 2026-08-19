import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { HexisMcpConfig } from './config.js';
import { hexisHome, hostKey } from './materialize.js';

/**
 * Browser sign-in (OAuth) for a person running this server without a
 * connection key — the default when no `--key`/`HEXIS_CONNECTION_KEY` is set.
 *
 * The shape is the standard one for a native app (RFC 8252) against an
 * MCP-style deployment:
 *
 *   1. DISCOVER — poke the deployment's MCP endpoint unauthenticated; its 401
 *      names the protected-resource metadata (RFC 9728), which names the
 *      authorization server, whose own metadata names the three endpoints.
 *   2. REFRESH — a prior sign-in left `{clientId, refreshToken}` on disk; a
 *      refresh grant skips the browser entirely.
 *   3. BROWSER — first run (or a dead refresh token): bind a loopback
 *      redirect, register a client for exactly that redirect (RFC 7591),
 *      send the person's browser to the authorization endpoint with PKCE,
 *      and trade the returned code for tokens.
 *   4. EXCHANGE — the OAuth access token is traded at the deployment's
 *      `/api/mcp/local-token` for an INTERNAL token, which is what the rest
 *      of this process uses as its bearer.
 *
 * The internal token lands in `HexisMcpConfig.connectionKey` — the same field
 * a connection key would fill, because it means the same thing: the one
 * credential THIS process attaches to the deployment. Vault separation is
 * unchanged by any of this: signing in only replaces the key as this
 * process's identity; remote tools still execute on the server, resolving
 * their secrets there, and nothing new becomes readable locally.
 */

/** Same contract as DeploymentError: a message the person can act on, printed without a stack. */
export class OAuthError extends Error {}

/** Bounded like deployment.ts's requests: a wedged endpoint fails with a message, not a hang. */
const FETCH_TIMEOUT_MS = 15_000;

/** The whole browser round trip — DCR to code — before we stop waiting on a human. */
const BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

async function reachOrExplain(url: string, label: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new OAuthError(
      `Could not reach ${label} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function jsonOrExplain(res: Response, url: string, label: string): Promise<unknown> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new OAuthError(`${label} returned HTTP ${res.status} from ${url}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new OAuthError(
      `${label} at ${url} answered with something that is not JSON — ` +
        'a proxy or login page may be intercepting it. Check that --url points at the workspace itself.',
    );
  }
}

/** An http(s) URL out of untrusted metadata, or a loud refusal naming the field. */
function httpUrlOrExplain(raw: unknown, label: string, source: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new OAuthError(`${source} names no ${label} — the deployment's OAuth setup looks incomplete.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OAuthError(`${source} advertised an unusable ${label}: "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OAuthError(`${source} advertised a non-http ${label}: "${raw}".`);
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// 1. Discovery
// ---------------------------------------------------------------------------

export interface AuthServerEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

/**
 * From the MCP endpoint to the three OAuth endpoints, by the MCP-standard
 * chain: an unauthenticated POST earns a 401 whose `WWW-Authenticate` names
 * the protected-resource metadata (RFC 9728); that names the authorization
 * server; the server's `/.well-known/oauth-authorization-server` (RFC 8414)
 * names the endpoints. Every link is validated loudly — a deployment that
 * cannot complete the chain gets told what is missing and that a connection
 * key still works.
 */
export async function discoverAuthServer(mcpUrl: string): Promise<AuthServerEndpoints> {
  const probe = await reachOrExplain(mcpUrl, 'the MCP endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await probe.body?.cancel().catch(() => {});
  if (probe.status !== 401) {
    throw new OAuthError(
      `Expected the MCP endpoint at ${mcpUrl} to answer an unauthenticated request with HTTP 401, ` +
        `got ${probe.status} — is --url pointing at a Hexis deployment?`,
    );
  }
  const challenge = probe.headers.get('www-authenticate') ?? '';
  const metadataRef = /resource_metadata="([^"]+)"/.exec(challenge);
  if (!metadataRef) {
    throw new OAuthError(
      'The MCP endpoint\'s 401 does not name its resource metadata (no resource_metadata in ' +
        `WWW-Authenticate${challenge ? `: "${challenge}"` : ' — the header is absent'}). ` +
        'This deployment may be too old for browser sign-in; a connection key (--key) still works.',
    );
  }
  const metadataUrl = httpUrlOrExplain(metadataRef[1], 'resource metadata URL', 'the MCP endpoint');

  const resourceMetadata = (await jsonOrExplain(
    await reachOrExplain(metadataUrl, 'the resource metadata'),
    metadataUrl,
    'the resource metadata',
  )) as { authorization_servers?: unknown };
  const servers = resourceMetadata?.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new OAuthError(
      `The resource metadata at ${metadataUrl} names no authorization server (no "authorization_servers" array) — ` +
        "the deployment's OAuth setup looks incomplete.",
    );
  }
  const issuer = httpUrlOrExplain(servers[0], 'authorization server issuer', 'the resource metadata')
    .replace(/\/+$/, '');

  const asMetadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const asMetadata = (await jsonOrExplain(
    await reachOrExplain(asMetadataUrl, 'the authorization server metadata'),
    asMetadataUrl,
    'the authorization server metadata',
  )) as { authorization_endpoint?: unknown; token_endpoint?: unknown; registration_endpoint?: unknown };
  const source = 'the authorization server metadata';
  return {
    authorizationEndpoint: httpUrlOrExplain(asMetadata?.authorization_endpoint, 'authorization endpoint', source),
    tokenEndpoint: httpUrlOrExplain(asMetadata?.token_endpoint, 'token endpoint', source),
    // Registration is not optional here: with no pre-provisioned client id,
    // dynamic registration is the only way this process gets one.
    registrationEndpoint: httpUrlOrExplain(asMetadata?.registration_endpoint, 'registration endpoint', source),
  };
}

// ---------------------------------------------------------------------------
// 2. Stored credentials
// ---------------------------------------------------------------------------

export interface StoredOAuthCredentials {
  clientId: string;
  refreshToken: string;
}

/** `~/.hexis/oauth/<host-key>.json` — same per-deployment keying the plugin trees use. */
export function oauthStorePath(baseUrl: string): string {
  return path.join(hexisHome(), 'oauth', `${hostKey(baseUrl)}.json`);
}

/**
 * A corrupt, unreadable or wrong-shaped store is an ABSENT one: the browser
 * flow rebuilds it, and nothing a person can do to this file should wedge the
 * server behind an unreadable parse error.
 */
export async function readStoredCredentials(baseUrl: string): Promise<StoredOAuthCredentials | null> {
  try {
    const raw = await fs.readFile(oauthStorePath(baseUrl), 'utf8');
    const parsed = JSON.parse(raw) as { clientId?: unknown; refreshToken?: unknown };
    if (
      typeof parsed?.clientId === 'string' &&
      parsed.clientId.length > 0 &&
      typeof parsed?.refreshToken === 'string' &&
      parsed.refreshToken.length > 0
    ) {
      return { clientId: parsed.clientId, refreshToken: parsed.refreshToken };
    }
  } catch {
    // fall through: absent
  }
  return null;
}

/**
 * Owner-only, the same posture materialize.ts documents for the plugin trees:
 * the refresh token is a durable credential for the person's workspace access
 * and belongs to no other local user. `writeFile`'s mode only applies on
 * creation, so the chmod re-asserts it for a pre-existing file — with the
 * same Windows pass the rest of the package gives chmod.
 */
export async function writeStoredCredentials(
  baseUrl: string,
  credentials: StoredOAuthCredentials,
): Promise<void> {
  const file = oauthStorePath(baseUrl);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch((err: unknown) => {
    if (process.platform !== 'win32') throw err;
  });
}

// ---------------------------------------------------------------------------
// Token endpoint grants
// ---------------------------------------------------------------------------

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
}

async function postForm(url: string, label: string, params: Record<string, string>): Promise<Response> {
  return reachOrExplain(url, label, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

async function parseTokenResponse(res: Response, url: string): Promise<TokenResponse> {
  const body = (await jsonOrExplain(res, url, 'the token endpoint')) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new OAuthError(`The token endpoint at ${url} answered without an access_token.`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
  };
}

/**
 * One refresh grant. `null` — not a throw — on a 400/401: an expired or
 * revoked refresh token is the EXPECTED way a stored sign-in dies, and the
 * caller's answer is the browser, not an error. Anything else unexpected
 * still throws, because a 500 from the token endpoint is not a reason to
 * bother a human with a browser tab.
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse | null> {
  const res = await postForm(tokenEndpoint, 'the token endpoint', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (res.status === 400 || res.status === 401) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return parseTokenResponse(res, tokenEndpoint);
}

// ---------------------------------------------------------------------------
// 3. Browser flow
// ---------------------------------------------------------------------------

/**
 * Hand a URL to the system browser without ever interpolating it into a shell
 * string: argument arrays only. On Windows `start` is a cmd builtin, so cmd is
 * unavoidable — the URL rides as ONE quoted verbatim argument (quotes cannot
 * occur in it: everything we build is percent-encoded, and any stray `"` is
 * re-encoded below), which keeps its `&`s from becoming cmd operators.
 */
export function openInBrowser(url: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/d', '/s', '/c', `start "" "${url.replace(/"/g, '%22')}"`], {
          windowsVerbatimArguments: true,
          detached: true,
          stdio: 'ignore',
        })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
          detached: true,
          stdio: 'ignore',
        });
  child.on('error', () => {
    // A missing opener (headless Linux without xdg-open) is not fatal: the
    // URL was already printed to stderr for exactly this case.
  });
  child.unref();
}

/** The tiny page the loopback answers with — a human is looking at it. */
function callbackPage(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:4rem auto;max-width:28rem"><h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`;
}

export interface BrowserFlowOptions {
  /** Injectable for tests and for `--no-open`; the default opens the system browser. */
  openBrowser?: (url: string) => void;
  /** Where the sign-in URL is ALWAYS written, browser or not. Defaults to stderr. */
  print?: (line: string) => void;
  timeoutMs?: number;
  clientName?: string;
}

export interface BrowserFlowResult {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
}

/**
 * The full first-run flow: loopback redirect, dynamic client registration,
 * PKCE authorization, code exchange.
 *
 * Order matters at the start: the loopback is bound FIRST, because dynamic
 * registration (RFC 7591) must name exactly the redirect_uri that will answer
 * — a port picked after registering would register a promise nobody keeps.
 * The `state` check is what stops a stray or hostile request to the loopback
 * from completing someone else's sign-in; a mismatch refuses the whole flow.
 */
export async function authorizeInBrowser(
  endpoints: AuthServerEndpoints,
  options: BrowserFlowOptions = {},
): Promise<BrowserFlowResult> {
  const timeoutMs = options.timeoutMs ?? BROWSER_FLOW_TIMEOUT_MS;
  const print = options.print ?? ((line: string) => process.stderr.write(`${line}\n`));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // Dynamic client registration, for exactly the redirect bound above.
    const registrationRes = await reachOrExplain(endpoints.registrationEndpoint, 'the registration endpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: options.clientName ?? `hexis-mcp on ${os.hostname()}`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // A public client: a CLI on a laptop cannot keep a secret, so PKCE is
        // the proof-of-possession instead.
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!registrationRes.ok) {
      await registrationRes.body?.cancel().catch(() => {});
      throw new OAuthError(
        `The registration endpoint refused this client (HTTP ${registrationRes.status}) — ` +
          'the deployment may not allow dynamic registration; a connection key (--key) still works.',
      );
    }
    const registration = (await registrationRes.json().catch(() => {
      throw new OAuthError('The registration endpoint answered with something that is not JSON.');
    })) as { client_id?: unknown };
    if (typeof registration?.client_id !== 'string' || !registration.client_id) {
      throw new OAuthError('The registration endpoint answered without a client_id.');
    }
    const clientId = registration.client_id;

    // PKCE (S256) + state.
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const authUrl = new URL(endpoints.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new OAuthError(
            `Timed out after ${Math.round(timeoutMs / 60_000)} minute(s) waiting for the browser sign-in. ` +
              'Run the command again to retry, or pass --key to skip the browser.',
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            callbackPage('Sign-in refused', 'This response does not belong to the sign-in this process started.'),
          );
          settle(reject)(
            new OAuthError(
              'The browser sign-in answered with a state this process never issued — refusing it. ' +
                'Run the command again to start a fresh sign-in.',
            ),
          );
          return;
        }
        const errorCode = url.searchParams.get('error');
        const returnedCode = url.searchParams.get('code');
        if (errorCode || !returnedCode) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            callbackPage('Sign-in failed', 'The workspace did not authorize this sign-in. You can close this tab.'),
          );
          settle(reject)(
            new OAuthError(`The workspace refused the sign-in${errorCode ? ` (${errorCode})` : ''}.`),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          callbackPage('Signed in', 'You can close this tab and return to your terminal.'),
        );
        settle(resolve)(returnedCode);
      });
      // Printed unconditionally — a machine with no display, or a browser that
      // never appears, still leaves the person a URL they can follow anywhere.
      print(`[hexis-mcp] sign in to continue: ${authUrl.toString()}`);
      (options.openBrowser ?? openInBrowser)(authUrl.toString());
    });

    const tokenRes = await postForm(endpoints.tokenEndpoint, 'the token endpoint', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!tokenRes.ok) {
      await tokenRes.body?.cancel().catch(() => {});
      throw new OAuthError(
        `The token endpoint refused the sign-in code (HTTP ${tokenRes.status}). Run the command again to retry.`,
      );
    }
    const tokens = await parseTokenResponse(tokenRes, endpoints.tokenEndpoint);
    return { clientId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// ---------------------------------------------------------------------------
// 4. Exchange — OAuth access token → internal token
// ---------------------------------------------------------------------------

export interface LocalTokenGrant {
  token: string;
  expiresInMs?: number;
}

/**
 * Trade the OAuth access token for the deployment's INTERNAL token at
 * `/api/mcp/local-token`. The 404 is handled by name because it is precisely
 * how a deployment that predates this endpoint answers — and "too old" is
 * actionable where "not found" is baffling.
 */
export async function exchangeForLocalToken(baseUrl: string, accessToken: string): Promise<LocalTokenGrant> {
  const url = `${baseUrl}/api/mcp/local-token`;
  const res = await reachOrExplain(url, 'the local-token exchange', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new OAuthError(
      'This deployment is too old for browser sign-in (it has no /api/mcp/local-token endpoint). ' +
        'Upgrade the deployment, or pass --key with a connection key from the profile menu → External agent access.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new OAuthError(
      `The local-token exchange rejected the sign-in (HTTP ${res.status}). ` +
        'Restart hexis-mcp to sign in through your browser again.',
    );
  }
  const body = (await jsonOrExplain(res, url, 'the local-token exchange')) as {
    token?: unknown;
    expiresInMs?: unknown;
  };
  if (typeof body?.token !== 'string' || !body.token) {
    throw new OAuthError(`The local-token exchange at ${url} answered without a token.`);
  }
  return {
    token: body.token,
    expiresInMs: typeof body.expiresInMs === 'number' ? body.expiresInMs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface OAuthModeOptions {
  /** Print the sign-in URL only; open nothing (`--no-open` / `HEXIS_NO_BROWSER=1`). */
  noOpen?: boolean;
  /** Injectable for tests; ignored when `noOpen` is set. */
  openBrowser?: (url: string) => void;
  print?: (line: string) => void;
  browserTimeoutMs?: number;
}

/** Refresh first — no browser for a machine that already signed in. Browser on a first run or a dead refresh. */
async function obtainAccessToken(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  options: OAuthModeOptions,
): Promise<string> {
  const stored = await readStoredCredentials(baseUrl);
  if (stored) {
    const refreshed = await refreshAccessToken(endpoints.tokenEndpoint, stored.clientId, stored.refreshToken);
    if (refreshed) {
      // Rotation: an authorization server may retire the old refresh token
      // with every grant, so a new one must land on disk before it is needed.
      if (refreshed.refreshToken && refreshed.refreshToken !== stored.refreshToken) {
        await writeStoredCredentials(baseUrl, { clientId: stored.clientId, refreshToken: refreshed.refreshToken });
      }
      return refreshed.accessToken;
    }
    // An expired/revoked refresh token falls through to a fresh sign-in.
  }
  const flow = await authorizeInBrowser(endpoints, {
    openBrowser: options.noOpen ? () => {} : options.openBrowser,
    print: options.print,
    timeoutMs: options.browserTimeoutMs,
  });
  if (flow.refreshToken) {
    await writeStoredCredentials(baseUrl, { clientId: flow.clientId, refreshToken: flow.refreshToken });
  }
  return flow.accessToken;
}

/**
 * The whole OAuth mode, as one call: discover, sign in (refresh or browser),
 * exchange — and hand back a `HexisMcpConfig` the rest of the process uses
 * exactly as it would a key-mode one.
 *
 * The internal token fills `connectionKey`: same field, same meaning — the
 * one bearer this process attaches. Vault separation is unchanged: the OAuth
 * identity only replaces the key as THIS process's credential; remote tools
 * still execute on the deployment against its Secrets Vault, and nothing new
 * becomes readable locally.
 *
 * `renewConnectionKey` is the mid-run answer to an expired internal token:
 * refresh → re-exchange, no browser. deployment.ts consults it on a 401,
 * once; if the refresh itself is dead mid-run, the error tells the person to
 * restart and sign in again rather than popping a browser out from under a
 * running MCP session.
 */
export async function establishOAuthConfig(
  baseUrl: string,
  mcpUrl: string,
  options: OAuthModeOptions = {},
): Promise<HexisMcpConfig> {
  const endpoints = await discoverAuthServer(mcpUrl);
  const accessToken = await obtainAccessToken(baseUrl, endpoints, options);
  const grant = await exchangeForLocalToken(baseUrl, accessToken);
  return {
    baseUrl,
    connectionKey: grant.token,
    renewConnectionKey: async (): Promise<string> => {
      const stored = await readStoredCredentials(baseUrl);
      if (!stored) {
        throw new OAuthError(
          'No stored sign-in to refresh — restart hexis-mcp to sign in through your browser again.',
        );
      }
      const refreshed = await refreshAccessToken(endpoints.tokenEndpoint, stored.clientId, stored.refreshToken);
      if (!refreshed) {
        throw new OAuthError(
          'The sign-in could not be refreshed (revoked, or expired) — ' +
            'restart hexis-mcp to sign in through your browser again.',
        );
      }
      if (refreshed.refreshToken && refreshed.refreshToken !== stored.refreshToken) {
        await writeStoredCredentials(baseUrl, { clientId: stored.clientId, refreshToken: refreshed.refreshToken });
      }
      return (await exchangeForLocalToken(baseUrl, refreshed.accessToken)).token;
    },
  };
}
