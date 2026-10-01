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
  /** The registry's own key: what a profile lists, unique across the file. */
  id: string;
  /**
   * What the server is CALLED once it runs — the `mcp.json` key, the
   * `mcp__<name>__*` tool namespace a skill is written against. Several
   * entries may share one (two transports of one server); a profile picks
   * one of them. Absent, the id is the name.
   */
  name: string;
  /**
   * The server as one `mcp.json` entry — judged, and therefore usable, at
   * parse time — plus every field of the config the judgement does not
   * know (`startup_timeout_sec`, say), carried through untouched: a field a
   * client understands must reach it, and one it does not it ignores.
   */
  entry: (PortableStdioEntry | PortableHttpEntry) & Record<string, unknown>;
}

export interface RegistryProfile {
  id: string;
  servers: string[];
  extends?: string;
}

export interface McpRegistry {
  servers: Map<string, RegistryServer>;
  profiles: Map<string, RegistryProfile>;
  /** Servers the registry declared but could not keep, by id, with the reason — so a profile selecting one can say why it is missing. */
  rejected: Map<string, string>;
  warnings: string[];
}

export function parseRegistry(text: string): McpRegistry {
  const warnings: string[] = [];
  const servers = new Map<string, RegistryServer>();
  const profiles = new Map<string, RegistryProfile>();
  const rejected = new Map<string, string>();
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { servers, profiles, rejected, warnings: ['registry.json is not valid JSON'] };
  }
  if (!isRecord(root)) return { servers, profiles, rejected, warnings: ['registry.json must be a JSON object'] };

  for (const raw of asArray(root.servers)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      warnings.push('registry.json: a server without an id was skipped');
      continue;
    }
    if (servers.has(raw.id) || rejected.has(raw.id)) {
      warnings.push(`registry.json: server "${raw.id}" is declared twice — the second declaration is ignored`);
      continue;
    }
    // Converting IS the validation: a server the registry keeps is one whose
    // entry a client can run — judged by the ONE rule every mcp.json entry
    // meets (name, transport, required fields), after the customer's shape
    // is translated into that of mcp.json.
    const config = isRecord(raw.config) ? raw.config : raw;
    const converted = mcpEntryOf(raw.id, config);
    if ('reason' in converted) {
      warnings.push(`registry.json: server "${raw.id}" ${converted.reason} — skipped`);
      rejected.set(raw.id, converted.reason);
      continue;
    }
    // The running name is the key a client sees, so it meets the same
    // spelling rule the id just did. One that does not is not a reason to
    // lose the server: it runs under its id, and the registry's author is
    // told which skills will not find it.
    let name = raw.id;
    if (raw.name !== undefined) {
      const declared = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (declared === raw.id) {
        // Named as it is keyed: nothing to say.
      } else if (declared && judgeMcpServerEntry(declared, { ...config, ...converted.entry }).ok) {
        name = declared;
      } else {
        // Every name that is present and unusable is said, blank or not a
        // string included: a skill written against it will not find the server.
        warnings.push(
          declared
            ? `registry.json: server "${raw.id}" is named "${declared}", which cannot be a server name (lowercase alphanumeric with \`_\`/\`-\`) — it runs as "${raw.id}"`
            : `registry.json: server "${raw.id}" has a name that is blank or not a string — it runs as "${raw.id}"`,
        );
      }
    }
    servers.set(raw.id, { id: raw.id, name, entry: converted.entry });
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
  return { servers, profiles, rejected, warnings };
}

/**
 * The `mcpServers` map a profile resolves to, in `mcp.json` terms. Keyed by
 * the server's NAME, not its registry id: the name is what a client
 * registers the server as and what a skill's `mcp__<name>__*` calls are
 * written against, and it is the namespace vault secrets bind to — so the
 * two transports of one server (`figma-stdio` and `figma-remote`, both
 * named `figma`) present as one server whichever a profile picks, and share
 * one credential. A profile may select only one of them: two servers of one
 * name in one expansion is a conflict, reported, and the nearer profile's
 * wins. A selected server the registry could not keep is reported with the
 * reason it was rejected, so the plugin's page can say what is missing.
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
  const holder = new Map<string, string>();
  for (const id of ids) {
    const server = registry.servers.get(id);
    if (!server) {
      const reason = registry.rejected.get(id);
      warnings.push(
        reason
          ? `registry.json: profile "${profileId}" selects server "${id}", which was left out — ${reason}`
          : `registry.json: profile "${profileId}" selects unknown server "${id}"`,
      );
      continue;
    }
    const first = holder.get(server.name);
    if (first !== undefined) {
      warnings.push(
        `registry.json: profile "${profileId}" selects both "${first}" and "${id}", which are both named "${server.name}" — "${id}" left out`,
      );
      continue;
    }
    holder.set(server.name, id);
    mcpServers[server.name] = server.entry;
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
  name: string,
  config: Record<string, unknown>,
): { entry: RegistryServer['entry'] } | { reason: string } {
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
  const verdict = judgeMcpServerEntry(name, candidate);
  if (!verdict.ok) return { reason: verdict.reason };
  // Every field the judgement did not read rides along as written: a
  // `startup_timeout_sec` is meaningful to the client that knows it and
  // harmless to one that does not, and dropping it silently was the
  // customer's first complaint. The registry's own keys (`id`, `name`, a
  // flat entry's) are the record's, not the server's.
  const entry: Record<string, unknown> = { ...verdict.entry };
  for (const [key, value] of Object.entries(config)) {
    // Defined, not assigned: a field spelled `__proto__` is a field to
    // carry, and assignment would set the object's prototype instead.
    if (!JUDGED_OR_RECORD_KEYS.has(key)) {
      Object.defineProperty(entry, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return { entry: entry as RegistryServer['entry'] };
}

/** The config keys the judgement reads, plus the record's own; everything else passes through. */
const JUDGED_OR_RECORD_KEYS = new Set(['type', 'url', 'command', 'args', 'env', 'cwd', 'headers', 'id', 'name', 'config']);

function nonBlank(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
