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
  if (typeof value !== 'object' || value === null) return false;
  // The field reads are defensive: this guard runs on every candidate value
  // (toCallToolResult, the scrub's probe), and a candidate can carry a
  // THROWING getter on any of these names. Answering "not a sentinel" is the
  // safe verdict — the value then rides the ordinary serialization fallback
  // instead of turning a completed call into a handler failure.
  try {
    return (
      (value as { kind?: unknown }).kind === MCP_IMAGE_RESULT_KIND &&
      typeof (value as { data?: unknown }).data === 'string' &&
      typeof (value as { mimeType?: unknown }).mimeType === 'string' &&
      // A sentinel may have crossed a transport, so its shape is not this
      // process's to assume: a non-string `note` would be accepted here and then
      // emitted as a text block whose `text` is not a string — an invalid block.
      ['undefined', 'string'].includes(typeof (value as { note?: unknown }).note)
    );
  } catch {
    return false;
  }
}

/** A spec-shaped MCP image content block (`{type:'image', data, mimeType}`). */
function isMcpImageBlockObject(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  if (typeof value !== 'object' || value === null) return false;
  // Defensive like isMcpImageResult: a throwing getter means "not a block".
  try {
    return (
      (value as { type?: unknown }).type === 'image' &&
      typeof (value as { data?: unknown }).data === 'string' &&
      typeof (value as { mimeType?: unknown }).mimeType === 'string'
    );
  } catch {
    return false;
  }
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

/**
 * A note that survived a remote hop, whatever it decoded to.
 *
 * `@utcp/mcp` JSON-PARSES a text block's text, so a note that happens to read
 * as JSON comes back as what it denotes — `42` for "42", null for "null" —
 * not as a string. Insisting on strings meant such a result was not recognized
 * as the image it is, and the fallback stringified the whole thing, base64 and
 * all, into the transcript.
 */
function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
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
    value.every((e) => isMcpImageBlockObject(e) || isJsonScalar(e))
  ) {
    return {
      content: value.map((e) =>
        isMcpImageBlockObject(e) ? e : { type: 'text' as const, text: String(e) },
      ),
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
 * does not the original reference is preserved untouched (RegExp, Map, Date
 * and friends are never mangled).
 *
 * The one thing never preserved by reference is a USER `toJSON`. The scrubbed
 * result is stringified into the transcript AFTER this returns, so a hook left
 * live in it fires a second time there, unscrubbed: an impure one — clean when
 * probed, an image payload on the next call — would slip base64 straight past
 * the walk. Every object carrying one is therefore rebuilt from the single
 * view this scrub cached for it, and nothing reachable in the returned value
 * carries a hook the walk did not already resolve. Best-effort by design:
 * chain code that EXTRACTS the base64 string itself escapes the walk, and then
 * the ordinary max_output_size spill bounds the damage.
 *
 * `rootKey` is the JSON property name the SCRUBBED value will be serialized
 * under afterwards — '' (the default) when it is stringified standalone, the
 * envelope key (e.g. `call_tool_chain`'s 'result') when a caller embeds it —
 * so a key-sensitive root `toJSON` answers this scrub with the same view the
 * transcript serializer will ask it for.
 */
export function omitImagePayloads(value: unknown, rootKey = ''): unknown {
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

  // The `toJSON` a value carries, or undefined. Read defensively: this runs on
  // EVERY object the walks touch, and the property can be an accessor that
  // throws. Answering "no hook" there is safe — JSON.stringify reads `toJSON`
  // the same way and would throw too, so safeJsonText degrades and nothing
  // reaches the transcript unscrubbed.
  type JsonHook = (this: unknown, ...args: unknown[]) => unknown;
  const toJsonHook = (v: object): JsonHook | undefined => {
    try {
      const hook: unknown = (v as { toJSON?: unknown }).toJSON;
      return typeof hook === 'function' ? (hook as JsonHook) : undefined;
    } catch {
      return undefined;
    }
  };

  // The ONE hook trusted to fire again after the scrub, so an ordinary `Date`
  // keeps passing through by reference instead of collapsing to its ISO
  // string. `Date.prototype.toJSON` returns null or the result of invoking the
  // object's own `toISOString`, so when BOTH are the built-ins its result can
  // only ever be null or a string — there is no object for an image to hide
  // in, and no second call can differ in kind. (A non-Date receiver makes the
  // built-in throw, which is likewise harmless.) Every other `toJSON` is user
  // code and gets no such benefit of the doubt.
  const isBuiltinDateHook = (v: object, hook: JsonHook): boolean => {
    if (hook !== (Date.prototype.toJSON as unknown as JsonHook)) return false;
    try {
      return (v as { toISOString?: unknown }).toISOString === Date.prototype.toISOString;
    } catch {
      return false;
    }
  };

  /** Does this object define an enumerable own property backed by a GETTER? */
  const hasAccessor = (v: object): boolean => {
    for (const key of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (d !== undefined && d.get !== undefined) return true;
    }
    return false;
  };

  /**
   * The USER `toJSON` an object would be serialized through, or undefined.
   *
   * A user hook must never survive into the returned structure: the scrubbed
   * result is stringified into the transcript AFTERWARDS, and a hook left live
   * fires a SECOND time there — an impure one (clean when probed, an image
   * payload on the next call) would hand the transcript base64 the scrub never
   * saw. So every object carrying one is rebuilt from the single cached view
   * below, and the rebuilt copy is a plain array/record with no hook attached.
   */
  const userToJson = (v: object): JsonHook | undefined => {
    const hook = toJsonHook(v);
    return hook !== undefined && !isBuiltinDateHook(v, hook) ? hook : undefined;
  };

  // A value's JSON view: what JSON.stringify would serialize for it — the
  // toJSON() result when it defines one (a throwing toJSON falls back to the
  // value itself, matching safeJsonText's degraded path), the value otherwise.
  //
  // `key` is the JSON property name the value is being serialized UNDER, and
  // it is passed to the hook because JSON.stringify passes it: the spec calls
  // `toJSON(key)` — '' at the root, the property name inside an object, the
  // stringified index inside an array. Calling it with NO argument made a
  // key-dependent hook return one thing to this scrub and a different thing
  // to the transcript serializer that runs afterwards, which is precisely the
  // divergence the scrub exists to close.
  //
  // JSON.stringify UNBOXES a primitive wrapper object (`new String(…)` /
  // `new Number(…)` / `new Boolean(…)`) to its primitive before serializing.
  // A boxed VIEW must get the same treatment: rebuilding `new String('abc')`
  // from its enumerable keys would emit {"0":"a","1":"b","2":"c"} where JSON
  // emits "abc".
  const unboxed = (view: unknown): unknown => {
    if (view instanceof String) return String(view);
    if (view instanceof Number) return Number(view);
    if (view instanceof Boolean) return view.valueOf();
    return view;
  };

  // Cached per (object, key), not per object: the same object reachable under
  // two different keys genuinely HAS two views, and one cache slot would let
  // the second site emit the first site's answer. Within one (object, key)
  // the hook still fires at most once, so the rebuild emits exactly the view
  // it inspected even when the hook is impure.
  const viewCache = new WeakMap<object, Map<string, unknown>>();
  const jsonView = (v: object, key: string): unknown => {
    let byKey = viewCache.get(v);
    if (byKey === undefined) {
      byKey = new Map<string, unknown>();
      viewCache.set(v, byKey);
    }
    if (byKey.has(key)) return byKey.get(key);
    let view: unknown = v;
    const hook = userToJson(v);
    if (hook !== undefined) {
      try {
        view = Reflect.apply(hook, v, [key]);
      } catch {
        /* keep the value itself */
      }
    }
    byKey.set(key, view);
    return view;
  };

  // Must the subtree reachable from `root` be rebuilt rather than preserved by
  // reference? Two things force a rebuild, and the probe answers them in ONE
  // walk because the only caller needs both: an image sentinel / spec-shaped
  // image block anywhere in the shape, and any object carrying a user `toJSON`
  // (which must not stay live in the output — see `userToJson`). A hook is
  // reason enough on its own, so the probe never has to CALL one: it stops at
  // the bearer, and an object without a hook IS its own JSON view.
  //
  // Iterative and cycle-safe (a visited set suffices for a boolean probe).
  // Verdicts are memoized, but only the NEGATIVE one generalizes: a walk that
  // finishes clean proves every object it visited clean too, since each one's
  // reachable shape is a subset of what was just explored — so a nested object
  // is probed once, not re-walked by every enclosing probe. A hit stops the
  // walk early, which leaves the visited set half-explored and proves nothing
  // about those objects (the image or hook may sit outside an inner object's
  // own subtree), so only the root's verdict is recorded then.
  const probeCache = new WeakMap<object, boolean>();
  const subtreeNeedsRebuild = (root: object): boolean => {
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
      // An ACCESSOR is user code too, and it runs again every time the value is
      // read: a getter may answer the probe with something clean and hand the
      // serializer an image. Preserving such an object by reference would let
      // that second answer past the scrub, so its subtree is rebuilt from the
      // values read HERE, once.
      if (hasAccessor(v)) {
        found = true;
        break;
      }
      if (userToJson(v) !== undefined) {
        found = true;
        break;
      }
      if (Array.isArray(v)) {
        for (const entry of v) stack.push(entry);
        continue;
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

  /**
   * The own enumerable keys to rebuild a record from — every key
   * `JSON.stringify` would visit EXCEPT a function-valued `toJSON`.
   *
   * A rebuilt record is a plain object, and `JSON.stringify` consults exactly
   * one method on a plain object: `toJSON`. Copying that key across therefore
   * re-arms the hook on the sanitized value, and the transcript serializer
   * that runs after this scrub calls it — an impure hook (clean when the
   * scrub probed it, an image payload on the next call) hands the transcript
   * base64 the walk never saw. It is reachable through a VIEW: a `toJSON()`
   * that returns `{ data: …, toJSON() { …image… } }` is rebuilt from that
   * view's keys, and `toJSON` is one of them.
   *
   * No other function-valued own key can do this. `toISOString` matters only
   * because `Date.prototype.toJSON` calls it, and a rebuilt plain object has
   * `Object.prototype` — no inherited `toJSON` to reach it — so the copied
   * function is simply an own property `JSON.stringify` SKIPS, as it skips
   * every function value. Same for `valueOf`, `toString` and friends:
   * stringify consults none of them on an object.
   */
  const rebuildKeys = (src: object): string[] =>
    Object.keys(src).filter((k) => {
      if (k !== 'toJSON') return true;
      try {
        return typeof (src as Record<string, unknown>)[k] !== 'function';
      } catch {
        return false; // a throwing accessor named toJSON: never copy it
      }
    });

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

  /**
   * Resolve one value: a leaf to emit as-is, or a container frame to walk.
   * `key` is the JSON property name `v` is serialized under — '' at the root,
   * the property name in a record, the stringified index in an array — and is
   * threaded through only so a `toJSON` hook receives the argument
   * `JSON.stringify` would give it (see `jsonView`).
   */
  const resolve = (v: unknown, key: string): { leaf: unknown } | { frame: Frame } => {
    if (v === null || typeof v !== 'object') return { leaf: v };
    if (isMcpImageResult(v)) return { leaf: omittedNote(v.note ?? `an image (${v.mimeType})`) };
    if (isMcpImageBlockObject(v)) return { leaf: omittedNote(`an image (${v.mimeType})`) };
    if (active.has(v)) return { leaf: '[Circular]' };
    // A user `toJSON` is handled FIRST — before the array/plain-record split,
    // exactly as JSON.stringify applies it before looking at the value's
    // shape. Such an object is ALWAYS rebuilt from its one cached view, never
    // preserved by reference and never rebuilt from its own keys: leaving the
    // hook live (or copying it across as a `toJSON` property of a rebuilt
    // record) would let it fire again during transcript serialization and
    // return a payload this scrub never inspected.
    const hook = userToJson(v);
    if (hook !== undefined) {
      // Unboxing first mirrors stringify's own order: a hook returning a boxed
      // primitive serializes as that primitive, never as a record of index keys.
      const view = unboxed(jsonView(v, key));
      // The view can BE the image shape — a toJSON() returning a sentinel or
      // image block directly. Scrub it here: falling through would build a
      // record frame from the view and copy its base64 `data` field, key by
      // key, straight into the rebuilt result.
      if (isMcpImageResult(view)) return { leaf: omittedNote(view.note ?? `an image (${view.mimeType})`) };
      if (isMcpImageBlockObject(view)) return { leaf: omittedNote(`an image (${view.mimeType})`) };
      if (view === null || typeof view !== 'object') return { leaf: view };
      if (active.has(view)) return { leaf: '[Circular]' };
      active.add(v);
      const release: object[] = view === (v as unknown) ? [v] : [v, view];
      if (view !== (v as unknown)) active.add(view);
      if (Array.isArray(view)) {
        return { frame: { kind: 'array', src: view, out: new Array<unknown>(view.length), i: 0, release } };
      }
      return {
        frame: {
          kind: 'record',
          src: view as Record<string, unknown>,
          out: {},
          keys: rebuildKeys(view),
          i: 0,
          release,
        },
      };
    }
    if (Array.isArray(v)) {
      active.add(v);
      return { frame: { kind: 'array', src: v, out: new Array<unknown>(v.length), i: 0, release: [v] } };
    }
    if (isPlainRecord(v)) {
      active.add(v);
      return { frame: { kind: 'record', src: v, out: {}, keys: rebuildKeys(v), i: 0, release: [v] } };
    }
    // Non-plain object with no hook of its own: it IS its own JSON view, so it
    // passes through untouched (by reference) unless the shape below it needs
    // rebuilding — an image to scrub, or a nested object whose user `toJSON`
    // must not stay live in the result. Only then is a plain sanitized copy
    // built from its enumerable own properties, exactly what JSON.stringify
    // would have emitted.
    if (!subtreeNeedsRebuild(v)) return { leaf: v };
    active.add(v);
    return {
      frame: {
        kind: 'record',
        src: v as Record<string, unknown>,
        out: {},
        keys: rebuildKeys(v),
        i: 0,
        release: [v],
      },
    };
  };

  // '' is the root key JSON.stringify uses for a standalone value (it
  // serializes through a synthetic wrapper `{ '': value }`); a caller that
  // embeds the scrubbed value under an envelope key passes that key instead
  // (see `rootKey` above).
  const seed = resolve(value, rootKey);
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
      // An array element's JSON key is its stringified index — what
      // JSON.stringify hands the element's own `toJSON`.
      const r = resolve(top.src[idx], String(idx));
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
      const r = resolve(top.src[key], key);
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
