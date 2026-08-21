import { describe, expect, it } from 'vitest';
import {
  describeToolFailure,
  toCallToolResult,
  renderProgress,
  mcpImageResult,
  omitImagePayloads,
  MCP_IMAGE_RESULT_KIND,
} from '../results.js';

describe('describeToolFailure', () => {
  it('pulls the REST error body out of an axios-shaped failure', () => {
    expect(describeToolFailure({ response: { data: { error: 'no such branch' } } })).toBe('no such branch');
  });

  it('never throws on a thrown value whose own toString throws', () => {
    // A null-prototype object has no toString; String() on it throws — and a
    // describe that throws inside a catch path turns a tool failure into a
    // handler failure.
    expect(describeToolFailure(Object.create(null))).toBe('(indescribable tool failure)');
  });
});

describe('toCallToolResult', () => {
  it('passes an MCP-shaped result through untouched', () => {
    const value = { content: [{ type: 'text', text: 'hi' }] };
    expect(toCallToolResult(value)).toBe(value);
  });

  it('stringifies a plain object into one text block', () => {
    expect(toCallToolResult({ a: 1 })).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
    });
  });

  it('never throws on a BigInt result — a completed call must stay a result', () => {
    const result = toCallToolResult({ count: 10n });
    expect(result.content).toEqual([{ type: 'text', text: '{"count":"10"}' }]);
  });

  it('never throws on a circular result', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    const result = toCallToolResult(value);
    expect(result.content).toEqual([{ type: 'text', text: '{"a":1,"self":"[Circular]"}' }]);
  });

  it('keeps shared (non-circular) references intact rather than mislabeling them', () => {
    const shared = { x: 1 };
    const result = toCallToolResult({ a: shared, b: shared });
    expect(result.content).toEqual([{ type: 'text', text: '{"a":{"x":1},"b":{"x":1}}' }]);
  });

  it('keeps shared references intact on the degraded path too — a BigInt elsewhere must not turn siblings circular', () => {
    // The BigInt forces the replacer pass, where only an ACTIVE-descent check
    // tells a diamond share (visited once per parent) from a real cycle.
    const shared = { x: 1 };
    const result = toCallToolResult({ a: shared, b: shared, n: 10n });
    expect(result.content).toEqual([{ type: 'text', text: '{"a":{"x":1},"b":{"x":1},"n":"10"}' }]);
  });

  it('still labels a real cycle on the degraded path', () => {
    const value: Record<string, unknown> = { n: 10n };
    value.self = value;
    const result = toCallToolResult(value);
    expect(result.content).toEqual([{ type: 'text', text: '{"n":"10","self":"[Circular]"}' }]);
  });

  it('survives a toJSON that throws', () => {
    const value = {
      toJSON() {
        throw new Error('boom');
      },
    };
    const result = toCallToolResult(value);
    expect((result.content[0] as { text: string }).text).toBeTruthy();
  });
});

describe('renderProgress', () => {
  it('never throws on a chunk JSON.stringify maps to undefined', () => {
    expect(renderProgress(undefined)).toBe('undefined');
    expect(renderProgress(() => 1)).toBe(String(() => 1));
  });

  it('never throws on a BigInt chunk', () => {
    expect(renderProgress(10n)).toBe('"10"');
  });

  it('never throws on a circular chunk', () => {
    const chunk: Record<string, unknown> = {};
    chunk.self = chunk;
    expect(renderProgress(chunk)).toBe('{"self":"[Circular]"}');
  });

  it('still truncates long chunks to 500 chars', () => {
    const s = renderProgress('x'.repeat(600));
    expect(s).toHaveLength(500);
    expect(s.endsWith('...')).toBe(true);
  });
});

