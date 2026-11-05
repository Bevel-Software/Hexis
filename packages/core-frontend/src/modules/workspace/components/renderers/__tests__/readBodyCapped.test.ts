import { describe, it, expect, vi } from 'vitest';
import { readBodyCapped } from '../readBodyCapped';

/**
 * The shared cap the binary viewers read through. Two things have to hold at
 * once: an oversized response never lands in the tab (and its transfer ends),
 * and an ACCEPTED one comes back byte-for-byte — the single-copy path fills a
 * preallocated buffer as the chunks arrive, so an off-by-one there would hand
 * a parser a corrupt file rather than fail loudly.
 */

const CAP = 1024;

/** A response double: `headers.get` + a one-shot stream over `chunks`. */
function streamed(chunks: Uint8Array[], contentLength?: number | string) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  const res = {
    headers: {
      get: (name: string) =>
        name === 'content-length' && contentLength !== undefined ? String(contentLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel,
      }),
    },
    arrayBuffer: async () => {
      throw new Error('must not buffer a streamable body');
    },
  } as unknown as Response;
  return { res, cancel, readSoFar: () => i };
}

function bytes(n: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, k) => (k + seed) % 251);
}

describe('readBodyCapped', () => {
  it('returns exactly the declared bytes, copied once into the preallocated buffer', async () => {
    const whole = bytes(600, 7);
    const chunks = [whole.subarray(0, 100), whole.subarray(100, 517), whole.subarray(517)];
    const { res } = streamed(chunks, 600);

    const out = await readBodyCapped(res, CAP, new AbortController());

    expect(out).not.toBeNull();
    expect(new Uint8Array(out!)).toEqual(whole);
  });

  it('refuses an over-cap Content-Length without reading the body, and aborts the request', async () => {
    const { res, readSoFar } = streamed([bytes(10)], CAP + 1);
    const abort = new AbortController();

    expect(await readBodyCapped(res, CAP, abort)).toBeNull();
    expect(abort.signal.aborted).toBe(true);
    expect(readSoFar()).toBe(0);
  });

  it('takes the oversized path even when cancelling the body would reject', async () => {
    // `body.cancel()` rejects on a stream that has already errored; the guard
    // aborts the controller instead, which cannot reject, so the caller still
    // sees `null` rather than a thrown error on its generic failure path.
    const res = {
      headers: { get: () => String(CAP + 1) },
      body: {
        cancel: () => Promise.reject(new Error('stream already errored')),
        getReader: () => {
          throw new Error('must not read an over-declared body');
        },
      },
    } as unknown as Response;

    await expect(readBodyCapped(res, CAP, new AbortController())).resolves.toBeNull();
  });

  it('abandons an UNDECLARED body the moment it crosses the cap', async () => {
    const chunks = [bytes(400), bytes(400), bytes(400)];
    const { res, cancel, readSoFar } = streamed(chunks);

    expect(await readBodyCapped(res, CAP, new AbortController())).toBeNull();
    // Stopped on the third chunk (1,200 > 1,024) — never held whole.
    expect(readSoFar()).toBe(3);
    expect(cancel).toHaveBeenCalled();
  });

  it('recovers when Content-Length UNDERSTATES the body: the spill still merges in order', async () => {
    // A decoded transfer can arrive longer than the encoded length announced.
    const whole = bytes(500, 3);
    const chunks = [whole.subarray(0, 180), whole.subarray(180, 260), whole.subarray(260)];
    const { res } = streamed(chunks, 200);

    const out = await readBodyCapped(res, CAP, new AbortController());

    expect(new Uint8Array(out!)).toEqual(whole);
  });

  it('trims the trailing zeros when Content-Length OVERSTATES the body', async () => {
    const whole = bytes(90, 11);
    const { res } = streamed([whole], 900);

    const out = await readBodyCapped(res, CAP, new AbortController());

    expect(out!.byteLength).toBe(90);
    expect(new Uint8Array(out!)).toEqual(whole);
  });

  it('still bounds a response with no stream at all', async () => {
    const small = { arrayBuffer: async () => bytes(10).buffer } as unknown as Response;
    const big = { arrayBuffer: async () => bytes(CAP + 1).buffer } as unknown as Response;

    expect((await readBodyCapped(small, CAP, new AbortController()))!.byteLength).toBe(10);
    expect(await readBodyCapped(big, CAP, new AbortController())).toBeNull();
  });
});
