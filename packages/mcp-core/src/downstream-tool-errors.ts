import { CommunicationProtocol, type CallTemplate } from '@utcp/sdk';
import { McpCommunicationProtocol } from '@utcp/mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SecretRedactor, rememberCallCredentials } from './secret-redactor.js';

/**
 * A downstream MCP server said its own call failed: it answered a
 * `CallToolResult` with `isError: true` ("This tool requires a Business plan",
 * "No calendar is connected", a validation message). Thrown so the call fails
 * as a failed call: the hosted surface answers `isError: true` with the
 * server's own words, and a `call_tool_chain` sees a rejected call instead of
 * a value. It is the server's answer, not a transport failure, so it is never
 * a reason to refresh a token or retry the call.
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
   * The same failure with every secret `redactor` holds taken out of its words:
   * text blocks, an embedded resource's text and the message. Other blocks
   * (an image) carry no quoted text and pass as they are.
   */
  redactedWith(redactor: SecretRedactor): DownstreamToolError {
    const content = this.content.map((block) => {
      if (block.type === 'text') return { ...block, text: redactor.redact(block.text) };
      if (block.type === 'resource' && 'text' in block.resource && typeof block.resource.text === 'string') {
        return { ...block, resource: { ...block.resource, text: redactor.redact(block.resource.text) } };
      }
      return block;
    });
    return new DownstreamToolError(redactor.redact(this.message), content);
  }

  /**
   * The failed call as a proxy answers it: the downstream server's own words,
   * marked `isError`, with the call's secrets already taken out (the protocol
   * throws it redacted, see {@link keepDownstreamToolErrors}). Not re-worded
   * otherwise: a server that already says which tool failed (the platform's
   * own refusals do) would say it twice.
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

type ResultProcessor = {
  _processMcpToolResult?: (this: unknown, result: unknown) => unknown;
  callTool?: (this: unknown, caller: unknown, toolName: string, args: unknown, template: CallTemplate) => Promise<unknown>;
};

/** The template a client stores for `toolName`, with its `${VAR}` references, or undefined. */
async function storedTemplate(caller: unknown, toolName: string): Promise<CallTemplate | undefined> {
  try {
    const repository = (caller as { config?: { tool_repository?: { getTool(name: string): Promise<unknown> } } })
      ?.config?.tool_repository;
    const tool = (await repository?.getTool(toolName)) as { tool_call_template?: CallTemplate } | undefined;
    return tool?.tool_call_template;
  } catch {
    return undefined;
  }
}

/**
 * Teach one `@utcp/mcp` protocol instance to keep a downstream `isError`.
 *
 * `@utcp/mcp` 1.2 unwraps a `CallToolResult` into its parsed `content` and
 * drops `isError` on the way (`_processMcpToolResult`), so a downstream
 * server's failure reached our callers as a successful answer whose text was
 * the error. An MCP client that trusts the flag then treats a call that never
 * did anything as done. The unwrap is private to
 * the library, so it is wrapped on the instance; `downstream-tool-errors.test`
 * fails if a release renames it.
 *
 * The server's words are quoted back to the caller, and a server can echo the
 * credential the call carried. So `callTool` is wrapped too: a failure leaves
 * it with every secret the call carried taken out (`rememberCallCredentials`,
 * from the template as the client filled it in and as it stores it). Streaming
 * goes through `callTool` in this protocol, so it is covered by the same wrap.
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
  const call = target.callTool;
  if (typeof call === 'function') {
    target.callTool = async function (this: unknown, caller, toolName, args, template) {
      try {
        return await call.call(this, caller, toolName, args, template);
      } catch (err) {
        if (!(err instanceof DownstreamToolError)) throw err;
        const redactor = new SecretRedactor();
        rememberCallCredentials(redactor, template, await storedTemplate(caller, toolName));
        throw err.redactedWith(redactor);
      }
    };
  }
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
