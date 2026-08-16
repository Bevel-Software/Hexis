import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Extract a human-meaningful failure message from a tool-call error. UTCP's
 * HTTP protocol surfaces a non-2xx as an axios-style error whose `.response.data`
 * is the REST endpoint's JSON body (`{ error: "..." }`). Pull that out so the
 * MCP caller sees the tool's real message instead of a bare "status code 500".
 */
export function describeToolFailure(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const inner = (data as { error?: unknown }).error;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  if (typeof data === 'string' && data.length > 0) return data;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a tool's final value into an MCP result:
 *  - a tool that already returns the MCP agentic shape (`{ content: [...] }`,
 *    each entry a real content block) is passed through unchanged;
 *  - a bare string becomes the text content;
 *  - anything else is JSON-stringified into one text block.
 *
 * Note we do NOT collapse a structured object down to its `text` field: doing
 * so silently dropped the other fields (e.g. `ask`'s `status` / `sessionId`,
 * the id a caller must echo back to poll or continue a conversation).
 * Stringifying the whole object keeps every field, so the caller always sees
 * the id it is responsible for echoing.
 *
 * The passthrough guard checks the entries, not just that `content` is an array:
 * a domain value that merely happens to carry a `content` array of non-blocks
 * (e.g. `{ content: ['a', 'b'] }`) is data, not an MCP result, so it falls
 * through to JSON-stringify and survives intact instead of being emitted as a
 * malformed result the client can't parse.
 */
function isMcpContentBlock(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string';
}

/**
 * `JSON.stringify`, made total. A tool can legally hand back a value JSON
 * refuses verbatim — a BigInt or circular object (throws), a bare
 * function/symbol (stringifies to `undefined`) — and a COMPLETED call must not
 * turn into a crash at the serialization step. The plain stringify runs first
 * so well-formed values (shared non-circular references included) come out
 * exactly as before; only a value it rejects degrades to the replacer pass
 * (BigInt → decimal string, its own ancestor → '[Circular]'), and a value even
 * that can't take (e.g. a throwing `toJSON`) falls back to `String(value)`.
 */
function safeJsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text;
  } catch {
    // BigInt / circular / throwing toJSON — degrade below.
  }
  try {
    // Circularity is being one's own ANCESTOR, not being visited twice: a
    // shared (diamond) reference is legal JSON and stringify visits it once
    // per parent, so a grown-only "seen" set would mislabel every sibling
    // share as circular. The stack tracks only the active descent — the
    // holder (`this`) of the current key is necessarily the innermost live
    // ancestor, so popping down to it discards branches already unwound.
    const ancestors: object[] = [];
    const text = JSON.stringify(value, function (this: unknown, _key, v: unknown) {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(v)) return '[Circular]';
        ancestors.push(v);
      }
      return v;
    });
    if (text !== undefined) return text;
  } catch {
    // fall through to the value's own toString
  }
  try {
    return String(value);
  } catch {
    return '(unserializable tool output)';
  }
}

export function toCallToolResult(value: unknown): CallToolResult {
  // Already in MCP agentic format — pass through untouched, but only when every
  // `content` entry is a real content block (has a string `type`).
  const content = (value as { content?: unknown })?.content;
  if (value && typeof value === 'object' && Array.isArray(content) && content.every(isMcpContentBlock)) {
    return value as CallToolResult;
  }
  const text = typeof value === 'string' ? value : safeJsonText(value ?? null);
  return { content: [{ type: 'text', text: text || '(tool produced no output)' }] };
}

export function renderProgress(chunk: unknown): string {
  const s = typeof chunk === 'string' ? chunk : safeJsonText(chunk);
  return s.length > 500 ? s.slice(0, 497) + '...' : s;
}

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * The result returned when the caller is missing personal credentials a tool
 * needs. Marked `isError` so the external agent surfaces it to the person rather
 * than treating it as tool output. Names the tool, lists the missing items, and
 * gives the absolute setup-page URL so the person can provide them and retry.
 */
export function needsAuthorizationResult(
  toolName: string,
  missing: string[],
  connectUrl: string,
): CallToolResult {
  const items = missing.join(', ');
  const text =
    `The "${toolName}" tool needs credentials you haven't set up yet: ${items}. ` +
    `Open ${connectUrl} to connect your accounts and enter your keys, then run the tool again.`;
  return { isError: true, content: [{ type: 'text', text }] };
}
