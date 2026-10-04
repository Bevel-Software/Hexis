import type { Tool as McpTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpNameToTsInterfaceName, findToolsByNames, sanitizeIdentifier } from './code-mode-names.js';
import { chainExample, type ChainExample, type ChainExampleTool } from './chain-example.js';
import { toCallToolResult, toolError, describeToolFailure, withTransportDetail, omitImagePayloads } from './results.js';
import { retiredToolInFailure } from './retired-tools.js';
import {
  CHAIN_TIMEOUT_DEFAULT_MS,
  CHAIN_TIMEOUT_MAX_MS,
  CHAIN_TIMEOUT_MIN_MS,
  runToolChain,
} from './chain-runtime.js';

/**
 * Code-mode meta-tools exposed ALONGSIDE the direct tools. They let an external
 * agent batch many Bevel calls into one isolated-vm run (`call_tool_chain`)
 * instead of one MCP round-trip per call — the same efficiency our own agent
 * gets. `call_tool_chain`'s description carries the code-mode protocol, so the
 * client learns the convention from the tool itself; `list_tools`/`tools_info`
 * are how it discovers what to call. There IS a system prompt over MCP now: the
 * platform header and the admin's preamble arrive as `instructions` on the
 * initialize handshake (see core-backend's modules/agent-instructions/compose.ts).
 * The PROTOCOL stays in the description regardless, because several clients
 * (claude.ai on the web, the Agent SDK, Cline) drop that field.
 *
 * What a chain DOES, though — to a failure, to a large result, to an image —
 * is true of every call, and those rules are stated once, in the handshake
 * instructions and in the platform-managed agent guide, rather than on each
 * tool they cover. So on a surface that has those rules the chain description
 * ends with the same pointer sentence every file tool ends with, composed
 * where the tool is served and the guide's configured name is known
 * (core-backend's mcp.service.ts; nothing here may spell `AGENTS.md`, since
 * the name is a deployment setting). A client that drops `instructions` is
 * then still told WHERE the rules are, which is what the guide is for.
 * The standalone bridge in `hexis-mcp` passes no pointer and so serves the
 * description WHOLE, rules included: it proxies a remote knowledge base and
 * does not know that deployment's layout.
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

/** The chain tool's name, for the callers that single it out by name. */
export const CALL_TOOL_CHAIN_NAME = 'call_tool_chain';

/**
 * The namespace every example in the three descriptions is written against.
 *
 * It is NOT fixed text, because it is not the same name on every connection:
 * the hosted endpoint registers the knowledge-base tools as `KNOWLEDGE_BASE`,
 * while the local server registers the whole deployment as one `hexis` manual.
 * A description that named the other one taught the agent a namespace the
 * runtime had no binding for, and the example call it copied died of
 * `ReferenceError` — which is how this was reported. So each surface passes
 * the name it actually registers, and the examples are built from it.
 *
 * Sanitized the way the runtime sanitizes it, so the example is callable even
 * when the registered manual's name is not a bare identifier: `@utcp/code-mode`
 * exposes `global.<sanitized manual name>`, and an example spelled any other
 * way would not run.
 */
export function chainNamespaceExample(namespace: string): string {
  return sanitizeIdentifier(namespace);
}

/**
 * What a chain does when it FAILS — one of the rules about a chain that are
 * true of every call, not of how to write one.
 *
 * Exported as text because it is stated in ONE of two places, never both: in
 * the rules every tool shares (the handshake instructions and the managed
 * agent guide, see core-backend's `agent-instructions/shared-file-rules.ts`)
 * on a surface that has them, and in the chain's own description on one that
 * does not. The same sentences either way, so the rule cannot read differently
 * depending on where an agent found it.
 */
export const CHAIN_FAILURES_RULE = `Failures are answered, never dropped: a chain that throws comes back as an error carrying the reason, and one that outlives \`timeout\` (default ${CHAIN_TIMEOUT_DEFAULT_MS} ms, maximum ${CHAIN_TIMEOUT_MAX_MS} ms) comes back saying so — raise \`timeout\` or split the work and run it again. Either way the connection stays open and your next call works as usual.`;

