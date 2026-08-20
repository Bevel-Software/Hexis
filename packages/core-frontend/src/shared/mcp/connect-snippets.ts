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
    /**
     * Credentials are STRIPPED, not preserved and not rejected.
     *
     * A `PUBLIC_BACKEND_URL` of `https://user:hunter2@kb.acme.com` is a
     * misconfiguration, but every surface downstream would have published the
     * password: the copy blocks render this string on screen and put it on the
     * clipboard, and the install link hands it to claude.ai. Rejecting outright
     * would take the whole connect page down over a credential nobody needs —
     * MCP authenticates over OAuth, so the userinfo is dead weight even when
     * someone sets it.
     *
     * So: drop the secret, keep the address, and say so.
     */
    if (parsed.username !== '' || parsed.password !== '') {
      console.warn(
        '[mcp] stripped credentials from the configured mcpUrl — PUBLIC_BACKEND_URL should not carry a username or password',
      );
      parsed.username = '';
      parsed.password = '';
    }
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

  // Never hand a third party a URL carrying credentials. `parseEndpoint`
  // already strips them on the way in; this is the second lock, because
  // `canDeepLink` is exported and a future caller may not have gone through it.
  if (parsed.username !== '' || parsed.password !== '') return false;

  const host = parsed.hostname.toLowerCase();

  // Bracketed IPv6 literal, e.g. `https://[2001:db8::1]/`.
  if (host.startsWith('[')) return !isPrivateIpv6(host);

  // Names that are private by definition.
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;

  if (isDottedQuad(host)) return !isPrivateIpv4(host);

  // A single-label DNS name (`https://hexis/`) has no public DNS to resolve.
  return host.includes('.');
}

