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
  config: Record<string, unknown>;
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
    const config = isRecord(raw.config) ? raw.config : configFromFlat(raw);
    const problem = config ? unusableConfigReason(config) : 'no usable config';
    if (!config || problem) {
      warnings.push(`registry.json: server "${raw.id}" ${problem} — skipped`);
      continue;
    }
    servers.set(raw.id, { id: raw.id, name: typeof raw.name === 'string' ? raw.name : undefined, config });
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
 * The `mcpServers` map a profile resolves to, in `mcp.json` terms: a stdio
 * server keeps `command`/`args`/`env`/`cwd`; an http server becomes
 * `type: streamable-http` + `url` (+ literal `headers`). Keyed by server id —
 * the namespace vault secrets bind to, so the same registry server in three
 * plugins shares one credential, which is what a registry means.
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
    mcpServers[id] = toMcpEntry(server.config);
  }
  return { mcpServers, warnings };
}

/** A registry config → one `mcp.json` server entry. */
function toMcpEntry(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = typeof config.type === 'string' ? config.type.toLowerCase() : undefined;
  if (typeof config.url === 'string' && (type === 'http' || type === 'streamable-http' || type === 'sse' || type === undefined)) {
    out.type = type === 'sse' ? 'sse' : 'streamable-http';
    out.url = config.url;
    if (isRecord(config.headers)) out.headers = config.headers;
    return out;
  }
  out.type = 'stdio';
  if (typeof config.command === 'string') out.command = config.command;
  if (Array.isArray(config.args)) out.args = config.args.map(String);
  if (isRecord(config.env)) out.env = config.env;
  if (typeof config.cwd === 'string') out.cwd = config.cwd;
  return out;
}

/**
 * Why a config cannot become a working `mcp.json` entry, or null when it can:
 * an http-style transport needs a non-empty `url`, anything else needs a
 * non-empty `command`. Compiled as-is, such an entry would fail in every
 * client that installs it.
 */
function unusableConfigReason(config: Record<string, unknown>): string | null {
  const type = typeof config.type === 'string' ? config.type.toLowerCase() : undefined;
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  const command = typeof config.command === 'string' ? config.command.trim() : '';
  if (type === 'http' || type === 'streamable-http' || type === 'sse') {
    return url ? null : `has transport "${type}" but no url`;
  }
  if (type === 'stdio') return command ? null : 'has transport "stdio" but no command';
  if (type !== undefined) return `has an unknown transport "${type}"`;
  return url || command ? null : 'has neither a url nor a command';
}

function configFromFlat(raw: Record<string, unknown>): Record<string, unknown> | null {
  const picked: Record<string, unknown> = {};
  for (const key of ['type', 'url', 'headers', 'command', 'args', 'env', 'cwd']) {
    if (raw[key] !== undefined) picked[key] = raw[key];
  }
  return typeof picked.url === 'string' || typeof picked.command === 'string' ? picked : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
