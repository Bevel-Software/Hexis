import {
  HEXIS_EXTENSION_NS,
  PLUGIN_MCP_FILE,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
} from '@bevel-software/platform-shared';
import type { ToolManualDescriptor, ToolVariable } from './tool-manuals.contract.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import { RESERVED_VARIABLE_NAMES, findReservedVariableRef } from '../../shared/variable-refs.js';

/**
 * The same reserved-reference policy `.tool` parsing enforces, applied to the
 * extension block: `API_URL`/`CONNECTION_KEY` (bare or namespaced) are seeded
 * by the platform for its own manuals, and an extension header referencing one
 * would be asking the substitutor to hand a third-party server the caller's
 * bearer. One rule, both declaration surfaces — and one GRAMMAR deciding what
 * a reference is (shared/variable-refs.ts), so nothing the migration or the
 * editor classifies as a portable literal can be reserved here.
 */
const referencesReservedVariable = findReservedVariableRef;

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
 * Validate an extension entry's `variables` declarations, or `null` when any
 * entry is malformed. The `.tool` parser THROWS on a bad entry so the whole
 * file is skipped — a variable silently dropped or mis-read is not cosmetic:
 * an undeclared reference defaults to the shared `admin` scope, so losing a
 * `scope: user` declaration would hand one caller's slot to everyone. The
 * same stake applies here, at this file's per-server grain: a bad entry
 * invalidates the SERVER, never its siblings.
 */
function validatedVariables(raw: unknown): ToolVariable[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: ToolVariable[] = [];
  const declared = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(entry.name)) return null;
    // The `.tool` parser's declaration rules, at this file's grain: a
    // platform-seeded name may not be re-declared (it would shadow the
    // seeding), and a duplicate would make later scope resolution depend on
    // declaration order.
    if (RESERVED_VARIABLE_NAMES.includes(entry.name) || declared.has(entry.name)) return null;
    declared.add(entry.name);
    const scope = entry.scope ?? 'admin';
    if (scope !== 'admin' && scope !== 'user') return null;
    let oauth: ToolVariable['oauth'];
    if (entry.oauth !== undefined) {
      // OAuth is inherently per-caller (same rule the `.tool` parser
      // enforces): an admin-shared OAuth token would leak one user's token
      // to all callers. The provider config's required halves must be there
      // — a sign-in wired to a missing URL is a declaration, not a feature.
      if (!isRecord(entry.oauth) || scope !== 'user') return null;
      const o = entry.oauth;
      if (
        typeof o.authorizationUrl !== 'string' ||
        typeof o.tokenUrl !== 'string' ||
        typeof o.clientId !== 'string'
      ) {
        return null;
      }
      // The same https + SSRF gate the `.tool` parser runs on these URLs: a
      // sign-in or token exchange aimed at an internal host is a declaration
      // this surface must refuse exactly like the other one does.
      try {
        assertSafeFetchUrl(o.authorizationUrl, { requireHttps: true, label: `${entry.name} oauth.authorizationUrl` });
        assertSafeFetchUrl(o.tokenUrl, { requireHttps: true, label: `${entry.name} oauth.tokenUrl` });
      } catch {
        return null;
      }
      // Forwarded verbatim as query params later — a non-string value here is
      // a malformed declaration, not something to coerce.
      if (o.authParams !== undefined) {
        if (!isRecord(o.authParams) || !Object.values(o.authParams).every((v) => typeof v === 'string')) {
          return null;
        }
      }
      oauth = {
        authorizationUrl: o.authorizationUrl,
        tokenUrl: o.tokenUrl,
        clientId: o.clientId,
        ...(Array.isArray(o.scopes) && o.scopes.every((s) => typeof s === 'string')
          ? { scopes: o.scopes as string[] }
          : {}),
        ...(o.authParams !== undefined ? { authParams: o.authParams as Record<string, string> } : {}),
      };
    }
    out.push({
      name: entry.name,
      scope,
      ...(typeof entry.label === 'string' && entry.label.trim() ? { label: entry.label.trim() } : {}),
      ...(oauth ? { oauth } : {}),
    });
  }
  return out;
}

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
    // The extension entry is knowledge-base content too — same zero-trust
    // parse as the rest: a non-object entry reads as "no extension data".
    const ext: HexisMcpServerExtension = isRecord(extensions[name])
      ? (extensions[name] as HexisMcpServerExtension)
      : {};
    // The EFFECTIVE declaration, not just the extension block: a reserved
    // reference in mcp.json's own url or literal headers would be expanded
    // into outbound requests exactly the same way.
    const reserved = referencesReservedVariable({ raw, ext });
    if (reserved !== null) {
      console.warn(
        `[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: its declaration (mcp.json ` +
          `entry or plugin.json extension) references the reserved variable "${reserved}" — API_URL and ` +
          'CONNECTION_KEY are platform-seeded and may not appear in server declarations.',
      );
      continue;
    }
    const variables = validatedVariables(ext.variables);
    if (variables === null) {
      console.warn(
        `[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: its plugin.json \`variables\` ` +
          'declaration is malformed — a dropped declaration would silently re-scope a credential, so ' +
          'the server stays offline until the manifest is fixed.',
      );
      continue;
    }
    const shared = {
      slug: name,
      name,
      path: mcpJsonPath,
      type: 'mcp' as const,
      ...(typeof ext.description === 'string' ? { description: ext.description } : {}),
      ...(variables.length > 0 ? { variables } : {}),
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
      // Scheme first, for EVERYONE: `local: true` exempts a server from the
      // private-network reachability policy, not from being http(s) at all.
      let schemeOk = false;
      try {
        const u = new URL(raw.url);
        schemeOk = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        schemeOk = false;
      }
      if (!schemeOk) {
        console.warn(`[tool-manuals] skipping mcp server "${name}" in ${mcpJsonPath}: url must be http(s).`);
        continue;
      }
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
      // Both sides pass the isRecord gate — spreading a malformed non-object
      // value (a string, say) would scatter its indices into header keys.
      const headers = {
        ...(isRecord(raw.headers) ? (raw.headers as Record<string, string>) : {}),
        ...(isRecord(ext.headers) ? (ext.headers as Record<string, string>) : {}),
      };
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
