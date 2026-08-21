import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Discriminator for {@link McpImageResult}. The slash + version suffix make it
 * a value no ordinary tool result carries by accident — a domain object with a
 * `kind` field holds things like `'image'` or `'file'`, never this string —
 * so the result shaping below can act on the shape without ever mistaking
 * caller data for it.
 */
export const MCP_IMAGE_RESULT_KIND = 'bevel/mcp-image@v1';

/**
 * The sentinel a tool HANDLER returns when its result is a picture, not JSON.
 *
 * Handlers normally return domain JSON that `toCallToolResult` stringifies
 * into one text block. An image cannot ride that path — a multimodal client
 * only SEES a picture delivered as a native MCP image content block — so a
 * handler that wants the caller to see one returns this shape instead, and
 * the MCP result shaping turns it into
 * `content: [{type:'image', data, mimeType}, {type:'text', text: note}]`.
 * The `note` keeps the transcript self-describing (path, size, dimensions);
 * without it the result is the bare image block.
 *
 * The shape intentionally travels as plain JSON: it crosses the UTCP http hop
 * (loopback REST → hosted proxy) unchanged, and only the final MCP surface
 * turns it into content blocks.
 */
export interface McpImageResult {
  kind: typeof MCP_IMAGE_RESULT_KIND;
  /** Base64-encoded image bytes (no data-URI prefix). */
  data: string;
  /** e.g. `image/png` — what the MCP image block advertises. */
  mimeType: string;
  /** One-line description (path + size/dimensions) emitted as a text block beside the image. */
  note?: string;
}

/** Build a {@link McpImageResult} for a handler to return. */
export function mcpImageResult(data: string, mimeType: string, note?: string): McpImageResult {
  return { kind: MCP_IMAGE_RESULT_KIND, data, mimeType, ...(note !== undefined ? { note } : {}) };
}

export function isMcpImageResult(value: unknown): value is McpImageResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === MCP_IMAGE_RESULT_KIND &&
    typeof (value as { data?: unknown }).data === 'string' &&
    typeof (value as { mimeType?: unknown }).mimeType === 'string'
  );
}

/** A spec-shaped MCP image content block (`{type:'image', data, mimeType}`). */
function isMcpImageBlockObject(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'image' &&
    typeof (value as { data?: unknown }).data === 'string' &&
    typeof (value as { mimeType?: unknown }).mimeType === 'string'
  );
}

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
  // Total, like `safeJsonText`: a thrown value whose own `toString` throws
  // (e.g. a null-prototype object) must still come back as a description —
  // this function runs inside catch paths, where a second throw would turn
  // a tool failure into a handler failure.
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return '(indescribable tool failure)';
  }
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
  // An image sentinel (see McpImageResult): the tool's result IS a picture.
  // Emit a native image content block so a multimodal client renders it, plus
  // the note as a text block so the transcript stays self-describing.
  if (isMcpImageResult(value)) {
    return {
      content: [
        { type: 'image', data: value.data, mimeType: value.mimeType },
        ...(value.note !== undefined ? [{ type: 'text' as const, text: value.note }] : []),
      ],
    };
  }
  // The same image result AFTER a remote MCP hop. The local stdio server
  // (hexis-mcp) reaches the deployment's MCP endpoint through @utcp/mcp, whose
  // `_processMcpToolResult` unwraps a CallToolResult's `content` array: text
  // blocks are JSON-parsed (our prose note comes back as a bare string), other
  // blocks pass through verbatim, and a single-entry list collapses to the
  // entry itself. So the hosted proxy's `[image, text]` result arrives here as
  // `[imageBlock, "note"]` — or, noteless, as the bare image block. Recognize
  // both and reassemble the spec-shaped result instead of JSON-stringifying
  // megabytes of base64 into a text block. A caller's ordinary data is safe:
  // only arrays made EXCLUSIVELY of image blocks and strings (with at least
  // one image block) qualify, and such a value already denotes image content.
  if (isMcpImageBlockObject(value)) {
    return { content: [value] };
  }
  if (
    Array.isArray(value) &&
    value.some(isMcpImageBlockObject) &&
    value.every((e) => isMcpImageBlockObject(e) || typeof e === 'string')
  ) {
    return {
      content: value.map((e) => (typeof e === 'string' ? { type: 'text' as const, text: e } : e)),
    };
  }
  // Already in MCP agentic format — pass through untouched, but only when every
  // `content` entry is a real content block (has a string `type`).
  const content = (value as { content?: unknown })?.content;
  if (value && typeof value === 'object' && Array.isArray(content) && content.every(isMcpContentBlock)) {
    return value as CallToolResult;
  }
  const text = typeof value === 'string' ? value : safeJsonText(value ?? null);
  return { content: [{ type: 'text', text: text || '(tool produced no output)' }] };
}

