/**
 * Everything this app knows about handing its MCP endpoint to an agent: where
 * the endpoint is, what a given client needs pasted into it, and whether the
 * endpoint is in a state where a one-click connector link could possibly work.
 *
 * It lives in `shared/` rather than under `modules/onboarding/` on purpose.
 * The welcome page and the External agent access page both need this, and
 * some of it (the bearer-token variants) is settings-only, secret-bearing
 * output that has no business being filed under the first-run experience —
 * a folder name is a claim about who owns the code, and the next person
 * auditing credential handling will not go looking in onboarding.
 *
 *   PUBLIC_BACKEND_URL ─► config.publicBackendUrl ─┬─► OAuth resourceServerUrl
 *        (env)              core-config.ts:326     │      (the authority)
 *                                                  └─► GET /api/config { mcpUrl }
 *                                                              │
 *                          configureMcpUrl() ◄─────────────────┘
 *                                  │            loadServerConfig()
 *                                  ▼
 *                          mcpEndpointUrl()
 *                             │        │
 *              canDeepLink() ─┘        └─► claudeCodeCommand / jsonConfigSnippet / …
 *                    │
 *                    ▼
 *          claudeInstallUrl(url, connectorName(url))
 */

/** Where `/api/mcp` hangs off a given origin. The one place that path is spelled. */
const MCP_PATH = '/api/mcp';

/**
 * The deployment's own answer, from `GET /api/config`. Module-global because
 * it is a property of the deployment rather than of any component, and it is
 * settled once during boot — the same shape as the branch model next door.
 *
 * A FUNCTION rather than an exported constant: a module-scope constant would
 * capture whatever was true at import time, and this module is imported by
 * components that load before the boot fetch resolves (see the same warning
 * on `library.api.ts`).
 */
let configured: string | null = null;

/**
 * Record what the server said. Tolerates absence and nonsense on purpose: an
 * older server that predates the field, or a payload we cannot parse, must
 * leave the app booting normally rather than take the whole page down for a
 * connect snippet. Both cases fall back to the origin, which is what every
 * surface used before this existed.
 */
export function configureMcpUrl(url: unknown): void {
  // Absent is the expected older-server case, not a problem — say nothing.
  if (url === undefined || url === null || url === '') {
    configured = null;
    return;
  }
  configured = parseEndpoint(url);
  if (configured === null) {
    // A value WAS sent and we refused it. Without this the app silently shows
    // the origin instead, and an operator who typo'd PUBLIC_BACKEND_URL has no
    // signal anywhere — the snippets just quietly name the wrong server.
    console.warn('[mcp] ignoring an unusable mcpUrl from /api/config:', url);
  }
}

/**
 * `null` unless this is a string holding an absolute http(s) URL.
 *
 * The scheme check is deliberate rather than incidental. `new URL()` happily
 * parses `javascript:alert(1)` — nothing renders this value as an `href`
 * today, and `canDeepLink` would refuse it anyway, but a value that reaches
 * the UI from over the network should not be ABLE to carry a script scheme
 * waiting for the next consumer to use it less carefully.
 */
function parseEndpoint(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The MCP endpoint to show people. The server's answer when we have one;
 * otherwise the browser's origin, which is right on the common deployment and
 * was the only behaviour before `mcpUrl` existed.
 */
export function mcpEndpointUrl(): string {
  return configured ?? `${window.location.origin}${MCP_PATH}`;
}

/** Drop any configured value. For tests — module-global state must not leak between them. */
export function resetMcpUrlForTests(): void {
  configured = null;
}

/**
 * Could claude.ai possibly reach this endpoint?
 *
 * Read the name literally. This answers "is this certainly dead", not "will
 * this work" — claude.ai fetches the MCP server from Anthropic's
 * infrastructure, and nothing we can compute from inside your network proves
 * anything about that vantage point. An https URL on a hostname that only
 * resolves inside a corporate network passes this check and still fails.
 *
 * It is worth having anyway, because the cases it DOES catch are the default
 * configuration rather than an edge case: `publicBackendUrl` falls back to
 * `http://localhost:3001` when `PUBLIC_BACKEND_URL` is unset, and
 * `.env.example` ships it commented out. Every dev machine and every
 * quickstart Docker deploy lands there. Offering a one-click button that
 * cannot work on the first screen a self-hoster sees is worse than not
 * offering one.
 */
export function canDeepLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Anthropic will not fetch plaintext http, whatever the host.
  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();

  // Bracketed IPv6 literals and bare single-label hostnames (`https://hexis/`)
  // have no public DNS to resolve. A dot is a weak signal but a necessary one.
  if (!host.includes('.')) return false;

  // Names that are private by definition.
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;

  return !isPrivateIpv4(host);
}

