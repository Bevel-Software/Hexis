import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchema, Tool as UtcpTool } from '@utcp/sdk';

/** A tool discovered from a UTCP manual, flattened into what an MCP surface advertises. */
export interface ProxiedTool {
  utcpName: string;
  mcpName: string;
  description: string;
  inputSchema: JsonSchema;
  /** The UTCP manual this tool came from (the `<manual>` in `<manual>.<tool>`),
   * used to look up the manual's declared per-user credentials before dispatch. */
  manualName: string;
}

/**
 * MCP tool-name grammar (also the Anthropic API's), and a length bound. A
 * remote MCP server can expose a tool whose flattened name breaks this — too
 * long, or an illegal char the `<manual>_<name>` flattening didn't remove — and
 * an MCP client (or the model API behind it) rejects the ENTIRE `tools/list`
 * response when a single entry is non-conforming. That makes EVERY tool vanish
 * the moment one bad tool from a newly-added server enters the catalog, with no
 * server-side error (the rejection is the client's). `toListedTool` isolates it
 * per tool: drop the offender (logged), normalize an odd schema, keep the rest.
 */
const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// The Anthropic API caps a tool name at 128 chars — but the MCP CLIENT (Claude
// Code, claude.ai) prepends `mcp__<server>__` (≈20+ chars) before sending it,
// and that FULL name is what the 128 applies to. So budget for the prefix here,
// or a long `googlecalendar_…` name we pass gets the whole request 400'd. This
// is deliberately conservative; a dropped tool is logged so it's diagnosable.
const MCP_TOOL_NAME_MAX = 100;

/** A discovered tool as an MCP listing entry, or null if its name can't be listed. */
export function toListedTool(tool: ProxiedTool): McpTool | null {
  if (!MCP_TOOL_NAME_RE.test(tool.mcpName) || tool.mcpName.length > MCP_TOOL_NAME_MAX) {
    console.warn(
      `[mcp] dropping tool "${tool.mcpName}" from the listing — not a valid MCP tool name ` +
        `(must match ${MCP_TOOL_NAME_RE} and be ≤${MCP_TOOL_NAME_MAX} chars). ` +
        'One non-conforming tool would otherwise make the whole toolset disappear on the client.',
    );
    return null;
  }
  // MCP requires an object inputSchema. A remote server's schema that isn't a
  // plain object (or omits `type: 'object'`) can invalidate the whole response,
  // so normalize it — keeping any declared properties — rather than pass it
  // through verbatim.
  const raw = tool.inputSchema;
  let inputSchema: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { type: 'object', ...(raw as Record<string, unknown>) }
      : { type: 'object', properties: {} };
  // Sanitize the schema into what the Anthropic tool validator accepts. A
  // remote server that emits a construct the validator rejects — Google's
  // gmail/calendar use `$ref`/`$defs` AND OpenAPI `format` values like
  // `int32`/`byte` — makes the CLIENT reject the ENTIRE tools/list response,
  // so all tools vanish and nothing registers. Sanitizing per-tool means one
  // odd server can't blank the whole toolset.
  inputSchema = sanitizeInputSchema(inputSchema) as Record<string, unknown>;
  // The MCP/Anthropic validator requires the top-level `type` to be exactly
  // "object" and (for the Anthropic API) `properties` to be present. Force both
  // so a remote schema that declared something else — or a union like
  // `["object","null"]` — can't reject the whole tools/list.
  inputSchema.type = 'object';
  if (typeof inputSchema.properties !== 'object' || inputSchema.properties === null) {
    inputSchema.properties = {};
  }
  return {
    name: tool.mcpName,
    description: tool.description,
    inputSchema: inputSchema as McpTool['inputSchema'],
  };
}