/**
 * Replace image payloads inside a `call_tool_chain` result with a short note.
 *
 * A chain's return value is JSON that gets STRINGIFIED into the transcript
 * (or spilled), so an image result reaching it would either flood the context
 * with base64 or burn a spill for bytes no one can see — a chain has no way to
 * deliver a native image block. Policy (v1): images are returned directly,
 * never through tool chains. This walk swaps every image sentinel — and every
 * spec-shaped image content block, which is what the local server's remote
 * MCP hop hands a chain (see `toCallToolResult`) — for
 * `{ image_omitted: true, note }`, keeping whatever structure the chain built
 * around it. The walk is ITERATIVE (explicit stack) and cycle-safe with no
 * depth cutoff — nesting depth can never smuggle a payload past the scrub.
 * Arrays and plain records are rebuilt; a NON-plain object (class instance,
 * Map-like with enumerable props) is judged by its JSON shape — `toJSON()`
 * output when it defines one, enumerable own properties otherwise — because
 * that is exactly what `JSON.stringify` will emit downstream: when that shape
 * holds an image the object is rebuilt as a plain sanitized copy, and when it
 * does not the original reference is preserved untouched (Date, RegExp, Map
 * and friends are never mangled). Best-effort by design: chain code that
 * EXTRACTS the base64 string itself escapes the walk, and then the ordinary
 * max_output_size spill bounds the damage.
 */
