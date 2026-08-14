import type { HexisMcpConfig } from './config.js';

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
  init: RequestInit & { label: string },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new DeploymentError(
      `Could not reach ${init.label} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new DeploymentError(
      `The connection key was rejected by ${init.label} (HTTP ${res.status}). ` +
        'Mint a fresh one from the profile menu → External agent access.',
    );
  }
  if (!res.ok) {
    throw new DeploymentError(`${init.label} returned HTTP ${res.status} from ${url}.`);
  }
  return res.json();
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
  })) as { manuals?: unknown };
  return Array.isArray(body?.manuals) ? (body.manuals as RawManual[]) : [];
}

/**
 * The names of the manuals that only work locally — the ones this server exists
 * to add. Asking the deployment (rather than inferring from the two list
 * variants) keeps the definition of "local-only" in the one place that owns it.
 */
export async function fetchLocalOnlyManuals(config: HexisMcpConfig): Promise<Map<string, string>> {
  const body = (await getJson(`${config.baseUrl}/api/agent/tools/list_local_tools`, {
    label: 'the local-only tool list',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.connectionKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })) as { tools?: unknown };
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  // name → KB path of its declaration. The path is what locates the PLUGIN a
  // stdio server belongs to (`Plugins/<folder>/mcp.json`), which is what gets
  // materialized locally before the server can spawn.
  const manuals = new Map<string, string>();
  for (const t of tools) {
    const name = (t as { name?: unknown })?.name;
    const path = (t as { path?: unknown })?.path;
    if (typeof name === 'string' && name.length > 0) {
      manuals.set(name, typeof path === 'string' ? path : '');
    }
  }
  return manuals;
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
  });
}
