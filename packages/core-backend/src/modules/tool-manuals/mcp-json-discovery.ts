import {
  HEXIS_EXTENSION_NS,
  PLUGIN_MCP_FILE,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
} from '@bevel-software/platform-shared';
import type { ToolManualDescriptor, ToolVariable } from './tool-manuals.contract.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';

/**
 * The same reserved-reference policy `.tool` parsing enforces, applied to the
 * extension block: `API_URL`/`CONNECTION_KEY` (bare or namespaced) are seeded
 * by the platform for its own manuals, and an extension header referencing one
 * would be asking the substitutor to hand a third-party server the caller's
 * bearer. One rule, both declaration surfaces.
 */
const RESERVED_VARIABLE_RE = /\$\{\s*([A-Za-z0-9_]+)\s*\}|\$([A-Za-z0-9_]+)/g;
function referencesReservedVariable(doc: unknown): string | null {
  const text = JSON.stringify(doc) ?? '';
  for (const match of text.matchAll(RESERVED_VARIABLE_RE)) {
    const varName = match[1] ?? match[2] ?? '';
    if (varName.endsWith('API_URL') || varName.endsWith('CONNECTION_KEY')) return match[0];
  }
  return null;
}

/**
 * MCP servers are declared in each plugin's `mcp.json` (the Agent Plugins
 * fixed location), not in `.tool` files — `mcp.json` is AUTHORITATIVE. This
 * module turns one plugin's `mcp.json` (+ its `plugin.json` extensions block)
 * into the same `ToolManualDescriptor`s the `.tool` scanner produces, so
 * everything downstream — call templates, the vault's variable scoping, OAuth
 * auto-discovery, `list_tool_setup` — is unchanged.
 *
 * The split between the two files is the specification's:
 *
 *  - `mcp.json` holds what is PORTABLE: the server's name, transport, url,
 *    and literal headers. No credentials, no `${VAR}` references — a
 *    conformant client must transmit header values verbatim and expand
 *    nothing beyond `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`.
 *  - `plugin.json`'s `extensions["software.bevel.hexis"].mcpServers[<name>]`
 *    holds what is OURS: auth headers carrying `${VAR}` vault references,
 *    the `variables` declarations (scope/label/oauth), a `description`, and
 *    `local: true` for servers only reachable from a user's machine. The spec
 *    reserves `extensions` for exactly this, and other clients ignore it.
 *
 * The `mcpServers` KEY is the manual name — the namespace vault secrets bind
 * to (`<name>_<VAR>`). The migration writes it from the old `.tool`'s id so
 * configured secrets and completed OAuth grants stay bound; renaming a server
 * key is renaming its secret namespace, and the editor should say so.
 */

