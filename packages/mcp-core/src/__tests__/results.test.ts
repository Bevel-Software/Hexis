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
});
