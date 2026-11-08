import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { SignInRefusedError, type HexisMcpConfig, type RenewedGrant } from './config.js';
import { agentDisplayName, agentStoreKey, registrationName, type AgentIdentity } from './handshake.js';
import { hexisHome, hostKey } from './materialize.js';
import { scheduleProactiveRenewal } from './renewal.js';

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
 *   2. REUSE OR REFRESH — a prior sign-in left `{clientId, refreshToken}` on
 *      disk, with the access token it last minted and when that expires. A
 *      live access token is reused as it is; otherwise a refresh grant renews
 *      it. Either way the browser stays shut. Every process of one agent on
 *      one machine shares this store, so both happen under a file lock (see
 *      `withStoreLock`).
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

/** The local-token exchange refused the access token it was handed (401/403): that token is dead. */
class LocalTokenRejectedError extends OAuthError {}

/**
 * What a process says, on stderr and in its `hexis_unavailable` notice, once
 * the workspace has refused its sign-in for good.
 */
const SIGN_IN_REFUSED_SENTENCE =
  'The workspace refused this sign-in (revoked, or expired), so hexis-mcp has stopped renewing it: ' +
  'restart hexis-mcp to sign in through your browser again.';

/** Bounded like deployment.ts's requests: a wedged endpoint fails with a message, not a hang. */
const FETCH_TIMEOUT_MS = 15_000;

/** The whole browser round trip — DCR to code — before we stop waiting on a human. */
const BROWSER_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

