import type { ISecretsVaultService, OAuthProviderConfig } from './secrets-vault.contract.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import { utcpNamespacedKey, MCP_OAUTH_VAR } from '../../shared/utcp-namespace.js';

export type McpAuthDiscovery =
  /** The server answered without demanding auth — nothing to configure. */
  | { status: 'open' }
  /** OAuth discovered (or already registered); per-user sign-in via the vault. */
  | { status: 'oauth'; provider: OAuthProviderConfig }
  /** The server wants auth but the spec chain didn't complete — leave the tool as-is. */
  | { status: 'unsupported'; reason: string };

const FETCH_TIMEOUT_MS = 5_000;
/** Re-probe an open/unsupported server after this long (it may grow/lose auth). */
const NEGATIVE_TTL_MS = 5 * 60_000;
/** A discovered provider is durable (shared vault row); cache is just DB-pressure relief. */
const OAUTH_TTL_MS = 60 * 60_000;

/**
 * Zero-config OAuth for `type: mcp` `.tool`s — the MCP authorization spec makes
 * everything a bare `url` needs discoverable, so a tool file shouldn't have to
 * declare any of it. Given a manual that points at a remote MCP server:
 *
 *   1. probe the server — no 401 ⇒ it's open, done;
 *   2. on 401, follow RFC 9728: the protected-resource metadata (from the
 *      `WWW-Authenticate: resource_metadata` pointer or the well-known paths)
 *      names the authorization server;
 *   3. fetch the AS metadata, dynamically register (RFC 7591) as a PUBLIC
 *      client — PKCE only, no client secret — with our existing secrets-vault
 *      callback as the redirect URI;
 *   4. persist the discovered provider as the SHARED vault row under the
 *      synthetic key `<manual>_MCP_OAUTH`.
 *
 * From there the standard tool-OAuth machinery takes over unchanged: /connect
 * shows an Authorize button (the manual is decorated with a synthetic
 * user-scoped oauth variable), `beginToolOAuthByKey` provisions the caller's
 * row from the shared one, and the UTCP variable loader injects the fresh
 * access token into the manual's `Authorization` header at call time.
 *
 * Every fetch is SSRF-guarded (https-only, no redirects, bounded) — these URLs
 * originate from user-authored `.tool` files and remote servers' own metadata.
 */
