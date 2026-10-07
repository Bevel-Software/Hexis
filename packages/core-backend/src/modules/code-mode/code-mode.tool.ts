import '@utcp/direct-call';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  omitImagePayloads,
  retiredToolInFailure,
  CHAIN_TIMEOUT_DEFAULT_MS,
  CHAIN_TIMEOUT_MAX_MS,
  CHAIN_TIMEOUT_MIN_MS,
  chainExample,
  type ChainExampleTool,
  runToolChain,
} from '@bevel-software/platform-mcp-core';
import type { SpillStore } from '../workspace/spill-store.js';
import { utcpNameToTsInterfaceName, findToolByName, AmbiguousToolNameError } from './code-mode-names.js';

/**
 * The in-process agent's three code-mode tools.
 *
 * `namespace` is the UTCP manual the knowledge-base tools are registered under
 * for THIS client, and every example in the descriptions is written against it.
 * It is a parameter rather than fixed text because it is not the same name on
 * every surface — the hosted endpoint registers `KNOWLEDGE_BASE`, the local MCP
 * server registers the whole deployment as `hexis` — and a description naming
 * the other one taught the agent a namespace the runtime had no binding for.
 *
 * `tools` is this client's catalog — names AND input schemas — and is used only
 * to write an EXAMPLE call that actually runs. Both halves are needed: the
 * namespace does not say how deeply a tool's name is nested, and the name does
 * not say which of its arguments are required (see `chainExample`). Passing
 * nothing prints no concrete example, which is the honest default for a caller
 * that has not handed over its catalog.
 */
export function createCallToolChainTool(
  client: CodeModeUtcpClient,
  spillStore: SpillStore,
  namespace: string,
  tools: readonly ChainExampleTool[] = [],
) {
  const { namespace: ns, call } = chainExample(namespace, tools);
  // Printed only when the catalog determines every required argument, so a
  // copied example never 400s on a missing one; see `chainExample`.
  const worked = call ? ` A call that works exactly as written: \`return ${call};\`.` : '';
  return createTool({
    id: 'call_tool_chain',
    description: [
      CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE,
      `Execute JavaScript code with direct access to all registered UTCP tools as hierarchical functions, synchronous, no await.${worked} The runtime is plain JavaScript — no type annotations or other TypeScript-only syntax — plus \`atob\`, \`btoa\`, \`TextEncoder\` and \`TextDecoder\` for base64 and UTF-8 bytes, as in a browser; there is no \`Buffer\`, no \`fetch\` and no \`require\`. Return the final value with \`return\`. Use \`list_tools\` and \`tools_info\` first to discover available tools and their interfaces.`,
      `There is NO single calling shape: some tools take their arguments under a \`body\` object, others take them flat. Call each tool as the \`Call:\` line at the top of its own description shows — it is generated from that tool's input schema, and every tool in \`${ns}\` has one. Every argument a tool declares REQUIRED must be present; for the knowledge-base tools that includes \`branch\`. Arguments that do not match the schema are refused before anything is sent or run, and the refusal carries the tool's interface.`,
      'Error handling inside the chain: a failing tool call THROWS, and the thrown error\'s `.message` holds the server\'s actual reason (e.g. a 403 with the explanation, not just a status code). If you catch it, surface `err.message` (and `err.status` / `err.data` when present) — NEVER `return { error: err }` or otherwise return the raw Error object, because an Error serializes to `{}` (its `message` is non-enumerable) and the reason is lost. If you don\'t need to handle it, just let it throw — the runtime already reports `err.message` back to you.',
      `Failures are answered, never dropped: a chain that throws comes back with \`success: false\` and the reason, and one that outlives \`timeout\` (default ${CHAIN_TIMEOUT_DEFAULT_MS} ms, maximum ${CHAIN_TIMEOUT_MAX_MS} ms) comes back saying it timed out — raise \`timeout\` or split the work and run it again. Either way your next tool call works as usual.`,
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
        .min(CHAIN_TIMEOUT_MIN_MS)
        .max(CHAIN_TIMEOUT_MAX_MS)
        .optional()
        .default(CHAIN_TIMEOUT_DEFAULT_MS)
        .describe(`Timeout in milliseconds (default: ${CHAIN_TIMEOUT_DEFAULT_MS}, max: ${CHAIN_TIMEOUT_MAX_MS}).`),
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
      const timeout = input.timeout ?? CHAIN_TIMEOUT_DEFAULT_MS;
      const maxOutputSize = input.max_output_size ?? 200_000;
      // The shared runner always answers: the chain's browser globals are in
      // place, and a timeout, an exhausted heap and an unknown namespace each
      // come back as the sentence that says so rather than as a success with a
      // null result (which is what the runner's own resolved shape looks like).
      const outcome = await runToolChain(client, input.code, timeout);
      if (!outcome.ok) {
        // A chain that failed while calling a REMOVED tool gets the reason it
        // was removed (who does it now, and where), not "is not a function".
        // The failure is the signal, not the chain's source: a chain that only
        // mentions the name and died of something else keeps its own error.
        const message = retiredToolInFailure(outcome.error) ?? outcome.error;
        return {
          success: false,
          error: message,
          ...(outcome.logs.length ? { logs: outcome.logs } : {}),
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        };
      }
      const { result: rawResult, logs } = outcome;
      // Everything past the outcome is still fallible — `omitImagePayloads`
      // walks a value the chain built, `JSON.stringify` can meet a cycle or a
      // BigInt, and the spill store writes to disk. This tool promises a
      // STRUCTURED failure for every outcome, so a disk or serialization error
      // must come back as `success: false` with its reason rather than as an
      // unhandled tool failure the agent sees as a dropped call.
      try {
        // Same policy as the MCP surfaces' `call_tool_chain` (see
        // `omitImagePayloads`): a chain result is stringified JSON, so an image
        // read inside it comes back as an omitted-image note instead of a
        // base64 flood — images are only delivered on a direct `read_file`.
        const result = omitImagePayloads(rawResult, 'result');
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
      } catch (err) {
        // The chain itself SUCCEEDED and only its delivery failed, so the logs
        // ride along: they are the only trace of the work left, and an agent
        // deciding whether to re-run a long chain needs them.
        return {
          success: false,
          error: `The chain ran, but its result could not be returned: ${err instanceof Error ? err.message : String(err)}. Re-run a narrower chain that returns only what you need.`,
          ...(logs.length ? { logs } : {}),
        };
      }
    },
  });
}