/**
 * RFC 1918 space plus loopback, link-local and the unspecified address. Only
 * meaningful when the host IS a dotted-quad — a domain name falls straight
 * through, which is correct: we cannot resolve it and are not trying to.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 127) return true; // unspecified, loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/**
 * What this deployment is called in someone's Claude connector list.
 *
 * The host is in it because there is no deployment-identity concept in this
 * product, and something has to disambiguate: the public demo and a
 * self-hosted instance are the same product at different addresses, and two
 * identically-named connectors pointing at different servers is a list nobody
 * can clean up. The product name is in it because a bare domain sitting
 * between "Gmail" and "Google Drive" says where it is but not what it is.
 *
 * `host`, not `hostname`, so a non-default port survives — two instances on
 * one machine are still telling apart.
 */
export function connectorName(mcpUrl: string): string {
  try {
    return `Hexis — ${new URL(mcpUrl).host}`;
  } catch {
    return 'Hexis';
  }
}

/** Anthropic's documented install-link target for a connector not in the directory. */
const CLAUDE_ADD_CONNECTOR = 'https://claude.ai/customize/connectors';

/**
 * A link that opens claude.ai's "Add custom connector" dialog with the name
 * and URL already filled in. It only prefills — the person still reviews and
 * confirms, and Claude tells them the values came from an external link.
 *
 * Encoded with `encodeURIComponent` rather than `URLSearchParams`, which is
 * the one place being explicit earns its keep: `URLSearchParams` serializes a
 * space as `+`, and `+` means "space" only to a decoder that applies form
 * rules. `%20` is unambiguous under both, and the connector name always
 * contains spaces.
 */
export function claudeInstallUrl(mcpUrl: string, name: string): string {
  const params = [
    'modal=add-custom-connector',
    `connectorName=${encodeURIComponent(name)}`,
    `connectorUrl=${encodeURIComponent(mcpUrl)}`,
  ].join('&');
  return `${CLAUDE_ADD_CONNECTOR}?${params}`;
}

/* ------------------------------------------------------------------ *
 * The snippets themselves. One builder per client, each taking the URL
 * so no caller ever re-derives it, and an optional bearer token for the
 * autonomous-agent variants that carry an external API key.
 * ------------------------------------------------------------------ */

/** The `claude mcp add` one-liner, with the key appended when there is one. */
export function claudeCodeCommand(mcpUrl: string, bearer?: string): string {
  const base = `claude mcp add --transport http knowledge-base ${mcpUrl}`;
  return bearer ? `${base} --header "Authorization: Bearer ${bearer}"` : base;
}

/** The JSON block for clients that read their servers from a config file. */
export function jsonConfigSnippet(mcpUrl: string, bearer?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'knowledge-base': {
          type: 'http',
          url: mcpUrl,
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        },
      },
    },
    null,
    2,
  );
}

/** Langdock wants the URL and the header spelled out as separate fields. */
export function langdockSnippet(mcpUrl: string, bearer: string): string {
  return `URL: ${mcpUrl}\nHeader name: Authorization\nHeader value: Bearer ${bearer}`;
}