export class McpOAuthDiscoveryService {
  private readonly cache = new Map<string, { result: McpAuthDiscovery; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<McpAuthDiscovery>>();

  constructor(
    private readonly deps: {
      secretsVault: ISecretsVaultService;
      /** Our OAuth callback (`<publicBackendUrl>/api/secrets/oauth/callback`) — the DCR redirect_uri. */
      redirectUri: string;
      now?: () => number;
      fetchFn?: typeof fetch;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The vault key the discovered provider (and each user's tokens) live under. */
  static keyFor(manualName: string): string {
    return utcpNamespacedKey(manualName, MCP_OAUTH_VAR);
  }

  async statusFor(manualName: string, mcpUrl: string): Promise<McpAuthDiscovery> {
    const key = McpOAuthDiscoveryService.keyFor(manualName);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.discover(key, manualName, mcpUrl).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private remember(key: string, result: McpAuthDiscovery): McpAuthDiscovery {
    const ttl = result.status === 'oauth' ? OAUTH_TTL_MS : NEGATIVE_TTL_MS;
    this.cache.set(key, { result, expiresAt: this.now() + ttl });
    return result;
  }

  private async discover(key: string, manualName: string, mcpUrl: string): Promise<McpAuthDiscovery> {
    // A prior discovery (any replica, any boot) already registered a client —
    // NEVER re-register: a new client_id would orphan every user's tokens.
    // Fail CLOSED on a lookup error: a vault/DB blip must not read as "no
    // provider exists", or we'd fall through to fresh RFC 7591 registration
    // and orphan those tokens. Returned uncached so the next call retries
    // once the store recovers.
    let existing;
    try {
      existing = await this.deps.secretsVault.getSharedOAuthProvider(key);
    } catch (err) {
      const reason = `provider lookup failed (not re-registering): ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[mcp-oauth-discovery] "${manualName}" (${mcpUrl}): ${reason}`);
      return { status: 'unsupported', reason };
    }
    if (existing) return this.remember(key, { status: 'oauth', provider: existing });

    let result: McpAuthDiscovery;
    try {
      result = await this.discoverFresh(manualName, key, mcpUrl);
    } catch (err) {
      result = {
        status: 'unsupported',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.status === 'unsupported') {
      console.warn(`[mcp-oauth-discovery] "${manualName}" (${mcpUrl}): ${result.reason}`);
    }
    return this.remember(key, result);
  }

  private async discoverFresh(manualName: string, key: string, mcpUrl: string): Promise<McpAuthDiscovery> {
    // 1. Probe: an unauthenticated initialize. A 401/403, or ANY response
    //    carrying a `WWW-Authenticate` challenge, means the server wants OAuth;
    //    a redirect to a login page (fetch throws under `redirect:'error'`)
    //    counts too. Anything else means it served us without auth — nothing to
    //    configure. `allow401` short-circuits `fetchRaw`'s ok/redirect handling
    //    so the challenge itself is inspected rather than thrown.
    let probe: Response;
    try {
      probe = await this.fetchRaw(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'bevel-discovery', version: '0.0.0' },
          },
        }),
      });
    } catch (err) {
      // A redirect to a login page (or a network refusal) — treat a redirect as
      // "auth wanted" and keep going from the well-known metadata; a genuine
      // network failure surfaces as unsupported.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/redirect/i.test(msg)) return { status: 'unsupported', reason: `probe failed: ${msg}` };
      probe = new Response(null, { status: 401 });
    }
    // 2. Protected-resource metadata (RFC 9728): prefer the server's own
    //    pointer in the challenge, else the well-known locations. Fetch this
    //    BEFORE deciding — a server can require OAuth for tool CALLS while
    //    letting an unauthenticated `initialize` through (Google's gmail/
    //    calendar MCP return 200 to initialize but still publish a PRM doc), so
    //    the probe status alone is not a reliable "needs auth" signal.
    const prmUrl =
      parseResourceMetadataUrl(probe.headers.get('www-authenticate')) ??
      undefined;
    const base = new URL(mcpUrl);
    const prmCandidates = prmUrl
      ? [prmUrl]
      : [
          new URL(`/.well-known/oauth-protected-resource${base.pathname === '/' ? '' : base.pathname}`, base).toString(),
          new URL('/.well-known/oauth-protected-resource', base).toString(),
        ];
    let prm: Record<string, unknown> | null = null;
    for (const candidate of prmCandidates) {
      prm = await this.fetchJson(candidate);
      if (prm) break;
    }
    // Wants OAuth iff the probe demanded it (401/403/challenge) OR the server
    // publishes protected-resource metadata. Neither → genuinely open.
    const wantsAuth =
      probe.status === 401 ||
      probe.status === 403 ||
      probe.headers.get('www-authenticate') != null ||
      prm != null;
    if (!wantsAuth) return { status: 'open' };
    const authServers = Array.isArray(prm?.authorization_servers)
      ? prm!.authorization_servers.filter((s): s is string => typeof s === 'string')
      : [];
    // MCP pre-RFC9728 fallback: the resource server's own origin is the AS.
    const issuer = authServers[0] ?? base.origin;
    const resource = typeof prm?.resource === 'string' ? prm.resource : mcpUrl;
    const scopes = Array.isArray(prm?.scopes_supported) ? prm!.scopes_supported.map(String) : undefined;

    // 3. Authorization-server metadata (RFC 8414; OIDC discovery as fallback).
    const issuerUrl = new URL(issuer);
    const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname;
    const asCandidates = [
      new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuerUrl).toString(),
      new URL(`${issuerPath}/.well-known/openid-configuration`, issuerUrl).toString(),
    ];
    let asMeta: Record<string, unknown> | null = null;
    for (const candidate of asCandidates) {
      asMeta = await this.fetchJson(candidate);
      if (asMeta) break;
    }
    if (!asMeta) {
      return { status: 'unsupported', reason: `no authorization-server metadata at ${issuer}` };
    }
    const authorizationUrl = typeof asMeta.authorization_endpoint === 'string' ? asMeta.authorization_endpoint : '';
    const tokenUrl = typeof asMeta.token_endpoint === 'string' ? asMeta.token_endpoint : '';
    const registrationUrl = typeof asMeta.registration_endpoint === 'string' ? asMeta.registration_endpoint : '';
    if (!authorizationUrl || !tokenUrl) {
      return { status: 'unsupported', reason: 'authorization-server metadata is missing endpoints' };
    }
    if (!registrationUrl) {
      return {
        status: 'unsupported',
        reason:
          'server requires sign-in but does not support automatic client registration — declare the oauth provider in the .tool file instead',
      };
    }

    // 4. Dynamic client registration (RFC 7591), as a PUBLIC client: PKCE
    //    carries the proof, no secret to store or leak.
    assertSafeFetchUrl(registrationUrl, { requireHttps: true, label: 'registration_endpoint' });
    const regRes = await this.fetchRaw(registrationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Bevel Knowledge Base',
        redirect_uris: [this.deps.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!regRes.ok) {
      return { status: 'unsupported', reason: `client registration failed: HTTP ${regRes.status}` };
    }
    const reg = (await regRes.json().catch(() => null)) as Record<string, unknown> | null;
    const clientId = typeof reg?.client_id === 'string' ? reg.client_id : '';
    if (!clientId) {
      return { status: 'unsupported', reason: 'client registration returned no client_id' };
    }
    const clientSecret = typeof reg?.client_secret === 'string' && reg.client_secret ? reg.client_secret : undefined;

    const provider: OAuthProviderConfig = {
      authorizationUrl,
      tokenUrl,
      clientId,
      clientSecret,
      scopes,
      pkce: true,
      publicClient: !clientSecret,
      resource,
    };
    await this.deps.secretsVault.putSharedOAuthProvider({
      key,
      label: `${manualName} sign-in`,
      provider,
    });
    // Return the stored (public) shape — no secret rides in cache entries.
    const publicProvider = { ...provider };
    delete publicProvider.clientSecret;
    return { status: 'oauth', provider: publicProvider };
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    assertSafeFetchUrl(url, { requireHttps: true, label: 'mcp discovery url' });
    const fetchFn = this.deps.fetchFn ?? fetch;
    return fetchFn(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  /** GET a metadata document; null on any failure (fall through to the next candidate). */
  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchRaw(url, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

/** Extract `resource_metadata="…"` from a WWW-Authenticate challenge (RFC 9728 §5.1). */
function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match ? match[1] : null;
}
