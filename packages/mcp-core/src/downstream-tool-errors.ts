import { CommunicationProtocol } from '@utcp/sdk';
import { McpCommunicationProtocol } from '@utcp/mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A downstream MCP server said its own call failed: it answered a
 * `CallToolResult` with `isError: true` ("This tool requires a Business plan",
 * "No calendar is connected", a validation message). Thrown so the call fails
 * like any other failed call: the hosted surface answers `isError: true` with
 * the server's own words, the Audit log records an error, and a
 * `call_tool_chain` sees a rejected call instead of a value.
 */
export class DownstreamToolError extends Error {
  constructor(
    message: string,
    /** The server's own content blocks, passed on as they came. */
    readonly content: CallToolResult['content'],
  ) {
    super(message);
    this.name = 'DownstreamToolError';
  }

  /**
   * The failed call as a proxy answers it: the downstream server's own words,
   * unchanged, marked `isError`. Not re-worded: a server that already says
   * which tool failed (the platform's own refusals do) would otherwise say it
   * twice.
   */
  toCallToolResult(): CallToolResult {
    return { isError: true, content: this.content.length > 0 ? this.content : [{ type: 'text', text: this.message }] };
  }
}

/** What a result says when it reports its own failure, or null when it does not. */
export function downstreamErrorText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  if ((result as { isError?: unknown }).isError !== true) return null;
  const content = (result as { content?: unknown }).content;
  const texts = Array.isArray(content)
    ? content.flatMap((block) =>
        block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
          ? [(block as { text: string }).text]
          : [],
      )
    : [];
  const text = texts.join('\n').trim();
  return text.length > 0 ? text : 'The tool reported that it failed and gave no details.';
}

/** The well-formed content blocks of a result: each an object with a string `type`. */
function contentBlocksOf(result: unknown): CallToolResult['content'] {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is CallToolResult['content'][number] =>
      !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string',
  );
}

type ResultProcessor = { _processMcpToolResult?: (this: unknown, result: unknown) => unknown };

/**
 * Teach one `@utcp/mcp` protocol instance to keep a downstream `isError`.
 *
 * `@utcp/mcp` 1.2 unwraps a `CallToolResult` into its parsed `content` and
 * drops `isError` on the way (`_processMcpToolResult`), so a downstream
 * server's failure reached our callers as a successful answer whose text was
 * the error. An MCP client that trusts the flag (Microsoft 365 Copilot does)
 * then treats a call that never did anything as done. The unwrap is private to
 * the library, so it is wrapped on the instance; `downstream-tool-errors.test`
 * fails if a release renames it.
 */
export function keepDownstreamToolErrors<T extends object>(protocol: T): T {
  const target = protocol as unknown as ResultProcessor;
  const unwrap = target._processMcpToolResult;
  if (typeof unwrap !== 'function') {
    console.warn('[mcp] @utcp/mcp has no _processMcpToolResult: downstream isError results are not kept.');
    return protocol;
  }
  target._processMcpToolResult = function (this: unknown, result: unknown): unknown {
    const failure = downstreamErrorText(result);
    if (failure !== null) throw new DownstreamToolError(failure, contentBlocksOf(result));
    return unwrap.call(this, result);
  };
  return protocol;
}

/**
 * Register the `mcp` protocol so every client built from now on keeps a
 * downstream `isError`. A factory, as `@utcp/mcp` registers itself: each client
 * still gets an instance of its own, so sessions stay per client.
 */
export function installDownstreamToolErrors(): void {
  CommunicationProtocol.communicationProtocolFactories['mcp'] = () =>
    keepDownstreamToolErrors(new McpCommunicationProtocol());
}