describe('toCallToolResult — image results', () => {
  const B64 = 'aGVsbG8='; // any base64 payload

  it('shapes an image sentinel into spec content: image block + text note', () => {
    const value = mcpImageResult(B64, 'image/png', '[image: Files/logo.png — image/png, 5 bytes, 1×1 px]');
    expect(toCallToolResult(value)).toEqual({
      content: [
        { type: 'image', data: B64, mimeType: 'image/png' },
        { type: 'text', text: '[image: Files/logo.png — image/png, 5 bytes, 1×1 px]' },
      ],
    });
  });

  it('shapes a noteless sentinel into a lone image block', () => {
    expect(toCallToolResult(mcpImageResult(B64, 'image/gif'))).toEqual({
      content: [{ type: 'image', data: B64, mimeType: 'image/gif' }],
    });
  });

  it('reassembles the remote-hop mangled form ([imageBlock, "note"]) instead of stringifying base64', () => {
    // Exactly what @utcp/mcp's _processMcpToolResult hands the local server for
    // the hosted proxy's [image, text] result: the image block verbatim, the
    // prose note JSON-parse-failed back to a bare string.
    const mangled = [{ type: 'image', data: B64, mimeType: 'image/jpeg' }, '[image: a.jpg — image/jpeg, 5 bytes]'];
    expect(toCallToolResult(mangled)).toEqual({
      content: [
        { type: 'image', data: B64, mimeType: 'image/jpeg' },
        { type: 'text', text: '[image: a.jpg — image/jpeg, 5 bytes]' },
      ],
    });
  });

  it('reassembles a bare image block (single-entry remote collapse) into spec content', () => {
    const block = { type: 'image', data: B64, mimeType: 'image/webp' };
    expect(toCallToolResult(block)).toEqual({ content: [block] });
  });

  it('leaves ordinary data untouched: a kind field that is not the sentinel constant stringifies as before', () => {
    const value = { kind: 'image', data: B64, mimeType: 'image/png' };
    expect(toCallToolResult(value)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(value) }],
    });
  });

  it('leaves an array with any non-image, non-string entry on the stringify path', () => {
    const value = [{ type: 'image', data: B64, mimeType: 'image/png' }, { other: true }];
    expect(toCallToolResult(value)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(value) }],
    });
  });
});