/** The extension block for one server, as we define it. */
export interface HexisMcpServerExtension {
  /** Auth headers, values may carry `${VAR}` vault references. Merged OVER mcp.json's. */
  headers?: Record<string, string>;
  variables?: ToolVariable[];
  description?: string;
  /** Only reachable from a user's machine (e.g. localhost) — remote proxy skips it. */
  local?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `mcpServers` extension map from a parsed plugin.json, or `{}`. */
function extensionServers(pluginJson: unknown): Record<string, HexisMcpServerExtension> {
  if (!isRecord(pluginJson)) return {};
  const ext = pluginJson.extensions;
  if (!isRecord(ext)) return {};
  const ns = ext[HEXIS_EXTENSION_NS];
  if (!isRecord(ns) || !isRecord(ns.mcpServers)) return {};
  return ns.mcpServers as Record<string, HexisMcpServerExtension>;
}

/** A manual name must be usable as a UTCP namespace + route slug. Same shape `.tool` ids use. */
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Descriptors for one plugin's `mcp.json`. Malformed entries are skipped with
 * a logged reason — one bad server must not take the plugin's others offline —
 * and a missing/unparsable file yields `[]` (the caller decides whether that
 * is worth a log line; an absent mcp.json is the common case, not an error).
 *
 * `stdio` entries are inherently LOCAL (`remote: false`): the hosted proxy can
 * never spawn a subprocess out of knowledge-base content, so they are served
 * only to local consumers (hexis-mcp), whose UTCP mcp plugin spawns them.
 * `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` placeholders are NOT expanded yet — local
 * materialization is a later phase — so a stdio server relying on them will
 * fail to spawn until then; bare-command servers (`npx …`) work today.
 */
export function descriptorsFromMcpJson(
  pluginFolder: string,
  mcpJsonText: string,
  pluginJsonText: string | null,
): ToolManualDescriptor[] {
  let mcp: unknown;
  try {
    mcp = JSON.parse(mcpJsonText);
  } catch {
    console.warn(`[tool-manuals] ${PLUGINS_DIR}/${pluginFolder}/${PLUGIN_MCP_FILE} is not valid JSON — skipped.`);
    return [];
  }
  if (!isRecord(mcp) || !isRecord(mcp.mcpServers)) return [];

  let manifest: unknown = null;
  if (pluginJsonText !== null) {
    try {
      manifest = JSON.parse(pluginJsonText);
    } catch {
      // A broken manifest costs the extension data (auth wiring), not the
      // servers themselves — they are still listed, as the spec's own
      // "invalid components are skipped, valid ones load" posture suggests.
      console.warn(
        `[tool-manuals] ${PLUGINS_DIR}/${pluginFolder}/${PLUGIN_MANIFEST_FILE} is not valid JSON — ` +
          'its mcp-server auth/variable declarations are ignored.',
      );
    }
  }
  const extensions = extensionServers(manifest);
  const mcpJsonPath = `${PLUGINS_DIR}/${pluginFolder}/${PLUGIN_MCP_FILE}`;

  const out: ToolManualDescriptor[] = [];
  for (const [name, raw] of Object.entries(mcp.mcpServers)) {
    if (!SERVER_NAME_RE.test(name)) {
      console.warn(
        `[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: the name is the secret ` +
          'namespace and route slug, so it must be lowercase alphanumeric with `_`/`-`.',
      );
      continue;
    }
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      console.warn(`[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: no transport type.`);
      continue;
    }
    const ext = extensions[name] ?? {};
    // The EFFECTIVE declaration, not just the extension block: a reserved
    // reference in mcp.json's own url or literal headers would be expanded
    // into outbound requests exactly the same way.
    const reserved = referencesReservedVariable({ raw, ext });
    if (reserved !== null) {
      console.warn(
        `[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: its extension entry references ` +
          `the reserved variable "${reserved}" — API_URL and CONNECTION_KEY are platform-seeded and may ` +
          'not appear in server declarations.',
      );
      continue;
    }
    const shared = {
      slug: name,
      name,
      path: mcpJsonPath,
      type: 'mcp' as const,
      ...(typeof ext.description === 'string' ? { description: ext.description } : {}),
      ...(Array.isArray(ext.variables) && ext.variables.length > 0 ? { variables: ext.variables } : {}),
    };

    if (raw.type === 'stdio') {
      if (typeof raw.command !== 'string' || raw.command.length === 0) {
        console.warn(`[tool-manuals] skipping stdio server "${name}" in ${mcpJsonPath}: no command.`);
        continue;
      }
      out.push({
        ...shared,
        remote: false,
        stdio: {
          command: raw.command,
          args: Array.isArray(raw.args) ? raw.args.map(String) : [],
          env: isRecord(raw.env) ? (raw.env as Record<string, string>) : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      });
      continue;
    }

    if (raw.type === 'streamable-http' || raw.type === 'sse') {
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        console.warn(`[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: no url.`);
        continue;
      }
      // Remote-capable servers get the same SSRF gate `.tool` urls pass —
      // otherwise mcp.json becomes the way to point the backend at loopback,
      // private ranges, or the cloud metadata endpoint. A `local: true` entry
      // is exempt because loopback is exactly what local MEANS, and only the
      // user's own machine ever dials it.
      if (ext.local !== true) {
        try {
          assertSafeFetchUrl(raw.url, { label: `mcp server "${name}" url` });
        } catch (err) {
          console.warn(
            `[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: ` +
              `${err instanceof Error ? err.message : String(err)} (declare it \`local: true\` if it is deliberately private).`,
          );
          continue;
        }
      }
      // Extension headers (auth, `${VAR}` refs) win over mcp.json's literal
      // ones on a key collision: the portable file cannot carry a credential,
      // so when both name the same header the extension is the operative one.
      const headers = { ...(isRecord(raw.headers) ? (raw.headers as Record<string, string>) : {}), ...ext.headers };
      out.push({
        ...shared,
        url: raw.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(ext.local === true ? { remote: false } : {}),
      });
      continue;
    }

    // Unknown transport: the spec says an unknown `type` invalidates the
    // ENTRY, not the file — skip it, keep its siblings.
    console.warn(`[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: unknown type "${raw.type}".`);
  }
  return out;
}