/** JSON-Schema string `format` values the Anthropic tool validator accepts. */
const SUPPORTED_SCHEMA_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * Make a remote server's JSON Schema safe for the Anthropic tool validator:
 *  - inline local `$ref` pointers (`#/$defs/...`, `#/definitions/...`) and drop
 *    the now-unreferenced `$defs`/`definitions` blocks (the API restricts `$ref`
 *    and MCP clients converting our schemas reject it outright);
 *  - drop non-standard `format` values (OpenAPI's `int32`/`byte`/… — only the
 *    JSON-Schema-standard formats above are accepted; `format` is advisory, so
 *    dropping it doesn't change tool behavior).
 * Depth-bounded so a recursive schema degrades to a permissive `{}` node instead
 * of hanging or emitting the unsupported recursion; non-local/external refs
 * degrade the same way. Exported for direct testing.
 */
export function sanitizeInputSchema(schema: unknown): unknown {
  const root = schema;
  const resolvePointer = (pointer: string): unknown => {
    if (!pointer.startsWith('#/')) return undefined;
    let node: unknown = root;
    for (const partRaw of pointer.slice(2).split('/')) {
      const part = partRaw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };
  // `isPropertyMap` marks the value of `properties`/`patternProperties`: its
  // keys are the tool's OWN field names, not schema keywords, so a field
  // literally named `format`, `$ref` or `definitions` must survive untouched
  // (its VALUE is still a schema and is walked as one).
  const walk = (node: unknown, depth: number, isPropertyMap = false): unknown => {
    if (depth > 20) return {}; // recursion/cycle guard — permissive fallback
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (!isPropertyMap && typeof obj.$ref === 'string') {
      const target = resolvePointer(obj.$ref);
      // JSON Schema allows siblings next to $ref; keep them, target wins ties.
      const siblings: Record<string, unknown> = { ...obj };
      delete siblings.$ref;
      const resolved = walk(target ?? {}, depth + 1);
      return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
        ? { ...siblings, ...(resolved as Record<string, unknown>) }
        : Object.keys(siblings).length
          ? siblings
          : resolved ?? {};
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isPropertyMap) {
        out[key] = walk(value, depth + 1);
        continue;
      }
      if (key === '$defs' || key === 'definitions') continue; // inlined above
      // Drop a non-standard `format` (OpenAPI `int32`/`byte`/…) — the validator
      // only allows the JSON-Schema-standard set; the annotation is non-load-bearing.
      if (key === 'format' && (typeof value !== 'string' || !SUPPORTED_SCHEMA_FORMATS.has(value))) {
        continue;
      }
      out[key] = walk(value, depth + 1, key === 'properties' || key === 'patternProperties');
    }
    return out;
  };
  return walk(schema, 0);
}

/**
 * Flatten a discovered UTCP tool (`<manual>.<tool>`) into the advertised shape
 * when MULTIPLE manuals are registered. Tools from `kbManualName` keep their
 * bare name (so existing agents still call `read_file`); every other manual's
 * tool is namespaced as `<manual>_<tool>` to guarantee a unique, dot-free MCP
 * name.
 *
 * `kbManualName` is a parameter rather than a constant because the two surfaces
 * that call this reach the KB through different manuals: the hosted proxy
 * registers it over loopback, the local server registers the deployment's MCP
 * endpoint. Whichever manual carries the core toolset is the one whose names
 * must stay bare.
 */
export function flattenManualTool(tool: UtcpTool, kbManualName: string): ProxiedTool {
  const dot = tool.name.indexOf('.');
  const manual = dot >= 0 ? tool.name.slice(0, dot) : '';
  const bare = dot >= 0 ? tool.name.slice(dot + 1) : tool.name;
  const mcpName = manual === kbManualName ? bare : tool.name.replace(/\./g, '_');
  return {
    utcpName: tool.name,
    mcpName,
    description: tool.description,
    inputSchema: tool.inputs,
    manualName: manual,
  };
}

/**
 * Flatten one discovered UTCP tool into the advertised shape: strip the
 * `<manual>.` namespace prefix for the MCP name and keep the UTCP input schema
 * verbatim (Bevel-hosted HTTP tools show their `{body}` envelope, exactly as in
 * `call_tool_chain`).
 */
export function flattenDiscoveredTool(prefix: string, tool: UtcpTool): ProxiedTool {
  return {
    utcpName: tool.name,
    mcpName: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
    description: tool.description,
    inputSchema: tool.inputs,
    // `prefix` is `<manual>.`; the manual is that without the trailing dot.
    manualName: prefix.endsWith('.') ? prefix.slice(0, -1) : prefix,
  };
}