/** What a chain does with a result too large to return. Placed as {@link CHAIN_FAILURES_RULE} is. */
export const CHAIN_LARGE_RESULTS_RULE =
  'Large results: if the combined result+logs exceed `max_output_size` (default 200000 chars) the full JSON is spilled to a shared store and you get back a `__tool_chain_spill__/…` ref instead. Read it with `read_file` (pass that ref as `path` — `branch` is ignored — plus `offset`/`limit` to slice it), or better, re-run a narrower chain that returns only what you need.';

/**
 * What a chained read of an IMAGE gives back. On a surface with the shared
 * rules this is part of their content rule, which states it among everything
 * else a read returns; it is spelled here only for a description that has to
 * carry it itself.
 */
const CHAIN_IMAGES_RULE =
  'Images: image files are returned as native MCP image content on a DIRECT `read_file` call only — a chained `read_file` of an image yields `{ image_omitted: true, note }` instead of the picture, so call it outside the chain to actually see the image.';

/**
 * The chain's description, in one of two forms.
 *
 * WITH a `sharedRulesPointer`, it is how to write a chain and how to discover
 * what to call, ending in that sentence: the rules about what a chain does —
 * failures, large results, images — are stated once for every tool, in the
 * place the pointer names, and repeating them here is what made this
 * description long enough for a client to cut.
 *
 * WITHOUT one, it carries those rules itself. A surface that has no shared
 * rules to point at (the standalone bridge, which proxies a deployment whose
 * guide it cannot name) would otherwise tell an agent nothing about a chain
 * that timed out.
 */
function callToolChainDescription(example: ChainExample, sharedRulesPointer?: string): string {
  const { namespace: ns, name, call } = example;
  // Printed only when the catalog determines every required argument. A call
  // the agent cannot trust is worse than the shape on its own, and `tools_info`
  // is one hop away either way.
  const worked = call ? ` A call that works exactly as written: \`return ${call};\`.` : '';
  const howToWriteOne = [
    `Execute a short JavaScript program with direct access to every registered UTCP tool as a synchronous function. Call tools as \`${ns}.<tool>({ body: { ...args } })\` with NO \`await\` (results are already resolved), and \`return\` the final value.${worked} Every argument a tool declares REQUIRED must be present — \`tools_info\` gives the exact shapes, and for the knowledge-base tools that includes \`branch\`. The runtime is plain JavaScript (no type annotations / no TypeScript-only syntax), plus \`atob\`, \`btoa\`, \`TextEncoder\` and \`TextDecoder\` for base64 and UTF-8 bytes, as in a browser. There is no \`Buffer\`, no \`fetch\` and no \`require\`.`,
    `Discover first: \`list_tools\` lists every tool in callable form (e.g. \`${name}\`); \`tools_info\` returns their exact argument + return shapes — do not guess. Batch multiple tool calls into one chain to avoid a round-trip per call. The chain runs with your own connection key, so it can only reach the tools you can already call directly.`,
  ];
  if (sharedRulesPointer !== undefined) return `${howToWriteOne.join('\n\n')}${sharedRulesPointer}`;
  return [...howToWriteOne, CHAIN_FAILURES_RULE, CHAIN_LARGE_RESULTS_RULE, CHAIN_IMAGES_RULE].join('\n\n');
}

/** What a surface says about itself when it asks for the meta-tools. */
export interface CodeModeMetaToolsOptions {
  /**
   * The sentence that ends the chain's description on a surface whose
   * knowledge base states the shared rules (see {@link callToolChainDescription}).
   * Opaque text: the caller composes it, because it names the agent guide and
   * that name is a deployment setting — nothing here may spell `AGENTS.md`.
   * Absent, the description carries the chain's rules itself.
   */
  sharedRulesPointer?: string;
}

/**
 * The three meta-tools, with every example written against the namespace this
 * connection really exposes and a tool name its catalog really has.
 *
 * Built per listing rather than held as a module constant: both belong to the
 * surface, and a description computed once and shared across surfaces is the
 * fixed text this replaces. `tools` is the surface's catalog — pass every tool
 * it serves, names AND input schemas, since the arguments in the example come
 * from the schema (see `chainExample`).
 *
 * `list_tools` and `tools_info` describe the registry, not what a call does,
 * so neither ever carried a shared rule and neither gains the pointer.
 */
