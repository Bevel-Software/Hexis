/**
 * At most `limit` bytes of a response body, decoded as text, the rest of the
 * stream cancelled — and whether the body was SEEN to end within the limit.
 *
 * Bounded on RAW bytes, before decoding: each chunk is sliced to the
 * remaining budget as it arrives, so a provider that answers in one 5MB chunk
 * never puts the whole of it through the decoder, which is the bound bypassed
 * by the very party it is meant to bound. Never a byte past the limit: once
 * the budget is spent the read stops without asking for more, so a body of
 * exactly `limit` bytes on a stream that stays open returns at once rather
 * than waiting on a next chunk until the request times out. The price is that
 * such a body cannot be told from a longer one, and `ended` says so: it is
 * true only when the stream reported its end within the budget, never
 * inferred from the decoded text, whose length a multi-byte character cut at
 * the limit would understate. The decode runs once over the kept bytes, so a
 * character cut in half reads as U+FFFD rather than lingering in a streaming
 * decoder. The read never falls back to `res.text()` on a live stream: a cap
 * applied after that read bounds nothing.
 *
 * Shared, not a module's own: the connection probe reads a provider's
 * rejection with it and the secrets vault a token endpoint's refusal, and one
 * reader is the only way the two cannot disagree about what "bounded" means.
 */
export async function readCappedBytes(res: Response, limit: number): Promise<{ text: string; ended: boolean }> {
  const reader = res.body?.getReader();
  // No stream (a mocked or already-consumed response): fall back to the whole
  // body, which for those cases is ours and small.
  if (!reader) {
    const whole = await res.text();
    return { text: whole.slice(0, limit), ended: whole.length <= limit };
  }
  const chunks: Uint8Array[] = [];
  let read = 0;
  let ended = false;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      const remaining = limit - read;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      read += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const kept = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    kept.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(kept), ended };
}

/** The text alone, for a caller that only quotes a bounded snippet. */
export async function readCapped(res: Response, limit: number): Promise<string> {
  return (await readCappedBytes(res, limit)).text;
}