describe('omitImagePayloads', () => {
  const sentinel = mcpImageResult('QUJD', 'image/png', '[image: Files/logo.png — image/png, 3 bytes]');

  it('replaces a top-level sentinel with an omitted-image note that keeps the file description', () => {
    const out = omitImagePayloads(sentinel) as { image_omitted: boolean; note: string };
    expect(out.image_omitted).toBe(true);
    expect(out.note).toContain('Files/logo.png');
    expect(out.note).toContain('read_file');
    expect(JSON.stringify(out)).not.toContain('QUJD');
  });

  it('replaces sentinels nested inside the structure a chain built', () => {
    const value = { files: [{ name: 'a', res: sentinel }], count: 1 };
    const out = JSON.stringify(omitImagePayloads(value));
    expect(out).not.toContain('QUJD');
    expect(out).not.toContain(MCP_IMAGE_RESULT_KIND);
    expect(out).toContain('"count":1');
    expect(out).toContain('image_omitted');
  });

  it('replaces a spec-shaped image block too (what the remote MCP hop hands a local chain)', () => {
    const value = [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }, 'note'];
    const out = JSON.stringify(omitImagePayloads(value));
    expect(out).not.toContain('QUJD');
    expect(out).toContain('image_omitted');
    expect(out).toContain('"note"');
  });

  it('leaves ordinary values untouched and survives cycles', () => {
    const value: Record<string, unknown> = { a: 1, list: ['x', 2, null] };
    value.self = value;
    const out = omitImagePayloads(value) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.list).toEqual(['x', 2, null]);
    expect(out.self).toBe('[Circular]');
  });

  it('omits an image buried 100 levels deep — no depth cutoff lets base64 escape into the transcript', () => {
    let value: unknown = { res: sentinel };
    for (let i = 0; i < 100; i++) value = { wrap: [value] };
    const out = JSON.stringify(omitImagePayloads(value));
    expect(out).not.toContain('QUJD');
    expect(out).toContain('image_omitted');
  });

  it('rebuilds special keys as own data properties — no prototype pollution, no dropped keys', () => {
    // JSON.parse creates an OWN `__proto__` data property (never a setter call).
    const value = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "kept"}') as Record<string, unknown>;
    (value as { img?: unknown }).img = sentinel;
    const out = omitImagePayloads(value) as Record<string, unknown>;
    // The key survives as data…
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: true });
    expect(out.constructor).toBe('kept');
    expect(JSON.stringify(out)).toContain('"__proto__"');
    // …and nothing leaked onto Object.prototype or the rebuilt object's chain.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('preserves non-plain objects by reference instead of mangling them into records', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const buf = new Map([['k', 'v']]);
    class Thing {
      label = 'thing';
    }
    const thing = new Thing();
    const out = omitImagePayloads({ when, buf, thing, res: sentinel }) as Record<string, unknown>;
    expect(out.when).toBe(when);
    expect(out.buf).toBe(buf);
    expect(out.thing).toBe(thing);
    expect((out.res as { image_omitted?: boolean }).image_omitted).toBe(true);
  });

  it('scrubs a sentinel hidden inside a CLASS INSTANCE — JSON.stringify would emit its base64 otherwise', () => {
    class Holder {
      label = 'holder';
      payload: unknown = sentinel;
    }
    const holder = new Holder();
    const out = omitImagePayloads({ holder }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(text).toContain('"label":"holder"');
    // The original instance is never mutated — the scrub rebuilt a copy.
    expect((holder.payload as { data: string }).data).toBe('QUJD');
    expect(out.holder).not.toBe(holder);
  });

  it('scrubs a sentinel delivered through toJSON — the serialized shape is what reaches the transcript', () => {
    const value = {
      wrapper: new (class {
        toJSON(): unknown {
          return { meta: 'from-toJSON', img: sentinel };
        }
      })(),
    };
    const text = JSON.stringify(omitImagePayloads(value));
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(text).toContain('"meta":"from-toJSON"');
  });

  it('scrubs a toJSON that returns the sentinel ITSELF — the view must never be copied into a record frame', () => {
    const value = {
      wrapper: new (class {
        toJSON(): unknown {
          return sentinel;
        }
      })(),
    };
    const out = omitImagePayloads(value) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('QUJD');
    expect(text).not.toContain(MCP_IMAGE_RESULT_KIND);
    expect((out.wrapper as { image_omitted?: boolean }).image_omitted).toBe(true);
    expect((out.wrapper as { note?: string }).note).toContain('Files/logo.png');
  });

  it('scrubs a toJSON that returns a spec-shaped image block directly', () => {
    const value = {
      wrapper: new (class {
        toJSON(): unknown {
          return { type: 'image', data: 'QUJD', mimeType: 'image/png' };
        }
      })(),
    };
    const text = JSON.stringify(omitImagePayloads(value));
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
  });

  it('fires a user toJSON exactly ONCE per object per scrub — the probe and the rebuild share one view', () => {
    let dirtyCalls = 0;
    const dirty = new (class {
      toJSON(): unknown {
        dirtyCalls++;
        return { img: sentinel };
      }
    })();
    let cleanCalls = 0;
    const clean = new (class {
      toJSON(): unknown {
        cleanCalls++;
        return { plain: true };
      }
    })();
    const out = omitImagePayloads({ dirty, clean });
    expect(dirtyCalls).toBe(1);
    expect(cleanCalls).toBe(1);
    const text = JSON.stringify(out);
    // …and STILL once after serialization: both were rebuilt from the view
    // this scrub cached, so neither hook is left live in the result.
    expect(dirtyCalls).toBe(1);
    expect(cleanCalls).toBe(1);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(text).toContain('"plain":true');
  });

  it('a clean non-plain object nested under a dirty one is still probed and evaluated once', () => {
    let innerCalls = 0;
    const inner = new (class {
      toJSON(): unknown {
        innerCalls++;
        return { fine: 'kept' };
      }
    })();
    const outer = new (class {
      constructor(public img: unknown = sentinel, public child: unknown = inner) {}
    })();
    const out = omitImagePayloads({ outer });
    expect(innerCalls).toBe(1);
    const text = JSON.stringify(out);
    expect(innerCalls).toBe(1); // rebuilt from that one view, not re-hooked here
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(text).toContain('"fine":"kept"');
  });

  it('a Map-like with enumerable own props holding an image is rebuilt as its sanitized JSON shape', () => {
    const mapish = new Map<string, unknown>();
    (mapish as unknown as Record<string, unknown>).stashed = { deep: [sentinel] };
    const out = omitImagePayloads({ mapish }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(out.mapish).not.toBe(mapish);
  });

  it('Date and RegExp pass through UNTOUCHED even next to an image', () => {
    const when = new Date('2026-02-02T00:00:00Z');
    const pattern = /ab+c/gi;
    const out = omitImagePayloads({ when, pattern, res: sentinel }) as Record<string, unknown>;
    expect(out.when).toBe(when);
    expect(out.pattern).toBe(pattern);
    expect(JSON.stringify(out)).not.toContain('QUJD');
  });

  it('rebuilds an image-free object that has a toJSON — the hook must not stay live in the result', () => {
    let calls = 0;
    const obj = new (class {
      toJSON(): unknown {
        calls++;
        return { plain: true };
      }
    })();
    const out = omitImagePayloads({ obj }) as Record<string, unknown>;
    // Rebuilt from the cached view, NOT preserved by reference: the reference
    // would carry the hook into the transcript's own stringify pass.
    expect(out.obj).not.toBe(obj);
    expect(out.obj).toEqual({ plain: true });
    expect(calls).toBe(1);
    JSON.stringify(out);
    expect(calls).toBe(1); // serializing the scrubbed result fires nothing
  });

  it('an IMPURE toJSON cannot smuggle base64 past the scrub on its second call', () => {
    // Clean when the scrub looks, an image the next time — exactly what a
    // preserved-by-reference hook would hand JSON.stringify downstream.
    let calls = 0;
    const sneaky = new (class {
      toJSON(): unknown {
        calls++;
        return calls === 1 ? { plain: true } : sentinel;
      }
    })();
    const out = omitImagePayloads({ sneaky });
    expect(calls).toBe(1);
    const text = JSON.stringify(out);
    expect(calls).toBe(1); // the hook is gone from the result — nothing re-fired
    expect(text).not.toContain('QUJD');
    expect(text).not.toContain(MCP_IMAGE_RESULT_KIND);
    expect(text).toContain('"plain":true');
  });

  it('an impure toJSON on a PLAIN record is rebuilt too — stringify applies toJSON before the shape', () => {
    // A record literal is `isPlainRecord`, but JSON.stringify still calls its
    // own `toJSON` first; rebuilding it key-by-key used to copy the function
    // across, hook and all.
    let calls = 0;
    const value = {
      label: 'plain',
      toJSON(): unknown {
        calls++;
        return calls === 1 ? { label: 'plain' } : sentinel;
      },
    };
    const text = JSON.stringify(omitImagePayloads({ value }));
    expect(calls).toBe(1);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('"label":"plain"');
  });

  it('a clean object with no toJSON anywhere below it still passes through BY REFERENCE', () => {
    class Leaf {
      note = 'leaf';
    }
    class Holder {
      label = 'holder';
      child = new Leaf();
      list = [1, 2, 3];
    }
    const holder = new Holder();
    const out = omitImagePayloads({ holder, res: sentinel }) as Record<string, unknown>;
    expect(out.holder).toBe(holder); // no copy: nothing below it needs scrubbing
    expect(JSON.stringify(out)).not.toContain('QUJD');
  });

  it('a clean object that merely CONTAINS a toJSON-bearing child is rebuilt around it', () => {
    let calls = 0;
    const child = new (class {
      toJSON(): unknown {
        calls++;
        return calls === 1 ? { deep: 'clean' } : sentinel;
      }
    })();
    class Holder {
      label = 'holder';
      child: unknown = child;
    }
    const holder = new Holder();
    const out = omitImagePayloads({ holder }) as Record<string, unknown>;
    expect(out.holder).not.toBe(holder); // rebuilt so the child's hook can be resolved
    const text = JSON.stringify(out);
    expect(calls).toBe(1);
    expect(text).toContain('"label":"holder"');
    expect(text).toContain('"deep":"clean"');
    expect(text).not.toContain('QUJD');
  });

  it('a Date keeps passing by reference — its built-in toJSON can only yield null or a string', () => {
    const when = new Date('2026-03-03T00:00:00Z');
    const out = omitImagePayloads({ when }) as Record<string, unknown>;
    expect(out.when).toBe(when);
    expect(JSON.stringify(out)).toBe('{"when":"2026-03-03T00:00:00.000Z"}');
    // …and the trust is pinned to the BUILT-IN pair, not to being a Date: an
    // own `toJSON` is user code, and so is an own `toISOString`, which the
    // built-in `toJSON` would go on to call.
    const hookSpoof = Object.assign(new Date('2026-03-03T00:00:00Z'), {
      toJSON: () => sentinel as unknown as string,
    });
    expect(JSON.stringify(omitImagePayloads({ hookSpoof }))).not.toContain('QUJD');
    const isoSpoof = Object.assign(new Date('2026-03-03T00:00:00Z'), {
      toISOString: () => sentinel as unknown as string,
    });
    expect(JSON.stringify(omitImagePayloads({ isoSpoof }))).not.toContain('QUJD');
  });

  it('survives a cycle reachable only through a class instance holding an image', () => {
    class Node {
      img: unknown = sentinel;
      self: unknown;
    }
    const node = new Node();
    node.self = node;
    const text = JSON.stringify(omitImagePayloads({ node }));
    expect(text).not.toContain('QUJD');
    expect(text).toContain('image_omitted');
    expect(text).toContain('[Circular]');
  });

  it('calls toJSON with the JSON KEY, exactly as JSON.stringify does', () => {
    // The spec calls `toJSON(key)`. Calling it with NO argument let a
    // key-dependent hook answer the scrub one way and the transcript
    // serializer that runs afterwards another — precisely the divergence the
    // scrub exists to close. Here the hook is clean under its real key and
    // dirty under any other, so a missing argument surfaces as an omitted
    // image where the deck has none.
    const keyed = new (class {
      toJSON(key?: unknown): unknown {
        return key === 'safe' ? { seen: key } : { img: sentinel };
      }
    })();
    expect(JSON.stringify(omitImagePayloads({ safe: keyed }))).toBe('{"safe":{"seen":"safe"}}');
  });

  it('threads the root, array-index and property keys the way stringify numbers them', () => {
    const seen: unknown[] = [];
    const probe = new (class {
      toJSON(key?: unknown): unknown {
        seen.push(key);
        return { at: key };
      }
    })();
    omitImagePayloads(probe); // the root serializes under ''
    omitImagePayloads(['zero', probe]); // an element under its stringified index
    omitImagePayloads({ a: { b: probe } }); // a property under its own name
    expect(seen).toEqual(['', '1', 'b']);
  });

  it('gives the SAME object two views when it is reachable under two different keys', () => {
    // The view cache is keyed by (object, key), not by object: one slot would
    // have emitted the first site's answer at the second site.
    const keyed = new (class {
      toJSON(key?: unknown): unknown {
        return { under: key };
      }
    })();
    const value = { first: keyed, second: keyed };
    expect(JSON.stringify(omitImagePayloads(value))).toBe(
      '{"first":{"under":"first"},"second":{"under":"second"}}',
    );
  });

  it('never copies a function-valued toJSON out of a VIEW into the rebuilt record', () => {
    // A hook's return value is rebuilt key by key. When one of those keys is
    // an enumerable, function-valued `toJSON`, it landed on the sanitized
    // record — and `toJSON` is the one method JSON.stringify consults on a
    // plain object, so the hook fired AGAIN at transcript time and an impure
    // one reintroduced the payload this walk had just removed.
    let inner = 0;
    const value = new (class {
      toJSON(): unknown {
        return {
          data: 'kept',
          toJSON(): unknown {
            inner++;
            return { img: sentinel };
          },
        };
      }
    })();
    const text = JSON.stringify(omitImagePayloads({ value }));
    expect(inner).toBe(0); // it never fired: not during the scrub, not after
    expect(text).toBe('{"value":{"data":"kept"}}');
    expect(text).not.toContain('QUJD');
  });

  it('but a `toJSON` that is DATA rather than a function is ordinary content and survives', () => {
    // Only a CALLABLE toJSON can re-fire; JSON.stringify ignores a
    // non-callable one, so dropping it would lose a caller's field. And no
    // other function-valued key can affect serialization: a rebuilt record
    // has Object.prototype, so there is no inherited `toJSON` left to reach
    // an own `toISOString` (the way Date.prototype.toJSON would), and
    // stringify simply skips function values.
    const out = omitImagePayloads({ v: { toJSON: 'a string', toISOString: () => 'x', n: 1 } });
    expect(JSON.stringify(out)).toBe('{"v":{"toJSON":"a string","n":1}}');
  });
});
