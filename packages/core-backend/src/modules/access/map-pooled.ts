/**
 * `items.map(fn)` with at most `limit` calls in flight, results in input
 * order. The access module's one way to read many files without opening them
 * all at once: an unbounded `Promise.all` over a knowledge base's thousands
 * of files trips EMFILE. Once a call fails, no further item is started: the
 * caller already has the failure, and the rest would be read for nothing.
 */
export async function mapPooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
