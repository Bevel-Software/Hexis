/**
 * The customer's MCP registry — `configs/mcp/registry.json` — and how a
 * bundle's `mcpProfile` expands through it into an `mcpServers` map of the
 * shape `mcp.json` carries.
 *
 * The file holds two lists:
 *
 *   servers   each with an `id`, a `name`, and the real config — either a
 *             stdio launch (`command`, `args`, `env`) or `type: http` + `url`;
 *             the config may sit under a `config` key or flat on the entry.
 *   profiles  each with an `id`, the server ids it selects, and an optional
 *             `extends` naming another profile (a chain, never a cycle).
 *
 * Pure: parse once, expand many. Unknown ids and cycles are warnings, never
 * throws — a registry typo must not take every plugin down.
 */

export interface RegistryServer {
  id: string;
  name?: string;
  /** The server as one `mcp.json` entry — converted, and therefore usable, at parse time. */
  entry: Record<string, unknown>;
}

export interface RegistryProfile {
  id: string;
  servers: string[];
  extends?: string;
}

export interface McpRegistry {
  servers: Map<string, RegistryServer>;
  profiles: Map<string, RegistryProfile>;
  warnings: string[];
}

export function parseRegistry(text: string): McpRegistry {
  const warnings: string[] = [];
  const servers = new Map<string, RegistryServer>();
  const profiles = new Map<string, RegistryProfile>();
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { servers, profiles, warnings: ['registry.json is not valid JSON'] };
  }
  if (!isRecord(root)) return { servers, profiles, warnings: ['registry.json must be a JSON object'] };

  for (const raw of asArray(root.servers)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      warnings.push('registry.json: a server without an id was skipped');
      continue;
    }
    if (servers.has(raw.id)) {
      warnings.push(`registry.json: server "${raw.id}" is declared twice — the second declaration is ignored`);
      continue;
    }
    // Converting IS the validation: a server the registry keeps is one whose
    // entry a client can run, and nothing decides the transport twice.
    const converted = mcpEntryOf(isRecord(raw.config) ? raw.config : raw);
    if ('reason' in converted) {
      warnings.push(`registry.json: server "${raw.id}" ${converted.reason} — skipped`);
      continue;
    }
    servers.set(raw.id, { id: raw.id, name: typeof raw.name === 'string' ? raw.name : undefined, entry: converted.entry });
  }
  for (const raw of asArray(root.profiles)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      warnings.push('registry.json: a profile without an id was skipped');
      continue;
    }
    if (profiles.has(raw.id)) {
      warnings.push(`registry.json: profile "${raw.id}" is declared twice — the second declaration is ignored`);
      continue;
    }
    profiles.set(raw.id, {
      id: raw.id,
      servers: asArray(raw.servers).filter((s): s is string => typeof s === 'string'),
      extends: typeof raw.extends === 'string' ? raw.extends : undefined,
    });
  }
  return { servers, profiles, warnings };
}

/**
 * The `mcpServers` map a profile resolves to, in `mcp.json` terms. Keyed by
 * server id — the namespace vault secrets bind to, so the same registry
 * server in three plugins shares one credential, which is what a registry
 * means.
 */
export function expandProfile(
  registry: McpRegistry,
  profileId: string,
): { mcpServers: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = profileId;
  while (current !== undefined) {
    if (seen.has(current)) {
      warnings.push(`registry.json: profile "${current}" extends itself through a cycle — chain cut`);
      break;
    }
    seen.add(current);
    const profile = registry.profiles.get(current);
    if (!profile) {
      warnings.push(`registry.json: profile "${current}" does not exist`);
      break;
    }
    // Nearest profile first, so a base profile's servers come after the
    // extending one's; the map below keeps the first occurrence of an id.
    for (const id of profile.servers) if (!ids.includes(id)) ids.push(id);
    current = profile.extends;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const id of ids) {
    const server = registry.servers.get(id);
    if (!server) {
      warnings.push(`registry.json: profile "${profileId}" selects unknown server "${id}"`);
      continue;
    }
    mcpServers[id] = server.entry;
  }
  return { mcpServers, warnings };
}

/**
 * A registry config → one `mcp.json` server entry, or why there is none.
 *
 * The transport is decided ONCE, here: a declared `type` names it, and an
 * undeclared one is read off the fields — a `url` means http, else a
 * `command` means stdio. Blank strings are absent, whatever the transport.
 * An http-style server (`http`, `streamable-http`, `sse`) keeps `url` (+
 * literal `headers`); a stdio server keeps `command`/`args`/`env`/`cwd`.
 */
function mcpEntryOf(config: Record<string, unknown>): { entry: Record<string, unknown> } | { reason: string } {
  const declared = typeof config.type === 'string' ? config.type.trim().toLowerCase() : undefined;
  const url = nonBlank(config.url);
  const command = nonBlank(config.command);

  let transport: 'streamable-http' | 'sse' | 'stdio';
  if (declared === undefined) {
    if (url) transport = 'streamable-http';
    else if (command) transport = 'stdio';
    else return { reason: 'has neither a url nor a command' };
  } else if (declared === 'http' || declared === 'streamable-http') {
    transport = 'streamable-http';
  } else if (declared === 'sse' || declared === 'stdio') {
    transport = declared;
  } else {
    return { reason: `has an unknown transport "${declared}"` };
  }

  if (transport === 'stdio') {
    if (!command) return { reason: 'has transport "stdio" but no command' };
    const entry: Record<string, unknown> = { type: 'stdio', command };
    if (Array.isArray(config.args)) entry.args = config.args.map(String);
    if (isRecord(config.env)) entry.env = config.env;
    if (typeof config.cwd === 'string') entry.cwd = config.cwd;
    return { entry };
  }
  if (!url) return { reason: `has transport "${declared}" but no url` };
  const entry: Record<string, unknown> = { type: transport, url };
  if (isRecord(config.headers)) entry.headers = config.headers;
  return { entry };
}

function nonBlank(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
