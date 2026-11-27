import { CommunicationProtocol, type CallTemplate } from '@utcp/sdk';
import { McpCommunicationProtocol } from '@utcp/mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { callRedactor, manualSecrets } from './call-secrets.js';
import { utcpManualName } from './utcp-namespace.js';

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
   * The same failure with `redact` applied to every string the server wrote.
   * Each content block is rebuilt from the text fields the MCP spec gives its
   * kind ({@link BLOCK_FIELDS}), so no key the server chose (`_meta`, an
   * extension) is passed on, and a block of a kind it does not name is left
   * out. That leaves out binary payloads too (an image's or audio's `data`, a
   * resource's `blob`): encoded, a secret in one would pass any text search,
   * and a failure's words are in its text. Only a block's `type` (one of the
   * named kinds, since it chose the fields) and numbers (a size, a priority)
   * pass as they came. The message is redacted too.
   */
  redactedWith(redact: (text: string) => string): DownstreamToolError {
    const content = this.content.flatMap((block) => {
      const fields = BLOCK_FIELDS[block.type];
      const kept = fields ? (specFields(block, fields, redact) as typeof block) : null;
      // A resource whose only content was a blob says nothing once it is gone.
      return kept && !(kept.type === 'resource' && !('text' in (kept.resource ?? {}))) ? [kept] : [];
    });
    return new DownstreamToolError(redact(this.message), content);
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

/** The text fields the MCP spec gives each kind of content block that carries text, and the nested objects within them. */
const BLOCK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  text: ['type', 'text', 'annotations'],
  resource_link: ['type', 'uri', 'name', 'title', 'description', 'mimeType', 'size', 'annotations'],
  resource: ['type', 'resource', 'annotations'],
};
const NESTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  resource: ['uri', 'mimeType', 'text'],
  annotations: ['audience', 'priority', 'lastModified'],
};
/** `object` reduced to `fields`: every string redacted, numbers kept, a block's `type` (a spec kind) kept. */
function specFields(object: object, fields: readonly string[], redact: (text: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in object)) continue;
    const value = (object as Record<string, unknown>)[field];
    const nested = NESTED_FIELDS[field];
    if (field === 'type' || typeof value === 'number') out[field] = value;
    else if (nested && value && typeof value === 'object' && !Array.isArray(value)) out[field] = specFields(value, nested, redact);
    else if (typeof value === 'string') out[field] = redact(value);
    else if (Array.isArray(value)) out[field] = value.filter((item) => typeof item === 'string').map((item) => redact(item));
  }
  return out;
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
 * credential the call carried. So `callTool` is wrapped too: every failure
 * leaves it with every secret the call carried taken out (`callRedactor`):
 * each value substituted into the manual when it registered, as the
 * substitutor resolved it (`call-secrets.ts`), and every credential the
 * template spells out in full. A `DownstreamToolError` is rebuilt redacted;
 * any other failure (a JSON-RPC error a handler threw, an HTTP error with the
 * response body in its message) keeps its class, code and cause, with its
 * message and stack redacted in place, so the token classifier still reads
 * it; one whose message cannot be replaced (a frozen error) becomes an
 * `Error` with its name, code and cause. With the call's arguments about
 * (strings, keys, numbers, booleans and nulls), a failure's text goes whole or
 * not at all: with no secret held it goes as it came; otherwise one that
 * repeats any of them (four characters of one, or shorter ones glued into
 * four) or holds any secret is withheld, so the answer does not depend on
 * whether they matched a secret (`SecretRedactor.redact`). Streaming goes
 * through `callTool` in this protocol, so the same wrap covers it.
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
        const redactor = callRedactor(manualSecrets(caller, utcpManualName(String(template.name ?? ''))), template);
        const sent = stringsIn(args);
        const redact = (text: string) => redactor.redact(text, sent);
        if (err instanceof DownstreamToolError) throw err.redactedWith(redact);
        if (err instanceof Error) throw redactedInPlace(err, redact);
        throw typeof err === 'string' ? redact(err) : err;
      }
    };
  }
  return protocol;
}

/**
 * `err` with `redact` applied to its message and stack, or an `Error` in its
 * place, with its name, code and cause, when they cannot be replaced. An own
 * value shadows a prototype getter (a `DOMException`'s message), so only a
 * frozen or non-extensible error needs the replacement.
 */
function redactedInPlace(err: Error, redact: (text: string) => string): Error {
  const message = redact(err.message);
  try {
    Object.defineProperty(err, 'message', { value: message, writable: true, configurable: true });
    if (typeof err.stack === 'string') Object.defineProperty(err, 'stack', { value: redact(err.stack), writable: true, configurable: true });
    return err;
  } catch {
    const replacement = Object.assign(new Error(message, { cause: err.cause }), { code: (err as { code?: unknown }).code });
    replacement.name = err.name;
    return replacement;
  }
}

/**
 * Every string, object key, number, boolean and null in a call's arguments,
 * however deeply nested (walked without recursion): any of them can be a
 * guess at a secret that reads the same.
 */
function stringsIn(args: unknown): string[] {
  const found: string[] = [];
  const pending: unknown[] = [args];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') found.push(value);
    else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || value === null) found.push(String(value));
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) for (const item of value) pending.push(item);
      else {
        for (const [key, item] of Object.entries(value)) {
          found.push(key);
          pending.push(item);
        }
      }
    }
  }
  return found;
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
