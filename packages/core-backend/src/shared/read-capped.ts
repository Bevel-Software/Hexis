/**
 * At most `limit` bytes of a response body, decoded as text, the rest of the
 * stream cancelled — and whether the body went past the limit.
 *
 * Bounded on RAW bytes, before decoding: each chunk is sliced to the
 * remaining budget as it arrives, so a provider that answers in one 5MB chunk
 * never puts the whole of it through the decoder, which is the bound bypassed
 * by the very party it is meant to bound. One byte past the limit is read so
 * a body that merely FILLS the limit can be told from one that was cut at it;
 * `truncated` is that raw-byte fact, never inferred from the decoded text,
 * whose length a multi-byte character cut at the limit would understate. The
 * decode runs once over the kept bytes, so a character cut in half reads as
 * U+FFFD rather than lingering in a streaming decoder. The read never falls
 * back to `res.text()` on a live stream: a cap applied after that read bounds
 * nothing.
 *
 * Shared, not a module's own: the connection probe reads a provider's
 * rejection with it and the secrets vault a token endpoint's refusal, and one
 * reader is the only way the two cannot disagree about what "bounded" means.
 */
export async function readCappedBytes(
  res: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  // No stream (a mocked or already-consumed response): fall back to the whole
  // body, which for those cases is ours and small.
  if (!reader) {
    const whole = await res.text();
    return { text: whole.slice(0, limit), truncated: whole.length > limit };
  }
  const budget = limit + 1;
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (read < budget) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = budget - read;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      read += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const kept = new Uint8Array(Math.min(read, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, kept.byteLength - offset);
    if (take <= 0) break;
    kept.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { text: new TextDecoder().decode(kept), truncated: read > limit };
}

/** The text alone, for a caller that only quotes a bounded snippet. */
export async function readCapped(res: Response, limit: number): Promise<string> {
  return (await readCappedBytes(res, limit)).text;
}