export function omitImagePayloads(value: unknown): unknown {
  const omittedNote = (what: string): { image_omitted: true; note: string } => ({
    image_omitted: true,
    note:
      `${what} — images are returned directly to you as native MCP image content, not through ` +
      '`call_tool_chain`. Call `read_file` on the image path as a DIRECT tool call (outside the chain) to see it.',
  });

  // Plain records (Object.prototype or null prototype) are always rebuilt.
  // Anything else — Date, Map, Buffer, class instances, other JSON-friendly
  // oddities — is preserved BY REFERENCE unless its JSON shape actually holds
  // an image (see subtreeHasImage below): rebuilding would mangle it.
  const isPlainRecord = (v: object): v is Record<string, unknown> => {
    const proto: unknown = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  const hasToJson = (v: object): v is { toJSON(): unknown } =>
    typeof (v as { toJSON?: unknown }).toJSON === 'function';

  // A value's JSON view: what JSON.stringify would serialize for it — the
  // toJSON() result when it defines one (a throwing toJSON falls back to the
  // value itself, matching safeJsonText's degraded path), the value otherwise.
  // Cached per object: toJSON is a USER hook, so it must fire at most once per
  // object per scrub — not once in the probe and again in the rebuild — and
  // both walks must observe the SAME view even if the hook is impure.
  const viewCache = new WeakMap<object, unknown>();
  const jsonView = (v: object): unknown => {
    if (viewCache.has(v)) return viewCache.get(v);
    let view: unknown = v;
    if (hasToJson(v)) {
      try {
        view = v.toJSON();
      } catch {
        /* keep the value itself */
      }
    }
    viewCache.set(v, view);
    return view;
  };

  // Does the JSON shape reachable from `root` contain an image sentinel or
  // spec-shaped image block? Iterative and cycle-safe (a visited set suffices
  // for a boolean probe); non-plain objects are entered through their JSON
  // view, exactly like the rebuild walk below. Verdicts are memoized: a clean
  // probe proves every object it visited clean too (each one's reachable shape
  // is a subset of what was just explored), so a nested non-plain object is
  // probed once, not re-walked by every enclosing probe. A hit only proves the
  // ROOT dirty — the image may sit outside an inner object's own subtree — so
  // only the root's verdict is recorded then.
  const probeCache = new WeakMap<object, boolean>();
  const subtreeHasImage = (root: object): boolean => {
    const known = probeCache.get(root);
    if (known !== undefined) return known;
    const visited = new Set<object>();
    const stack: unknown[] = [root];
    let found = false;
    while (stack.length > 0) {
      const v = stack.pop();
      if (v === null || typeof v !== 'object') continue;
      if (isMcpImageResult(v) || isMcpImageBlockObject(v)) {
        found = true;
        break;
      }
      if (visited.has(v)) continue;
      const cached = probeCache.get(v);
      if (cached === true) {
        found = true;
        break;
      }
      visited.add(v);
      if (cached === false) continue;
      if (Array.isArray(v)) {
        for (const entry of v) stack.push(entry);
        continue;
      }
      if (!isPlainRecord(v)) {
        const view = jsonView(v);
        if (view !== v) {
          stack.push(view);
          continue;
        }
      }
      for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
    }
    probeCache.set(root, found);
    if (!found) for (const v of visited) probeCache.set(v, false);
    return found;
  };

  // `out[key] = …` would be a prototype-pollution hazard for keys like
  // `__proto__`; defineProperty makes every rebuilt key an ordinary own data
  // property (JSON.stringify then serializes it exactly like the original).
  const defineKey = (out: Record<string, unknown>, key: string, val: unknown): void => {
    Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true });
  };

  // ITERATIVE depth-first rebuild: an explicit frame stack instead of
  // recursion, so arbitrarily deep nesting cannot overflow the call stack —
  // and, crucially, cannot ESCAPE the scrub the way a depth cutoff would let
  // a deeply nested image reach the transcript. `active` tracks only the
  // live descent (added on push, removed on pop), so real cycles become
  // '[Circular]' while diamond shares rebuild normally.
  type Frame =
    | { kind: 'array'; src: readonly unknown[]; out: unknown[]; i: number; release: object[] }
    | {
        kind: 'record';
        src: Record<string, unknown>;
        out: Record<string, unknown>;
        keys: string[];
        i: number;
        release: object[];
      };

  const active = new WeakSet<object>();

  /** Resolve one value: a leaf to emit as-is, or a container frame to walk. */
  const resolve = (v: unknown): { leaf: unknown } | { frame: Frame } => {
    if (v === null || typeof v !== 'object') return { leaf: v };
    if (isMcpImageResult(v)) return { leaf: omittedNote(v.note ?? `an image (${v.mimeType})`) };
    if (isMcpImageBlockObject(v)) return { leaf: omittedNote(`an image (${v.mimeType})`) };
    if (active.has(v)) return { leaf: '[Circular]' };
    if (Array.isArray(v)) {
      active.add(v);
      return { frame: { kind: 'array', src: v, out: new Array<unknown>(v.length), i: 0, release: [v] } };
    }
    if (isPlainRecord(v)) {
      active.add(v);
      return { frame: { kind: 'record', src: v, out: {}, keys: Object.keys(v), i: 0, release: [v] } };
    }
    // Non-plain object. Untouched (by reference) unless its JSON shape — the
    // thing JSON.stringify will actually emit for it — smuggles an image; only
    // then is a plain sanitized copy rebuilt from that shape, toJSON applied
    // first when the object defines one.
    if (!subtreeHasImage(v)) return { leaf: v };
    const view = jsonView(v);
    // The view can BE the image shape — a toJSON() returning a sentinel or
    // image block directly. Scrub it here: falling through would build a
    // record frame from the view and copy its base64 `data` field, key by key,
    // straight into the rebuilt result.
    if (isMcpImageResult(view)) return { leaf: omittedNote(view.note ?? `an image (${view.mimeType})`) };
    if (isMcpImageBlockObject(view)) return { leaf: omittedNote(`an image (${view.mimeType})`) };
    if (view === null || typeof view !== 'object') {
      // Unreachable in practice (a primitive view cannot hold the image that
      // subtreeHasImage found), kept total for safety.
      return { leaf: view };
    }
    active.add(v);
    if (Array.isArray(view)) {
      const release = view === (v as unknown) ? [v] : [v, view];
      if (view !== (v as unknown)) active.add(view);
      return { frame: { kind: 'array', src: view, out: new Array<unknown>(view.length), i: 0, release } };
    }
    const release = view === v ? [v] : [v, view];
    if (view !== v) active.add(view);
    return {
      frame: {
        kind: 'record',
        src: view as Record<string, unknown>,
        out: {},
        keys: Object.keys(view),
        i: 0,
        release,
      },
    };
  };

  const seed = resolve(value);
  if ('leaf' in seed) return seed.leaf;
  const stack: Frame[] = [seed.frame];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.kind === 'array') {
      if (top.i >= top.src.length) {
        for (const held of top.release) active.delete(held);
        stack.pop();
        continue;
      }
      const idx = top.i++;
      const r = resolve(top.src[idx]);
      if ('leaf' in r) {
        top.out[idx] = r.leaf;
      } else {
        // The child's `out` fills in place as its frame drains.
        top.out[idx] = r.frame.out;
        stack.push(r.frame);
      }
    } else {
      if (top.i >= top.keys.length) {
        for (const held of top.release) active.delete(held);
        stack.pop();
        continue;
      }
      const key = top.keys[top.i++];
      const r = resolve(top.src[key]);
      if ('leaf' in r) {
        defineKey(top.out, key, r.leaf);
      } else {
        defineKey(top.out, key, r.frame.out);
        stack.push(r.frame);
      }
    }
  }
  return seed.frame.out;
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
