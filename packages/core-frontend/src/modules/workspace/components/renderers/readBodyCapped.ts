/**
 * The one capped body read the binary viewers share.
 *
 * `.xlsx`, `.pptx` and `.eml`/`.msg` all hand a WHOLE-FILE buffer to a parser
 * with no streaming mode, so each has to refuse an oversized response before
 * it is in the tab. That logic lived three times, in three slightly different
 * states — every fix landed on one copy and left the others behind. It lives
 * here once.
 */

/**
 * `res`'s bytes, or `null` once they exceed `maxBytes`.
 *
 * Two bounds, because one is not enough. A DECLARED Content-Length over the
 * cap is refused before a byte is buffered, and `abort` ends the request so
 * the browser stops receiving a file nobody will look at — returning alone
 * left the connection streaming for as long as the view stayed mounted. But
 * Content-Length can be absent (chunked) or understate the body, so the
 * stream is also counted as it arrives and abandoned the moment it crosses
 * the cap. The early exit aborts the CONTROLLER rather than cancelling
 * `res.body`: cancelling a stream that has already errored REJECTS, and that
 * rejection would carry the caller into its generic error path instead of the
 * oversized one this returns `null` for.
 *
 * Where the server declared a length the bytes are copied ONCE — each chunk
 * lands directly in a buffer of exactly that size, rather than being retained
 * as a chunk list and then copied AGAIN into a merged buffer, which peaked at
 * twice the file. (Preallocating `maxBytes` up front would bound that peak
 * too, and would charge a 4 KB message the whole 25/50/200 MB cap; the
 * declared length is the size that is actually right. A server that overstates
 * its length costs that overstatement instead — bounded by `maxBytes`, which
 * it could have made us allocate by simply sending the bytes.) An undeclared
 * or understated body falls back to the chunk list.
 *
 * Falls back to `arrayBuffer()` (capped after the fact) where the response has
 * no stream at all, e.g. the test DOM's mocked responses.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  abort: AbortController,
): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers?.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    return null;
  }
  const body = res.body;
  if (!body) {
    const buffer = await res.arrayBuffer();
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const reader = body.getReader();
  // Preallocated only against a length the server actually declared; a
  // fractional or absent one leaves this null and takes the chunk path.
  let sized = Number.isInteger(declared) && declared > 0 ? new Uint8Array(declared) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const offset = received;
    received += value.byteLength;
    if (received > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    if (sized !== null && received <= sized.byteLength) {
      sized.set(value, offset);
      continue;
    }
    if (sized !== null) {
      // Content-Length understated the body — a decoded transfer arrives
      // longer than the encoded length that was announced. What has landed so
      // far becomes the first chunk and the rest accumulates behind it. Copied
      // with `slice`, not viewed with `subarray`: a view would pin the whole
      // preallocated buffer for as long as the chunk list lives, holding the
      // declared length on top of the chunks and the merge it feeds.
      chunks.push(sized.slice(0, offset));
      sized = null;
    }
    chunks.push(value);
  }
  if (sized !== null) {
    // Exactly as declared: the buffer already IS the answer. A short body (the
    // server overstated) is trimmed rather than handed over with the trailing
    // zeros nobody sent.
    return received === sized.byteLength ? sized.buffer : sized.buffer.slice(0, received);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}
