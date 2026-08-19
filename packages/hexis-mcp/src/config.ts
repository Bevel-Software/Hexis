/**
 * What the local server needs to reach a deployment, and where it comes from.
 *
 * Two values only — the workspace's base URL and a bearer credential — because
 * everything else about a deployment is something the deployment itself can
 * answer (see `resolveDeployment`). An MCP client config is an awkward place to
 * keep settings in sync, so we ask for the minimum and derive the rest.
 *
 * The credential arrives one of two ways. A connection key is autonomous mode:
 * right for CI and pipelines, exactly today's behavior. Without one, the CLI
 * signs the person in through their browser (see `oauth.ts`) and the internal
 * token that sign-in mints lands in `connectionKey` — same field, same
 * meaning: the ONE bearer this process attaches to the deployment. Nothing
 * downstream needs to know which mode produced it.
 */

export interface HexisMcpConfig {
  /** Base URL of the deployment, e.g. `https://demo.bevel.software`. No trailing slash. */
  baseUrl: string;
  /**
   * The bearer this process authenticates with: a connection key minted from
   * the profile menu's External agent access screen, or — in browser sign-in
   * mode — the internal token the sign-in was exchanged for.
   */
  connectionKey: string;
  /**
   * OAuth mode only: mint a fresh bearer after the current one is rejected
   * (refresh → re-exchange). `deployment.ts` consults this on a mid-run 401,
   * exactly once per request; a connection key has no renewal, so key mode
   * leaves it unset.
   */
  renewConnectionKey?: () => Promise<string>;
}

/**
 * What the CLI resolved from argv + env, before a credential necessarily
 * exists. `connectionKey` present = key mode; absent = browser sign-in, which
 * `oauth.ts` turns into a full `HexisMcpConfig` before the server starts.
 */
export interface ResolvedCliConfig {
  baseUrl: string;
  connectionKey?: string;
  /** Print the sign-in URL instead of opening a browser (OAuth mode only). */
  noOpen: boolean;
}

export class ConfigError extends Error {}

/** `--url=x`, `--url x` and `-u x` all mean the same thing. */
function readFlag(argv: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === `--${long}` || (short && arg === `-${short}`)) {
      const next = argv[i + 1];
      // `--url --key k` is a forgotten value, not a value spelled `--key` —
      // silently consuming the next flag would misconfigure BOTH options.
      if (next === undefined || next.startsWith('-')) {
        throw new ConfigError(`${arg} expects a value, e.g. ${arg} <${long}>.`);
      }
      return next;
    }
    if (arg.startsWith(`--${long}=`)) return arg.slice(long.length + 3);
  }
  return undefined;
}

/**
 * Trailing slashes are stripped so `new URL(path, baseUrl)` and plain
 * concatenation agree; a base with a path (`https://host/hexis`) keeps it.
 * A query, fragment or embedded credentials are refused rather than stripped:
 * everything downstream appends `/api/…` by plain concatenation, so a
 * surviving `?x` or `#x` would silently change every request — and the
 * connection key is the credential, so a `user:pass@` here is a mistake worth
 * naming, not forwarding.
 */
function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`"${raw}" is not a valid URL. Pass the workspace address, e.g. https://demo.bevel.software`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`"${raw}" must be an http(s) URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError(`"${raw}" must not embed credentials — the connection key is how this server authenticates.`);
  }
  // The raw string, not `parsed.search`/`parsed.hash`: a bare trailing `?` or
  // `#` parses to an EMPTY query/fragment yet survives serialization, and a
  // surviving delimiter corrupts concatenation exactly like a populated one.
  if (/[?#]/.test(raw)) {
    throw new ConfigError(`"${raw}" must not have a query or fragment. Pass the workspace's base address only.`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Resolve config from argv and the environment, flags winning.
 *
 * The env path exists because that is how MCP clients pass configuration —
 * Claude Code's `env` block, and the same mechanism that supplies `${VAR}`
 * values to local-only tools. Nothing is read from a file on disk: a second
 * place to configure this is a second place for it to be wrong.
 */
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = {}): ResolvedCliConfig {
  // Trimmed BEFORE the presence checks: copy buttons and shell quoting add
  // whitespace, and a whitespace-only value is a missing one, not a config.
  const rawUrl = (readFlag(argv, 'url', 'u') ?? env.HEXIS_URL ?? env.BEVEL_URL)?.trim();
  const key = (readFlag(argv, 'key', 'k') ?? env.HEXIS_CONNECTION_KEY ?? env.BEVEL_CONNECTION_KEY)?.trim();

  if (!rawUrl) {
    throw new ConfigError(
      'Missing the workspace URL. Pass --url https://your-workspace.example or set HEXIS_URL.',
    );
  }
  // A missing key is NOT an error: it selects browser sign-in (OAuth mode).
  // The key remains the autonomous path — CI, pipelines, anywhere nobody is
  // present to sign in.
  const noBrowserEnv = env.HEXIS_NO_BROWSER?.trim().toLowerCase();
  const noOpen =
    argv.includes('--no-open') || (!!noBrowserEnv && noBrowserEnv !== '0' && noBrowserEnv !== 'false');
  const resolved: ResolvedCliConfig = { baseUrl: normalizeBaseUrl(rawUrl), noOpen };
  if (key) resolved.connectionKey = key;
  return resolved;
}

export const USAGE = `hexis-mcp — run a Hexis workspace as a local MCP server.

  npx @bevel-software/hexis-mcp --url <workspace-url> [--key <connection-key>]

Options
  -u, --url      Workspace base URL (or HEXIS_URL)
  -k, --key      Connection key from External agent access (or HEXIS_CONNECTION_KEY).
                 With a key the server runs autonomously — the right mode for CI
                 and pipelines. Without one, it signs you in through your browser
                 (needs a deployment at least as new as this package; an older
                 one says so, and a connection key still works there).
      --no-open  Print the sign-in URL instead of opening a browser
                 (or HEXIS_NO_BROWSER=1) — for a machine with no display
  -h, --help     Show this message
  -v, --version  Print the version

Every tool the hosted endpoint serves is available, plus the local-only tools it
cannot reach. Credentials for local-only tools come from this process's
environment — set them in the same MCP client config that launches this command.
`;
