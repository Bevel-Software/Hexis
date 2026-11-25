/**
 * `items.map(fn)` with at most `limit` calls in flight, results in input
 * order. The access module's one way to read many files without opening them
 * all at once: an unbounded `Promise.all` over a knowledge base's thousands
 * of files trips EMFILE.
 */
export async function mapPooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
