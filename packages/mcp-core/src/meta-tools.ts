import type { Tool as McpTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpNameToTsInterfaceName, findToolByName } from './code-mode-names.js';
import { toCallToolResult, toolError, describeToolFailure } from './results.js';

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
      const names = Array.isArray(args.tool_names) ? (args.tool_names as string[]) : [];
      const interfaces: string[] = [];
      const notFound: string[] = [];
      for (const n of names) {
        const found = await findToolByName(client, n);
        if (found) interfaces.push(client.toolToTypeScriptInterface(found.tool));
        else notFound.push(n);
      }
      return toCallToolResult({ interfaces: interfaces.join('\n\n'), not_found: notFound });
    }
    // call_tool_chain
    const code = typeof args.code === 'string' ? args.code : '';
    const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000;
    // Clamp to [1000, 1_000_000] so a caller can't force oversized inline
    // output past the spill (schema bounds are advisory over a raw JSON-RPC call).
    const maxOutputSize =
      typeof args.max_output_size === 'number'
        ? Math.min(1_000_000, Math.max(1_000, Math.trunc(args.max_output_size)))
        : CALL_TOOL_CHAIN_MAX_OUTPUT;
    const { result, logs } = await client.callToolChain(code, timeout);
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
        result_bytes: fullJson.length,
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