export function createListToolsTool(
  client: CodeModeUtcpClient,
  namespace: string,
  tools: readonly ChainExampleTool[] = [],
) {
  const { name } = chainExample(namespace, tools);
  return createTool({
    id: 'list_tools',
    // A name the catalog really has, or none: see `ChainExample.name`.
    description: `Returns a list of all UTCP tool names currently registered, in their TypeScript-accessible form${name ? ` (e.g. \`${name}\`)` : ''}.`,
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
      const errors: string[] = [];
      for (const name of input.tool_names) {
        // Per-name, not per-call: `findToolByName` THROWS on an ambiguous
        // sanitized name (two UTCP tools collapsing to one TS name), and one
        // ambiguous entry aborting the whole batch would cost the agent every
        // other answer in it. The error text says how to disambiguate, so it
        // is the per-name answer, not a failure of the tool.
        try {
          const found = await findToolByName(client, name);
          if (found) {
            interfaces.push(client.toolToTypeScriptInterface(found.tool));
          } else {
            notFound.push(name);
          }
        } catch (err) {
          // Only AMBIGUITY is a per-name answer (the message says how to
          // disambiguate). Anything else — a repository outage, a catalog
          // failure — must fail the call: containing it would dress an
          // outage up as a successful lookup with partial data. Typed, not
          // message-matched: the wording belongs to another package.
          if (!(err instanceof AmbiguousToolNameError)) throw err;
          errors.push(`${name}: ${err.message}`);
        }
      }
      return {
        interfaces: interfaces.join('\n\n'),
        not_found: notFound,
        ...(errors.length > 0 ? { errors } : {}),
      };
    },
  });
}