export function codeModeMetaTools(
  namespace: string,
  tools: readonly ChainExampleTool[] = [],
  options: CodeModeMetaToolsOptions = {},
): McpTool[] {
  const example = chainExample(namespace, tools);
  const { name } = example;
  return [
    {
      name: 'list_tools',
      description: `List every UTCP tool currently registered, in TypeScript-accessible form (e.g. \`${name}\`) for use inside \`call_tool_chain\`.`,
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
      name: CALL_TOOL_CHAIN_NAME,
      description: callToolChainDescription(example, options.sharedRulesPointer),
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1, description: 'JavaScript to execute against the registered tools.' },
          timeout: {
            type: 'integer',
            minimum: CHAIN_TIMEOUT_MIN_MS,
            maximum: CHAIN_TIMEOUT_MAX_MS,
            description: `Timeout in ms (default ${CHAIN_TIMEOUT_DEFAULT_MS}, max ${CHAIN_TIMEOUT_MAX_MS}).`,
          },
          max_output_size: { type: 'integer', minimum: 1000, maximum: 1000000, description: 'Max result+logs size in chars before spilling (default 200000, max 1000000).' },
        },
        required: ['code'],
        additionalProperties: false,
      } as McpTool['inputSchema'],
    },
  ];
}

/**
 * The meta-tool NAMES, which no namespace can change. Kept separate from
 * {@link codeModeMetaTools} because every surface needs them to route a call
 * and to keep a discovered copy out of its listing, and neither of those knows
 * — or should need — the namespace.
 */
export const META_TOOL_NAMES: ReadonlySet<string> = new Set(['list_tools', 'tools_info', CALL_TOOL_CHAIN_NAME]);
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
        ? Math.min(CHAIN_TIMEOUT_MAX_MS, Math.max(CHAIN_TIMEOUT_MIN_MS, Math.trunc(args.timeout)))
        : CHAIN_TIMEOUT_DEFAULT_MS;
    // Clamp to [1000, 1_000_000] so a caller can't force oversized inline
    // output past the spill.
    const maxOutputSize =
      typeof args.max_output_size === 'number' && Number.isFinite(args.max_output_size)
        ? Math.min(1_000_000, Math.max(1_000, Math.trunc(args.max_output_size)))
        : CALL_TOOL_CHAIN_MAX_OUTPUT;
    // The shared runner, which answers every failure instead of leaving one to
    // pass for a success with a null result: the chain's own browser globals
    // are in place, and a timeout, an exhausted heap and an unknown namespace
    // each come back as the sentence that says so.
    const outcome = await runToolChain(client, code, timeout);
    if (!outcome.ok) {
      // A chain that died calling a REMOVED tool gets the reason it was
      // removed, not the runtime's "is not a function". Read from the failure
      // itself, never from the chain's source: a chain that merely mentions
      // the name and died of something else keeps its own reason. A migration
      // notice answers alone — the transport detail below would be noise
      // beside an answer that is not about the transport.
      const retired = retiredToolInFailure(outcome.error);
      if (retired) return toolError(retired);
      // An MCP caller is answered with TEXT and nothing else, so the
      // transport's own status and body are folded into it. `runToolChain`
      // composes the message with `describeToolFailure` (which lifts an
      // axios-shaped `response.data.error` out) and carries `status`/`data`
      // beside it for the shapes that put the reason there instead; returning
      // `outcome.error` alone dropped that half on this surface, leaving the
      // caller with generic transport text.
      return toolError(withTransportDetail(outcome.error, outcome.status, outcome.data));
    }
    const { result: rawResult, logs } = outcome;
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
    // `runToolChain` answers rather than throws, so a chain no longer reaches
    // here — what does is a catalog read, a name lookup or the spill write.
    // The retired-tool mapping is kept all the same: it costs nothing, and it
    // is the one answer that must survive however the failure arrived.
    const failure = describeToolFailure(err);
    const retired = name === CALL_TOOL_CHAIN_NAME ? retiredToolInFailure(failure) : undefined;
    if (retired) return toolError(retired);
    return toolError(`The "${name}" tool failed: ${failure}`);
  }
}
