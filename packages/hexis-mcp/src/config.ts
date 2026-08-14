/**
 * What the local server needs to reach a deployment, and where it comes from.
 *
 * Two values only — the workspace's base URL and a connection key — because
 * everything else about a deployment is something the deployment itself can
 * answer (see `resolveDeployment`). An MCP client config is an awkward place to
 * keep settings in sync, so we ask for the minimum and derive the rest.
 */

export interface HexisMcpConfig {
  /** Base URL of the deployment, e.g. `https://demo.bevel.software`. No trailing slash. */
  baseUrl: string;
  /** A connection key minted from the profile menu's External agent access screen. */
  connectionKey: string;
}

export class ConfigError extends Error {}

/** `--url=x`, `--url x` and `-u x` all mean the same thing. */
function readFlag(argv: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === `--${long}` || (short && arg === `-${short}`)) return argv[i + 1];
    if (arg.startsWith(`--${long}=`)) return arg.slice(long.length + 3);
  }
  return undefined;
}

/**
 * Trailing slashes are stripped so `new URL(path, baseUrl)` and plain
 * concatenation agree; a base with a path (`https://host/hexis`) keeps it.
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
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = {}): HexisMcpConfig {
  const rawUrl = readFlag(argv, 'url', 'u') ?? env.HEXIS_URL ?? env.BEVEL_URL;
  const key = readFlag(argv, 'key', 'k') ?? env.HEXIS_CONNECTION_KEY ?? env.BEVEL_CONNECTION_KEY;

  if (!rawUrl) {
    throw new ConfigError(
      'Missing the workspace URL. Pass --url https://your-workspace.example or set HEXIS_URL.',
    );
  }
  if (!key) {
    throw new ConfigError(
      'Missing the connection key. Pass --key bevel_… or set HEXIS_CONNECTION_KEY. ' +
        'Mint one from the profile menu → External agent access.',
    );
  }
  return { baseUrl: normalizeBaseUrl(rawUrl), connectionKey: key.trim() };
}

export const USAGE = `hexis-mcp — run a Hexis workspace as a local MCP server.

  npx @bevel-software/hexis-mcp --url <workspace-url> --key <connection-key>

Options
  -u, --url    Workspace base URL (or HEXIS_URL)
  -k, --key    Connection key from External agent access (or HEXIS_CONNECTION_KEY)
  -h, --help   Show this message

Every tool the hosted endpoint serves is available, plus the local-only tools it
cannot reach. Credentials for local-only tools come from this process's
environment — set them in the same MCP client config that launches this command.
`;