async function reachOrExplain(url: string, label: string, init?: RequestInit): Promise<Response> {
  try {
    // `redirect: 'error'`, everywhere in this flow: every URL here either came
    // out of untrusted discovery metadata or carries a credential (the token,
    // registration and exchange POSTs), and a redirect is how a compromised
    // answer re-aims the request at a host the gate never saw. Refusing is
    // safe because nothing in the OAuth chain legitimately redirects.
    return await fetch(url, { redirect: 'error', ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // fetch wraps the interesting part ("unexpected redirect", a DNS failure)
    // in `cause` behind a generic "fetch failed" — surface it.
    const detail =
      err instanceof Error
        ? err.cause instanceof Error && err.cause.message
          ? `${err.message} (${err.cause.message})`
          : err.message
        : String(err);
    throw new OAuthError(`Could not reach ${label} at ${url}: ${detail}`);
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

/**
 * A literal loopback host — the one place plain http is tolerable, because
 * only this machine can answer it. Hexis-mcp's own copy of the semantics of
 * core's `ensureSecureMcpUrl` (the packages share no code today): names are
 * NOT resolved, so only the literal spellings qualify.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * An http(s) URL out of untrusted metadata, or a loud refusal naming the field.
 *
 * The https-or-loopback gate is the discovery chain's SSRF boundary: every URL
 * validated here arrived over the network (a 401 header, a metadata document)
 * and is about to be fetched with — or asked to receive — this process's
 * credentials. Without the gate, a compromised or spoofed deployment could
 * aim the token/registration POSTs (bearer, refresh token, code) at an
 * arbitrary internal address, or send the person's BROWSER to one via the
 * authorization URL. https is required everywhere; plain http only for a
 * literal loopback host, which is what a local dev deployment looks like.
 */
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
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new OAuthError(
      `${source} advertised an insecure ${label}: "${raw}". Discovered OAuth URLs must be https ` +
        '(plain http is allowed only for a literal loopback host like 127.0.0.1 or localhost) — ' +
        'refusing to send credentials there. If this deployment is really behind plain http on ' +
        'another host, fix its TLS or use a connection key (--key) instead of browser sign-in.',
    );
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
  /** RFC 7009, when the server offers it: how a sign-in this process no longer needs is ended. */
  revocationEndpoint?: string;
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
  )) as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    registration_endpoint?: unknown;
    revocation_endpoint?: unknown;
  };
  const source = 'the authorization server metadata';
  return {
    authorizationEndpoint: httpUrlOrExplain(asMetadata?.authorization_endpoint, 'authorization endpoint', source),
    tokenEndpoint: httpUrlOrExplain(asMetadata?.token_endpoint, 'token endpoint', source),
    // Registration is not optional here: with no pre-provisioned client id,
    // dynamic registration is the only way this process gets one.
    registrationEndpoint: httpUrlOrExplain(asMetadata?.registration_endpoint, 'registration endpoint', source),
    // Revocation is: a server without one simply keeps a retired sign-in
    // until its refresh window closes.
    ...(typeof asMetadata?.revocation_endpoint === 'string' && asMetadata.revocation_endpoint
      ? { revocationEndpoint: httpUrlOrExplain(asMetadata.revocation_endpoint, 'revocation endpoint', source) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 2. Stored credentials
// ---------------------------------------------------------------------------

export interface StoredOAuthCredentials {
  clientId: string;
  refreshToken: string;
  /**
   * The OAuth access token the last grant minted, so a sibling process (Cursor
   * starts one server per window) reuses it instead of spending the rotating
   * refresh token again. Present only together with `accessExpiresAt`; a store
   * written before this field existed has neither, and reads as one whose
   * access token is spent.
   */
  accessToken?: string;
  /** When `accessToken` expires, in ms since the epoch. */
  accessExpiresAt?: number;
}

/**
 * `~/.hexis/oauth/<host-key>--<agent>.json` — per deployment (the same keying
 * the plugin trees use) AND per agent: a sign-in IS the agent's, registered
 * under its name and revocable on its own, so Claude Code and Cursor on one
 * machine each keep their own. With no agent known, the plain `<host-key>`
 * file the server used before it learned who was running it.
 */
export function oauthStorePath(baseUrl: string, agent: AgentIdentity | null = null): string {
  const suffix = agent ? `--${agentStoreKey(agent)}` : '';
  return path.join(hexisHome(), 'oauth', `${hostKey(baseUrl)}${suffix}.json`);
}

/**
 * A corrupt, unreadable or wrong-shaped store is an ABSENT one: the browser
 * flow rebuilds it, and nothing a person can do to this file should wedge the
 * server behind an unreadable parse error. An access token without a usable
 * expiry is dropped, not trusted: the refresh token alone still signs in.
 */
export async function readStoredCredentials(
  baseUrl: string,
  agent: AgentIdentity | null = null,
): Promise<StoredOAuthCredentials | null> {
  try {
    const raw = await fs.readFile(oauthStorePath(baseUrl, agent), 'utf8');
    const parsed = JSON.parse(raw) as {
      clientId?: unknown;
      refreshToken?: unknown;
      accessToken?: unknown;
      accessExpiresAt?: unknown;
    };
    if (
      typeof parsed?.clientId === 'string' &&
      parsed.clientId.length > 0 &&
      typeof parsed?.refreshToken === 'string' &&
      parsed.refreshToken.length > 0
    ) {
      const access =
        typeof parsed.accessToken === 'string' &&
        parsed.accessToken.length > 0 &&
        typeof parsed.accessExpiresAt === 'number' &&
        Number.isFinite(parsed.accessExpiresAt)
          ? { accessToken: parsed.accessToken, accessExpiresAt: parsed.accessExpiresAt }
          : {};
      return { clientId: parsed.clientId, refreshToken: parsed.refreshToken, ...access };
    }
  } catch {
    // fall through: absent
  }
  return null;
}

/**
 * Owner-only, the same posture materialize.ts documents for the plugin trees:
 * the refresh token is a durable credential for the person's workspace access
 * and belongs to no other local user. The file is written beside the store and
 * renamed over it, so a sibling process reading at that moment sees the old
 * sign-in or the new one, never half of one (which it would read as absent,
 * and answer with a browser tab). The chmod re-asserts the mode, with the same
 * Windows pass the rest of the package gives chmod.
 */
export async function writeStoredCredentials(
  baseUrl: string,
  credentials: StoredOAuthCredentials,
  agent: AgentIdentity | null = null,
): Promise<void> {
  const file = oauthStorePath(baseUrl, agent);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.${b64url(randomBytes(6))}.tmp`;
  try {
    await fs.writeFile(staged, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
    await fs.chmod(staged, 0o600).catch((err: unknown) => {
      if (process.platform !== 'win32') throw err;
    });
    await fs.rename(staged, file);
  } catch (err) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * A lock file untouched for this long was left by a process that died holding
 * it, and is taken over. A live holder touches it every STORE_LOCK_HEARTBEAT_MS
 * however long its refresh takes, so a live holder's lock is never judged stale.
 */
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_HEARTBEAT_MS = 5_000;
const STORE_LOCK_POLL_MS = 100;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` holding this sign-in's lock: `<store>.lock`, created with `O_EXCL`
 * so exactly one process on the machine holds it. Everything that reads the
 * store to decide whether to refresh, refreshes, and writes the result runs
 * inside it, so a refresh is made by one process at a time and the others
 * find its result in the store instead of presenting the token it retired.
 *
 * A waiter never runs `fn` while another process holds the lock: it waits
 * until the lock is released, or until its file has gone STORE_LOCK_STALE_MS
 * without the holder's heartbeat (a crashed holder) and is removed. The one
 * exception is a lock that cannot be created at all (an unwritable
 * directory): it is skipped, because a lock that can never be taken must not
 * cost the person their tools. The release removes the file only while it is
 * still this holder's.
 */
async function withStoreLock<T>(baseUrl: string, agent: AgentIdentity | null, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${oauthStorePath(baseUrl, agent)}.lock`;
  const owner = `${process.pid}:${b64url(randomBytes(12))}`;
  let held = false;
  await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 }).catch(() => {});
  for (;;) {
    try {
      await fs.writeFile(lockFile, owner, { flag: 'wx', mode: 0o600 });
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break;
    }
    const seen = await fs.stat(lockFile).then(
      (stat) => stat.mtimeMs,
      () => null, // released between our attempt and the stat: try again at once
    );
    if (seen === null) continue;
    if (Date.now() - seen > STORE_LOCK_STALE_MS) {
      // Removed only if it is still the stale file just judged: two waiters
      // judging the same dead lock must not have the slower one remove the
      // lock the faster one has just taken.
      const again = await fs.stat(lockFile).then((stat) => stat.mtimeMs, () => null);
      if (again === seen) await fs.rm(lockFile, { force: true }).catch(() => {});
      continue;
    }
    await pause(STORE_LOCK_POLL_MS);
  }
  const heartbeat = held
    ? setInterval(() => {
        const now = new Date();
        fs.utimes(lockFile, now, now).catch(() => {});
      }, STORE_LOCK_HEARTBEAT_MS)
    : null;
  heartbeat?.unref();
  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (held) {
      const current = await fs.readFile(lockFile, 'utf8').catch(() => null);
      if (current === owner) await fs.rm(lockFile, { force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Token endpoint grants
// ---------------------------------------------------------------------------

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** From `expires_in`; absent when the server does not say, and then the access token is never shared. */
  expiresInMs?: number;
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
    expires_in?: unknown;
  };
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new OAuthError(`The token endpoint at ${url} answered without an access_token.`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    expiresInMs:
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
        ? body.expires_in * 1000
        : undefined,
  };
}

/**
 * The two OAuth error codes (RFC 6749 §4.1.2.1) that say "try again later"
 * rather than "this token is no good": a 400/401 carrying one is transient.
 */
const TRANSIENT_TOKEN_ERRORS = new Set(['temporarily_unavailable', 'server_error']);

/**
 * One refresh grant. `null` — not a throw — on a 400/401: an unknown,
 * revoked or expired refresh token is the EXPECTED way a stored sign-in dies,
 * a refusal for good. Anything else throws, a 400/401 naming a transient error
 * included, because a 500 from the token endpoint is not a reason to bother a
 * human with a browser tab, nor to give up on a sign-in that may still work.
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
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    if (typeof error === 'string' && TRANSIENT_TOKEN_ERRORS.has(error)) {
      throw new OAuthError(`The token endpoint at ${tokenEndpoint} could not refresh the sign-in just now (${error}).`);
    }
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

/** The agent's name reaches the page from `clientInfo`, which is the client's to choose — so it is text, never markup. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
  /** What the deployment registers this client as — the name its Audit log shows. */
  clientName?: string;
  /** What the callback page tells the person to return to ("Claude Code"); defaults to their terminal. */
  returnTo?: string;
}

export interface BrowserFlowResult {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** The access token's lifetime, when the token endpoint says (`expires_in`). */
  expiresInMs?: number;
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
        // One rule for the registered name (handshake.ts): never the server itself.
        client_name: options.clientName ?? registrationName(null, os.hostname()),
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
          callbackPage('Signed in', `You can close this tab and return to ${escapeHtml(options.returnTo ?? 'your terminal')}.`),
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
    return {
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(tokens.expiresInMs !== undefined ? { expiresInMs: tokens.expiresInMs } : {}),
    };
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
    throw new LocalTokenRejectedError(
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
  /**
   * The agent running this server, from the MCP handshake (see handshake.ts).
   * It decides which stored sign-in is this one, what the sign-in registers
   * as, and what the callback page says to return to. Null (or absent) is a
   * client that named itself to nobody: the plain per-machine sign-in.
   */
  agent?: AgentIdentity | null;
}

/**
 * A stored access token is reused only while it has at least this long to
 * live. The internal token it is exchanged for lives no longer than it does
 * (the deployment binds the two) and is renewed at 80% of that life, so a
 * margin of minutes keeps a nearly spent token from being exchanged again and
 * again as it runs out.
 */
const ACCESS_REUSE_MARGIN_MS = 5 * 60_000;

/** The stored access token while it may be reused, else null. `distrusted` is one the exchange just rejected. */
function reusableAccessToken(stored: StoredOAuthCredentials, distrusted?: string): string | null {
  if (!stored.accessToken || stored.accessExpiresAt === undefined) return null;
  if (stored.accessToken === distrusted) return null;
  return stored.accessExpiresAt - Date.now() > ACCESS_REUSE_MARGIN_MS ? stored.accessToken : null;
}

/** What the store gave: an access token (reused, or freshly granted), no sign-in at all, or one refused for good. */
type StoredSignIn =
  | { kind: 'live'; accessToken: string; reused: boolean }
  | { kind: 'absent' }
  | { kind: 'refused' };

/** What one grant minted, as the store keeps it. The access token only with a known expiry. */
function grantedCredentials(
  clientId: string,
  refreshToken: string,
  accessToken: string,
  expiresInMs: number | undefined,
  requestedAt: number,
): StoredOAuthCredentials {
  return {
    clientId,
    refreshToken,
    ...(expiresInMs !== undefined ? { accessToken, accessExpiresAt: requestedAt + expiresInMs } : {}),
  };
}

/**
 * Refresh `stored` and write what the grant minted to the store BEFORE
 * anything uses it: a process starting a moment later must find the rotated
 * refresh token (the one presented here is now retired), and may reuse the
 * access token. Null when the workspace refused the refresh for good.
 */
async function refreshStored(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  agent: AgentIdentity | null,
  stored: StoredOAuthCredentials,
): Promise<string | null> {
  const requestedAt = Date.now();
  const refreshed = await refreshAccessToken(endpoints.tokenEndpoint, stored.clientId, stored.refreshToken);
  if (!refreshed) return null;
  await writeStoredCredentials(
    baseUrl,
    grantedCredentials(
      stored.clientId,
      refreshed.refreshToken ?? stored.refreshToken,
      refreshed.accessToken,
      refreshed.expiresInMs,
      requestedAt,
    ),
    agent,
  );
  return refreshed.accessToken;
}

/**
 * The stored sign-in's access token, decided under the store lock: the
 * stored one while it is live, else a refresh. A refusal re-reads the store
 * ONCE, because a writer that took no lock (an older hexis-mcp, or a sibling
 * whose lock directory is unwritable) may have written a newer sign-in; that
 * one is used instead. Nothing newer means the refusal stands.
 */
async function storedAccessToken(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  agent: AgentIdentity | null,
  distrusted?: string,
): Promise<StoredSignIn> {
  return withStoreLock(baseUrl, agent, async (): Promise<StoredSignIn> => {
    const stored = await readStoredCredentials(baseUrl, agent);
    if (!stored) return { kind: 'absent' };
    const reusable = reusableAccessToken(stored, distrusted);
    if (reusable) return { kind: 'live', accessToken: reusable, reused: true };
    const refreshed = await refreshStored(baseUrl, endpoints, agent, stored);
    if (refreshed) return { kind: 'live', accessToken: refreshed, reused: false };
    const latest = await readStoredCredentials(baseUrl, agent);
    if (!latest || (latest.clientId === stored.clientId && latest.refreshToken === stored.refreshToken)) {
      return { kind: 'refused' };
    }
    const newer = reusableAccessToken(latest, distrusted);
    if (newer) return { kind: 'live', accessToken: newer, reused: true };
    const renewed = await refreshStored(baseUrl, endpoints, agent, latest);
    return renewed ? { kind: 'live', accessToken: renewed, reused: false } : { kind: 'refused' };
  });
}

/**
 * The stored sign-in exchanged for an internal token, or why there is none.
 * A REUSED access token that the exchange rejects (revoked on the Audit log
 * page before it expired) is distrusted and a refresh tried in its place, so
 * what follows is the refresh token's own verdict, given once.
 */
async function exchangeStoredSignIn(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  agent: AgentIdentity | null,
): Promise<LocalTokenGrant | 'absent' | 'refused'> {
  let signIn = await storedAccessToken(baseUrl, endpoints, agent);
  if (signIn.kind === 'live' && signIn.reused) {
    try {
      return await exchangeForLocalToken(baseUrl, signIn.accessToken);
    } catch (err) {
      if (!(err instanceof LocalTokenRejectedError)) throw err;
      signIn = await storedAccessToken(baseUrl, endpoints, agent, signIn.accessToken);
    }
  }
  if (signIn.kind !== 'live') return signIn.kind;
  return exchangeForLocalToken(baseUrl, signIn.accessToken);
}

/**
 * The stored sign-in first: no browser for a machine that already signed in,
 * and none because a sibling process rotated the refresh token (the lock and
 * the store see to that). The browser opens only when nothing is stored or
 * the stored sign-in was refused for good.
 */
async function obtainGrant(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  options: OAuthModeOptions,
): Promise<LocalTokenGrant> {
  const agent = options.agent ?? null;
  const stored = await exchangeStoredSignIn(baseUrl, endpoints, agent);
  if (typeof stored === 'object') return stored;
  const flowStartedAt = Date.now();
  const flow = await authorizeInBrowser(endpoints, {
    openBrowser: options.noOpen ? () => {} : options.openBrowser,
    print: options.print,
    timeoutMs: options.browserTimeoutMs,
    clientName: registrationName(agent, os.hostname()),
    returnTo: agent ? agentDisplayName(agent) : undefined,
  });
  const refreshToken = flow.refreshToken;
  if (refreshToken) {
    await withStoreLock(baseUrl, agent, () =>
      writeStoredCredentials(
        baseUrl,
        grantedCredentials(flow.clientId, refreshToken, flow.accessToken, flow.expiresInMs, flowStartedAt),
        agent,
      ),
    );
  }
  if (agent) await retirePlainSignIn(baseUrl, endpoints, options.print);
  return exchangeForLocalToken(baseUrl, flow.accessToken);
}

/**
 * An agent's first sign-in supersedes the per-machine one the server used
 * before it knew who was running it: that sign-in is ended at the workspace
 * (RFC 7009 — the workspace then lists its "hexis-mcp on <host>" connection
 * as disconnected rather than live forever) and its refresh token leaves the
 * disk. Best effort, and said on stderr: the agent's own sign-in is already
 * in hand, and nothing here may take it back.
 */
async function retirePlainSignIn(
  baseUrl: string,
  endpoints: AuthServerEndpoints,
  print: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  const plain = await readStoredCredentials(baseUrl);
  if (!plain) return;
  try {
    if (endpoints.revocationEndpoint) {
      const res = await postForm(endpoints.revocationEndpoint, 'the revocation endpoint', {
        token: plain.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: plain.clientId,
      });
      await res.body?.cancel().catch(() => {});
    }
    await fs.rm(oauthStorePath(baseUrl), { force: true });
    print('[hexis-mcp] retired the previous per-machine sign-in; this agent now signs in as itself.');
  } catch (err) {
    print(
      `[hexis-mcp] could not retire the previous per-machine sign-in (${err instanceof Error ? err.message : String(err)}); ` +
        'it will expire on its own.',
    );
  }
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
 * `renewConnectionKey` is the answer to an expiring internal token: the
 * stored access token if a sibling has already renewed it, else a refresh,
 * then a re-exchange; no browser. It is only ever run through `renewal.ts`'s
 * single-flight (deployment.ts consults that on a mid-run 401; the proactive
 * timer armed below consults it before expiry). A refresh refused for good
 * mid-run throws `SignInRefusedError`, which tells the person to restart and
 * sign in again rather than popping a browser out from under a running MCP
 * session, and which renewal.ts never retries.
 */
export async function establishOAuthConfig(
  baseUrl: string,
  mcpUrl: string,
  options: OAuthModeOptions = {},
): Promise<HexisMcpConfig> {
  const endpoints = await discoverAuthServer(mcpUrl);
  const agent = options.agent ?? null;
  const grant = await obtainGrant(baseUrl, endpoints, options);
  const config: HexisMcpConfig = {
    baseUrl,
    connectionKey: grant.token,
    renewConnectionKey: async (): Promise<RenewedGrant> => {
      let signIn: LocalTokenGrant | 'absent' | 'refused';
      try {
        signIn = await exchangeStoredSignIn(baseUrl, endpoints, agent);
      } catch (err) {
        // A freshly granted access token the exchange rejects: the sign-in is gone.
        if (err instanceof LocalTokenRejectedError) throw new SignInRefusedError(SIGN_IN_REFUSED_SENTENCE);
        throw err;
      }
      if (signIn === 'refused') throw new SignInRefusedError(SIGN_IN_REFUSED_SENTENCE);
      if (signIn === 'absent') {
        // Not a refusal: no request was made, and a sign-in another window
        // completes lands in the store this retry reads.
        throw new OAuthError(
          'No stored sign-in to refresh — restart hexis-mcp to sign in through your browser again.',
        );
      }
      return signIn;
    },
  };
  // Arm the first proactive renewal off the initial grant: without it the
  // remote manual's transport — which never travels the reactive 401 path —
  // would ride the first token to its death (see renewal.ts).
  scheduleProactiveRenewal(config, grant.expiresInMs);
  return config;
}
