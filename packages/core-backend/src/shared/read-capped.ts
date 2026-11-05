/**
 * At most `limit` bytes of a response body, decoded as text, the rest of the
 * stream cancelled.
 *
 * Each CHUNK is sliced to the remaining budget before being decoded, not just
 * counted against it: a provider that answers in one 5MB chunk would otherwise
 * put the whole thing through the decoder before the loop noticed it was over,
 * which is the bound bypassed by the very party it is meant to bound. Never a
 * byte past the limit: once the budget is spent the read stops without asking
 * for more, so a body of exactly `limit` bytes on a stream that stays open
 * returns at once. And the read never falls back to `res.text()` on a live
 * stream: a cap applied after that read bounds nothing.
 *
 * Shared, not a module's own: the connection probe reads a provider's
 * rejection with it and the secrets vault a token endpoint's refusal, and one
 * reader is the only way the two cannot disagree about what "bounded" means.
 */
export async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  // No stream (a mocked or already-consumed response): fall back to the whole
  // body, which for those cases is ours and small.
  if (!reader) return (await res.text()).slice(0, limit);
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - read;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      read += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}
