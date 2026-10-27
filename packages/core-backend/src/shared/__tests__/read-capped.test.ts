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

    expect(out).toEqual({ text: 'z'.repeat(2048), ended: false });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('returns at once on a body of exactly the budget whose stream stays open', async () => {
    // Asking for one more byte here would wait on a chunk that never comes.
    let pulls = 0;
    const openAfterFill = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('a'.repeat(8)));
        // A second pull would hang forever: never resolve it.
        return pulls === 1 ? undefined : new Promise<void>(() => {});
      },
    });
    const out = await readCappedBytes(new Response(openAfterFill), 8);
    expect(out).toEqual({ text: 'a'.repeat(8), ended: false });
    expect(pulls).toBe(1);
  });

  it('says a body ended only when the stream reported its end within the budget', async () => {
    expect(await readCappedBytes(new Response(streamOf('a'.repeat(7))), 8)).toEqual({ text: 'a'.repeat(7), ended: true });
    // An exact fill is not told from a longer body: no byte past the budget is read.
    expect(await readCappedBytes(new Response(streamOf('a'.repeat(8))), 8)).toEqual({ text: 'a'.repeat(8), ended: false });
    expect(await readCappedBytes(new Response(streamOf('a'.repeat(8), 'b')), 8)).toEqual({ text: 'a'.repeat(8), ended: false });
    // A two-byte character straddling the limit: the decoded text is one byte
    // short of the limit, yet the body did not end — `ended` says so.
    const straddle = await readCappedBytes(new Response(streamOf(`${'a'.repeat(7)}éX`)), 8);
    expect(straddle.ended).toBe(false);
    expect(straddle.text.startsWith('a'.repeat(7))).toBe(true);
    expect(straddle.text).not.toContain('X');
  });

  it('reads a stream-less response whole, cut to the budget', async () => {
    const res = new Response('abcdef');
    // Consume the stream so only `text()` is left, as a mocked response may be.
    Object.defineProperty(res, 'body', { value: null });
    expect(await readCappedBytes(res, 4)).toEqual({ text: 'abcd', ended: false });
    const short = new Response('ab');
    Object.defineProperty(short, 'body', { value: null });
    expect(await readCappedBytes(short, 4)).toEqual({ text: 'ab', ended: true });
  });
});
