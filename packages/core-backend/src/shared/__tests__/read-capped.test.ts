import { describe, expect, it } from 'vitest';
import { readCapped } from '../read-capped.js';

describe('readCapped', () => {
  /**
   * Counting a chunk against the budget after decoding it lets a provider that
   * answers in one huge chunk put the whole thing through the decoder — the
   * bound bypassed by exactly the party it exists to bound. Asserted on the
   * reader directly because a caller's short snippet is identical either way.
   */
  it('holds one oversized chunk to the byte budget, not just the loop', async () => {
    const oneHugeChunk = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(5_000_000)));
        controller.close();
      },
    });

    const out = await readCapped(new Response(oneHugeChunk), 8 * 1024);

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

    const out = await readCapped(new Response(endless), 2048);

    expect(out).toBe('z'.repeat(2048));
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it('reads a stream-less response whole, cut to the budget', async () => {
    const res = new Response('abcdef');
    // Consume the stream so only `text()` is left, as a mocked response may be.
    Object.defineProperty(res, 'body', { value: null });
    expect(await readCapped(res, 4)).toBe('abcd');
  });
});
