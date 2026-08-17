import { describe, expect, it } from 'vitest';
import { describeToolFailure, toCallToolResult, renderProgress } from '../results.js';

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
