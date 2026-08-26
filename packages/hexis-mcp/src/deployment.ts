import type { HexisMcpConfig } from './config.js';
import { renewConnectionKeyNow } from './renewal.js';

/**
 * The REST surface this server reads before it can serve anything. Everything
 * here is already exposed to an external agent holding a connection key — we
 * add no new endpoint and ask for nothing a remote agent could not already ask
 * for itself.
 */

/** Bounded so a wedged deployment fails startup with a message instead of hanging a client. */
const FETCH_TIMEOUT_MS = 15_000;

export class DeploymentError extends Error {}

async function getJson(
  url: string,
  init: RequestInit & { label: string; renew?: () => Promise<string> },
): Promise<unknown> {
  const { renew, label, ...request } = init;
  const attempt = async (freshBearer?: string): Promise<Response> => {
    const headers = freshBearer
      ? { ...(request.headers as Record<string, string>), Authorization: `Bearer ${freshBearer}` }
      : request.headers;
    try {
      return await fetch(url, { ...request, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new DeploymentError(
        `Could not reach ${label} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  let res = await attempt();
  const authed = 'Authorization' in ((request.headers ?? {}) as Record<string, unknown>);
  // OAuth mode's mid-run 401: the internal token expired, and one refresh →
  // re-exchange (that is all `renew` does) earns exactly ONE retry. A second
  // 401 means the authorization itself is gone — revoked, or the account lost
  // access — which no amount of refreshing fixes, so it propagates below.
  // 401 only: a 403 is a permission answer about a live credential.
  let retried = false;
  if (res.status === 401 && authed && renew) {
    // The discarded response's body is drained before the retry replaces it —
    // an unread body pins its connection (and, kept long enough, its memory)
    // for as long as the runtime cares to wait.
    await res.body?.cancel().catch(() => {});
    res = await attempt(await renew());
    retried = true;
  }
  if (res.status === 401 || res.status === 403) {
    // Only a request that actually carried the credential can blame it: the
    // config endpoint is unauthenticated, so its 401/403 is something else
    // (an SSO gate, a proxy) answering in the deployment's place.
    throw new DeploymentError(
      !authed
        ? `${label} refused access (HTTP ${res.status}) to a request that carries no credentials — ` +
            'an SSO gate or proxy may be intercepting the deployment. Check that --url points at the workspace itself.'
        : renew
          ? res.status === 403
            ? // A 403 is a PERMISSION answer about a live credential — the
              // sign-in worked, the account simply may not do this. Telling
              // the person to re-authorize would send them through a browser
              // round trip that changes nothing.
              `${label} denied access (HTTP 403): your signed-in account does not have permission for this. ` +
                'The sign-in itself is valid — ask a workspace admin for access; signing in again will not change the answer.'
            : `Your sign-in was rejected by ${label} (HTTP 401)${retried ? ' even after refreshing it' : ''} — ` +
                'the authorization may have been revoked. Re-authorize by restarting hexis-mcp and signing in through your browser again.'
          : `The connection key was rejected by ${label} (HTTP ${res.status}). ` +
              'Mint a fresh one from the profile menu → External agent access.',
    );
  }
  if (!res.ok) {
    throw new DeploymentError(`${label} returned HTTP ${res.status} from ${url}.`);
  }
  // A 200 that is not JSON is a proxy or SPA fallback answering in the
  // deployment's place (a login page, a catch-all index.html). That is a
  // deployment problem the person can act on, so it must not escape as a raw
  // SyntaxError — the CLI prints those as stack traces, treating them as bugs.
  try {
    return await res.json();
  } catch {
    throw new DeploymentError(
      `${label} at ${url} answered with something that is not JSON — ` +
        'a proxy or login page may be intercepting the deployment. Check that --url points at the workspace itself.',
    );
  }
}

/**
 * The `renew` a request should consult, if the config carries one. It routes
 * through `renewal.ts`'s SINGLE-FLIGHT — never `config.renewConnectionKey`
 * directly — because the refresh token rotates: two racing renewals (startup's
 * `Promise.all` fetches, or concurrent mid-run tool calls) would have the
 * loser present a just-retired refresh token and kill the sign-in. The shared
 * flight also updates `config.connectionKey`, so every LATER request carries
 * the fresh token without each call site re-threading it.
 */
function renewer(config: HexisMcpConfig): (() => Promise<string>) | undefined {
  if (!config.renewConnectionKey) return undefined;
  return () => renewConnectionKeyNow(config);
}

/**
 * The deployment's own MCP endpoint.
 *
 * Asked for rather than computed. `/api/config` derives `mcpUrl` from the same
 * expression as the OAuth `resourceServerUrl`, which is the identifier that
 * decides whether a connection works — so a locally-guessed `<base>/api/mcp`
 * is right only until someone puts the deployment behind a proxy or on a second
 * domain, and a process on a laptop has no address bar to guess from anyway.
 *
 * Falls back to the guess when the field is absent, which is how a deployment
 * older than that field looks. The frontend's `configureMcpUrl()` degrades the
 * same way, for the same reason.
 */
export async function resolveMcpUrl(config: HexisMcpConfig): Promise<string> {
  const body = (await getJson(`${config.baseUrl}/api/config`, {
    label: 'the deployment config',
  })) as { mcpUrl?: unknown };
  const advertised = typeof body?.mcpUrl === 'string' ? body.mcpUrl.trim() : '';
  if (!advertised) {
    console.error(
      '[hexis-mcp] this deployment does not advertise its MCP endpoint; falling back to <url>/api/mcp. ' +
        'If the workspace sits behind a proxy or on another domain, upgrade it or point --url at the address ' +
        'its OAuth metadata publishes.',
    );
    return `${config.baseUrl}/api/mcp`;
  }
  let parsed: URL;
  try {
    parsed = new URL(advertised);
  } catch {
    throw new DeploymentError(`The deployment advertised an unusable MCP endpoint: "${advertised}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DeploymentError(`The deployment advertised a non-http MCP endpoint: "${advertised}".`);
  }
  // Embedded credentials never travel: the connection key is the credential,
  // and every MCP request would otherwise carry a misconfigured `user:pass@`
  // to the endpoint alongside it.
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    console.error('[hexis-mcp] dropped credentials embedded in the advertised MCP endpoint — the connection key is the credential.');
  }
  // A cross-origin endpoint is legitimate — a proxy or second domain is the
  // reason this field exists — and it adds no exposure the deployment does not
  // already have (it holds the key that gets attached). But it is also the one
  // place a compromised deployment could point this process at an address the
  // user never typed, so the redirection is named rather than silent.
  // Origin, not host: an https→http swap on the same host re-routes the key
  // over plaintext and deserves the same named notice as a host change.
  const configuredOrigin = new URL(config.baseUrl).origin;
  if (parsed.origin !== configuredOrigin) {
    console.error(
      `[hexis-mcp] the deployment routes MCP through ${parsed.origin}, not ${configuredOrigin} — expected for a proxied workspace, worth noticing otherwise.`,
    );
  }
  return parsed.toString();
}

/** One `.tool` manual as `GET /api/agent/all-tools` returns it. */
export type RawManual = Record<string, unknown> & { name?: unknown };

/**
 * Every manual the caller can read, local-only ones included.
 *
 * `?remote=false` is the opt-in the REST surface already documents for "a
 * locally installed MCP server" — the default excludes local-only manuals
 * precisely because the hosted proxy cannot run them.
 */
export async function fetchAllManuals(config: HexisMcpConfig): Promise<RawManual[]> {
  const body = (await getJson(`${config.baseUrl}/api/agent/all-tools?remote=false`, {
    label: 'the tool manual list',
    headers: { Authorization: `Bearer ${config.connectionKey}` },
    renew: renewer(config),
  })) as { manuals?: unknown };
  // Shape drift is loud, not empty: an `[]` here would let the server start,
  // log success, and quietly serve none of the local-only tools it exists for.
  if (!Array.isArray(body?.manuals)) {
    throw new DeploymentError(
      'The tool manual list did not have the expected shape (no "manuals" array) — is --url pointing at a Hexis deployment?',
    );
  }
  return body.manuals as RawManual[];
}

/** What this server needs to know about one local-only manual beyond its name. */
export interface LocalManualInfo {
  /**
   * How the manual is ADDRESSED on the deployment's REST surface — the key for
   * the variable-resolution route. Distinct from the manual's UTCP `name`,
   * which is the namespace its `${VAR}` refs are keyed by; they coincide for a
   * `.tool` file but not necessarily for every source.
   */
  slug: string;
  /** The manual's declaring file in the knowledge base, e.g. `Plugins/<folder>/mcp.json`. */
  path: string;
}

/**
 * The manuals that only work locally — the ones this server exists to add.
 * Asking the deployment (rather than inferring from the two list variants)
 * keeps the definition of "local-only" in the one place that owns it.
 */
export async function fetchLocalOnlyManuals(config: HexisMcpConfig): Promise<Map<string, LocalManualInfo>> {
  const body = (await getJson(`${config.baseUrl}/api/agent/tools/list_local_tools`, {
    label: 'the local-only tool list',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.connectionKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    renew: renewer(config),
  })) as { tools?: unknown };
  // Same loudness as `fetchAllManuals`: losing this list silently is losing
  // exactly the tools this server exists to add.
  if (!Array.isArray(body?.tools)) {
    throw new DeploymentError(
      'The local-only tool list did not have the expected shape (no "tools" array) — is --url pointing at a Hexis deployment?',
    );
  }
  const tools = body.tools;
  // UTCP name → { slug, path }. The path locates the PLUGIN a stdio server
  // belongs to (`Plugins/<folder>/mcp.json`), which is what gets materialized
  // locally before the server can spawn; the slug addresses the manual when
  // asking the deployment to resolve the variables it declares.
  const manuals = new Map<string, LocalManualInfo>();
  for (const t of tools) {
    const name = (t as { name?: unknown })?.name;
    const path = (t as { path?: unknown })?.path;
    const slug = (t as { slug?: unknown })?.slug;
    if (typeof name === 'string' && name.length > 0) {
      manuals.set(name, {
        // An older deployment predates `slug` on this listing; for a `.tool`
        // the two are equal, so falling back to the name keeps this server
        // working against one rather than silently resolving nothing.
        slug: typeof slug === 'string' && slug.length > 0 ? slug : name,
        path: typeof path === 'string' ? path : '',
      });
    }
  }
  return manuals;
}

/** What a resolution attempt produced, and whether it actually succeeded. */
export interface LocalToolVariables {
  /**
   * Whether the deployment answered. FALSE for a network blip, a refusal, or a
   * deployment predating the route — distinct from "answered, nothing set",
   * because only a real answer is worth caching.
   */
  ok: boolean;
  values: Record<string, string>;
}

/**
 * The variables one LOCAL manual declares, resolved by the deployment.
 *
 * The request names the MANUAL, never a variable: the deployment re-reads the
 * `.tool` file and resolves exactly what that file declares, so the knowledge
 * base is the allowlist and this process cannot widen it. What comes back is
 * scoped to one manual's namespace and goes straight into that manual's tool
 * invocations — see `localVariableLoader`.
 *
 * A failure is NOT fatal. A manual may declare variables that are simply unset,
 * the deployment may be an older build without the route, and either way the
 * tool should still be offered and fail with its own error message rather than
 * being absent from the toolset. So the caller gets `ok: false` and an empty
 * map — and, because it is `ok: false`, the caller knows not to cache it.
 */
export async function fetchLocalToolVariables(
  config: HexisMcpConfig,
  slug: string,
): Promise<LocalToolVariables> {
  try {
    const body = (await getJson(
      `${config.baseUrl}/api/agent/local-tools/${encodeURIComponent(slug)}/variables`,
      {
        label: `the variables for local tool "${slug}"`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.connectionKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        renew: renewer(config),
      },
    )) as { variables?: unknown; missing?: unknown };
    const vars = body?.variables;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      // A 200 whose shape we do not recognise is protocol drift, not an unset
      // secret. Saying so is the difference between an operator debugging their
      // vault and an operator debugging a version mismatch.
      console.error(
        `[hexis-mcp] the deployment answered for local tool "${slug}" without a "variables" object — ` +
          'its secrets will not resolve. Check that the deployment is new enough to serve this route.',
      );
      return { ok: false, values: {} };
    }
    if (Array.isArray(body.missing) && body.missing.length > 0) {
      console.error(
        `[hexis-mcp] local tool "${slug}" has unset variables: ${body.missing.join(', ')} — ` +
          'set them on the deployment (Secrets), or the tool will run without them.',
      );
    }
    // Null-prototype, so a variable named `__proto__` or `constructor` is an
    // ordinary own property rather than a write to the prototype. A `.tool` may
    // declare any `[A-Za-z0-9_]+` name, and those two are both valid names.
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return { ok: true, values: out };
  } catch (err) {
    console.error(
      `[hexis-mcp] could not resolve variables for local tool "${slug}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, values: {} };
  }
}

/** A skill as the catalog lists it, and one loaded in full. Shapes mirror the KB tools. */
export async function callKbTool(
  config: HexisMcpConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return getJson(`${config.baseUrl}/api/agent/tools/${tool}`, {
    label: `the ${tool} tool`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.connectionKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    renew: renewer(config),
  });
}
