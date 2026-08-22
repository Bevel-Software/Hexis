import type { Tool as McpTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpNameToTsInterfaceName, findToolsByNames } from './code-mode-names.js';
import { toCallToolResult, toolError, describeToolFailure, omitImagePayloads } from './results.js';

/**
 * Code-mode meta-tools exposed ALONGSIDE the direct tools. They let an external
 * agent batch many Bevel calls into one isolated-vm run (`call_tool_chain`)
 * instead of one MCP round-trip per call — the same efficiency our own agent
 * gets. `call_tool_chain`'s description carries the code-mode protocol (there is
 * no system prompt over MCP), so the client learns the convention from the tool
 * itself; `list_tools`/`tools_info` are how it discovers what to call.
 *
 * Security is identical to the direct surface: the chain runs in an isolated-vm
 * but calls tools with the CALLER's credentials against the external catalog —
 * internal-only tools aren't in that catalog, so a chain can't reach them either.
 *
 * These three belong to whichever client holds the registry. A surface that
 * registers ANOTHER Bevel MCP endpoint as one of its manuals therefore has to
 * drop that endpoint's copies from the passthrough (see {@link META_TOOL_NAMES}):
 * the remote trio describes the remote registry, and locally they must describe
 * the merged one.
 */
const CALL_TOOL_CHAIN_DESCRIPTION = [
  'Execute a short JavaScript program with direct access to every registered UTCP tool as a synchronous function. Call tools as `KNOWLEDGE_BASE.<tool>({ body: { ...args } })` with NO `await` (results are already resolved), and `return` the final value. The runtime is plain JavaScript (no type annotations / no TypeScript-only syntax).',
  'Discover first: `list_tools` lists every tool in callable form (e.g. `KNOWLEDGE_BASE.read_file`); `tools_info` returns their exact argument + return shapes — do not guess. Batch multiple tool calls into one chain to avoid a round-trip per call. The chain runs with your own connection key, so it can only reach the tools you can already call directly.',
  'Large results: if the combined result+logs exceed `max_output_size` (default 200000 chars) the full JSON is spilled to a shared store and you get back a `__tool_chain_spill__/…` ref instead. Read it with `read_file` (pass that ref as `path` — `branch` is ignored — plus `offset`/`limit` to slice it), or better, re-run a narrower chain that returns only what you need.',
  'Images: image files are returned as native MCP image content on a DIRECT `read_file` call only — a chained `read_file` of an image yields `{ image_omitted: true, note }` instead of the picture, so call it outside the chain to actually see the image.',
].join('\n\n');

export const CODE_MODE_META_TOOLS: McpTool[] = [
  {
    name: 'list_tools',
    description:
      'List every UTCP tool currently registered, in TypeScript-accessible form (e.g. `KNOWLEDGE_BASE.read_file`) for use inside `call_tool_chain`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as McpTool['inputSchema'],
  },
  {
    name: 'tools_info',
    description:
      'Get full TypeScript interface definitions for named tools (names from `list_tools`). The schemas are the source of truth — do not guess shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tool names to describe.' },
      },
      required: ['tool_names'],
      additionalProperties: false,
    } as McpTool['inputSchema'],
  },
  {
    name: 'call_tool_chain',
    description: CALL_TOOL_CHAIN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, description: 'JavaScript to execute against the registered tools.' },
        timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Timeout in ms (default 30000).' },
        max_output_size: { type: 'integer', minimum: 1000, maximum: 1000000, description: 'Max result+logs size in chars before spilling (default 200000, max 1000000).' },
      },
      required: ['code'],
      additionalProperties: false,
    } as McpTool['inputSchema'],
  },
];

export const META_TOOL_NAMES: ReadonlySet<string> = new Set(CODE_MODE_META_TOOLS.map((t) => t.name));

/** Default cap on a `call_tool_chain` result's stringified size before it spills. */
export const CALL_TOOL_CHAIN_MAX_OUTPUT = 200_000;

/**
 * UTF-8 byte length without Node's `Buffer` — this module stays free of
 * runtime-specific globals. Matches `Buffer.byteLength`: a lone surrogate
 * encodes as the 3-byte replacement character.
 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * Where an oversized `call_tool_chain` payload goes. The hosted proxy hands in
 * the shared workspace spill store, whose refs `read_file` can read back. A
 * surface with nowhere to put it (the local server has no server-side store of
 * its own) passes nothing and gets a truncation notice instead — the caller is
 * told to narrow the chain rather than handed a ref that resolves nowhere.
 */
export interface SpillPort {
  write(json: string): Promise<{ ref: string; bytes: number }>;
}

