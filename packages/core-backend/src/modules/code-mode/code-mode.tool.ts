import '@utcp/direct-call';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import type { SpillStore } from '../workspace/spill-store.js';
import { utcpNameToTsInterfaceName, findToolByName } from './code-mode-names.js';

export function createCallToolChainTool(
  client: CodeModeUtcpClient,
  spillStore: SpillStore,
) {
  return createTool({
    id: 'call_tool_chain',
    description: [
      CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE,
      'Execute JavaScript code with direct access to all registered UTCP tools as hierarchical functions (e.g. `manual.tool(args)`, synchronous, no await). The runtime is plain JavaScript — no type annotations or other TypeScript-only syntax. Return the final value with `return`. Use `list_tools` and `tools_info` first to discover available tools and their interfaces.',
      'Error handling inside the chain: a failing tool call THROWS, and the thrown error\'s `.message` holds the server\'s actual reason (e.g. a 403 with the explanation, not just a status code). If you catch it, surface `err.message` (and `err.status` / `err.data` when present) — NEVER `return { error: err }` or otherwise return the raw Error object, because an Error serializes to `{}` (its `message` is non-enumerable) and the reason is lost. If you don\'t need to handle it, just let it throw — the runtime already reports `err.message` back to you.',
      'Large return values: if the returned value exceeds `max_output_size`, the full JSON is auto-spilled to a shared spill store (outside any workspace, never committed) and the response contains only a `__tool_chain_spill__/…` ref + a truncated marker. You can read the spill back with the regular `read_file` tool — pass that ref as `path` (its `branch` is ignored) plus `offset` / `limit` to slice it, never read a multi-MB file in full. Order of preference: (1) re-run `call_tool_chain` with a follow-up code chain that filters/maps the data inline and returns just what you need; (2) narrow the API call — shorter `fields`, tighter date window, lower `limit`; (3) last resort — `read_file` against the spill ref with `offset` / `limit`. The spill is read-only context only; do NOT use it as a way to persist KB content — for KB writes use the regular `write_file` / `edit_file` tools, which go through the lock/commit pipeline.',
    ].join('\n\n'),
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe('JavaScript code to execute with access to all registered tools.'),
      timeout: z
        .number()
        .int()
        .min(1_000)
        .max(120_000)
        .optional()
        .default(30_000)
        .describe('Timeout in milliseconds (default: 30000).'),
      max_output_size: z
        .number()
        .int()
        .min(1_000)
        .max(1_000_000)
        .optional()
        .default(200_000)
        .describe('Max size of the stringified result in characters (default: 200000, max: 1000000). If exceeded, the full result is spilled to the shared spill store and only a `__tool_chain_spill__/…` ref is returned.'),
    }),
    execute: async (input) => {
      const timeout = input.timeout ?? 30_000;
      const maxOutputSize = input.max_output_size ?? 200_000;
      try {
        const { result, logs } = await client.callToolChain(input.code, timeout);
        const json = JSON.stringify({ success: true, result, logs });
        if (json.length <= maxOutputSize) {
          return { success: true, result, logs };
        }
        const fullJson = JSON.stringify({ result, logs }, null, 2);
        const { ref, bytes } = await spillStore.write(fullJson);
        return {
          success: true,
          truncated: true,
          result_ref: ref,
          result_bytes: bytes,
          message: `Combined result+logs payload was ${fullJson.length} characters (exceeded max_output_size of ${maxOutputSize}). Full JSON (both \`result\` and \`logs\`) saved to the shared spill store as \`${ref}\` (outside any workspace, uncommitted). Read it back with \`read_file\` — pass that ref as \`path\` (\`branch\` is ignored) plus \`offset\` / \`limit\` for a slice — or, usually better, narrow the next \`call_tool_chain\` call (smaller fields list, tighter date window, lower limit) so the result fits inline.`,
        };
      } catch (e) {
        // A failed tool call inside the chain surfaces here. When the UTCP http
        // transport carries the server's status + body on the thrown error
        // (so non-2xx tool errors aren't reduced to a bare status code), pass
        // them through to the agent — `e.message` already holds the server's
        // reason, and `status` / `data` give it the structured detail.
        const message = e instanceof Error ? e.message : String(e);
        const status = (e as { status?: unknown })?.status;
        const data = (e as { data?: unknown })?.data;
        return {
          success: false,
          error: message,
          ...(typeof status === 'number' ? { status } : {}),
          ...(data !== undefined ? { data } : {}),
        };
      }
    },
  });
}

export function createListToolsTool(client: CodeModeUtcpClient) {
  return createTool({
    id: 'list_tools',
    description: 'Returns a list of all UTCP tool names currently registered, in their TypeScript-accessible form (e.g. `manual.tool`).',
    inputSchema: z.object({}),
    execute: async () => {
      const tools = await client.config.tool_repository.getTools();
      return { tools: tools.map((t) => utcpNameToTsInterfaceName(t.name)) };
    },
  });
}

export function createToolsInfoTool(client: CodeModeUtcpClient) {
  return createTool({
    id: 'tools_info',
    description:
      'Get complete information about a specified list of tools, including TypeScript interface definitions. Accepts either UTCP names or sanitized TS-accessible names (from `list_tools`).',
    inputSchema: z.object({
      tool_names: z
        .array(z.string())
        .min(1)
        .describe('Names of the tools to get complete information for.'),
    }),
    execute: async (input) => {
      const interfaces: string[] = [];
      const notFound: string[] = [];
      for (const name of input.tool_names) {
        const found = await findToolByName(client, name);
        if (found) {
          interfaces.push(client.toolToTypeScriptInterface(found.tool));
        } else {
          notFound.push(name);
        }
      }
      return { interfaces: interfaces.join('\n\n'), not_found: notFound };
    },
  });
}