/** Four dot-separated decimal octets, each 0-255. */
function isDottedQuad(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/**
 * Every IPv4 block that is not routable on the public internet.
 *
 * Broader than RFC 1918 on purpose. The gate's job is "could Anthropic reach
 * this at all", and carrier-grade NAT (100.64/10) and the benchmark range
 * (198.18/15) are just as unreachable as 10/8 while looking like ordinary
 * public addresses. Only meaningful for a dotted-quad host — see `isDottedQuad`.
 */
function isPrivateIpv4(host: string): boolean {
  const [a, b, c] = host.split('.').map(Number) as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8      this network
  if (a === 10) return true; // 10.0.0.0/8     private
  if (a === 127) return true; // 127.0.0.0/8    loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10  carrier-grade NAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12  private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24   IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24   TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15  benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Whether an IPv6 literal is something Anthropic could never reach.
 *
 * Stated as an allowlist, unlike its v4 counterpart, because v6 hands us one:
 * globally routable unicast is `2000::/3` and nothing else is. Naming the
 * unreachable blocks instead — loopback, ULA, link-local — reads fine and
 * leaks, because the unreachable set is most of a 128-bit space and a list of
 * it is never finished. Refusing everything outside `2000::/3` closes
 * multicast, the discard prefix, the `::`-compressed reserved forms and every
 * block IANA has not allocated yet, in one line that cannot fall behind.
 *
 * Takes the host WITH its brackets, the form `URL.hostname` returns.
 */
function isPrivateIpv6(bracketed: string): boolean {
  const addr = bracketed.slice(1, -1).toLowerCase();

  /**
   * IPv4-mapped (`::ffff:10.0.0.1`) — an IPv4 address wearing a v6 hat, and
   * exactly as unreachable as the address it wraps.
   *
   * The readable dotted form never gets here: `new URL()` normalizes
   * `[::ffff:10.0.0.1]` to `[::ffff:a00:1]`, so the v4 address has to be
   * decoded back out of the last two hextets. The dotted branch is kept
   * anyway for a raw string that never went through the parser.
   */
  if (addr.startsWith('::ffff:')) {
    const tail = addr.slice('::ffff:'.length);
    if (tail.includes('.')) return isDottedQuad(tail) ? isPrivateIpv4(tail) : true;
    const [hi, lo] = tail.split(':').map((h) => Number.parseInt(h, 16));
    // Anything else wearing an `::ffff:` prefix is a shape we cannot read —
    // refuse rather than guess it is public.
    if (tail.split(':').length !== 2 || Number.isNaN(hi!) || Number.isNaN(lo!)) return true;
    return isPrivateIpv4([hi! >> 8, hi! & 0xff, lo! >> 8, lo! & 0xff].join('.'));
  }

  const parts = addr.split(':');
  const first = Number.parseInt(parts[0] ?? '', 16);

  /**
   * Outside global unicast — so loopback, the unspecified address, ULA
   * (fc00::/7), link-local (fe80::/10), multicast (ff00::/8) and the
   * discard-only prefix (100::/64) all land here without needing a rule each.
   *
   * A first hextet we cannot read fails this test too, which is the right way
   * round: `::2` splits to an empty leading field and parses as NaN, and an
   * address we cannot parse must not be advertised as reachable. Nothing
   * legitimate is caught by that — `2000::/3` never starts with elided zeros.
   */
  if (!(first >= 0x2000 && first <= 0x3fff)) return true;

  /**
   * Allocated inside `2000::/3`, still not somewhere you can deploy. The v4
   * gate already refuses its documentation and benchmark ranges; these are the
   * same ranges, and leaving them out is what let `2001:db8::1` read as public.
   *
   * `2001:db8::1` splits to ['2001','db8','','1'], but `2001::1` gives
   * ['2001','','1'] — an empty field is elided zeros, so it reads as 0.
   */
  const second = parts[1] === '' ? 0 : Number.parseInt(parts[1] ?? '', 16);
  if (Number.isNaN(second)) return true;
  if (first === 0x2001 && second <= 0x01ff) return true; // 2001::/23 IETF protocol assignments
  if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 documentation (RFC 3849)
  if (first === 0x3fff && second <= 0x0fff) return true; // 3fff::/20 documentation (RFC 9637)
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

/**
 * Escape a value for interpolation inside a double-quoted POSIX shell string.
 * Backslash, `"`, `$` and backtick are the four characters the shell still
 * reads there — a token carrying any of them would otherwise cut the pasted
 * command short or expand into it.
 */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

/** The `claude mcp add` one-liner, with the key appended when there is one. */
export function claudeCodeCommand(mcpUrl: string, bearer?: string): string {
  const base = `claude mcp add --transport http knowledge-base ${mcpUrl}`;
  return bearer ? `${base} --header "Authorization: Bearer ${escapeForDoubleQuotes(bearer)}"` : base;
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

/* ------------------------------------------------------------------ *
 * The LOCAL server (`npx @bevel-software/hexis-mcp`): the same workspace
 * as a stdio server on the member's own machine, which is the only place
 * a plugin's local-only tools — stdio servers, localhost services — can
 * run. It serves everything the hosted endpoint serves plus those. It
 * authenticates either interactively — keyless, opening the person's own
 * browser to sign in on first run — or autonomously with a connection
 * key, for pipelines with nobody present to sign in.
 * ------------------------------------------------------------------ */

/**
 * The base URL to hand the local server — deliberately NOT `mcpEndpointUrl`.
 *
 * `hexis-mcp` takes the WORKSPACE's address, not the MCP endpoint: it asks
 * `GET <base>/api/config` for the real endpoint itself, the same field
 * `configureMcpUrl` records up top. So what it needs is a base the config
 * endpoint answers on — and the one address the browser has PROVEN serves
 * this whole app, config endpoint included, is its own origin, because it
 * loaded this page from it. The configured `mcpUrl` proves less: it may sit
 * on a proxy domain that forwards only the MCP path.
 */
export function workspaceBaseUrl(): string {
  return window.location.origin;
}

/**
 * The JSON block that runs the workspace as a LOCAL MCP server. Read by the
 * same clients as `jsonConfigSnippet` — Claude Desktop, Cursor, Windsurf,
 * Cline, anything that loads servers from a JSON config — but the entry
 * spawns `npx @bevel-software/hexis-mcp` instead of pointing at the hosted
 * endpoint, so the command needs Node on the machine.
 *
 * Without a bearer there is NO key field at all: keyless is the interactive
 * mode, where the server opens the person's browser to sign in on first run
 * (the same OAuth flow the hosted endpoint puts web agents through). The
 * bearer variant exists for the key-reveal modal, whose reader is setting up
 * an autonomous pipeline that cannot open a browser.
 */
export function hexisMcpJsonSnippet(baseUrl: string, bearer?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'hexis-local': {
          command: 'npx',
          args: ['-y', '@bevel-software/hexis-mcp'],
          env: {
            HEXIS_URL: baseUrl,
            ...(bearer ? { HEXIS_CONNECTION_KEY: bearer } : {}),
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The `claude mcp add` one-liner for the local server. A stdio command, not
 * a URL, so the address (and the key, when the autonomous variant carries
 * one) travel as `--env` values — interpolated inside double quotes and
 * escaped, exactly as the header is in `claudeCodeCommand`. Today's values
 * are tame (a tenant-prefixed key, an https URL), but a URL can legally
 * carry `$` or backtick, and quoting only the value that looks dangerous is
 * how the other one bites later. Keyless = interactive sign-in, same as
 * {@link hexisMcpJsonSnippet}.
 */
export function hexisMcpClaudeCommand(baseUrl: string, bearer?: string): string {
  return (
    `claude mcp add hexis-local` +
    ` --env HEXIS_URL="${escapeForDoubleQuotes(baseUrl)}"` +
    (bearer ? ` --env HEXIS_CONNECTION_KEY="${escapeForDoubleQuotes(bearer)}"` : '') +
    ` -- npx -y @bevel-software/hexis-mcp`
  );
}