/**
 * Handle a code-mode meta-tool. `list_tools`/`tools_info` reflect on the
 * client's discovered catalog; `call_tool_chain` runs the caller's JavaScript in
 * the client's isolated-vm, where every registered tool is reachable as
 * `<manual>.tool(...)`.
 */
export async function dispatchMetaTool(
  client: CodeModeUtcpClient,
  name: string,
  args: Record<string, unknown>,
  spill?: SpillPort,
): Promise<CallToolResult> {
  try {
    if (name === 'list_tools') {
      const tools = await client.config.tool_repository.getTools();
      return toCallToolResult({ tools: tools.map((t) => utcpNameToTsInterfaceName(t.name)) });
    }
    if (name === 'tools_info') {
      // The schema is advisory over a raw JSON-RPC call: a missing array or a
      // non-string entry must be a named validation error here, not a generic
      // failure out of a repository lookup it was never valid input for.
      const rawNames = args.tool_names;
      // Empty included — the schema says minItems 1, and an empty success
      // payload for invalid input would read as "no tools exist".
      if (!Array.isArray(rawNames) || rawNames.length === 0 || rawNames.some((n) => typeof n !== 'string')) {
        return toolError('The "tools_info" tool requires "tool_names": a non-empty array of tool name strings.');
      }
      const names = rawNames as string[];
      const interfaces: string[] = [];
      const notFound: string[] = [];
      const resolved = await findToolsByNames(client, names);
      for (const n of names) {
        const found = resolved.get(n);
        if (found) interfaces.push(client.toolToTypeScriptInterface(found.tool));
        else notFound.push(n);
      }
      return toCallToolResult({ interfaces: interfaces.join('\n\n'), not_found: notFound });
    }
    // call_tool_chain
    // Same advisory-schema rule as above: a missing or non-string `code` must
    // not silently execute an empty program and report success.
    const code = args.code;
    if (typeof code !== 'string' || code.length === 0) {
      return toolError('The "call_tool_chain" tool requires a non-empty "code" string.');
    }
    // Clamp both knobs to their schema bounds — the schema is advisory over a
    // raw JSON-RPC call, and an unclamped `timeout` would let one chain hold
    // the isolate far past the documented 120s cap.
    const timeout =
      typeof args.timeout === 'number' && Number.isFinite(args.timeout)
        ? Math.min(120_000, Math.max(1_000, Math.trunc(args.timeout)))
        : 30_000;
    // Clamp to [1000, 1_000_000] so a caller can't force oversized inline
    // output past the spill.
    const maxOutputSize =
      typeof args.max_output_size === 'number' && Number.isFinite(args.max_output_size)
        ? Math.min(1_000_000, Math.max(1_000, Math.trunc(args.max_output_size)))
        : CALL_TOOL_CHAIN_MAX_OUTPUT;
    const { result: rawResult, logs } = await client.callToolChain(code, timeout);
    // Images never ride a chain result: the chain's value is stringified JSON,
    // where base64 is context flood, not a picture. A chained `read_file` of an
    // image comes back as an omitted-image note instead (see omitImagePayloads);
    // the direct tool call is the sanctioned way to SEE an image.
    const result = omitImagePayloads(rawResult, 'result');
    // Bound the payload: an external session has no ambient workspace, so an
    // oversized result spills to the shared store and we return only a ref —
    // parity with the in-process agent's `call_tool_chain`.
    if (JSON.stringify({ success: true, result, logs }).length <= maxOutputSize) {
      return toCallToolResult({ success: true, result, logs });
    }
    const fullJson = JSON.stringify({ result, logs }, null, 2);
    if (!spill) {
      return toCallToolResult({
        success: true,
        truncated: true,
        // Bytes, not chars: the spill branch reports the store's byte count,
        // and `result_bytes` must mean one thing across both paths.
        result_bytes: utf8ByteLength(fullJson),
        message:
          `Result+logs payload was ${fullJson.length} characters (exceeded max_output_size of ${maxOutputSize}), ` +
          'and this server has no spill store to park it in. Re-run a narrower chain that returns only what you ' +
          'need, or raise max_output_size.',
      });
    }
    const { ref, bytes } = await spill.write(fullJson);
    return toCallToolResult({
      success: true,
      truncated: true,
      result_ref: ref,
      result_bytes: bytes,
      message: `Result+logs payload was ${fullJson.length} characters (exceeded max_output_size of ${maxOutputSize}). Full JSON saved to the shared spill store as \`${ref}\`. Read it back with \`read_file\` (pass that ref as \`path\`, \`branch\` ignored, plus \`offset\`/\`limit\` to slice), or re-run a narrower chain that returns only what you need.`,
    });
  } catch (err) {
    return toolError(`The "${name}" tool failed: ${describeToolFailure(err)}`);
  }
}
