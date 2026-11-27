import { CommunicationProtocol } from '@utcp/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toCallToolResult } from './results.js';

/**
 * A downstream MCP server said its own call failed: it answered a
 * `CallToolResult` with `isError: true` ("This tool requires a Business plan",
 * "No calendar is connected", a validation message). Thrown so the call fails
 * as a failed call: a direct call answers `isError: true`, and a
 * `call_tool_chain` sees a rejected call instead of a value. It is the
 * server's answer, not a transport failure, so it is never a reason to
 * refresh a token or retry the call.
 */
export class DownstreamToolError extends Error {
  /**
   * What `@utcp/mcp`'s unwrap made of the server's answer: the value this
   * call returned before the flag was kept. A `#` field, so it is no property
   * of the error: a logger or a serialiser that copies an error's own fields
   * does not copy a provider's whole answer with it.
   */
  readonly #answer: unknown;

  constructor(answer: unknown) {
    super(textOf(answer));
    this.name = 'DownstreamToolError';
    this.#answer = answer;
  }

  /**
   * The failed call as a proxy answers it: the result the same answer made
   * before the flag was kept (`toCallToolResult` of the unwrapped value, with
   * the same `options`), marked `isError`. So a direct call reads what it
   * read when the failure passed for a success, and nothing else; it is not
   * re-worded, so a server that already says which tool failed is not said
   * twice.
   */
  toCallToolResult(options?: Parameters<typeof toCallToolResult>[1]): CallToolResult {
    return { ...toCallToolResult(this.#answer, options), isError: true };
  }
}

/** The text of the result an answer makes, which is what a chain reads as the rejection's message. */
function textOf(answer: unknown): string {
  const text = toCallToolResult(answer)
    .content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  return text.length > 0 ? text : 'The tool reported that it failed and gave no details.';
}

type ResultProcessor = { _processMcpToolResult?: (this: unknown, result: unknown) => unknown };

/**
 * Teach one `@utcp/mcp` protocol instance to keep a downstream `isError`.
 *
 * `@utcp/mcp` 1.2 unwraps a `CallToolResult` into a value and drops `isError`
 * on the way (`_processMcpToolResult`), so a downstream server's failure
 * reached our callers as a successful answer whose text was the error. An MCP
 * client that trusts the flag then treats a call that never did anything as
 * done. The unwrap still runs, and what it returns is what the failure
 * carries: only the flag is added. The unwrap is private to the library, so
 * it is wrapped on the instance; `downstream-tool-errors.test` fails if a
 * release renames it.
 */
function keepDownstreamToolErrors<T extends object>(protocol: T): T {
  const target = protocol as unknown as ResultProcessor;
  const unwrap = target._processMcpToolResult;
  if (typeof unwrap !== 'function') {
    console.warn('[mcp] @utcp/mcp has no _processMcpToolResult: downstream isError results are not kept.');
    return protocol;
  }
  target._processMcpToolResult = function (this: unknown, result: unknown): unknown {
    const answer = unwrap.call(this, result);
    if ((result as { isError?: unknown } | null | undefined)?.isError === true) throw new DownstreamToolError(answer);
    return answer;
  };
  return protocol;
}

/** Set on an `mcp` factory this module has wrapped, so installing twice in a row wraps once. */
const KEEPS_FAILURES = Symbol.for('bevel.mcp-core.keepsDownstreamToolErrors');

/**
 * Make every client built from now on keep a downstream `isError`: the `mcp`
 * protocol factory registered in this process is wrapped in place, as
 * `installGetHasNoBody` wraps the factories it guards, so each client still
 * gets an instance of its own from the same factory as before. Called again
 * right away it does nothing; called after something else has wrapped the
 * factory in between (`installGetHasNoBody` does, at the first registration)
 * it wraps once more, which changes no answer: the inner wrap has already
 * thrown the failure by the time the outer one looks.
 *
 * Called by a surface after its own `import '@utcp/mcp'`, which is what
 * registers the factory, and before it builds a client: a client creates its
 * protocol instances when it is built, so a later install would miss it.
 */
export function installDownstreamToolErrors(): void {
  const factories = CommunicationProtocol.communicationProtocolFactories;
  const factory = factories['mcp'];
  if (!factory) {
    console.warn('[mcp] no `mcp` protocol is registered: downstream isError results are not kept.');
    return;
  }
  const marked = factory as typeof factory & Record<symbol, unknown>;
  if (marked[KEEPS_FAILURES] === true) return;
  const wrapped = (() => keepDownstreamToolErrors(factory())) as typeof factory & Record<symbol, unknown>;
  wrapped[KEEPS_FAILURES] = true;
  factories['mcp'] = wrapped;
}
