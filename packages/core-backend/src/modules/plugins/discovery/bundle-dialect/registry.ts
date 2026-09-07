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
import {
  judgeMcpServerEntry,
  type PortableHttpEntry,
  type PortableStdioEntry,
} from '../../../tool-manuals/mcp-json-discovery.js';

export interface RegistryServer {
  id: string;
  name?: string;
  /** The server as one `mcp.json` entry — judged, and therefore usable, at parse time. */
  entry: PortableStdioEntry | PortableHttpEntry;
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
    // entry a client can run — judged by the ONE rule every mcp.json entry
    // meets (name, transport, required fields), after the customer's shape
    // is translated into that of mcp.json.
    const converted = mcpEntryOf(raw.id, isRecord(raw.config) ? raw.config : raw);
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
 * The registry's OWN knowledge is the customer's shape: a declared `type`
 * names the transport (`http` is their spelling of `streamable-http`), an
 * undeclared one is read off the fields — a `url` means http, else a
 * `command` means stdio — and blank strings are absent. That translation
 * done, whether the entry can work is the shared judgement's call, the same
 * one every `mcp.json` entry meets: a name that can be a server name, a
 * transport the client speaks (no `sse`), the field that transport needs.
 */
function mcpEntryOf(
  id: string,
  config: Record<string, unknown>,
): { entry: PortableStdioEntry | PortableHttpEntry } | { reason: string } {
  const declared = typeof config.type === 'string' ? config.type.trim().toLowerCase() : undefined;
  const url = nonBlank(config.url);
  const command = nonBlank(config.command);
  const type =
    declared === undefined ? (url ? 'streamable-http' : command ? 'stdio' : undefined) : declared === 'http' ? 'streamable-http' : declared;
  if (type === undefined) return { reason: 'has neither a url nor a command' };
  const candidate: Record<string, unknown> = { type };
  if (url) candidate.url = url;
  if (command) candidate.command = command;
  for (const key of ['args', 'env', 'cwd', 'headers'] as const) {
    if (config[key] !== undefined) candidate[key] = config[key];
  }
  const verdict = judgeMcpServerEntry(id, candidate);
  return verdict.ok ? { entry: verdict.entry } : { reason: verdict.reason };
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
