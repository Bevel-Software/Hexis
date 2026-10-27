import { describe, expect, it } from 'vitest';
import { readCapped, readCappedBytes } from '../read-capped.js';

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

describe('readCapped', () => {
  /**
   * Counting a chunk against the budget after decoding it lets a provider that
   * answers in one huge chunk put the whole thing through the decoder — the
   * bound bypassed by exactly the party it exists to bound. Asserted on the
   * reader directly because a caller's short snippet is identical either way.
   */
  it('holds one oversized chunk to the byte budget, not just the loop', async () => {
    const out = await readCapped(new Response(streamOf('x'.repeat(5_000_000))), 8 * 1024);
    expect(out.length).toBe(8 * 1024);
  });

  it('stops pulling at the budget and cancels a stream that never ends', async () => {
    // Without the cap this never returns: the stream has no end.
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('z'.repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });

    const out = await readCappedBytes(new Response(endless), 2048);

    expect(out).toEqual({ text: 'z'.repeat(2048), truncated: true });
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it('tells a body that fills the limit from one cut at it, on raw bytes', async () => {
    expect(await readCappedBytes(new Response(streamOf('a'.repeat(8))), 8)).toEqual({ text: 'a'.repeat(8), truncated: false });
    expect(await readCappedBytes(new Response(streamOf('a'.repeat(8), 'b')), 8)).toEqual({ text: 'a'.repeat(8), truncated: true });
    // A two-byte character straddling the limit: the decoded text is one byte
    // short of the limit, yet the body went past it — `truncated` says so.
    const straddle = await readCappedBytes(new Response(streamOf(`${'a'.repeat(7)}éX`)), 8);
    expect(straddle.truncated).toBe(true);
    expect(straddle.text.startsWith('a'.repeat(7))).toBe(true);
    expect(straddle.text).not.toContain('X');
  });

  it('reads a stream-less response whole, cut to the budget', async () => {
    const res = new Response('abcdef');
    // Consume the stream so only `text()` is left, as a mocked response may be.
    Object.defineProperty(res, 'body', { value: null });
    expect(await readCappedBytes(res, 4)).toEqual({ text: 'abcd', truncated: true });
  });
});
